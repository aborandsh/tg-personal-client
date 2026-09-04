// src/admin.js — management dashboard API (all under /admin, session-gated).
const express = require('express');
const auth = require('./auth');

module.exports = function makeAdmin({ getTd, startTd, envStatus, broadcastWS, logActivity }) {
  const router = express.Router();

  // ---- login (rate-limited, no session needed) -----------------------------
  router.post('/login', (req, res) => {
    const ip = req.ip;
    if (!auth.rateLimitLogin(ip)) {
      auth.logActivity(ip, 'login rate-limited');
      return res.status(429).json({ error: 'too many attempts; wait 10 minutes' });
    }
    const { user, password } = req.body || {};
    if (!auth.verifyAdminCreds(user || '', password || '')) {
      // debug (no secrets): log only shape of what arrived to diagnose bad logins
      const dbg = `login FAILED (user.len=${String(user || '').length} pw.len=${String(password || '').length}` +
        ` ct=${req.get('content-type') || '-'} keys=${Object.keys(req.body || {}).join(',')})`;
      auth.logActivity(ip, dbg);
      console.log('[admin]', dbg);
      return res.status(401).json({ error: 'bad credentials' });
    }
    const sid = auth.newSession();
    auth.logActivity(ip, 'login ok');
    res.json({ sid });
  });

  // everything below requires an admin session
  router.use((req, res, next) => auth.requireAdmin(req, res, next));

  router.post('/logout', (req, res) => {
    auth.destroySession(req.adminSid);
    res.json({ ok: true });
  });

  // ---- status ---------------------------------------------------------------
  router.get('/status', (req, res) => {
    const td = getTd();
    const mem = process.memoryUsage();
    res.json({
      env: envStatus(),
      tdState: td ? td.state : 'not-started',
      tdDetail: td ? td.stateDetail : null,
      me: td ? td.me : null,
      process: {
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        rssMB: +(mem.rss / 1048576).toFixed(1),
        heapMB: +(mem.heapUsed / 1048576).toFixed(1),
      },
    });
  });

  // ---------- message view helpers (shared by chat endpoints) ----------
  function msgView(m) {
    const c = m.content || {};
    let kind = 'text', text = '';
    if (c._ === 'messageText') { kind = 'text'; text = c.text ? c.text.text : ''; }
    else if (c._ === 'messagePhoto') { kind = 'photo'; text = c.caption ? c.caption.text : ''; }
    else if (c._ === 'messageVoiceNote') { kind = 'voice'; }
    else if (c._ === 'messageDocument') { kind = 'file'; text = c.document && c.document.file_name || ''; }
    else if (c._ === 'messageSticker') { kind = 'sticker'; }
    else if (c._ === 'messageAnimation') { kind = 'gif'; }
    else { kind = 'other'; }
    const sid = m.sender_id || {};
    const sender = sid.user_id || (sid.chat_id ? -sid.chat_id : 0);
    return {
      id: m.id, kind, text: (text || '').slice(0, 800),
      out: m.is_outgoing === true,
      date: m.date || 0,
      sender_id: sender,
      edited: m.edit_date ? true : false,
    };
  }
  function mediaLabel(kind) {
    return { photo: '🖼 عکس', voice: '🎙 ویس', file: '📎 فایل', sticker: '🎨 استیکر', gif: '🎞 GIF', other: 'پیام' }[kind] || 'پیام';
  }

  // account summary for the home page (chats count, unread)
  router.get('/me', async (req, res) => {
    const td = getTd();
    if (!td) return res.status(503).json({ error: 'tdlib not started' });
    if (td.state !== 'ready') return res.json({ ready: false, state: td.state });
    try {
      const chats = await td.invoke({ _: 'getChats', chat_list: { _: 'chatListMain' }, limit: 100 });
      let total_unread = 0;
      for (const id of (chats.chat_ids || []).slice(0, 50)) {
        try { const c = await td.invoke({ _: 'getChat', chat_id: id }); total_unread += c.unread_count || 0; } catch { /* skip */ }
      }
      res.json({ ready: true, me: td.me, chats: (chats.chat_ids || []).length, unread: total_unread });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // quick chat list (telegram-web-style sidebar)
  router.get('/chats', async (req, res) => {
    const td = getTd();
    if (!td) return res.status(503).json({ error: 'tdlib not started' });
    if (td.state !== 'ready') return res.status(409).json({ error: `tdlib not ready (state: ${td.state})` });
    try {
      const limit = Math.min(parseInt(req.query.limit || '30', 10) || 30, 100);
      const r = await td.invoke({ _: 'getChats', chat_list: { _: 'chatListMain' }, limit });
      const chats = [];
      for (const id of (r.chat_ids || [])) {
        try {
          const c = await td.invoke({ _: 'getChat', chat_id: id });
          const lm = c.last_message ? msgView(c.last_message) : null;
          chats.push({
            id: c.id, title: c.title || '—', unread: c.unread_count || 0,
            last: lm ? (lm.kind === 'text' ? lm.text : mediaLabel(lm.kind)) : '',
            last_ts: lm ? lm.date : 0,
          });
        } catch { /* skip */ }
      }
      res.json({ count: chats.length, chats });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // messages of one chat (reading works now — TDLib 1.8 uses `limit`)
  router.get('/chats/:id/messages', async (req, res) => {
    const td = getTd();
    if (!td) return res.status(503).json({ error: 'tdlib not started' });
    if (td.state !== 'ready') return res.status(409).json({ error: `tdlib not ready (state: ${td.state})` });
    try {
      const chatId = Number(req.params.id);
      const limit = Math.min(parseInt(req.query.limit || '40', 10) || 40, 100);
      const from = parseInt(req.query.from_message_id || '0', 10) || 0;
      const r = await td.invoke({
        _: 'getChatHistory', chat_id: chatId,
        from_message_id: from, offset: from ? 1 : 0, limit, only_local: false,
      });
      const msgs = (r.messages || []).map(msgView);
      // resolve sender names (TDLib caches; cheap)
      const names = {};
      for (const m of msgs) {
        const uid = m.sender_id;
        if (uid > 0 && names[uid] === undefined) {
          try { const u = await td.invoke({ _: 'getUser', user_id: uid }); names[uid] = [u.first_name, u.last_name].filter(Boolean).join(' '); }
          catch { names[uid] = ''; }
        }
      }
      res.json({ count: msgs.length, messages: msgs, names });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // send text message from the dashboard (used to test session liveness)
  router.post('/chats/:id/messages', async (req, res) => {
    const td = getTd();
    if (!td) return res.status(503).json({ error: 'tdlib not started' });
    if (td.state !== 'ready') return res.status(409).json({ error: `tdlib not ready (state: ${td.state})` });
    try {
      const text = String((req.body || {}).text || '').trim();
      if (!text) return res.status(400).json({ error: 'text required' });
      const m = await td.invoke({
        _: 'sendMessage', chat_id: Number(req.params.id),
        input_message_content: { _: 'inputMessageText', text: { _: 'formattedText', text } },
      });
      res.json(msgView(m));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ---- session backup: zip the TDLib database dir and stream it ----------------
  router.get('/backup', async (req, res) => {
    const dir = process.env.TDLIB_DIR || '/data/tdlib';
    auth.logActivity(req.ip, 'backup: session archive requested');
    // python3 zipfile streams a deterministic PK archive; no zip binary needed
    const { spawn } = require('child_process');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="tdlib-session-${Date.now()}.zip"`);
    const py = spawn('python3', ['-c',
      'import sys,os,zipfile; d=sys.argv[1]; z=zipfile.ZipFile(sys.stdout.buffer,"w",zipfile.ZIP_STORED); [z.write(os.path.join(r,f),os.path.relpath(os.path.join(r,f),d)) for r,_,fs in os.walk(d) for f in fs]; z.close()',
      dir]);
    py.stdout.pipe(res);
    let errbuf = '';
    py.stderr.on('data', d => { errbuf += d; if (errbuf.length > 500) errbuf = errbuf.slice(-500); });
    py.on('close', code => {
      if (code !== 0) console.error('[backup] zip failed rc=' + code, errbuf.slice(0, 300));
    });
    py.on('error', () => res.status(500).json({ error: 'backup failed: python3 unavailable' }));
  });

  // ---- admin sessions (who is logged into the dashboard) -----------------------
  router.get('/sessions', (req, res) => {
    res.json({ sessions: auth.listSessions() });
  });
  router.post('/sessions/revoke', (req, res) => {
    const { sid } = req.body || {};
    auth.destroySession(String(sid || ''));
    auth.logActivity(req.ip, `session revoked: ${String(sid || '').slice(0, 8)}…`);
    res.json({ ok: true });
  });
  router.post('/sessions/revoke-others', (req, res) => {
    auth.destroyOthers(req.adminSid);
    auth.logActivity(req.ip, 'all other admin sessions revoked');
    res.json({ ok: true });
  });

  // ---- tdlib control ----------------------------------------------------------
  router.post('/td/start', async (req, res) => {
    try {
      await startTd();
      auth.logActivity(req.ip, 'tdlib start');
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/td/restart', async (req, res) => {
    const td = getTd();
    if (!td) return res.status(409).json({ error: 'tdlib not started' });
    try {
      await td.restart();
      auth.logActivity(req.ip, 'tdlib restart');
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/td/logout', async (req, res) => {
    const td = getTd();
    if (!td) return res.status(409).json({ error: 'tdlib not started' });
    try {
      await td.logout();
      auth.logActivity(req.ip, 'tdlib LOGOUT (session wiped via logOut)');
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- login flow (phone / code / password / registration) -------------------
  router.post('/auth/phone', async (req, res) => {
    try {
      await getTd().submitPhone(String(req.body.phone || ''));
      auth.logActivity(req.ip, 'auth: phone submitted');
      res.json({ ok: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  router.post('/auth/code', async (req, res) => {
    try {
      await getTd().submitCode(String(req.body.code || ''));
      auth.logActivity(req.ip, 'auth: code submitted');
      res.json({ ok: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  router.post('/auth/password', async (req, res) => {
    try {
      await getTd().submitPassword(String(req.body.password || ''));
      auth.logActivity(req.ip, 'auth: 2FA password submitted');
      res.json({ ok: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  router.post('/auth/registration', async (req, res) => {
    try {
      await getTd().submitRegistration(String(req.body.first || ''), String(req.body.last || ''));
      auth.logActivity(req.ip, 'auth: registration submitted');
      res.json({ ok: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // ---- logs -------------------------------------------------------------------
  const logRing = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => { const l = a.join(' '); logRing.push({ ts: new Date().toISOString(), level: 'info', msg: l }); if (logRing.length > 1000) logRing.shift(); origLog(...a); };
  console.error = (...a) => { const l = a.join(' '); logRing.push({ ts: new Date().toISOString(), level: 'error', msg: l }); if (logRing.length > 1000) logRing.shift(); origErr(...a); };

  router.get('/logs', (req, res) => {
    const n = Math.min(parseInt(req.query.n || '200', 10) || 200, 1000);
    res.json({ logs: logRing.slice(-n) });
  });

  router.get('/activity', (req, res) => {
    res.json({ activity: auth.activityLog.slice(-200) });
  });

  return router;
};
