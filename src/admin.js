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
      wsClients: broadcastWS ? undefined : undefined, // filled by index? keep simple
      process: {
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        rssMB: +(mem.rss / 1048576).toFixed(1),
        heapMB: +(mem.heapUsed / 1048576).toFixed(1),
      },
    });
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
