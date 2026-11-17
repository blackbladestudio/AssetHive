const test = require('node:test');
const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { recover, transient } = require('./lib/megascans-recovery.cjs');
const { QuixelClient } = require('./lib/megascans-transfer.cjs');
const { usable } = require('./lib/quixel-auth-state.cjs');

test('timeouts and 5xx retry with bounded backoff, then return the successful result', async () => {
  let calls = 0, waited = 0;
  const states = [];
  const result = await recover(async () => {
    if (++calls < 10) throw Object.assign(new Error('offline'), { status: 503 });
    return 'ok';
  }, { sleep: async ms => { waited += ms; }, onState: async state => states.push(state) });
  assert.equal(result, 'ok'); assert.equal(calls, 10); assert.ok(waited > 120000);
  assert.equal(states.length, 9); assert.equal(states.at(-1).retryAttempt, 9);
  assert.ok(states.every(state => state.stage === 'retrying'));
  assert.equal(transient(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })), true);
  assert.equal(transient(Object.assign(new Error('disk full'), { code: 'ENOSPC' })), false);
});

test('API authentication failure renews the token and retries the original request', async () => {
  let refreshes = 0;
  const client = new QuixelClient('old-private-token', { fetchImpl: async (_url, options) => new globalThis.Response(
    options.headers.Authorization === 'Bearer new-private-token' ? '[{"assetID":"one"}]' : '{}',
    { status: options.headers.Authorization === 'Bearer new-private-token' ? 200 : 401 }) });
  const states = [];
  assert.deepEqual(await recover(() => client.acquired(), { refreshAuth: async () => { refreshes++; client.token = 'new-private-token'; }, onState: async s => states.push(s) }), ['one']);
  assert.equal(refreshes, 1); assert.equal(states[0].stage, 'reauthenticating');
  assert.ok(!JSON.stringify(states).includes('private-token'));
});

test('a genuinely forbidden API asset stops after one session renewal, without a login loop', async () => {
  let requests = 0, refreshes = 0;
  const client = new QuixelClient('private', { fetchImpl: async () => { requests++; return new globalThis.Response('{}', { status: 403 }); } });
  await assert.rejects(recover(() => client.metadata('one'), { refreshAuth: async () => { refreshes++; } }), error => error.code === 'QUIXEL_AUTH' && error.status === 403);
  assert.equal(requests, 2); assert.equal(refreshes, 1);
});

test('CDN 403 refreshes the signed plan once, without treating it as expired API login', async () => {
  let attempts = 0, refreshes = 0;
  const result = await recover(async () => {
    if (++attempts === 1) throw Object.assign(new Error('signed link expired'), { status: 403 });
    return 'new signed plan succeeded';
  }, { refreshAuth: async () => { refreshes++; } });
  assert.equal(result, 'new signed plan succeeded'); assert.equal(attempts, 2); assert.equal(refreshes, 0);
});

test('pause interrupts offline backoff; corrupt content is never retried', async () => {
  let stop = false, attempts = 0;
  await assert.rejects(recover(async () => { attempts++; throw Object.assign(new Error('offline'), { code: 'ETIMEDOUT' }); }, {
    shouldStop: async () => stop, sleep: async () => { stop = true; }
  }), error => error.code === 'MEGASCANS_PAUSED');
  assert.equal(attempts, 1);
  let sleeps = 0;
  await assert.rejects(recover(async () => { throw new Error('文件校验失败'); }, { sleep: async () => { sleeps++; } }), /校验失败/);
  assert.equal(sleeps, 0);
});

test('API retry exhaustion preserves transient classification for the recovery loop', async () => {
  const client = new QuixelClient('private', { sleep: async () => {}, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(client.acquired(), error => transient(error) && !error.message.includes('private'));
});

test('login accepts fresh session tokens, rejects expired and explicitly rejected saved credentials', () => {
  const token = exp => `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
  const now = 1000000;
  assert.equal(usable({ token: token(2000) }, { now }), true);
  assert.equal(usable({ token: token(1000) }, { now }), false);
  assert.equal(usable({ token: 'opaque-token' }, { rejectedToken: 'opaque-token', now }), false);
  assert.equal(usable({ token: 'new-token' }, { rejectedToken: 'opaque-token', now }), true);
});

test('isolated HTTP 500 is deferred after three recovery rounds, with a bounded record', async () => {
  let attempts = 0, probes = 0;
  await assert.rejects(recover(async () => { attempts++; throw Object.assign(new Error('plan HTTP 500'), { status: 500, source: 'quixel' }); }, {
    sleep: async () => {}, shouldDefer: async () => { probes++; return true; }
  }), error => error.code === 'MEGASCANS_DEFER_ASSET' && error.status === 500 && error.retryAttempts === 3);
  assert.equal(attempts, 3); assert.equal(probes, 1);
});

test('global HTTP failures keep retrying, while offline/auth/rate limits never ask to defer', async () => {
  let attempts = 0, probes = 0;
  assert.equal(await recover(async () => {
    if (++attempts <= 4) throw Object.assign(new Error('service unavailable'), { status: 503 });
    return 'recovered';
  }, { sleep: async () => {}, shouldDefer: async () => { probes++; return false; } }), 'recovered');
  assert.equal(probes, 2);
  for (const fields of [{ code: 'ECONNRESET' }, { status: 429 }, { status: 401, code: 'QUIXEL_AUTH' }]) {
    let calls = 0;
    const operation = recover(async () => {
      if (++calls === 1) throw Object.assign(new Error('global'), fields);
      return 'ok';
    }, { sleep: async () => {}, shouldDefer: async () => { throw new Error('must not probe'); } });
    if (fields.code === 'QUIXEL_AUTH') await assert.rejects(operation, /global/);
    else assert.equal(await operation, 'ok');
  }
});

test('CDN denial is deferred only after a new signed plan and honors pause during diagnosis', async () => {
  let calls = 0, probes = 0;
  await assert.rejects(recover(async () => { calls++; throw Object.assign(new Error('file denied'), { source: 'cdn', status: 403, file: 'mesh_high.fbx' }); }, {
    shouldDefer: async () => { probes++; return true; }
  }), error => error.code === 'MEGASCANS_DEFER_ASSET' && error.retryAttempts === 2 && error.file === 'mesh_high.fbx');
  assert.equal(calls, 2); assert.equal(probes, 1);
  let stop = false;
  await assert.rejects(recover(async () => { throw Object.assign(new Error('gone'), { status: 404 }); }, {
    shouldStop: async () => stop, shouldDefer: async () => { stop = true; return true; }
  }), error => error.code === 'MEGASCANS_PAUSED');
});

test('isolated Fab denial retains its public API endpoint for later diagnosis', async () => {
  const endpoint = '/i/listings/asset';
  await assert.rejects(recover(async () => {
    throw Object.assign(new Error('Fab HTTP 403'), { source: 'fab', status: 403, endpoint });
  }, { shouldDefer: async () => true }), error => error.code === 'MEGASCANS_DEFER_ASSET'
    && error.source === 'fab' && error.endpoint === endpoint && error.retryAttempts === 2);
});
