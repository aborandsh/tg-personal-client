// src/auth.js — API token auth, admin session auth, login rate limiting.
const crypto = require('crypto');

// ---- constant-time compare ------------------------------------------------
function safeEq(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // still burn comparable time
    crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// ---- API token ------------------------------------------------------------
function requireApiToken(req, res, next) {
  const token = process.env.CLIENT_TOKEN;
  if (!token) {
    return res.status(503).json({ error: 'server misconfigured: CLIENT_TOKEN not set' });
  }
  const got = req.get('x-api-token') || (req.get('authorization') || '').replace(/^Bearer /i, '');
  if (!got || !safeEq(got, token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ---- admin sessions -------------------------------------------------------
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
// store only a sha256 of ADMIN_PASSWORD; fallback hash of 'changeme' with warning
const ADMIN_PASS_HASH = process.env.ADMIN_PASSWORD_HASH ||
  crypto.createHash('sha256').update('changeme').digest('hex');

const sessions = new Map(); // sid -> { expires }
const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8h

function newSession() {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { expires: Date.now() + SESSION_TTL_MS });
  return sid;
}

function checkSession(sid) {
  const s = sid && sessions.get(sid);
  if (!s) return false;
  if (Date.now() > s.expires) { sessions.delete(sid); return false; }
  return true;
}

function destroySession(sid) { sessions.delete(sid); }

// login rate limiting: max 5 attempts / 10 min per IP
const attempts = new Map(); // ip -> [timestamps]
function rateLimitLogin(ip) {
  const now = Date.now();
  const arr = (attempts.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  arr.push(now);
  attempts.set(ip, arr);
  return arr.length <= 5;
}

function requireAdmin(req, res, next) {
  const sid = req.get('x-admin-session') || (req.query.admin_sid || '');
  if (!checkSession(sid)) return res.status(401).json({ error: 'admin unauthorized' });
  req.adminSid = sid;
  next();
}

// tolerate copy/paste artifacts: surrounding whitespace, zero-width chars, and
// mobile keyboards capitalizing the username. The password itself stays exact
// apart from surrounding whitespace.
function normalize(s) {
  return String(s == null ? '' : s)
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '') // zero-width / bidi marks
    .trim();
}

function verifyAdminCreds(user, pass) {
  const u = normalize(user).toLowerCase();
  const p = normalize(pass);
  return safeEq(ADMIN_USER.toLowerCase(), u) &&
    safeEq(ADMIN_PASS_HASH, crypto.createHash('sha256').update(p).digest('hex'));
}

// ---- activity log (in-memory ring, survives until restart) ----------------
const activityLog = [];
function logActivity(ip, action) {
  activityLog.push({ ts: new Date().toISOString(), ip, action });
  if (activityLog.length > 500) activityLog.shift();
}

module.exports = {
  requireApiToken, requireAdmin, newSession, checkSession, destroySession,
  rateLimitLogin, verifyAdminCreds, logActivity, activityLog, safeEq,
};
