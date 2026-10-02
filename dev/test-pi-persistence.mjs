// Integration test: Pi chats survive a restart.
//
// Bundles the real PiAgent from vscode/src and drives it against a fake local
// OpenAI-compatible model server, with an in-memory stand-in for the host's per-session
// database. It runs a conversation (including a real tool call), then simulates an
// app restart with a brand-new agent instance and verifies:
//   1. the conversation was saved after the turn,
//   2. sessions can be described from the small saved record alone,
//   3. history (text and tool steps) is rebuilt for the screen,
//   4. the model receives the earlier conversation when the chat continues.
//
// Run from the repo root after `./dev/build.sh` has fetched vscode/ :
//   node dev/test-pi-persistence.mjs
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const vscode = join(root, 'vscode');
const work = mkdtempSync(join(root, 'test-run', 'persist-'));   // visible, git-ignored
const esbuild = (await import(pathToFileURL(join(vscode, 'build/node_modules/esbuild/lib/main.js')).href)).default ?? (await import(pathToFileURL(join(vscode, 'build/node_modules/esbuild/lib/main.js')).href));

// ---- 1. bundle the real agent --------------------------------------------------------
const out = join(vscode, '.pi-persistence-test.mjs');
await esbuild.build({
	entryPoints: [join(vscode, 'src/vs/platform/agentHost/node/pi/piAgent.ts')],
	outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
	tsconfig: join(vscode, 'src/tsconfig.json'),
	external: ['@earendil-works/*', 'typebox'],
	banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const { PiAgent } = await import(pathToFileURL(out).href);

// ---- 2. fake model server ------------------------------------------------------------
const seen = [];                        // every chat-completions request body
const server = createServer((req, res) => {
	let body = '';
	req.on('data', c => body += c);
	req.on('end', () => {
		const json = JSON.parse(body || '{}');
		seen.push(json);
		const messages = json.messages ?? [];
		const last = messages[messages.length - 1] ?? {};
		const lastUser = [...messages].reverse().find(m => m.role === 'user');
		const userText = typeof lastUser?.content === 'string' ? lastUser.content : (lastUser?.content ?? []).map(p => p.text).join('');
		res.writeHead(200, { 'Content-Type': 'text/event-stream' });
		const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
		const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake-model' };
		if (last.role !== 'tool' && /list the files/i.test(userText)) {
			send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }] }, finish_reason: null }] });
			send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
		} else {
			const reply = last.role === 'tool' ? 'I listed the files.' : `You said: ${userText}`;
			send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] });
			send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
		}
		res.write('data: [DONE]\n\n');
		res.end();
	});
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

// ---- 3. stand-ins for the host services ----------------------------------------------
const store = new Map();                // sessionString -> Map(key -> value)  (survives "restart")
const sessionData = {
	openDatabase: session => {
		const key = session.toString(); if (!store.has(key)) store.set(key, new Map());
		const m = store.get(key);
		return { object: { getMetadata: async k => m.get(k), setMetadata: async (k, v) => { m.set(k, v); }, setMetadataValues: async o => { for (const [k, v] of Object.entries(o)) m.set(k, v); } }, dispose() { } };
	},
};
const logs = [];
const log = { info: m => logs.push('info ' + m), warn: m => logs.push('WARN ' + m), error: (...a) => logs.push('ERROR ' + a.join(' ')), trace() { }, debug() { } };

const payload = JSON.stringify({ providers: [{ id: 'fake', name: 'Fake', kind: 'openai-compatible', enabled: true, baseUrl, apiKey: 'test-key', models: [{ id: 'fake-model' }] }], defaultModel: 'fake/fake-model' });
const makeAgent = async () => {
	const agent = new PiAgent(log, sessionData);
	await agent.handleAuthenticationToken({ resource: 'pi:providers', token: payload });
	return agent;
};

// helpers
const chatUri = URI_from('pi-chat:/session-1/chat-1');
function URI_from(s) { return { scheme: 'pi-chat', authority: '', path: s.replace('pi-chat:', ''), query: '', fragment: '', toString() { return s; }, fsPath: s, with() { return this; }, toJSON() { return s; } }; }
const sessionUri = URI_from('pi:/session-1');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
const waitFor = async (pred, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await new Promise(r => setTimeout(r, 25)); } return false; };
const sandbox = join(work, 'project'); mkdirSync(sandbox); writeFileSync(join(sandbox, 'hello.txt'), 'hi');
const cwdUri = { fsPath: sandbox, toString: () => sandbox, scheme: 'file' };

