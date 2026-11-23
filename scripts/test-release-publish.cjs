const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Buffer } = require('node:buffer');
const { execFileSync } = require('node:child_process');
const { createReleasePlan, publishPlan } = require('./publish_release.js');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'assethive-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  fs.mkdirSync(path.join(source, 'electron'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), '{"version":"2.3.5"}\n');
  fs.writeFileSync(path.join(source, 'electron/main.js'), 'module.exports = "animation";\n');
  const git = args => execFileSync('git', args, { cwd: source, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init']); git(['config', 'user.name', 'ReleaseFixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  git(['add', '.']); git(['commit', '-m', 'fixture']); git(['tag', 'v2.3.5']);
  for (const name of ['AssetHive-2.3.5-Windows.msi', 'AssetHive-2.3.5-Windows-setup.exe', 'AssetHive-2.3.5-setup-win64.exe']) {
    const bytes = Buffer.alloc(1048576, 23);
    fs.writeFileSync(path.join(directory, name), bytes);
    fs.writeFileSync(path.join(directory, name + '.sha256'), `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
  }
  return directory;
}

function fixturePlan(t) {
  const directory = fixture(t);
  return createReleasePlan('2.3.5', directory, path.join(directory, 'source'));
}

test('release plan targets the desktop updater repository with all three installers and checksums', async t => {
  const plan = await fixturePlan(t);
  assert.equal(plan.repository, 'blackbladestudio/AssetHive');
  assert.equal(plan.tag, 'v2.3.5');
  assert.equal(plan.assets.length, 6);
});

test('missing installers, changed bytes and wrong-version artifacts fail before publishing', async t => {
  const directory = fixture(t);
  await assert.rejects(createReleasePlan('2.3.6', directory), /ENOENT/);
  const file = path.join(directory, 'AssetHive-2.3.5-Windows.msi');
  fs.appendFileSync(file, 'changed');
  await assert.rejects(createReleasePlan('2.3.5', directory, path.join(directory, 'source')), /SHA-256/);
  fs.unlinkSync(file);
  await assert.rejects(createReleasePlan('2.3.5', directory, path.join(directory, 'source')), /ENOENT/);
});

function mockGithub(t, plan, { uploadFails = false, existingRelease = false, missingTag = false, sourceVersion = '2.3.5', staleSource = false } = {}) {
  const calls = [];
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url, options) => {
    const call = { url, method: options.method, body: typeof options.body === 'string' ? JSON.parse(options.body) : null };
    calls.push(call);
    let status = 200, data = {};
    if (url.includes('/releases/tags/')) { status = existingRelease ? 200 : 404; data = { id: 5 }; }
    else if (url.includes('/git/refs/tags/') || url.includes('/git/ref/tags/')) { status = missingTag ? 404 : 200; data = { object: { type: 'commit', sha: '1'.repeat(40) } }; }
    else if (url.includes('/contents/package.json')) data = { encoding: 'base64', content: Buffer.from(JSON.stringify({ version: sourceVersion })).toString('base64') };
    else if (url.includes('/git/trees/')) data = { tree: Object.entries(plan.source?.files || {}).map(([name, sha]) => ({ path: name, type: 'blob', sha: staleSource && name === 'electron/main.js' ? '0'.repeat(40) : sha })) };
    else if (url.includes('/branches/')) data = { commit: { sha: '1'.repeat(40) } };
    else if (url.includes('/git/refs') && options.method === 'POST') status = 201;
    else if (url.includes('uploads.github.com')) status = uploadFails ? 500 : 201;
    else if (options.method === 'POST' && url.endsWith('/releases')) { status = 201; data = { id: 7 }; }
    else if (options.method === 'PATCH') data = { html_url: 'https://github.com/blackbladestudio/AssetHive/releases/tag/v2.3.5' };
    else data = { default_branch: 'main' };
    return { status, text: async () => JSON.stringify(data) };
  };
  return calls;
}

test('release becomes public only after every attachment upload succeeds', async t => {
  const plan = await fixturePlan(t);
  const calls = mockGithub(t, plan);
  await publishPlan(plan, 'fixture-token', '动画导入与发送');
  const create = calls.find(call => call.method === 'POST' && call.url.endsWith('/releases'));
  assert.equal(create.body.draft, true);
  assert.equal(calls.filter(call => call.url.includes('uploads.github.com')).length, 6);
  assert.deepEqual(calls.at(-1).body, { draft: false });
  assert.equal(calls.at(-1).method, 'PATCH');
  assert.ok(calls.every(call => call.method !== 'DELETE'));
});

test('upload failure leaves the release as a draft and never publishes', async t => {
  const plan = await fixturePlan(t);
  const calls = mockGithub(t, plan, { uploadFails: true });
  await assert.rejects(publishPlan(plan, 'fixture-token', '动画导入与发送'), /上传附件失败/);
  assert.equal(calls.some(call => call.method === 'PATCH'), false);
  assert.equal(calls.some(call => call.method === 'DELETE'), false);
});

test('an existing release is preserved without any GitHub mutation', async t => {
  const plan = await fixturePlan(t);
  const calls = mockGithub(t, plan, { existingRelease: true });
  await assert.rejects(publishPlan(plan, 'fixture-token', '动画导入与发送'), /已存在/);
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('a new release tag cannot be created on a remote branch with an older source version', async t => {
  const plan = await fixturePlan(t);
  const calls = mockGithub(t, plan, { missingTag: true, sourceVersion: '2.3.4' });
  await assert.rejects(publishPlan(plan, 'fixture-token', '动画导入与发送'), /源码版本/);
  assert.ok(calls.every(call => call.method === 'GET'), 'stale source must fail before tag, draft or asset writes');
});

test('matching version numbers cannot hide stale application code at an existing tag', async t => {
  const plan = await fixturePlan(t);
  const calls = mockGithub(t, plan, { staleSource: true });
  await assert.rejects(publishPlan(plan, 'fixture-token', '动画导入与发送'), /electron\/main.js/);
  assert.ok(calls.every(call => call.method === 'GET'));
});
