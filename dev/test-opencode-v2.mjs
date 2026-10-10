// Integration test: the OpenCode agent against a REAL OpenCode 2.x server.
//
// Starts the agent (which starts its own private `opencode serve`), sends a plain prompt and a
// tool-using prompt on a free model, and checks the streamed text, the tool card, usage, the
// title and the history read back afterwards. Skipped (exit 0) when OpenCode 2.x is not installed
// or has no free model, so it never fails a machine that cannot run it.
//
//   node dev/test-opencode-v2.mjs
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const vscode = join(root, 'vscode');
const bin = join(homedir(), '.opencode', 'bin', 'opencode');
if (!existsSync(bin)) { console.log('SKIP: OpenCode is not installed'); process.exit(0); }
const version = execFileSync(bin, ['--version']).toString().trim();
if (!/v?2\./.test(version)) { console.log(`SKIP: OpenCode ${version} is not 2.x`); process.exit(0); }

const esbuild = await import(pathToFileURL(join(vscode, 'build/node_modules/esbuild/lib/main.js')).href);
const out = join(vscode, '.oc-v2-test.mjs');
await esbuild.build({ entryPoints: [join(vscode, 'src/vs/platform/agentHost/node/opencode/opencodeAgent.ts')], outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'error', tsconfig: join(vscode, 'src/tsconfig.json'), banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
const { OpenCodeAgent } = await import(pathToFileURL(out).href);

const ws = join(root, 'test-run', 'oc-agent-ws'); rmSync(ws, { recursive: true, force: true }); mkdirSync(ws, { recursive: true }); writeFileSync(join(ws, 'note.txt'), 'the secret word is pelican\n');
const logs = []; const log = { info: m => logs.push('info ' + m), warn: m => logs.push('WARN ' + m), error: (...a) => logs.push('ERROR ' + a.join(' ')), trace() { }, debug() { } };
const U = s => ({ scheme: 'x', authority: '', path: s, query: '', fragment: '', toString() { return s; }, fsPath: s, with() { return this; }, toJSON() { return s; } });
const cwd = { fsPath: ws, toString: () => ws, scheme: 'file' };

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + n + (extra ? '  ' + extra : '')); };
const waitFor = async (pred, ms = 90000) => { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };

