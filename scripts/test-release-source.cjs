const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { Buffer } = require('node:buffer');
const { createHash } = require('node:crypto');
const { getSourceProof, verifyLocalSource } = require('./release-source.cjs');
const { checkPublishedRelease } = require('./verify-release-source.cjs');

test('source fingerprints use the immutable tag and accept Windows text checkout without changing binary bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assethive-source-proof-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init']); git(['config', 'user.name', 'ReleaseFixture']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'core.autocrlf', 'true']);
  for (const [relative, bytes] of Object.entries({
    'package.json': Buffer.from('{"version":"2.3.5"}\r\n'),
    'electron/main.js': Buffer.from('module.exports = "animation";\r\n'),
    'shared/options.d.mts': Buffer.from('export type Option = string;\r\n'),
    'updater/Helper.cs': Buffer.from('class Helper {}\r\n'),
    'src/ui/icon.svg': Buffer.from('<svg/>\r\n'),
    'images/test.png': Buffer.from([137, 80, 78, 71, 13, 10, 0, 0])
  })) {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
  git(['add', '.']); git(['commit', '-m', 'fixture']); git(['tag', 'v2.3.5']);
  const proof = getSourceProof('2.3.5', root);
  assert.equal(verifyLocalSource(root, proof, 'v2.3.5').inputFiles, 6);
  fs.writeFileSync(path.join(root, 'electron/main.js'), 'module.exports = "old";\r\n');
  assert.throws(() => verifyLocalSource(root, proof, 'v2.3.5'), /electron\/main.js/);
  assert.throws(() => verifyLocalSource(root, proof, 'v2.3.6'), /标签/);
});

function publishedFixture() {
  const bodies = new Map();
  const assets = [];
  for (const suffix of ['Windows.msi', 'Windows-setup.exe', 'setup-win64.exe']) {
    const name = 'AssetHive-2.3.5-' + suffix, hash = '1'.repeat(64);
    const body = `${hash}  ${name}\n`;
    const url = 'https://github.com/blackbladestudio/AssetHive/releases/download/v2.3.5/' + name + '.sha256';
    bodies.set(url, body);
    assets.push({ name, state: 'uploaded', size: 1048576, digest: 'sha256:' + hash });
    assets.push({ name: name + '.sha256', state: 'uploaded', size: body.length, digest: 'sha256:' + createHash('sha256').update(body).digest('hex'), browser_download_url: url });
  }
  return { release: { tag_name: 'v2.3.5', draft: false, prerelease: false, body: '动画更新', assets, html_url: 'https://github.com/blackbladestudio/AssetHive/releases/tag/v2.3.5' }, bodies };
}

test('existing published release is validated through GET only and marked to skip all publishing', async () => {
  const { release, bodies } = publishedFixture(), calls = [];
  release.body = '动画更新\n规范检查';
  const fetcher = async (url, options) => {
    calls.push(options.method || 'GET');
    return url.includes('api.github.com') ? { status: 200, json: async () => release } : { status: 200, text: async () => bodies.get(url) };
  };
  const result = await checkPublishedRelease('blackbladestudio/AssetHive', { version: '2.3.5', sourceTag: 'v2.3.5' }, '动画更新\r\n规范检查\r\n', fetcher);
  assert.equal(result.publishNeeded, false);
  assert.deepEqual(calls, ['GET', 'GET', 'GET', 'GET']);
  await assert.rejects(checkPublishedRelease('blackbladestudio/AssetHive', { version: '2.3.5', sourceTag: 'v2.3.5' }, '动画更新\r\n其他内容', fetcher), /说明/);
});

test('missing or corrupted published assets fail validation rather than being silently replaced', async () => {
  const { release, bodies } = publishedFixture();
  const fetcher = async (url) => url.includes('api.github.com') ? { status: 200, json: async () => release } : { status: 200, text: async () => 'wrong checksum' };
  await assert.rejects(checkPublishedRelease('blackbladestudio/AssetHive', { version: '2.3.5', sourceTag: 'v2.3.5' }, '动画更新', fetcher), /校验和/);
  release.assets.pop();
  await assert.rejects(checkPublishedRelease('blackbladestudio/AssetHive', { version: '2.3.5', sourceTag: 'v2.3.5' }, '动画更新', fetcher), /缺失/);
  assert.equal(bodies.size, 3);
});

test('unpublished version continues to the normal build path without any mutation', async () => {
  const result = await checkPublishedRelease('blackbladestudio/AssetHive', { version: '2.3.5', sourceTag: 'v2.3.5' }, '动画更新', async () => ({ status: 404 }));
  assert.equal(result.publishNeeded, true);
});
