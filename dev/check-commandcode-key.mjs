// Find out why a Command Code key is rejected, without ever printing the key.
//
// Run it yourself (it reads your key; I never see it):
//   COMMAND_CODE_API_KEY=user_... node dev/check-commandcode-key.mjs
// or, to read the key your Command Code CLI already saved:
//   node dev/check-commandcode-key.mjs
//
// It sends one tiny request to each of Command Code's endpoints and prints only the
// HTTP status and the error code, which tells us what kind of key you have:
//   200 on provider/chat  -> the key works with the Provider API (mollycodel should too)
//   403 upgrade_required  -> a valid key whose plan has no Provider API access
//   401                   -> the key is not accepted by that endpoint at all
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function findKey() {
	if (process.env.COMMAND_CODE_API_KEY) return { key: process.env.COMMAND_CODE_API_KEY, from: 'COMMAND_CODE_API_KEY' };
	for (const file of [join(homedir(), '.commandcode', 'auth.json')]) {
		try {
			if (!existsSync(file)) continue;
			const j = JSON.parse(readFileSync(file, 'utf8'));
			const k = j.apiKey ?? j.commandcode ?? j['command-code']?.key ?? j['command-code'];
			if (typeof k === 'string' && k) return { key: k, from: file };
		} catch { /* ignore */ }
	}
	return undefined;
}

const found = findKey();
if (!found) { console.log('No key found. Set COMMAND_CODE_API_KEY or log in with the Command Code CLI first.'); process.exit(1); }
const key = found.key.trim();
console.log(`Key source: ${found.from}`);
console.log(`Key shape: ${key.length} characters, starts with "${key.slice(0, 5)}", ${/\s/.test(found.key) ? 'HAD whitespace (trimmed)' : 'no stray whitespace'}`);

async function probe(label, url, init) {
	try {
		const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
		let text = ''; try { text = await res.text(); } catch { /* streaming body */ }
		let code = ''; try { const j = JSON.parse(text); code = j.error?.code ?? j.code ?? j.error?.type ?? ''; } catch { /* not json */ }
		console.log(`${label.padEnd(44)} HTTP ${res.status} ${code}`);
	} catch (e) { console.log(`${label.padEnd(44)} failed: ${e.cause?.code ?? e.message}`); }
}

const base = 'https://api.commandcode.ai';
const json = { 'Content-Type': 'application/json' };
const chat = { model: 'deepseek/deepseek-v4-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] };
await probe('provider chat, Bearer', `${base}/provider/v1/chat/completions`, { method: 'POST', headers: { ...json, Authorization: `Bearer ${key}` }, body: JSON.stringify(chat) });
await probe('provider chat, x-api-key', `${base}/provider/v1/chat/completions`, { method: 'POST', headers: { ...json, 'x-api-key': key }, body: JSON.stringify(chat) });
await probe('provider messages (Claude), Bearer', `${base}/provider/v1/messages`, { method: 'POST', headers: { ...json, Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }) });
await probe('provider messages (Claude), x-api-key', `${base}/provider/v1/messages`, { method: 'POST', headers: { ...json, 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }) });
console.log('\nSend me these lines (they contain no key).');
