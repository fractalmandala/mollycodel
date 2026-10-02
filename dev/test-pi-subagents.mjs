// Integration test: Pi sub-agents.
//
// Runs the real PiAgent against a fake local model server that plays the parent and the
// children, and checks: parallel runs, per-type tool limits, custom agent files, the
// no-nesting rule, approvals for a sub-agent's writes, labelled tool cards in the chat,
// and that the delegation survives a restart.
//
//   node dev/test-pi-subagents.mjs
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const vscode = join(root, 'vscode');
const work = mkdtempSync(join(root, 'test-run', 'subagents-'));
const esbuild = await import(pathToFileURL(join(vscode, 'build/node_modules/esbuild/lib/main.js')).href);
const out = join(vscode, '.pi-subagents-test.mjs');
await esbuild.build({
	entryPoints: [join(vscode, 'src/vs/platform/agentHost/node/pi/piAgent.ts')],
	outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
	tsconfig: join(vscode, 'src/tsconfig.json'), external: ['@earendil-works/*', 'typebox'],
	banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const { PiAgent } = await import(pathToFileURL(out).href);

// ---- project with a custom agent --------------------------------------------------------
const project = join(work, 'project'); mkdirSync(join(project, '.pi', 'agents'), { recursive: true });
writeFileSync(join(project, 'hello.txt'), 'hi');
writeFileSync(join(project, '.pi', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews code.\ntools: read_file\n---\nYou are the REVIEWER-PERSONA. Be strict.\n');

// ---- fake model server --------------------------------------------------------------------
const requests = [];                    // { child, system, tools, lastRole, user }
let inflightChildren = 0, maxInflight = 0;
const sys = req => JSON.stringify((req.messages ?? []).filter(m => m.role === 'system' || m.role === 'developer'));
const server = createServer((httpReq, res) => {
	let body = ''; httpReq.on('data', c => body += c);
	httpReq.on('end', async () => {
		const req = JSON.parse(body || '{}');
		const messages = req.messages ?? [];
		const last = messages.at(-1) ?? {};
		const firstUser = messages.find(m => m.role === 'user');
		const userText = m => typeof m?.content === 'string' ? m.content : (m?.content ?? []).map(p => p.text).join('');
		const child = sys(req).includes('You are a sub-agent');
		const record = { child, system: sys(req), tools: (req.tools ?? []).map(t => t.function.name), lastRole: last.role, prompt: userText(firstUser), lastContent: userText(last), allUser: messages.filter(m => m.role === 'user').map(userText).join('|') };
		requests.push(record);
		const base = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fake-model' };
		const send = o => res.write(`data: ${JSON.stringify({ ...base, ...o })}\n\n`);
		const calls = list => { send({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: list.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }, finish_reason: null }] }); send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }); };
		const say = text => { send({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }); send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }); };
		res.writeHead(200, { 'Content-Type': 'text/event-stream' });
		if (child) {
			inflightChildren++; maxInflight = Math.max(maxInflight, inflightChildren);
			await new Promise(r => setTimeout(r, 250));
			inflightChildren--;
			const p = record.prompt;
			if (p.includes('CHILD-A')) { last.role === 'tool' ? say('REPORT-A saw: ' + record.lastContent.slice(0, 40)) : calls([{ id: 'call_1', name: 'list_dir', args: { path: '.' } }]); }
			else if (p.includes('CHILD-W')) { last.role === 'tool' ? say('REPORT-W result: ' + record.lastContent) : calls([{ id: 'call_1', name: 'write_file', args: { path: 'out.txt', content: 'x' } }]); }
			else if (p.includes('CHILD-B')) say('REPORT-B reviewed');
			else say('REPORT-C general');
		} else if (last.role === 'tool') {
			say('PARENT DONE: ' + messages.filter(m => m.role === 'tool').map(userText).join(' || ').slice(0, 400));
		} else if (/delegate three/i.test(userText(last))) {
			calls([
				{ id: 'call_1', name: 'Agent', args: { description: 'scan', prompt: 'CHILD-A list things', subagent_type: 'explore' } },
				{ id: 'call_2', name: 'Agent', args: { description: 'review', prompt: 'CHILD-B review', subagent_type: 'reviewer' } },
				{ id: 'call_3', name: 'Agent', args: { description: 'misc', prompt: 'CHILD-C misc', subagent_type: 'no-such-type' } },
			]);
		} else if (/delegate a write/i.test(userText(last))) {
			calls([{ id: 'call_1', name: 'Agent', args: { description: 'writer', prompt: 'CHILD-W write', subagent_type: 'general-purpose' } }]);
		} else { say('ok'); }
		res.write('data: [DONE]\n\n'); res.end();
	});
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

// ---- host stand-ins ----------------------------------------------------------------------
const store = new Map();
const sessionData = { openDatabase: session => { const k = session.toString(); if (!store.has(k)) store.set(k, new Map()); const m = store.get(k); return { object: { getMetadata: async x => m.get(x), setMetadata: async (x, v) => { m.set(x, v); }, setMetadataValues: async o => { for (const [x, v] of Object.entries(o)) m.set(x, v); } }, dispose() { } }; } };
const logs = []; const log = { info: m => logs.push('info ' + m), warn: m => logs.push('WARN ' + m), error: (...a) => logs.push('ERROR ' + a.join(' ')), trace() { }, debug() { } };
const payload = JSON.stringify({ providers: [{ id: 'fake', name: 'Fake', kind: 'openai-compatible', enabled: true, baseUrl, apiKey: 'k', models: [{ id: 'fake-model' }] }], defaultModel: 'fake/fake-model' });
const makeAgent = async () => { const a = new PiAgent(log, sessionData); await a.handleAuthenticationToken({ resource: 'pi:providers', token: payload }); return a; };
const U = s => ({ scheme: 'x', authority: '', path: s, query: '', fragment: '', toString() { return s; }, fsPath: s, with() { return this; }, toJSON() { return s; } });
const chatUri = U('pi-chat:/s1/c1'), sessionUri = U('pi:/s1'), cwdUri = { fsPath: project, toString: () => project, scheme: 'file' };

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + n + (extra ? '  ' + extra : '')); };
const waitFor = async (pred, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await new Promise(r => setTimeout(r, 25)); } return false; };
const turnsDone = s => s.filter(x => x.action?.type === 'chat/turnComplete' || x.action?.type === 'chat/error').length;

