// Smoke test: load libtdjson, create client, observe first authorization state.
const { getTdjson } = require('prebuilt-tdlib');
const tdl = require('tdl');
tdl.configure({ tdjson: getTdjson() });

(async () => {
  const client = tdl.createClient({
    apiId: 1, apiHash: 'x',
    databaseDirectory: '/tmp/tgclient/td-smoke',
    filesDirectory: '/tmp/tgclient/fd-smoke',
    skipUpdateUpdates: false,
  });
  client.on('error', e => console.error('client error:', e && e.message));
  client.on('update', u => {
    if (u._ === 'updateAuthorizationState') {
      console.log('AUTH STATE:', u.authorization_state._);
      client.close().then(() => process.exit(0));
    }
  });
  setTimeout(() => { console.error('TIMEOUT no auth state in 30s'); process.exit(2); }, 30000);
})().catch(e => { console.error('ERR', e); process.exit(1); });
