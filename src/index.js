// src/index.js — entrypoint: env check, TDLib session, Express REST, WS push, admin.
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const { TdSession } = require('./td');
const makeRoutes = require('./routes');
const auth = require('./auth');
const makeAdmin = require('./admin');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.TDLIB_DIR || '/data/tdlib';      // Railway Volume mount
const FILES_DIR = process.env.FILES_DIR || path.join(DATA_DIR, 'files');

// ---- env validation (fail fast, but keep admin reachable for first login) --
function envStatus() {
  return {
    API_ID: process.env.API_ID ? 'set' : 'MISSING',
    API_HASH: process.env.API_HASH ? 'set' : 'MISSING',
    CLIENT_TOKEN: process.env.CLIENT_TOKEN ? 'set' : 'MISSING',
    ADMIN_USER: process.env.ADMIN_USER ? 'set' : 'default(admin)',
    ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH ? 'set' : 'DEFAULT (changeme) — set ADMIN_PASSWORD_HASH!',
  };
}
console.log('[env]', JSON.stringify(envStatus()));

// ---- TDLib session ---------------------------------------------------------
let td = null;
let lastUpdatesRing = [];

async function startTd() {
  if (!process.env.API_ID || !process.env.API_HASH) {
    console.error('[td] API_ID/API_HASH missing — tdlib not started (dashboard still up)');
    return;
  }
  td = new TdSession({
    apiId: parseInt(process.env.API_ID, 10),
    apiHash: process.env.API_HASH,
    databaseDirectory: DATA_DIR,
    filesDir: FILES_DIR,
    log: m => console.log('[td]', m),
    onAuthState: (state) => {
      broadcastWS({ _: 'authState', state });
    },
    onUpdate: (u) => {
      // ring buffer for admin debug + forward interesting updates to app clients
      lastUpdatesRing.push(u._);
      if (lastUpdatesRing.length > 200) lastUpdatesRing.shift();
      if (u._ === 'updateNewMessage') {
        broadcastWS({ _: 'newMessage', message: u.message });
      } else if (u._ === 'updateChatAction' || u._ === 'updateUserStatus') {
        broadcastWS(u);
      }
    },
  });
  await td.start();
}
startTd().catch(e => console.error('[td] start failed:', e));

// ---- Express ---------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '2mb' }));

// health: intentionally reveals nothing sensitive
app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api', auth.requireApiToken, makeRoutes(() => td));

const adminRouter = makeAdmin({
  getTd: () => td,
  startTd,
  envStatus,
  broadcastWS,
  logActivity: auth.logActivity,
});
// static dashboard shell FIRST (public — holds no secrets); when the path is a
// JSON API route, express.static falls through with next() to the gated router
app.use('/admin', express.static(path.join(__dirname, 'admin_static')));
app.use('/admin', adminRouter);

// ---- WebSocket push ---------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const wsClients = new Set();

function broadcastWS(obj) {
  const s = JSON.stringify(obj);
  for (const ws of wsClients) {
    if (ws.readyState === 1 && ws._authed) ws.send(s);
  }
}

wss.on('connection', (ws, req) => {
  ws._authed = false;
  ws.on('message', data => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.type === 'hello' && auth.safeEq(m.token || '', process.env.CLIENT_TOKEN || '\u0000')) {
      ws._authed = true;
      wsClients.add(ws);
      ws.send(JSON.stringify({ _: 'helloOk', tdState: td ? td.state : 'not-started' }));
    }
  });
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

// housekeeping: ping all clients every 30s to keep Railway's proxy alive
setInterval(() => {
  for (const ws of wsClients) {
    if (ws.readyState === 1) { try { ws.ping(); } catch { /* ignore */ } }
  }
}, 30000).unref();

server.listen(PORT, () => console.log(`listening on :${PORT}`));
