const fs = require('node:fs/promises');
const { focusUnrealEditor } = require('./unrealFocus');
const { checkoutAnimationTargets } = require('./animationCheckout');
const {
  ANIMATION_UE_EXPORT_VERSION, ANIMATION_UE_CAPABILITY, planAnimationExport, resolveAnimationExportOptions
} = require('../../shared/animationUnrealExport.mjs');

const normalize = value => String(value || '').replaceAll('\\', '/').toLowerCase();

function isAnimationUEAsset(asset) {
  return String(asset?.assetType || '').trim().toLowerCase() === 'animation';
}

function animationFbxPath(asset) {
  return [...(asset?.modelFiles || []), asset?.metaPath].map(value => String(value || '').trim()).find(value => /\.fbx$/i.test(value)) || '';
}

function buildAnimationImportConfig(options) {
  return {
    version: ANIMATION_UE_EXPORT_VERSION,
    importMesh: false,
    importAnimations: true,
    importMaterials: false,
    importTextures: false,
    sampleRate: 60,
    animationLength: 'exportedTime',
    importBoneTracks: true,
    importCustomAttribute: true,
    removeRedundantKeys: false,
    convertScene: true,
    enableRootMotion: options.enableRootMotion,
    forceRootLock: options.forceRootLock,
    showImportDialog: options.showImportDialog,
    allowEngineCompressionFallback: options.allowEngineCompressionFallback,
    overwrite: 'reimport'
  };
}

async function buildAnimationExport(assets, requested = {}, libraryRoot = '', stat = fs.stat, realpath = fs.realpath) {
  const options = { ...resolveAnimationExportOptions(requested), ...(requested.root !== undefined ? { root: requested.root } : {}) };
  const unique = [...new Map(assets.map(asset => [asset.id, asset])).values()];
  if (!unique.length || !unique.every(isAnimationUEAsset)) throw new Error('本入口仅用于动画');
  const rows = planAnimationExport(unique.map(asset => ({
    assetId: String(asset.id), name: asset.name, fbxPath: animationFbxPath(asset),
    affiliation: String(asset.animationAffiliation || asset.meta?.animationAffiliation || '').trim()
  })), options, libraryRoot);
  const errors = rows.filter(row => row.error);
  if (errors.length) throw new Error(errors.map(row => `${row.name}：${row.error}`).join('；'));
  const targets = new Map();
  const resolvedRoot = libraryRoot ? normalize(await realpath(libraryRoot).catch(() => { throw new Error(`资源库路径不可访问：${libraryRoot}`); })).replace(/\/+$/, '') : '';
  for (const row of rows) {
    const key = row.targetPath.toLowerCase();
    if (targets.has(key)) throw new Error(`UE 目标路径重复：${row.targetPath}`);
    targets.set(key, row);
    if (!(await stat(row.sourcePath).catch(() => null))?.isFile()) throw new Error(`动画 FBX 不存在：${row.sourcePath}`);
    const resolvedSource = normalize(await realpath(row.sourcePath).catch(() => { throw new Error(`动画 FBX 无法读取：${row.sourcePath}`); }));
    if (resolvedRoot && !resolvedSource.startsWith(resolvedRoot + '/')) throw new Error(`动画 FBX 的实际路径位于资源库外（请检查快捷链接或目录联接）：${row.sourcePath}`);
  }
  const config = buildAnimationImportConfig(options);
  return rows.map(row => ({ key: row.assetId, assetId: row.assetId, kind: 'animSequence', name: row.name,
    sourcePath: row.sourcePath, targetPath: row.targetPath, skeletonPath: row.skeletonPath, config }));
}

async function sendAnimationJob(assets, options, onProgress, client, focus = focusUnrealEditor) {
  const editor = await client.getEditorInfo();
  if (!editor?.capabilities?.includes(ANIMATION_UE_CAPABILITY)) throw new Error('请更新并加载支持动画导入的 AssetHive 插件');
  if (options.unrealProjectPath && normalize(options.unrealProjectPath) !== normalize(editor.projectPath)) throw new Error('连接的 UE 工程与所选目标不一致');
  onProgress?.({ percent: 0, message: '正在检查动画文件…' });
  const animations = await buildAnimationExport(assets, options.animationExport || {}, options.customLibraryPath);
  const checkoutNotes = await checkoutAnimationTargets(editor.projectPath, animations, onProgress);
  onProgress?.({ percent: 0, message: `正在发送 ${animations.length} 个动画到 UE…` });
  const reply = await client.importAssets({ characterAnimation: { version: ANIMATION_UE_EXPORT_VERSION, animations } },
    { projectPath: editor.projectPath, onProgress });
  const result = reply.animationResult;
  if (result?.error) throw new Error(result.error);
  if (!result || !Array.isArray(result.entries)) throw new Error('插件没有返回动画逐项结果');
  const byKey = new Map(animations.map(entry => [entry.key, entry]));
  const entries = animations.map(entry => {
    const row = result.entries.find(item => item.key === entry.key) || { status: 'failed', message: '插件未返回该动画的结果' };
    return { ...row, message: [checkoutNotes.get(entry.key), row.message].filter(Boolean).join('；'), key: entry.key, assetId: entry.assetId, name: entry.name, targetPath: entry.targetPath, path: row.path || entry.targetPath };
  });
  const results = entries.map(row => ({ assetId: row.assetId, name: byKey.get(row.key).name,
    status: row.status === 'success' ? 'success' : row.status === 'skipped' ? 'skipped' : 'failed', message: row.message || '' }));
  const failed = results.filter(row => row.status !== 'success').length;
  if (failed < results.length) await focus(editor.pid).catch(() => false);
  return { ok: failed < results.length, partial: failed > 0, results,
    animationResult: { entries, projectPath: editor.projectPath },
    message: failed ? `已保存 ${results.length - failed} 个动画，${failed} 个未成功：${results.filter(row => row.status !== 'success').map(row => `${row.name}：${row.message}`).join('；')}` : `已在 UE 保存 ${results.length} 个动画，已选中导入的资产` };
}

module.exports = { isAnimationUEAsset, animationFbxPath, buildAnimationImportConfig, buildAnimationExport, sendAnimationJob };