try {
	// ---- run 1: a fresh app ----
	const a1 = await makeAgent();
	const signals1 = []; a1.onDidChatProgress(s => signals1.push(s));
	const created = await a1.chats.createChat(chatUri, sessionUri, { workingDirectories: [cwdUri] });
	check('createChat returns providerData to persist', !!created?.providerData, created?.providerData?.slice(0, 40));
	const providerData = created.providerData;

	await a1.chats.sendMessage(chatUri, 'My favourite number is 42.', [cwdUri], undefined, 'turn-A');
	check('turn 1 completes', await waitFor(() => signals1.some(s => s.action?.type === 'chat/turnComplete' || s.action?.type === 'chat/error')), signals1.filter(s => s.action?.type === 'chat/error').map(s => s.action.error.message).join('|'));
	await a1.chats.sendMessage(chatUri, 'Please list the files here.', [cwdUri], undefined, 'turn-B');
	check('turn 2 (with a real tool call) completes', await waitFor(() => signals1.filter(s => s.action?.type === 'chat/turnComplete').length >= 2));
	await new Promise(r => setTimeout(r, 300));
	await a1.shutdown();

	const saved = store.get(sessionUri.toString());
	const keys = saved ? [...saved.keys()] : [];
	check('conversation and small metadata record were saved', keys.some(k => k.startsWith('pi.conversation.')) && keys.some(k => k.startsWith('pi.meta.')), keys.join(', '));
	const meta = JSON.parse(saved.get(keys.find(k => k.startsWith('pi.meta.'))));
	check('title taken from the first question', meta.title === 'My favourite number is 42.', JSON.stringify(meta.title));
	check('model and working directory remembered', meta.model === 'fake/fake-model' && meta.cwd === sandbox);

	// ---- run 2: "restart" = brand-new agent, same stored data ----
	seen.length = 0;
	const a2 = await makeAgent();
	const signals2 = []; a2.onDidChatProgress(s => signals2.push(s));
	const described = await a2.getChatMetadata(chatUri, sessionUri, providerData);
	check('session can be described BEFORE re-attaching (host calls this first)', !!described && described.summary === 'My favourite number is 42.' && described.model?.id === 'fake/fake-model', JSON.stringify({ summary: described?.summary, model: described?.model?.id }));
	await a2.materializeChat(chatUri, sessionUri, providerData);
	const turns = await a2.chats.getMessages(chatUri, sessionUri);
	check('history rebuilt: two turns', turns.length === 2, 'turns=' + turns.length);
	check('turn ids from the host were kept', turns[0]?.id === 'turn-A' && turns[1]?.id === 'turn-B', turns.map(t => t.id).join(','));
	check('turn 1 shows the question and the reply', turns[0]?.message.text === 'My favourite number is 42.' && turns[0]?.responseParts.some(p => p.kind === 'markdown' && /You said: My favourite number is 42/.test(p.content)));
	const tool = turns[1]?.responseParts.find(p => p.kind === 'toolCall');
	check('turn 2 shows the tool call as completed with its output', tool?.toolCall.status === 'completed' && tool.toolCall.toolName === 'list_dir' && /hello\.txt/.test(tool.toolCall.content?.[0]?.text ?? ''), tool ? tool.toolCall.displayName : 'no tool part');

	await a2.chats.sendMessage(chatUri, 'What was my favourite number?', [cwdUri], undefined, 'turn-C');
	check('continuing the restored chat works', await waitFor(() => signals2.some(s => s.action?.type === 'chat/turnComplete')));
	const body = JSON.stringify(seen[seen.length - 1]?.messages ?? []);
	check('the MODEL received the earlier conversation (remembers it)', /favourite number is 42/.test(body) && /list_dir|You said: My favourite/.test(body), 'messages sent=' + (seen[seen.length - 1]?.messages?.length ?? 0));
	const turns3 = await a2.chats.getMessages(chatUri, sessionUri);
	check('history now has three turns', turns3.length === 3);
	await a2.shutdown();
} catch (e) {
	fail++; console.log('FAIL exception: ' + (e.stack ?? e));
}
const bad = logs.filter(l => l.startsWith('ERROR') || l.startsWith('WARN'));
if (bad.length) console.log('host log problems:\n  ' + bad.slice(0, 5).join('\n  '));
console.log(`\n${pass} passed, ${fail} failed`);
server.close(); rmSync(out, { force: true }); rmSync(work, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
