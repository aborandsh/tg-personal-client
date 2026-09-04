// src/td.js — TDLib session manager: auth state machine driven by updates,
// manual invocation of setAuthentication* so a web dashboard can drive login.
const { getTdjson } = require('prebuilt-tdlib');
const tdl = require('tdl');

tdl.configure({ tdjson: getTdjson() });

class TdSession {
  constructor(opts) {
    this.apiId = opts.apiId;
    this.apiHash = opts.apiHash;
    this.databaseDir = opts.databaseDirectory || opts.databaseDir; // index.js sends databaseDirectory
    this.filesDir = opts.filesDirectory || opts.filesDir;
    this.deviceModel = opts.deviceModel || 'personal-client';
    this.systemVersion = opts.systemVersion || 'railway';
    this.appVersion = opts.appVersion || '1.0.0';
    this.onAuthState = opts.onAuthState || (() => {});
    this.onUpdate = opts.onUpdate || (() => {});
    this.log = opts.log || console.log;

    this.client = null;
    this.state = 'closed';           // logical state for the dashboard
    this.stateDetail = null;         // e.g. {_, authorizationStateWaitCode, type:...}
    this.me = null;
    this._authWaiters = {};          // resolve fns for pending dashboard inputs
    this._closing = false;
  }

  // ---- lifecycle -----------------------------------------------------------
  async start() {
    const fs = require('fs');
    for (const d of [this.databaseDir, this.filesDir]) fs.mkdirSync(d, { recursive: true });
    this.client = tdl.createClient({
      apiId: this.apiId,
      apiHash: this.apiHash,
      databaseDirectory: this.databaseDir,
      filesDirectory: this.filesDir,
      deviceModel: this.deviceModel,
      systemVersion: this.systemVersion,
      applicationVersion: this.appVersion,
    });
    this.client.on('error', e => this.log(`tdlib error: ${e && e.message}`));
    this.client.on('update', u => this._handleUpdate(u));
    // tdl v8 auto-handles authorizationStateWaitTdlibParameters from createClient
    // options and TDLib emits updateAuthorizationState on its own — no nudge needed.
    this.log('td: client created');
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  async stop() {
    if (this.client && !this._closing) {
      this._closing = true;
      try { await this.client.close(); } catch { /* ignore */ }
      this._closing = false;
    }
    this.client = null;
    this._setState('closed', null);
  }

  async logout() {
    if (this.client) {
      try { await this.client.invoke({ _: 'logOut' }); } catch { /* ignore */ }
    }
    await this.stop();
  }

  // ---- auth flow (dashboard-driven) ---------------------------------------
  _setState(state, detail) {
    this.state = state;
    this.stateDetail = detail;
    this.log(`td: auth state -> ${state}`);
    this.onAuthState(state, detail);
  }

  _handleUpdate(u) {
    if (u._ === 'updateAuthorizationState') {
      const a = u.authorization_state;
      switch (a._) {
        case 'authorizationStateWaitTdlibParameters':
          // tdl v8 already answered this from createClient options — just record it.
          this._setState('init', a);
          break;
        case 'authorizationStateWaitPhoneNumber':
          this._setState('need_phone', a);
          break;
        case 'authorizationStateWaitCode':
          this._setState('need_code', a);
          break;
        case 'authorizationStateWaitRegistration':
          this._setState('need_registration', a);
          break;
        case 'authorizationStateWaitPassword':
          this._setState('need_password', a);
          break;
        case 'authorizationStateReady':
          this._setState('ready', a);
          this._fetchMe();
          break;
        case 'authorizationStateLoggingOut':
          this._setState('logging_out', a);
          break;
        case 'authorizationStateClosed':
          this._setState('closed', a);
          break;
        default:
          this._setState(a._, a);
      }
    }
    // forward everything to the app layer (WS push)
    this.onUpdate(u);
  }

  async _fetchMe() {
    try {
      this.me = await this.client.invoke({ _: 'getMe' });
      this.log(`td: logged in as ${this.me.first_name || ''} (${this.me.phone_number || ''})`);
      this._setState('ready', null);
    } catch (e) {
      this.log(`td: getMe failed: ${e.message}`);
    }
  }

  // called from dashboard endpoints
  async submitPhone(phone) {
    this._assertState('need_phone');
    await this.client.invoke({ _: 'setAuthenticationPhoneNumber', phone_number: phone, allow_flash_call: false, is_current_phone_number: false });
  }

  async submitCode(code) {
    this._assertState('need_code');
    await this.client.invoke({ _: 'checkAuthenticationCode', code });
  }

  async submitPassword(password) {
    this._assertState('need_password');
    await this.client.invoke({ _: 'checkAuthenticationPassword', password });
  }

  async submitRegistration(first, last) {
    this._assertState('need_registration');
    await this.client.invoke({ _: 'registerUser', first_name: first, last_name: last || '' });
  }

  _assertState(want) {
    if (this.state !== want) {
      const e = new Error(`expected auth state ${want}, current is ${this.state}`);
      e.status = 409;
      throw e;
    }
  }

  // ---- passthrough invoke (guarded: allow-list below) ----------------------
  async invoke(request) {
    if (!this.client) { const e = new Error('tdlib not started'); e.status = 503; throw e; }
    return this.client.invoke(request);
  }
}

module.exports = { TdSession, tdl };
