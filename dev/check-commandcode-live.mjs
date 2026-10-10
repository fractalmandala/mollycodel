// Run mollycodel's own Command Code code path against the real API with YOUR key.
// The key is read from COMMAND_CODE_API_KEY or ~/.commandcode/auth.json and is never printed.
//
//   node dev/check-commandcode-live.mjs
//
// If this answers, the provider code is fine and the key stored inside the app is what differs.
// If it fails, it prints the status and the (key-free) request headers we sent, so we can see why.
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const vscode = resolve(import.meta.dirname, '..', 'vscode');
function findKey() {
	if (process.env.COMMAND_CODE_API_KEY) return process.env.COMMAND_CODE_API_KEY;
	const file = join(homedir(), '.commandcode', 'auth.json');
	try { if (existsSync(file)) { const j = JSON.parse(readFileSync(file, 'utf8')); return j.apiKey ?? j.commandcode ?? j['command-code']?.key ?? j['command-code']; } } catch { /* ignore */ }
}
const key = findKey()?.trim();
if (!key) { console.log('No key found.'); process.exit(1); }

const esbuild = await import(pathToFileURL(join(vscode, 'build/node_modules/esbuild/lib/main.js')).href);
const out = join(vscode, '.cc-live-test.mjs');
await esbuild.build({ entryPoints: [join(vscode, 'src/vs/platform/agentHost/node/pi/piProviderRuntime.ts')], outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'error', tsconfig: join(vscode, 'src/tsconfig.json'), external: ['@earendil-works/*', 'typebox'] });
const { loadPiDeps, buildPiModels } = await import(pathToFileURL(out).href);

// Show what goes on the wire, with the credential masked.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
	const headers = {};
	const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
	h.forEach((v, k) => { headers[k] = /authorization|api-key/i.test(k) ? `<${v.length} chars${v.includes(key) ? ', contains your key' : ', DOES NOT contain your key'}>` : v; });
	console.log(`  -> ${init?.method ?? 'GET'} ${typeof input === 'string' ? input : input.url}`);
	console.log('  -> headers:', JSON.stringify(headers));
	const res = await realFetch(input, init);
	console.log(`  <- HTTP ${res.status}`);
	return res;
};

const deps = await loadPiDeps();
const models = await buildPiModels(deps, { providers: [{ id: 'cc', name: 'Command Code', kind: 'command-code', enabled: true, baseUrl: 'https://api.commandcode.ai/provider/v1', apiKey: key, models: [{ id: 'deepseek/deepseek-v4-flash' }, { id: 'claude-sonnet-4-6' }] }] });
for (const id of ['deepseek/deepseek-v4-flash', 'claude-sonnet-4-6']) {
	console.log(`\nModel ${id}`);
	const model = models.getModel('cc', id);
	let text = '', error;
	for await (const e of models.streamSimple(model, { messages: [{ role: 'user', content: 'Reply with exactly: pong', timestamp: Date.now() }] }, { maxTokens: 20 })) {
		if (e.type === 'text_delta') text += e.delta;
		if (e.type === 'error') error = e.error?.errorMessage ?? 'error';
	}
	console.log(error ? `  RESULT: FAILED: ${error}` : `  RESULT: answered: ${text.trim().slice(0, 60)}`);
}
rmSync(out, { force: true });
