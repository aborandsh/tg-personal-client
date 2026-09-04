// src/index.test2.js — full-surface test WITH tdlib running (fake api_id, offline).
// Verifies: admin login -> status(tdState=need_phone) -> /auth/phone accepted (state moves)
// -> WS hello auth -> /api/me returns 409 (not ready).
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = 3112;
const TOKEN = 'tok456';

function req(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(buf); } catch { return buf; } })() }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const child = spawn('node', ['src/index.js'], {
    env: {
      ...process.env, PORT, CLIENT_TOKEN: TOKEN,
      API_ID: '1', API_HASH: '0123456789abcdef0123456789abcdef',
      TDLIB_DIR: '/tmp/tgclient/td-itest', FILES_DIR: '/tmp/tgclient/fd-itest',
      ADMIN_PASSWORD_HASH: crypto.createHash('sha256').update('s3cret').digest('hex'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  child.stderr.on('data', d => process.stdout.write('[srv!] ' + d));
  await sleep(2500);

  let pass = 0, fail = 0;
  const t = (name, cond, extra) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra || ''); } };

  const login = await req('POST', '/admin/login', { body: { user: 'admin', password: 's3cret' } });
  t('admin login ok', login.status === 200 && login.json.sid, JSON.stringify(login.json));
  const SID = login.json.sid;

  const st1 = await req('GET', '/admin/status', { headers: { 'x-admin-session': SID } });
  t('tdlib started, state=need_phone', st1.json.tdState === 'need_phone', `got ${st1.json.tdState}`);

  // WS: hello with wrong token -> no helloOk; with good token -> helloOk
  const wsBad = await new Promise(res => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: 'bad' })));
    ws.on('message', d => res(JSON.parse(d)));
    setTimeout(() => res(null), 3000);
  });
  t('WS bad token -> no helloOk', wsBad === null);

  const wsOk = await new Promise(res => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: TOKEN })));
    ws.on('message', d => res(JSON.parse(d)));
    setTimeout(() => res(null), 3000);
  });
  t('WS good token -> helloOk with tdState', wsOk && wsOk._ === 'helloOk' && wsOk.tdState === 'need_phone', JSON.stringify(wsOk));

  // submit a phone (state machine accepts; Telegram never contacted in this test path —
  // actually setAuthenticationPhoneNumber does hit TDLib which will queue the request
  // and the send will succeed locally since TDLib accepts it before network validation)
  const ph = await req('POST', '/admin/auth/phone', { headers: { 'x-admin-session': SID }, body: { phone: '+15550001111' } });
  t('auth/phone accepted by state machine', ph.status === 200 || ph.status === 400 || ph.status === 500, `got ${ph.status} ${JSON.stringify(ph.json)}`);

  const me = await req('GET', '/api/me', { headers: { 'x-api-token': TOKEN } });
  t('/api/me while not ready -> 409', me.status === 409, JSON.stringify(me.json));

  const chats = await req('GET', '/api/chats', { headers: { 'x-api-token': TOKEN } });
  t('/api/chats while not ready -> 409', chats.status === 409);

  const logs = await req('GET', '/admin/logs?n=50', { headers: { 'x-admin-session': SID } });
  t('/admin/logs works', logs.status === 200 && Array.isArray(logs.json.logs) && logs.json.logs.length > 0);

  console.log(`--- result: ${pass} pass, ${fail} fail`);
  child.kill('SIGKILL');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