try {
	const a1 = await makeAgent();
	const sig = []; a1.onDidChatProgress(s => { sig.push(s); if (s.kind === 'pending_confirmation') { a1.respondToPermissionRequest(s.state.toolCallId, false); } });
	const created = await a1.chats.createChat(chatUri, sessionUri, { workingDirectories: [cwdUri] });

	// ---- turn 1: three sub-agents at once ----
	await a1.chats.sendMessage(chatUri, 'Please delegate three tasks.', [cwdUri], undefined, 'turn-1');
	check('turn 1 completes', await waitFor(() => turnsDone(sig) >= 1), sig.filter(s => s.action?.type === 'chat/error').map(s => s.action.error.message).join('|'));
	const kids = requests.filter(r => r.child);
	check('three sub-agents ran', kids.length >= 3, 'child requests=' + kids.length);
	check('they ran in parallel', maxInflight >= 2, 'max at once=' + maxInflight);
	const explore = kids.find(r => r.prompt.includes('CHILD-A'));
	const reviewer = kids.find(r => r.prompt.includes('CHILD-B'));
	const generic = kids.find(r => r.prompt.includes('CHILD-C'));
	check('Explore (looked up case-insensitively) is read-only', explore && explore.tools.sort().join() === 'list_dir,read_file', explore?.tools.join());
	check('custom agent file is used: persona and only its tools', reviewer?.system.includes('REVIEWER-PERSONA') && reviewer.tools.join() === 'read_file', reviewer?.tools.join());
	check('unknown type falls back to general-purpose (all tools, no Agent tool)', generic && generic.tools.includes('bash') && !generic.tools.includes('Agent'), generic?.tools.join());
	check('sub-agents cannot start sub-agents', kids.every(k => !k.tools.includes('Agent')));
	const parentReq = requests.find(r => !r.child);
	check('parent was offered the Agent tool listing the types', parentReq?.tools.includes('Agent'));
	const toolMsgs = JSON.stringify(sig.filter(s => s.action?.type === 'chat/toolCallComplete').map(s => s.action.result?.content?.[0]?.text));
	check('reports reached the parent as tool results', /REPORT-A/.test(toolMsgs) && /REPORT-B/.test(toolMsgs) && /REPORT-C/.test(toolMsgs) && /Unknown agent type/.test(toolMsgs));
	const starts = sig.map(s => s.action).filter(a => a?.displayName && a?.toolCallId);
	const childCard = starts.find(a => a.displayName === 'Explore: List Directory');
	check('a sub-agent\'s tool call shows as its own labelled card', !!childCard, starts.map(a => a.displayName).join(' | '));
	check('...with an id that cannot clash with the parent\'s', /^sub\d+:/.test(childCard?.toolCallId ?? ''));
	const completes = new Set(sig.map(s => s.action).filter(a => a?.type === 'chat/toolCallComplete').map(a => a.toolCallId));
	check('every card was completed', starts.every(a => completes.has(a.toolCallId)), 'cards=' + starts.length + ' completed=' + completes.size);

	// ---- turn 2: a sub-agent wants to write; the user declines ----
	const before = sig.length;
	await a1.chats.sendMessage(chatUri, 'Now delegate a write.', [cwdUri], undefined, 'turn-2');
	check('turn 2 completes', await waitFor(() => turnsDone(sig) >= 2));
	const pend = sig.slice(before).find(s => s.kind === 'pending_confirmation');
	check('the sub-agent\'s write asked for approval, named after the agent', pend?.state.displayName === 'general-purpose: Write File', pend?.state.displayName);
	check('declined write did not happen', !existsSync(join(project, 'out.txt')));
	const w = requests.filter(r => r.child && r.prompt.includes('CHILD-W')).at(-1);
	check('the sub-agent was told the user declined', /did not approve/.test(w?.lastContent ?? ''), w?.lastContent?.slice(0, 60));
	await new Promise(r => setTimeout(r, 300));
	await a1.shutdown();

	// ---- restart ----
	const a2 = await makeAgent();
	await a2.materializeChat(chatUri, sessionUri, created.providerData);
	const turns = await a2.chats.getMessages(chatUri, sessionUri);
	const cards = turns[0]?.responseParts.filter(p => p.kind === 'toolCall') ?? [];
	check('after restart, turn 1 shows its three sub-agent cards', cards.filter(c => c.toolCall.toolName === 'Agent').length === 3, 'cards=' + cards.length);
	check('...with the delegated task and the report', cards[0]?.toolCall.displayName === 'Sub-agent' && /REPORT-/.test(cards.map(c => c.toolCall.content?.[0]?.text ?? '').join('')));
	await a2.shutdown();
} catch (e) { fail++; console.log('FAIL exception: ' + (e.stack ?? e)); }
const bad = logs.filter(l => l.startsWith('ERROR') || l.startsWith('WARN'));
if (bad.length) console.log('host log problems:\n  ' + bad.slice(0, 5).join('\n  '));
console.log(`\n${pass} passed, ${fail} failed`);
server.close(); rmSync(out, { force: true }); rmSync(work, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
