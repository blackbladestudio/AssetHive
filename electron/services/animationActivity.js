const fs = require('node:fs');
const crypto = require('node:crypto');
const { animationFbxPath } = require('./animationUnrealExport');
const { readAnimationIdentitySidecar, applyAnimationIdentityMetadata, writeAnimationIdentitySidecar } = require('./animationIdentity');
const { computeContentIdentity } = require('./assetIdentity');

const projectKey = value => String(value || '').trim().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

function animationExportReceipt(meta, projectPath) {
  return (Array.isArray(meta?.animationUEExports) ? meta.animationUEExports : []).find(row => projectKey(row.projectPath) === projectKey(projectPath));
}

function recordAnimationExport(meta, row, projectPath, at = new Date().toISOString()) {
  const operation = { at, action: 'export', status: row.status, projectPath, targetPath: row.path || row.targetPath,
    sourcePath: row.sourcePath || '', message: row.message || '', sourceHash: row.sourceHash || '', savedHash: row.savedHash || '', contentFingerprint: row.contentFingerprint || '' };
  const next = { ...meta, animationOperationHistory: [...(meta.animationOperationHistory || []), operation].slice(-50) };
  if (row.status === 'success') {
    next.animationUEExports = [...(meta.animationUEExports || []).filter(receipt => projectKey(receipt.projectPath) !== projectKey(projectPath)), operation].slice(-20);
  }
  return next;
}

async function persistAnimationExport(asset, row, projectPath, at) {
  const file = animationFbxPath(asset);
  let meta = applyAnimationIdentityMetadata({ ...asset.meta, assetID: asset.id }, await readAnimationIdentitySidecar(file));
  if (!meta.identity?.contentFingerprint) {
    meta = { ...meta, identity: { ...meta.identity, ...await computeContentIdentity({ modelSlots: { Mesh: file } }) } };
  }
  meta = recordAnimationExport(meta, { ...row, sourcePath: file, contentFingerprint: meta.identity?.contentFingerprint }, projectPath, at);
  await writeAnimationIdentitySidecar(file, meta);
  return meta;
}

async function fileHash(filename) {
  const hash = crypto.createHash('md5');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function compareAnimationVersion(receipt, sourceHash, engine) {
  if (engine?.error) return 'error';
  if (!engine || typeof engine.exists !== 'boolean') return 'unverified';
  if (!engine.exists) return 'missing';
  if (!receipt?.sourceHash || !receipt?.savedHash || !engine.savedHash) return 'unverified';
  const sourceChanged = receipt.sourceHash.toLowerCase() !== sourceHash.toLowerCase();
  const engineChanged = engine.dirty || receipt.savedHash.toLowerCase() !== engine.savedHash.toLowerCase();
  return sourceChanged && engineChanged ? 'bothUpdated' : sourceChanged ? 'libraryUpdated' : engineChanged ? 'engineUpdated' : 'current';
}

async function getAnimationUnrealStatus(asset, options, client) {
  const configuredProject = options.unrealProjectPath || '';
  const previous = configuredProject ? animationExportReceipt(asset.meta, configuredProject) : asset.meta?.animationUEExports?.at(-1);
  const offline = { state: 'unverified', projectPath: configuredProject || previous?.projectPath || '', targetPath: previous?.targetPath, at: previous?.at,
    message: configuredProject || !previous ? 'UE 未连接，未实时核验' : 'UE 未连接，仅展示上次发送工程，未实时核验' };
  const editor = await client.getEditorInfo().catch(() => null);
  if (!editor) return offline;
  if (configuredProject && projectKey(configuredProject) !== projectKey(editor.projectPath)) return { ...offline, state: 'error', message: '连接的 UE 工程与目标不一致' };
  const projectPath = editor.projectPath;
  const receipt = animationExportReceipt(asset.meta, projectPath);
  if (!receipt) return { state: 'neverSent', projectPath, message: '没有此工程的发送记录；无法据此判断 UE 中是否已有同名动画' };
  let sourceHash;
  try { sourceHash = await fileHash(animationFbxPath(asset)); }
  catch { return { state: 'sourceMissing', projectPath, message: '归档 FBX 缺失或无法读取' }; }
  if (!editor.capabilities?.includes('characterAnimationInspectV1')) return { state: 'unverified', projectPath, targetPath: receipt.targetPath, message: '当前插件不支持动画版本检查，请编译并重启 UE', at: receipt.at };
  const targetPath = String(receipt.targetPath || '').split('.')[0];
  const reply = await client.importAssets({ characterAnimation: { version: 1, inspectOnly: true, animations: [{ key: asset.id, targetPath }] } }, { projectPath });
  if (reply.animationResult?.error) throw new Error(reply.animationResult.error);
  const engine = reply.animationResult?.entries?.find(row => row.key === asset.id);
  return { state: compareAnimationVersion(receipt, sourceHash, engine), projectPath, targetPath, at: receipt.at, message: engine?.error || (engine?.dirty ? 'UE 动画存在未保存修改' : !receipt.sourceHash || !receipt.savedHash ? '已有发送记录；缺少发送时的版本指纹，重新发送后可建立比较基准' : '') };
}

module.exports = { animationExportReceipt, recordAnimationExport, persistAnimationExport, fileHash, compareAnimationVersion, getAnimationUnrealStatus };
