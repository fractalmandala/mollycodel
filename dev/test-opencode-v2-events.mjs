// Test: how the OpenCode agent reacts to 2.x events, using a scripted fake server.
// Covers what a real server cannot be made to do on demand: approvals (allow and decline),
// a failed run, stopping a run, a title, a dropped event stream, and refusing to treat a
// 1.x-style server as 2.x. No network and no real OpenCode needed.
//
//   node dev/test-opencode-v2-events.mjs
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const vscode = join(root, 'vscode');
const work = join(root, 'test-run', 'oc-fake'); rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });

// ---- the fake OpenCode: a node server behind an executable the agent will launch ----
const serverJs = join(work, 'fake-opencode.mjs');
writeFileSync(serverJs, String.raw`
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const mode = process.env.FAKE_MODE || 'v2';
const logFile = process.env.FAKE_LOG;
const note = (o) => appendFileSync(logFile, JSON.stringify(o) + '\n');
const subs = new Set();
const emit = (type, data) => { const e = { id: 'evt_' + Math.random().toString(36).slice(2), type, data }; for (const r of subs) r.write('data: ' + JSON.stringify(e) + '\n\n'); };
const SID = 'ses_fake', MID = 'msg_fake';
let pendingReply = null;
const step = () => emit('session.step.started', { sessionID: SID, assistantMessageID: MID, agent: 'build', model: { providerID: 'fake', id: 'm1' } });
const text = (t) => { emit('session.text.started', { sessionID: SID, assistantMessageID: MID, ordinal: 0 }); emit('session.text.delta', { sessionID: SID, assistantMessageID: MID, ordinal: 0, delta: t }); emit('session.text.ended', { sessionID: SID, assistantMessageID: MID, ordinal: 0, text: t }); };
const ended = () => emit('session.step.ended', { sessionID: SID, assistantMessageID: MID, finish: 'stop', tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 2, write: 0 } } });
const server = createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const url = new URL(req.url, 'http://x'); const p = url.pathname;
    const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (mode === 'v1' && p.startsWith('/api')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><html></html>'); }
    if (p === '/api/info') return json({ version: '2.0.22' });
    if (p === '/api/model') return json({ data: [{ id: 'm1', modelID: 'm1', providerID: 'fake', name: 'Model One', enabled: true, limit: { context: 1000, output: 100 }, capabilities: { tools: true, input: ['text', 'image'], output: ['text'] } }] });
    if (p === '/api/event') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: ' + JSON.stringify({ id: 'e0', type: 'server.connected', data: {} }) + '\n\n'); subs.add(res); res.on('close', () => subs.delete(res)); return; }
    if (p === '/api/session' && req.method === 'POST') { note({ route: 'create', body: JSON.parse(body || '{}') }); return json({ data: { id: SID } }); }
    if (p === '/api/session/' + SID && req.method === 'GET') { return json({ data: { id: SID, time: { created: 1, updated: 1, idle: Date.now() + 1000 } } }); }
    if (p === '/api/session/' + SID + '/interrupt') { note({ route: 'interrupt' }); emit('session.execution.interrupted', { sessionID: SID, reason: 'user' }); return json({ interrupted: true }); }
    const reply = /\/permission\/([^/]+)\/reply$/.exec(p);
    if (reply) { const b = JSON.parse(body || '{}'); note({ route: 'reply', id: reply[1], body: b }); res.writeHead(204); res.end(); if (pendingReply) pendingReply(b.decision); return; }
    if (p === '/api/session/' + SID + '/prompt') {
      const t = JSON.parse(body || '{}').text || ''; note({ route: 'prompt', text: t }); json({ data: { id: 'inbox1' } });
      emit('session.execution.started', { sessionID: SID }); step();
      if (t.includes('APPROVE')) {
        emit('session.tool.input.started', { sessionID: SID, assistantMessageID: MID, id: 'call_1', name: 'shell' });
        emit('session.tool.called', { sessionID: SID, assistantMessageID: MID, id: 'call_1', input: { command: 'echo hi' }, executed: false });
        emit('permission.asked', { id: 'per_1', sessionID: SID, action: 'shell', resources: ['echo hi'], save: ['echo *'], source: { type: 'tool', messageID: MID, id: 'call_1' } });
        pendingReply = (decision) => { pendingReply = null; emit('permission.replied', { sessionID: SID, requestID: 'per_1', reply: decision });
          if (decision === 'reject') { emit('session.tool.failed', { sessionID: SID, assistantMessageID: MID, id: 'call_1', error: { type: 'aborted', message: 'The user declined this tool call' } }); emit('session.execution.interrupted', { sessionID: SID, reason: 'shutdown' }); }
          else { emit('session.tool.progress', { sessionID: SID, assistantMessageID: MID, id: 'call_1', metadata: {} }); emit('session.tool.success', { sessionID: SID, assistantMessageID: MID, id: 'call_1', content: [{ type: 'text', text: 'hi\n' }], metadata: { exit: 0 } }); text('done'); ended(); emit('session.execution.succeeded', { sessionID: SID }); } };
      } else if (t.includes('FAIL')) { emit('session.execution.failed', { sessionID: SID, error: { type: 'provider', message: 'model said no' } }); }
      else if (t.includes('HANG')) { /* never finishes; the test stops it */ }
      else if (t.includes('QUIET')) { /* the stream "drops": no end event, but the server is idle */ }
      else { emit('session.renamed', { sessionID: SID, title: 'A fake title' }); text('hello'); ended(); emit('session.execution.succeeded', { sessionID: SID }); }
      return;
    }
    res.writeHead(404); res.end();
  });
});
server.listen(0, '127.0.0.1', () => { console.log('server listening on http://127.0.0.1:' + server.address().port); });
`);
const wrapper = join(work, 'fake-opencode.sh');
writeFileSync(wrapper, `#!/bin/sh\nexec node "${serverJs}" "$@"\n`); chmodSync(wrapper, 0o755);