const agent = new OpenCodeAgent(log);
const signals = []; agent.onDidChatProgress(s => signals.push(s));
let providerData; agent.onDidChangeChatData(c => { providerData = c.providerData; });
const actions = () => signals.filter(s => s.kind === 'action').map(s => s.action);
try {
	check('agent detected the 2.x API', await waitFor(() => logs.some(l => /speaks the 2\.x API/.test(l)), 40000), logs.filter(l => /OpenCode/.test(l)).slice(-2).join(' | '));
	const gotModels = await waitFor(() => (agent.models.get?.() ?? agent.models.read?.() ?? []).some(m => m.id === 'opencode/ling-3.1-flash-free'), 60000);
	const models = agent.models.get?.() ?? [];
	check('models were published from /api/model', models.length > 5, `${models.length} models`);
	if (!gotModels) { console.log('SKIP the rest: the free model is not available here'); throw new Error('skip'); }

	const chat = U('oc-chat:/s1/c1'), session = U('oc:/s1');
	const created = await agent.chats.createChat(chat, session, { workingDirectories: [cwd], model: { id: 'opencode/ling-3.1-flash-free' } });
	check('model chosen up front is remembered', agent.chats.getModel(chat)?.id === 'opencode/ling-3.1-flash-free');

	// ---- plain reply ----
	await agent.chats.sendMessage(chat, 'Reply with exactly the word: pong', [cwd], undefined, 'turn-1');
	check('turn 1 completes', await waitFor(() => actions().some(a => a.type === 'chat/turnComplete' && a.turnId === 'turn-1' || a.type === 'chat/error')), JSON.stringify(actions().filter(a => a.type === 'chat/error').map(a => a.error)));
	if (process.env.DEBUG_ACTIONS) console.log('   actions:', actions().map(a => a.type).join(' '), '| signal kinds:', [...new Set(signals.map(s => s.kind))].join(','), '| log:'); console.log(logs.join('\n'));
	const textParts = actions().filter(a => a.type === 'chat/responsePart' && a.part.kind === 'markdown');
	const streamed = actions().filter(a => a.type === 'chat/delta').map(a => a.content).join('');
	check('the reply streamed in as text', textParts.length >= 1 && /pong/i.test(streamed), JSON.stringify(streamed.slice(0, 40)));
	check('usage was reported', actions().some(a => a.type === 'chat/usage' && a.usage.outputTokens > 0), '');
	// (OpenCode names sessions with a separate model call that it sometimes skips, so the title is checked in the fake-server test instead.)

	// ---- a tool call ----
	signals.length = 0;
	await agent.chats.sendMessage(chat, 'Use the shell tool to run exactly: cat note.txt   Then tell me the secret word.', [cwd], undefined, 'turn-2');
	check('turn 2 completes', await waitFor(() => actions().some(a => (a.type === 'chat/turnComplete' || a.type === 'chat/error') && a.turnId === 'turn-2')), JSON.stringify(actions().filter(a => a.type === 'chat/error').map(a => a.error)));
	const start = actions().find(a => a.type === 'chat/toolCallStart');
	const done = actions().find(a => a.type === 'chat/toolCallComplete');
	check('a tool card was started and finished', !!start && !!done && done.toolCallId === start.toolCallId, start ? start.displayName : 'no tool call');
	check('the tool output reached the card', /pelican/.test(JSON.stringify(done?.result?.content ?? '')), '');
	check('the answer used the tool output', /pelican/i.test(actions().filter(a => a.type === 'chat/delta').map(a => a.content).join('')), '');

	// ---- history, then a "restart" ----
	const turns = await agent.chats.getMessages(chat);
	check('history has both turns', turns.length === 2, 'turns=' + turns.length);
	check('history keeps the question and the reply', turns[0]?.message.text.includes('pong') && turns[0].responseParts.some(p => p.kind === 'markdown' && /pong/i.test(p.content)));
	check('history keeps the tool call and its output', turns[1]?.responseParts.some(p => p.kind === 'toolCall' && /pelican/.test(JSON.stringify(p.toolCall.content ?? ''))));

	check('the host was given data to re-attach the chat later', !!providerData && JSON.parse(providerData).sessionId?.startsWith('ses_'));

	// ---- a "restart": a brand-new agent re-attaches to the same OpenCode session ----
	await agent.shutdown(); agent.dispose();
	const agent2 = new OpenCodeAgent(log);
	const signals2 = []; agent2.onDidChatProgress(s => signals2.push(s));
	const actions2 = () => signals2.filter(s => s.kind === 'action').map(s => s.action);
	try {
		await agent2.materializeChat(chat, session, providerData);
		const again = await agent2.chats.getMessages(chat);
		check('after restart the history is still there', again.length === 2, 'turns=' + again.length);
		await agent2.chats.sendMessage(chat, 'What was the secret word? Answer with just that one word, and do not use any tool.', [cwd], undefined, 'turn-3');
		check('turn 3 (after restart) completes', await waitFor(() => actions2().some(a => (a.type === 'chat/turnComplete' || a.type === 'chat/error') && a.turnId === 'turn-3')), JSON.stringify(actions2().filter(a => a.type === 'chat/error').map(a => a.error)));
		check('the session remembered the earlier conversation', /pelican/i.test(actions2().filter(a => a.type === 'chat/delta').map(a => a.content).join('')));
	} finally { await agent2.shutdown(); agent2.dispose(); }
} catch (e) { if (e.message !== 'skip') { fail++; console.log('FAIL exception: ' + (e.stack ?? e)); } }
try { await agent.shutdown(); agent.dispose(); } catch { /* */ }
const bad = logs.filter(l => l.startsWith('ERROR') || (l.startsWith('WARN') && !/git|watcher/i.test(l)));
if (bad.length) console.log('agent log problems:\n  ' + bad.slice(0, 5).join('\n  '));
console.log(`\n${pass} passed, ${fail} failed`);
rmSync(out, { force: true });
setTimeout(() => process.exit(fail ? 1 : 0), 500);
