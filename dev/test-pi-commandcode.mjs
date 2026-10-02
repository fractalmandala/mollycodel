// Integration test: the Command Code provider routes each model to the right protocol.
//
// Bundles the real provider runtime, points a `command-code` row at a fake local server and
// streams one prompt through a Claude model and one non-Claude model, checking which URL,
// which credential header and which request shape each one used. No real key or network.
//
//   node dev/test-pi-commandcode.mjs
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const vscode = resolve(import.meta.dirname, '..', 'vscode');
const esbuild = await import(pathToFileURL(join(vscode, 'build/node_modules/esbuild/lib/main.js')).href);
const out = join(vscode, '.pi-commandcode-test.mjs');
await esbuild.build({
	entryPoints: [join(vscode, 'src/vs/platform/agentHost/node/pi/piProviderRuntime.ts')],
	outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
	tsconfig: join(vscode, 'src/tsconfig.json'), external: ['@earendil-works/*', 'typebox'],
});
const { loadPiDeps, buildPiModels, commandCodeApiFor, commandCodeBaseUrl } = await import(pathToFileURL(out).href);

const requests = [];
const server = createServer((req, res) => {
	let body = ''; req.on('data', c => body += c);
	req.on('end', () => {
		requests.push({ method: req.method, url: req.url, auth: req.headers['authorization'], xkey: req.headers['x-api-key'], body: body ? JSON.parse(body) : undefined });
		res.writeHead(200, { 'Content-Type': 'text/event-stream' });
		const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
		if (req.url.split('?')[0].endsWith('/messages')) {
			ev('message_start', { message: { id: 'm1', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
			ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
			ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hello from anthropic route' } });
			ev('content_block_stop', { index: 0 });
			ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
			ev('message_stop', {});
		} else {
			const base = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'x' };
			res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'hello from openai route' }, finish_reason: null }] })}\n\n`);
			res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } })}\n\n`);
			res.write('data: [DONE]\n\n');
		}
		res.end();
	});
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/provider/v1`;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

// pure helpers
check('claude-* ids use the Anthropic protocol', commandCodeApiFor({ id: 'claude-sonnet-4-6' }) === 'anthropic-messages');
check('other ids use the OpenAI protocol', commandCodeApiFor({ id: 'deepseek/deepseek-v4-flash' }) === 'openai-completions');
check('an explicit api wins over the id guess', commandCodeApiFor({ id: 'claude-x', api: 'openai-completions' }) === 'openai-completions');
check('Anthropic base drops /v1', commandCodeBaseUrl('https://api.commandcode.ai/provider/v1', 'anthropic-messages') === 'https://api.commandcode.ai/provider');
check('OpenAI base keeps /v1', commandCodeBaseUrl('https://api.commandcode.ai/provider/v1/', 'openai-completions') === 'https://api.commandcode.ai/provider/v1');

try {
	const deps = await loadPiDeps();
	const models = await buildPiModels(deps, { providers: [{ id: 'cc', name: 'Command Code', kind: 'command-code', enabled: true, baseUrl: base, apiKey: 'user_fake_key', models: [{ id: 'claude-sonnet-4-6' }, { id: 'deepseek/deepseek-v4-flash' }] }] });
	const claude = models.getModel('cc', 'claude-sonnet-4-6');
	const other = models.getModel('cc', 'deepseek/deepseek-v4-flash');
	check('both models are offered under one provider', !!claude && !!other);
	check('Pi\'s catalog filled in the Claude model\'s limits', claude?.contextWindow > 128000 || claude?.maxTokens > 16384, `ctx=${claude?.contextWindow} max=${claude?.maxTokens}`);

	const run = async model => {
		const stream = models.streamSimple(model, { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] }, {});
		let text = '', error;
		for await (const e of stream) {
			if (e.type === 'text_delta') { text += e.delta; }
			if (e.type === 'error') { error = e.error?.errorMessage ?? 'error'; }
			if (process.env.DEBUG_EVENTS) console.log('   event', e.type, e.reason ?? '');
		}
		return { text, error };
	};
	const a = await run(claude);
	const ra = requests.at(-1);
	check('Claude model replied through the Anthropic route', a.text.includes('anthropic route'), a.error ?? '');
	check('  URL is <base minus /v1>/v1/messages', ra?.url?.split('?')[0] === '/provider/v1/messages', ra?.url);
	if (process.env.DEBUG_EVENTS) console.log('   anthropic request', JSON.stringify({ ...ra?.body, messages: undefined, tools: undefined, system: undefined }));
	check('  the key went in as a credential and was not logged', !!(ra?.xkey || ra?.auth) && JSON.stringify(ra?.body).indexOf('user_fake_key') < 0);

	const o = await run(other);
	const ro = requests.at(-1);
	check('Non-Claude model replied through the OpenAI route', o.text.includes('openai route'), o.error ?? '');
	check('  URL is <base>/chat/completions', ro?.url === '/provider/v1/chat/completions', ro?.url);
	check('  bearer credential sent', ro?.auth === 'Bearer user_fake_key');
	check('  gateway-unfriendly fields are not sent (store, developer role)', ro?.body && !('store' in ro.body) && !JSON.stringify(ro.body.messages).includes('"developer"'));
} catch (e) {
	fail++; console.log('FAIL exception: ' + (e.stack ?? e));
}
console.log(`\n${pass} passed, ${fail} failed`);
server.close(); rmSync(out, { force: true });
process.exit(fail ? 1 : 0);
