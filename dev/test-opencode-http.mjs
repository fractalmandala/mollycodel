// Test: the OpenCode HTTP client, and the routing headers Pi sends to OpenCode's hosted models.
//
//   node dev/test-opencode-http.mjs
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const vscode = resolve(import.meta.dirname, '..', 'vscode');
const esbuild = await import(pathToFileURL(join(vscode, 'build/node_modules/esbuild/lib/main.js')).href);
const bundle = async (entry, name) => {
	const out = join(vscode, name);
	await esbuild.build({ entryPoints: [join(vscode, entry)], outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'error', tsconfig: join(vscode, 'src/tsconfig.json'), external: ['@earendil-works/*', 'typebox'] });
	return out;
};
const httpOut = await bundle('src/vs/platform/agentHost/node/opencode/opencodeHttp.ts', '.oc-http-test.mjs');
const rtOut = await bundle('src/vs/platform/agentHost/node/pi/piProviderRuntime.ts', '.oc-rt-test.mjs');
const { OpenCodeHttp } = await import(pathToFileURL(httpOut).href);
const { routingHeaders } = await import(pathToFileURL(rtOut).href);

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + n + (extra ? '  ' + extra : '')); };

// ---- routing headers ----
const h = routingHeaders('https://opencode.ai/zen/go/v1', 'chat-123');
check('OpenCode Go gets a session id and its own user agent', h?.['x-opencode-session'] === 'chat-123' && /^mollycodel\//.test(h['User-Agent']), JSON.stringify(h));
check('OpenCode Zen too', !!routingHeaders('https://opencode.ai/zen/v1', 'c'));
check('other hosts get nothing extra', routingHeaders('https://api.openai.com/v1', 'c') === undefined && routingHeaders('https://api.commandcode.ai/provider/v1', 'c') === undefined);
check('a look-alike host does not match', routingHeaders('https://evilopencode.ai/v1', 'c') === undefined && routingHeaders('https://opencode.ai.evil.com/v1', 'c') === undefined);
check('no session id, no header', routingHeaders('https://opencode.ai/zen/go/v1', undefined) === undefined);

// ---- http client ----
const seen = [];
const server = createServer((req, res) => {
	let body = ''; req.on('data', c => body += c);
	req.on('end', () => {
		seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
		if (req.url.startsWith('/slow')) { setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ done: true })); }, 1200); }
		else if (req.url.startsWith('/bad')) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: { message: 'boom' } })); }
		else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); }
	});
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
const http = new OpenCodeHttp({ url, authorization: 'Basic abc' });

const got = await http.get('/ok?x=1', '/proj');
check('GET works and sends the directory and credentials', got.ok === true && seen[0].url.includes('directory=%2Fproj') && seen[0].auth === 'Basic abc');
const slow = await http.postAndWait('/slow', { a: 1 }, '/proj');
check('a POST that answers late still returns its result', slow.done === true && seen.at(-1).method === 'POST' && JSON.parse(seen.at(-1).body).a === 1);
let err; try { await http.postAndWait('/bad', {}); } catch (e) { err = e; }
check('an error status carries the server\'s message', /\(500\).*boom/.test(err?.message ?? ''), err?.message);
const ctl = new AbortController(); const pending = http.postAndWait('/slow', {}, undefined, ctl.signal); setTimeout(() => ctl.abort(), 200);
let abortErr; try { await pending; } catch (e) { abortErr = e; }
check('a late POST can be aborted', abortErr?.name === 'AbortError', abortErr?.name);

server.close(); await new Promise(r => setTimeout(r, 100));
let refused; try { await http.get('/ok'); } catch (e) { refused = e; }
check('a refused connection says why, not just "fetch failed"', /ECONNREFUSED/.test(refused?.message ?? ''), refused?.message);
let refusedPost; try { await http.postAndWait('/slow', {}); } catch (e) { refusedPost = e; }
check('same for the long POST', /ECONNREFUSED/.test(refusedPost?.message ?? ''), refusedPost?.message);

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(httpOut, { force: true }); rmSync(rtOut, { force: true });
process.exit(fail ? 1 : 0);
