// Checks the OpenCode server protocol the host's OpenCodeAgent relies on, against the
// locally installed OpenCode, using a free Zen model (no cost). Run:
//   node dev/check-opencode-protocol.mjs [project-folder]
// Every line should print PASS. See docs/agents-window/SPEC.md (phase 3b).
import { spawn } from 'node:child_process';
const bin = process.env.HOME + '/.opencode/bin/opencode';
const password = 'spike-' + Math.random().toString(36).slice(2);
const child = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: process.env.HOME, env: { ...process.env, OPENCODE_SERVER_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
const base = await new Promise((resolve, reject) => { let out = ''; const t = setTimeout(() => reject(new Error('timeout')), 30000); const on = d => { out += d; const m = out.match(/listening on (https?:\/\/[^\s]+)/); if (m) { clearTimeout(t); resolve(m[1]); } }; child.stdout.on('data', on); child.stderr.on('data', on); });
const auth = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
const dir = process.argv[2] || process.cwd(); // a project folder OpenCode may work in
const url = (p, d) => { const u = new URL(p, base); if (d) u.searchParams.set('directory', d); return u.toString(); };
const get = async (p, d) => { const r = await fetch(url(p, d), { headers: { Authorization: auth } }); const t = await r.text(); if (!r.ok) throw new Error('GET ' + p + ' ' + r.status + ' ' + t.slice(0, 120)); return JSON.parse(t); };
const post = async (p, b, d) => { const r = await fetch(url(p, d), { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}) }); const t = await r.text(); if (!r.ok) throw new Error('POST ' + p + ' ' + r.status + ' ' + t.slice(0, 120)); return t ? JSON.parse(t) : undefined; };
const step = (n, ok, extra = '') => console.log((ok ? 'PASS ' : 'FAIL ') + n + (extra ? '  ' + extra : ''));
try {
	const prov = await get('/config/providers'); const models = (prov.providers ?? []).reduce((n, p) => n + Object.keys(p.models ?? {}).length, 0);
	step('GET /config/providers (no directory)', models > 0, models + ' models');
	const sess = await post('/session', {}, dir); step('POST /session with empty body', !!sess.id, sess.id?.slice(0, 14));
	// SSE reader using the same parsing approach as the adapter
	const ac = new AbortController(); const events = [];
	const resp = await fetch(url('/global/event'), { headers: { Authorization: auth, Accept: 'text/event-stream' }, signal: ac.signal });
	step('GET /global/event', resp.ok && !!resp.body, 'status ' + resp.status);
	const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = '';
	const pump = (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) return; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.search(/\r?\n\r?\n/)) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, ''); const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n'); if (data) { try { const o = JSON.parse(data); events.push(o.payload ?? o); } catch {} } } } } catch {} })();
	await post('/session/' + sess.id + '/message', { model: { providerID: 'opencode', modelID: 'fledge-alpha-free' }, parts: [{ type: 'text', text: 'Reply with the single word: pong' }] }, dir);
	await new Promise(r => setTimeout(r, 600));
	const mine = events.filter(e => (e.properties?.sessionID ?? e.properties?.part?.sessionID ?? e.properties?.info?.sessionID) === sess.id);
	const types = [...new Set(mine.map(e => e.type))];
	step('events parsed from the stream', mine.length > 3, mine.length + ' events: ' + types.join(','));
	step('saw text deltas or text parts', mine.some(e => e.type === 'message.part.delta' || (e.type === 'message.part.updated' && e.properties.part.type === 'text')));
	step('saw session.idle', mine.some(e => e.type === 'session.idle'));
	const hist = await get('/session/' + sess.id + '/message', dir);
	const asst = hist.filter(m => m.info.role === 'assistant'); const text = asst.flatMap(m => m.parts).filter(p => p.type === 'text').map(p => p.text).join('');
	step('GET history shape {info, parts}', hist.length >= 2 && !!hist[0].info && Array.isArray(hist[0].parts), hist.length + ' messages; assistant text=' + JSON.stringify(text.slice(0, 20)));
	await post('/session/' + sess.id + '/abort', {}, dir).then(() => step('POST abort on an idle session', true), e => step('POST abort on an idle session', false, e.message));
	ac.abort();
} catch (e) { console.log('ERROR', e.message); }
child.kill();
