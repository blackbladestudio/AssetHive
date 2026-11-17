const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { FabSession, listingApiUrl, readListingResponse } = require('./lib/fab-session.cjs');
const { FabMegascans } = require('./lib/fab-megascans.cjs');
const { ImportWorker } = require('./lib/megascans-import-worker.cjs');

const id = '58fbbb20-9737-4af2-805e-1cb3e6399c75';
const url = `https://www.fab.com/i/listings/${id}`;
const denied = () => new globalThis.Response(JSON.stringify({ detail: 'Mature content hidden for user' }), { status: 403 });

test('authenticated session is restricted to exact Fab listing GET endpoints', async () => {
  assert.equal(listingApiUrl(url), url);
  assert.equal(listingApiUrl(`${url}/asset-formats/fbx/files/${id}/download-info`), `${url}/asset-formats/fbx/files/${id}/download-info`);
  for (const value of [url.replace('www.fab.com', 'www.fab.com.evil.test'), url.replace('https:', 'http:'),
    url.replace('www.fab.com', 'me:secret@www.fab.com'), `${url}?override_mature_preference=1`, `${url}#fragment`,
    `${url}/purchase`, 'https://www.fab.com/i/users/me', 'https://media.fab.com/file.zip']) {
    assert.throws(() => listingApiUrl(value), /仅允许/);
  }
  let calls = 0;
  const result = await readListingResponse({ fetch: async (input, options) => {
    calls++; assert.equal(input, url); assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'include'); assert.equal(options.redirect, 'error');
    return new globalThis.Response('{"uid":"test"}', { status: 200 });
  } }, url);
  assert.equal(calls, 1); assert.equal(result.body, '{"uid":"test"}');
  await assert.rejects(readListingResponse({ fetch: () => { throw new Error('should not fetch'); } }, 'https://elsewhere.test/'), /仅允许/);
  await assert.rejects(readListingResponse({ fetch: async () => new globalThis.Response('x'.repeat(8 * 1024 * 1024 + 1)) }, url), /大小限制/);
});

test('only an explicit mature denial uses a user-prepared session; account restrictions still fail', async () => {
  let requests = 0, closes = 0;
  const sessionClient = { available: async () => true, fetch: async () => { requests++; return new globalThis.Response('{"uid":"ok"}'); }, close: async () => { closes++; } };
  const client = new FabMegascans('/unused', { fetchImpl: denied, sessionClient });
  assert.deepEqual(await client.request(`/i/listings/${id}`), { uid: 'ok' });
  assert.equal(requests, 1);
  client.fetch = async () => new globalThis.Response('{"detail":"Permission denied"}', { status: 403 });
  await assert.rejects(client.request(`/i/listings/${id}`), error => error.status === 403);
  assert.equal(requests, 1);
  client.fetch = denied; sessionClient.available = async () => false;
  await assert.rejects(client.request(`/i/listings/${id}`), error => error.status === 403);
  assert.equal(requests, 1);
  sessionClient.available = async () => true; sessionClient.fetch = denied;
  await assert.rejects(client.request(`/i/listings/${id}`), error => error.status === 403);
  await client.close(); assert.equal(closes, 1);
});

test('explicit user skip policy prevents opening an available mature-content session', async t => {
  const parent = path.resolve(__dirname, '../.cache/fab-session-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'skip-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(parent));
    await fs.rm(root, { recursive: true });
  });
  await fs.writeFile(path.join(root, 'mature-exclusions.json'), JSON.stringify({ action: 'skip' }));
  const client = new FabMegascans(root, { fetchImpl: denied, sessionClient: {
    available: () => { throw new Error('should not check login'); }, fetch: () => { throw new Error('should not fetch'); }, close: async () => {}
  } });
  await assert.rejects(client.request(`/i/listings/${id}`), error => error.code === 'FAB_MATURE_SKIPPED' && error.assetType === 'mature');
});

test('actual Electron session worker stays hidden, returns JSON over IPC and shuts down', { timeout: 45000 }, async t => {
  const parent = path.resolve(__dirname, '../.cache/fab-session-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'run-'));
  const bootstrap = path.join(root, 'fixture.cjs');
  await fs.writeFile(bootstrap, `
const {app,session}=require('electron');
app.on('browser-window-created',()=>app.exit(9));
require(${JSON.stringify(path.join(__dirname, 'fab-session-electron.cjs'))});
app.whenReady().then(()=>session.defaultSession.protocol.handle('https',async request=>{
  const cookies=await session.defaultSession.cookies.get({url:'https://www.fab.com',name:'fixture'});
  const persisted=cookies.some(cookie=>cookie.value==='private-fixture-value');
  if(!persisted){
    await session.defaultSession.cookies.set({url:'https://www.fab.com',name:'fixture',value:'private-fixture-value',expirationDate:Date.now()/1000+3600});
    await session.defaultSession.cookies.flushStore();
  }
  return new Response(JSON.stringify({uid:new URL(request.url).pathname.split('/')[3],fixture:true,persisted}),{headers:{'content-type':'application/json'}});
}));
`);
  const worker = new ImportWorker({ cacheRoot: path.join(root, 'fab-session'), entry: bootstrap });
  const client = new FabSession(root, { worker });
  let next;
  t.after(async () => {
    await client.close();
    if (next) await next.close();
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(parent));
    await fs.rm(root, { recursive: true, maxRetries: 8, retryDelay: 200 });
  });
  assert.equal(await client.available(), false);
  await fs.mkdir(client.root, { recursive: true });
  await fs.writeFile(path.join(client.root, 'status.json'), '{"ready":true}');
  assert.equal(await client.available(), true);
  const response = await client.fetch(url);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { uid: id, fixture: true, persisted: false });
  await assert.rejects(client.fetch('https://other.test/'), /仅允许/);
  await client.close(); assert.equal(worker.proc.exitCode, 0);
  next = new FabSession(root, { worker: new ImportWorker({ cacheRoot: path.join(root, 'fab-session'), entry: bootstrap }) });
  assert.deepEqual(await (await next.fetch(url)).json(), { uid: id, fixture: true, persisted: true });
});
