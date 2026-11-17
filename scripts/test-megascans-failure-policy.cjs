const test = require('node:test');
const assert = require('node:assert/strict');
const { isolatedAssetFailure } = require('./lib/megascans-failure-policy.cjs');

function probeClient({ apiStatus = 200, cdnStatus = 206 } = {}) {
  const calls = [], responses = [];
  return { token: 'test-private-token', calls, responses, fetch: async (url, options) => {
    const endpoint = new globalThis.URL(url).pathname;
    calls.push({ endpoint, range: options.headers?.Range });
    let response;
    if (endpoint.startsWith('/v1/assets/')) response = new globalThis.Response(JSON.stringify({ id: endpoint.split('/').at(-1), type: 'surface', maps: [] }), { status: apiStatus });
    else if (endpoint === '/v1/downloads') response = new globalThis.Response(JSON.stringify([{ uri: 'https://cdn.quixel.com/healthy/color.png?signed=private', contentLength: 3 }]), { status: apiStatus });
    else response = new globalThis.Response('x', { status: cdnStatus });
    responses.push(response);
    return response;
  } };
}
const options = (client, error) => ({ client, id: 'broken', error, controlIds: new Set(['healthy']), resolution: 4096 });

test('a healthy different asset distinguishes a single bad download plan from an outage', async () => {
  const client = probeClient();
  assert.equal(await isolatedAssetFailure(options(client, { source: 'quixel', status: 500 })), true);
  assert.deepEqual(client.calls.map(call => call.endpoint), ['/v1/assets/healthy', '/v1/downloads']);
  for (const apiStatus of [401, 403, 429, 500, 503]) {
    assert.equal(await isolatedAssetFailure(options(probeClient({ apiStatus }), { source: 'quixel', status: 500 })), false);
  }
});

test('CDN errors also require a working bounded Range read and cancel its body', async () => {
  const client = probeClient();
  assert.equal(await isolatedAssetFailure(options(client, { source: 'cdn', status: 403 })), true);
  assert.equal(client.calls.at(-1).range, 'bytes=0-0');
  assert.equal((await client.responses.at(-1).body.getReader().read()).done, true);
  assert.equal(await isolatedAssetFailure(options(probeClient({ cdnStatus: 503 }), { source: 'cdn', status: 503 })), false);
});

test('no control, network errors, rate limits, auth failures and unknown sources never defer', async () => {
  const client = probeClient();
  for (const error of [{ source: 'quixel', status: 429 }, { source: 'quixel', code: 'QUIXEL_AUTH', status: 403 }, { source: 'cdn', code: 'ECONNRESET' }, { status: 500 }]) {
    assert.equal(await isolatedAssetFailure(options(client, error)), false);
  }
  assert.equal(await isolatedAssetFailure({ ...options(client, { source: 'quixel', status: 500 }), controlIds: new Set(['broken']) }), false);
  assert.equal(client.calls.length, 0);
  client.fetch = async () => { throw new TypeError('fetch failed'); };
  assert.equal(await isolatedAssetFailure(options(client, { source: 'quixel', status: 500 })), false);
});

test('a bad control falls back to one other completed asset, and pause prevents probes', async () => {
  const client = probeClient(), fetch = client.fetch;
  client.fetch = async (url, opts) => url.endsWith('/missing') ? new globalThis.Response('{}', { status: 404 }) : fetch(url, opts);
  assert.equal(await isolatedAssetFailure({ ...options(client, { source: 'quixel', status: 500 }), controlIds: new Set(['healthy', 'missing']) }), true);
  await assert.rejects(isolatedAssetFailure({ ...options(client, { source: 'quixel', status: 500 }), shouldStop: async () => true }), error => error.code === 'MEGASCANS_PAUSED');
});