// ---- the agent ----
const esbuild = await import(pathToFileURL(join(vscode, 'build/node_modules/esbuild/lib/main.js')).href);
const out = join(vscode, '.oc-v2-events-test.mjs');
await esbuild.build({ entryPoints: [join(vscode, 'src/vs/platform/agentHost/node/opencode/opencodeAgent.ts')], outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'error', tsconfig: join(vscode, 'src/tsconfig.json'), banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
const { OpenCodeAgent } = await import(pathToFileURL(out).href);

const U = s => ({ scheme: 'x', authority: '', path: s, query: '', fragment: '', toString() { return s; }, fsPath: s, with() { return this; }, toJSON() { return s; } });
const cwd = { fsPath: work, toString: () => work, scheme: 'file' };
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + n + (extra ? '  ' + extra : '')); };
const waitFor = async (pred, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };

async function session(mode) {
	process.env.OPENCODE_BIN = wrapper; process.env.FAKE_MODE = mode; process.env.FAKE_LOG = join(work, `${mode}-${Date.now()}.ndjson`);
	writeFileSync(process.env.FAKE_LOG, '');
	const logs = []; const log = { info: m => logs.push('info ' + m), warn: m => logs.push('WARN ' + m), error: (...a) => logs.push('ERROR ' + a.join(' ')), trace() { }, debug() { } };
	const agent = new OpenCodeAgent(log); const signals = []; agent.onDidChatProgress(s => signals.push(s));
	const actions = () => signals.filter(s => s.kind === 'action').map(s => s.action);
	const calls = () => readFileSync(process.env.FAKE_LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
	return { agent, signals, actions, calls, logs, close: async () => { await agent.shutdown(); agent.dispose(); } };
}
import { readFileSync } from 'node:fs';
let n = 0;
const send = async (s, text, id) => { const chat = U('c:/' + (++n)); await s.agent.chats.createChat(chat, U('s:/1'), { workingDirectories: [cwd], model: { id: 'fake/m1' } }); s.chat = chat; await s.agent.chats.sendMessage(chat, text, [cwd], undefined, id); return chat; };

try {
	// ---- a plain run, with a title ----
	let s = await session('v2');
	check('models from the server are published', await waitFor(() => (s.agent.models.get().some(m => m.id === 'fake/m1'))), '');
	const m = s.agent.models.get().find(x => x.id === 'fake/m1');
	check('model limits and vision are mapped', m?.maxContextWindow === 1000 && m?.maxOutputTokens === 100 && m?.supportsVision === true);
	await send(s, 'say hello', 't1');
	check('a plain turn completes', await waitFor(() => s.actions().some(a => a.type === 'chat/turnComplete')));
	if (process.env.DEBUG_FAKE) console.log('   log:', s.logs.join(' ; ').slice(0, 900), '\n   actions:', s.actions().map(a => a.type).join(' '));
	check('text streams in', s.actions().filter(a => a.type === 'chat/delta').map(a => a.content).join('') === 'hello');
	check('the title is forwarded', s.actions().some(a => a.type === 'session/titleChanged' && a.title === 'A fake title'));
	const u = s.actions().find(a => a.type === 'chat/usage');
	check('usage is reported with the model', u?.usage.inputTokens === 7 && u.usage.outputTokens === 3 && u.usage.cacheReadTokens === 2 && u.usage.model === 'fake/m1', JSON.stringify(u?.usage));
	check('the session is created at the chosen folder and model', s.calls().some(c => c.route === 'create' && c.body.location.directory === work && c.body.model.providerID === 'fake' && c.body.model.id === 'm1'));
	await s.close();

	// ---- approve a tool ----
	s = await session('v2'); await send(s, 'APPROVE this', 't1');
	check('an approval is asked for, naming the command', await waitFor(() => s.signals.some(x => x.kind === 'pending_confirmation')));
	const ask = s.signals.find(x => x.kind === 'pending_confirmation');
	check('...as a shell approval for the right tool call', ask.permissionKind === 'shell' && ask.state.toolCallId === 'call_1' && /echo hi/.test(ask.state.toolInput ?? ''), JSON.stringify({ k: ask.permissionKind, id: ask.state.toolCallId }));
	s.agent.respondToPermissionRequest('call_1', true);
	check('approving finishes the run', await waitFor(() => s.actions().some(a => a.type === 'chat/turnComplete')));
	check('the reply was sent as "once"', s.calls().some(c => c.route === 'reply' && c.id === 'per_1' && c.body.decision === 'once'));
	check('the tool card completed with its output', s.actions().some(a => a.type === 'chat/toolCallComplete' && a.result.success && /hi/.test(JSON.stringify(a.result.content))));
	await s.close();

	// ---- decline a tool ----
	s = await session('v2'); await send(s, 'APPROVE this', 't1');
	await waitFor(() => s.signals.some(x => x.kind === 'pending_confirmation')); s.agent.respondToPermissionRequest('call_1', false);
	check('declining sends "reject"', await waitFor(() => s.calls().some(c => c.route === 'reply' && c.body.decision === 'reject')));
	check('the declined tool card shows as failed', await waitFor(() => s.actions().some(a => a.type === 'chat/toolCallComplete' && a.result.success === false && /declined/.test(a.result.error?.message ?? ''))));
	check('the turn ends (no hang)', await waitFor(() => s.actions().some(a => a.type === 'chat/turnComplete')));
	await s.close();

	// ---- a failed run ----
	s = await session('v2'); await send(s, 'FAIL please', 't1');
	check('a failed run is reported with the server\'s message', await waitFor(() => s.actions().some(a => a.type === 'chat/error' && /model said no/.test(a.error.message))));
	await s.close();

	// ---- stop a run ----
	s = await session('v2'); const chat = await send(s, 'HANG forever', 't1');
	await waitFor(() => s.calls().some(c => c.route === 'prompt'));
	await s.agent.chats.abort(chat);
	check('stopping calls interrupt on the server', await waitFor(() => s.calls().some(c => c.route === 'interrupt')));
	await new Promise(r => setTimeout(r, 500));
	check('a stopped run is not reported as complete or failed', !s.actions().some(a => a.type === 'chat/turnComplete' || a.type === 'chat/error'));
	await s.close();

	// ---- end event missed ----
	s = await session('v2'); await send(s, 'QUIET one', 't1');
	check('a run whose end event was missed is finished by asking the server', await waitFor(() => s.actions().some(a => a.type === 'chat/turnComplete'), 30000));
	await s.close();

	// ---- a 1.x style server is not mistaken for 2.x ----
	s = await session('v1');
	check('a server that answers /api with a web page is treated as 1.x', await waitFor(() => s.logs.some(l => /speaks the 1\.x API/.test(l)), 20000), s.logs.slice(-2).join(' | '));
	await s.close();
} catch (e) { fail++; console.log('FAIL exception: ' + (e.stack ?? e)); }
console.log(`\n${pass} passed, ${fail} failed`);
rmSync(out, { force: true });
setTimeout(() => process.exit(fail ? 1 : 0), 500);
