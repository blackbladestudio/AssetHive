const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Buffer } = require('node:buffer');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_REPOSITORY = 'Biscuits-Lab/Assethive_Sourcecode';
const DIRECTORIES = ['electron/', 'src/', 'shared/', 'images/', 'updater/', 'installer/', 'BlenderPlugin/', 'scripts/lib/'];
const FILES = ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'eslint.config.js', 'fab-login.cmd'];
const TEXT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.mts', '.cts', '.json', '.css', '.html', '.py', '.md', '.txt', '.ini', '.iss', '.wxs', '.ps1', '.bat', '.cmd', '.svg', '.cs']);

function isReleaseInput(relative) {
  return path.posix.normalize(relative) === relative && !path.posix.isAbsolute(relative)
    && !relative.split('/').includes('..')
    && (FILES.includes(relative) || DIRECTORIES.some(prefix => relative.startsWith(prefix)));
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function getSourceProof(version, root = ROOT) {
  const tag = 'v' + version;
  const entries = git(root, ['ls-tree', '-r', '-z', tag]).split('\0').filter(Boolean).map(line => {
    const [metadata, relative] = line.split('\t');
    const [, type, sha] = metadata.split(' ');
    return { relative, type, sha };
  });
  const packageVersion = JSON.parse(git(root, ['show', `${tag}:package.json`])).version;
  if (packageVersion !== version) throw new Error(`源码标签 ${tag} 的版本为 ${packageVersion}，请先修正版本与标签`);
  const files = Object.fromEntries(entries.filter(entry => entry.type === 'blob' && isReleaseInput(entry.relative)).map(entry => [entry.relative, entry.sha]));
  const manifestPath = `docs/release-source-${version}.json`;
  if (entries.some(entry => entry.relative === manifestPath)) {
    const proof = JSON.parse(git(root, ['show', `${tag}:${manifestPath}`]));
    assertSourceMatches(proof, version, files);
    return proof;
  }
  return { schemaVersion: 1, version, sourceRepository: SOURCE_REPOSITORY, sourceTag: tag, sourceCommit: git(root, ['rev-parse', `${tag}^{commit}`]), files };
}

function assertSourceMatches(proof, version, files) {
  if (proof.schemaVersion !== 1 || proof.sourceRepository !== SOURCE_REPOSITORY || !/^[a-f0-9]{40}$/.test(proof.sourceCommit || '')) throw new Error('发布源码来源记录无效');
  if (proof.version !== version || proof.sourceTag !== 'v' + version) {
    throw new Error(`发布仓库源码版本 ${version} 与期望 ${proof.version} 不一致，请先同步源码`);
  }
  if (!proof.files || !proof.files['package.json'] || !proof.files['electron/main.js']) throw new Error('缺少完整发布源码指纹');
  const actual = Object.fromEntries(Object.entries(files).filter(([relative]) => isReleaseInput(relative)));
  const differences = [...new Set([...Object.keys(proof.files), ...Object.keys(actual)])]
    .filter(relative => !isReleaseInput(relative) || proof.files[relative] !== actual[relative]);
  if (differences.length) throw new Error(`发布仓库源码与 ${proof.sourceTag} 不一致：${differences.slice(0, 8).join('、')}。请先同步源码，不能仅修改版本号`);
}

function blobHash(bytes, relative) {
  const content = TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase()) ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n')) : bytes;
  return createHash('sha1').update(Buffer.from(`blob ${content.length}\0`)).update(content).digest('hex');
}

function verifyLocalSource(root, proof, tag) {
  if (tag !== proof.sourceTag) throw new Error(`标签 ${tag} 与源码记录 ${proof.sourceTag} 不一致`);
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const files = {};
  function visit(relative) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) return;
    if (fs.statSync(absolute).isDirectory()) {
      for (const name of fs.readdirSync(absolute)) visit(relative + '/' + name);
    } else if (isReleaseInput(relative)) files[relative] = blobHash(fs.readFileSync(absolute), relative);
  }
  for (const directory of DIRECTORIES) visit(directory.slice(0, -1));
  for (const file of FILES) visit(file);
  assertSourceMatches(proof, version, files);
  return { version, tag, sourceCommit: proof.sourceCommit, inputFiles: Object.keys(proof.files).length };
}

module.exports = { getSourceProof, assertSourceMatches, verifyLocalSource, isReleaseInput, blobHash };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const version = args.includes('--version') ? args[args.indexOf('--version') + 1] : JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const destination = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : `docs/release-source-${version}.json`);
    const proof = getSourceProof(version);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(proof, null, 2) + '\n');
    console.log(`源码记录已生成：${destination}，${Object.keys(proof.files).length} 个应用文件，对应 ${proof.sourceCommit}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
