const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { verifyLocalSource } = require('./release-source.cjs');

function validatePublishedRelease(release, version) {
  if (release.tag_name !== 'v' + version || release.draft || release.prerelease) throw new Error('已发布版本的标签或状态不正确');
  const names = ['Windows.msi', 'Windows-setup.exe', 'setup-win64.exe'].map(suffix => `AssetHive-${version}-${suffix}`);
  const assets = new Map(release.assets.map(asset => [asset.name, asset]));
  for (const name of names) {
    const installer = assets.get(name), checksum = assets.get(name + '.sha256');
    if (!installer || !checksum || installer.state !== 'uploaded' || checksum.state !== 'uploaded'
      || installer.size < 1048576 || !/^sha256:[a-f0-9]{64}$/i.test(installer.digest || '')) throw new Error(`已发布附件缺失或不完整：${name}`);
  }
  return names.map(name => ({ installer: assets.get(name), checksum: assets.get(name + '.sha256') }));
}

async function checkPublishedRelease(repository, proof, notes, fetcher = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('仓库名称无效');
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const headers = { 'User-Agent': 'AssetHive-release-validation', Accept: 'application/vnd.github+json', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
  const response = await fetcher(`https://api.github.com/repos/${repository}/releases/tags/${proof.sourceTag}`, { headers });
  if (response.status === 404) return { publishNeeded: true };
  if (response.status !== 200) throw new Error(`无法检查已发布版本: HTTP ${response.status}`);
  const release = await response.json();
  const pairs = validatePublishedRelease(release, proof.version);
  if (release.body.trim() !== notes.trim()) throw new Error('已发布说明与版本源码中的说明不一致');
  for (const { installer, checksum } of pairs) {
    const downloaded = await fetcher(checksum.browser_download_url, { headers: { 'User-Agent': 'AssetHive-release-validation' } });
    if (downloaded.status !== 200) throw new Error(`校验文件下载失败：${checksum.name}`);
    const text = await downloaded.text();
    const [hash, name] = text.trim().split(/\s+/);
    if (name !== installer.name || 'sha256:' + hash.toLowerCase() !== installer.digest.toLowerCase()) throw new Error(`已发布附件校验和不一致：${installer.name}`);
    if (checksum.digest && 'sha256:' + createHash('sha256').update(text).digest('hex') !== checksum.digest) throw new Error(`校验文件内容与服务端指纹不一致：${checksum.name}`);
  }
  return { publishNeeded: false, url: release.html_url };
}

async function main() {
  const args = process.argv.slice(2);
  const value = name => args[args.indexOf(name) + 1];
  const root = path.resolve(args.includes('--root') ? value('--root') : '.');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const tag = args.includes('--tag') ? value('--tag') : 'v' + version;
  const proof = JSON.parse(fs.readFileSync(path.join(root, `docs/release-source-${version}.json`), 'utf8'));
  const result = verifyLocalSource(root, proof, tag);
  console.log(`源码校验通过：${tag}，对应 ${proof.sourceRepository}@${proof.sourceCommit}，${result.inputFiles} 个应用文件`);
  if (args.includes('--check-published')) {
    const repository = args.includes('--repository') ? value('--repository') : process.env.GITHUB_REPOSITORY || 'blackbladestudio/AssetHive';
    const notes = fs.readFileSync(path.join(root, `docs/release-notes-${version}.md`), 'utf8');
    const state = await checkPublishedRelease(repository, proof, notes);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `publish_needed=${state.publishNeeded}\n`);
    console.log(state.publishNeeded ? '该版本尚未发布，可以继续构建' : `已发布版本校验通过，保留附件并跳过重复发布：${state.url}`);
  }
}

module.exports = { validatePublishedRelease, checkPublishedRelease };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
