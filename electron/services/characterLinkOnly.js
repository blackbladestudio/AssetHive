const crypto = require('node:crypto');
const projectIdentity = require('./characterProjectIdentity');
const { compareLinkContent, meshLodCount } = require('./characterLinkContent');
const { updateAssetMetadataFile } = require('./assetMetadata');
const pending = new Map();
const normalize = value => String(value || '').replaceAll('\\', '/').toLowerCase();
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

async function sendCharacterLinkJob(assets, options, onProgress, client) {
  const editor = await client.getEditorInfo();
  if (!await require('./characterPluginCapabilities').hasCharacterCapability(client, editor, 'characterLinkOnlyV2')) throw new Error('目标 UE 插件尚不支持完整角色内容核验，请更新正式插件并重启 UE 后重新检查');
  if (options.unrealProjectPath && normalize(options.unrealProjectPath) !== normalize(editor.projectPath)) throw new Error('目标工程不一致，未建立关联');
  const phase = options.suitPhase || 'inspect';
  const unique = [...new Map(assets.map(asset => [asset.id, asset])).values()];
  if (phase === 'inspect') {
    if (!unique.length || unique.some(asset => !['suit', 'monster', 'npc', 'weapon', 'item'].includes(asset.assetType) || asset.meta?.componentView || String(asset.id).includes('::part::'))) throw new Error('请从角色资产主体管理 UE 资源，关联以完整资产为单位');
    for (const [token, state] of pending) if (Date.now() - state.at > 30 * 60 * 1000) pending.delete(token);
    const suits = [];
    for (const asset of unique) {
      onProgress?.({ percent: 0, message: '正在准备仅关联检查：' + asset.name });
      suits.push(await require('./characterSuitExport').buildSuitExport(asset, { includeStaticMeshes: true, inspectAllMeshes: true }));
    }
    const reply = await client.importAssets({ characterSuit: { version: 1, phase: 'linkInspect', suits } }, { projectPath: editor.projectPath });
    const result = reply.suitResult;
    if (result?.error || !Array.isArray(result?.entries) || !result.inspectToken) throw new Error(result?.error || 'UE 未返回仅关联检查结果');
    const expected = new Map(suits.flatMap(suit => suit.entries.map(entry => [entry.key, entry])));
    if (result.entries.length !== expected.size || new Set(result.entries.map(row => row.key)).size !== expected.size
      || result.entries.some(row => !expected.has(row.key))) throw new Error('仅关联回执不完整，未建立关联');
    const verified = [];
    for (const [index, row] of result.entries.entries()) {
      onProgress?.({ percent: 10 + index / result.entries.length * 85, message: '正在核对内容：' + row.name });
      if (row.status !== 'checking') continue;
      try {
        const source = expected.get(row.key);
        if (source.kind === 'material') {
          if (row.verification !== 'materialContract' || row.fingerprint !== source.fingerprint) throw new Error('材质核验回执不完整');
          row.status = 'ready'; row.message = '材质类型、母材质和贴图依赖核验通过';
          verified.push(row.key);
          continue;
        }
        if (row.sourceHash !== source.sourceHash) throw new Error('源文件版本不一致');
        if (source.kind === 'groom') {
          if (row.verification !== 'groomContent' || row.fingerprint !== source.fingerprint) throw new Error('Groom 内容核验回执不完整');
          row.status = 'ready'; row.message = 'Groom 曲线和属性核验通过'; verified.push(row.key); continue;
        }
        const allLodSources = source.config?.lodSources || [];
        if (JSON.stringify(row.lodSources || []) !== JSON.stringify(allLodSources)) throw new Error('LOD 核验回执不完整');
        const pendingLods = new Set(row.pendingLods || []);
        if ([...pendingLods].some(index => !allLodSources.some(lod => lod.index === index))) throw new Error('待发送 LOD 回执不完整');
        const lodSources = allLodSources.filter(lod => !pendingLods.has(lod.index));
        const isMesh = ['staticMesh','skeletalMesh'].includes(row.kind);
        const embeddedCount = isMesh ? await meshLodCount(source.sourcePath) : 1;
        const comparison = await compareLinkContent(source.sourcePath, row.exportedPath, row.kind, {source: row.sourceMaterialPaths, target: row.exportedMaterialPaths, sourceLod: isMesh ? 0 : null, targetLod: isMesh ? 0 : null});
        let equal = comparison.equal;
        if (equal) for (let index=1; index<embeddedCount; index++) {
          if (allLodSources.some(lod=>lod.index===index)) continue;
          const level = await compareLinkContent(source.sourcePath,row.exportedPath,row.kind,{source:row.sourceMaterialPaths,target:row.exportedMaterialPaths,sourceLod:index,targetLod:index});
          if (!level.equal) {equal=false;break;}
        }
        if (equal) for (const lod of lodSources) {
          const level = await compareLinkContent(lod.sourcePath, row.exportedPath, row.kind, {source: row.sourceMaterialPaths, target: row.exportedMaterialPaths, sourceLod: 0, targetLod: lod.index});
          if (!level.equal) { equal = false; break; }
        }
        if (!equal && isMesh && embeddedCount === 1) {
          // Original FBX axes, triangulation and UE-generated attributes differ
          // legitimately. Ask UE to parse a transient copy using its recorded
          // import settings; never relax the actual content comparison.
          const normalized = await client.importAssets({ characterSuit: { version: 1, phase: 'linkNormalize', inspectToken: result.inspectToken, keys: [row.key] } }, { projectPath: editor.projectPath });
          if (normalized.suitResult?.error) throw new Error(normalized.suitResult.error);
          const records = normalized.suitResult?.entries;
          const levels = records?.length === 1 && records[0].key === row.key ? records[0].normalizedSources : null;
          const sources = [{index:0, sourceHash:source.sourceHash}, ...lodSources];
          if (!Array.isArray(levels) || levels.length !== sources.length || new Set(levels.map(level => level.index)).size !== sources.length) throw new Error('源内容解析回执不完整');
          equal = true;
          for (const original of sources) {
            const level = levels.find(value => value.index === original.index);
            if (!level || level.sourceHash !== original.sourceHash) throw new Error('源内容解析版本不一致');
            if (level.sourceLod !== original.index) throw new Error('源内容 LOD 索引不一致');
            const proof = await compareLinkContent(level.exportedPath, row.exportedPath, row.kind, {source:row.exportedMaterialPaths, target:row.exportedMaterialPaths, sourceLod:level.sourceLod, targetLod:original.index});
            if (!proof.equal) { equal = false; break; }
          }
        }
        row.status = equal ? 'ready' : 'blocked';
        row.message = equal ? '内容及依赖核验通过，可仅关联' : '内容不一致或无法证明等价，未关联；不会导入覆盖';
        if (equal && pendingLods.size) row.message = `已有模型内容与依赖核验通过；LOD${[...pendingLods].join('、LOD')} 待显式发送，关联不会导入`;
        if (equal) verified.push(row.key);
      } catch (error) { row.status = 'blocked'; row.message = String(error.message || error); }
    }
    // A matching material path alone is insufficient if that texture's pixels
    // differ. Propagate failed verification through the complete asset graph.
    const rowsByKey = new Map(result.entries.map(row => [row.key, row]));
    let changed;
    do {
      changed = false;
      for (const row of result.entries) {
        if (row.status !== 'ready') continue;
        const source = expected.get(row.key);
        const dependencies = Object.values(source.kind === 'material' ? source.textures || {} : source.materials || {});
        if (dependencies.some(key => rowsByKey.get(key)?.status !== 'ready')) {
          row.status = 'blocked'; row.message = '所依赖的材质或贴图尚未核验通过，未建立关联'; changed = true;
        }
      }
    } while (changed);
    const verifiedKeys = verified.filter(key => rowsByKey.get(key)?.status === 'ready');
    for (const row of result.entries) if (row.status === 'ready' && row.alreadyLinked) {
      row.status = 'linked'; row.message = row.pendingLods?.length
        ? `已关联；LOD${row.pendingLods.join('、LOD')} 待显式发送，无需重复关联`
        : '已关联；内容与依赖核验通过，无需重复关联';
    }
    const manifestHash = hash(suits);
    await recordLinkInspection(unique, suits, result.entries, editor.projectPath, editor.projectId);
    pending.set(result.inspectToken, { at: Date.now(), project: normalize(editor.projectPath), ids: unique.map(a => a.id).sort(), verified: verifiedKeys, manifestHash, suits });
    return { ok: true, suitResult: { entries: publicRows(result.entries), inspectToken: result.inspectToken, manifestHash,
      projectPath: editor.projectPath, materialRequests: [], phase: 'inspect' }, message: '仅关联检查完成' };
  }
  const cached = pending.get(options.suitInspectToken);
  if (!cached || Date.now() - cached.at > 30 * 60 * 1000 || cached.project !== normalize(editor.projectPath)
    || JSON.stringify(cached.ids) !== JSON.stringify(unique.map(a => a.id).sort()) || cached.manifestHash !== options.suitManifestHash) throw new Error('检查已失效，请重新检查后仅关联');
  const current = [];
  for (const asset of unique) current.push(await require('./characterSuitExport').buildSuitExport(asset, { includeStaticMeshes: true, inspectAllMeshes: true }));
  if (hash(current) !== cached.manifestHash) throw new Error('库内内容或配置已变化，请重新核验后关联');
  const reply = await client.importAssets({ characterSuit: { version: 1, phase: 'linkApply', inspectToken: options.suitInspectToken, verifiedKeys: cached.verified } }, { projectPath: editor.projectPath });
  if (reply.suitResult?.error || !Array.isArray(reply.suitResult?.entries)) throw new Error(reply.suitResult?.error || 'UE 关联回执缺失');
  const entries = reply.suitResult.entries;
  const expectedKeys = new Set(cached.suits.flatMap(suit => suit.entries.map(entry => entry.key)));
  if (entries.length !== expectedKeys.size || new Set(entries.map(row => row.key)).size !== expectedKeys.size || entries.some(row => !expectedKeys.has(row.key))) throw new Error('仅关联结果不完整，请重新检查');
  const projectKey = projectIdentity.projectKey(editor);
  for (const asset of unique) {
    const rows = entries.filter(row => row.assetId === asset.id && ['success', 'unchanged'].includes(row.status) && cached.verified.includes(row.key));
    if (!rows.length) continue;
    await updateAssetMetadataFile(asset.metaPath, meta => {
      const receipts = meta.characterUnrealExports ||= {};
      const receipt = receipts[projectKey] ||= projectIdentity.projectReceipt(meta, editor) || { entries: {} };
      receipt.entries ||= {};
      for (const row of rows) receipt.entries[row.key] = { ...receipt.entries[row.key], ...publicRows([row])[0], action: 'linked',
        linkOnly: true, missingInUE: false, associationPending: false, livePath: row.path, lastSuccessPath: row.path };
      receipt.projectPath = editor.projectPath;
      receipt.projectId = projectIdentity.projectId(editor);
      receipt.targetRoot = cached.suits.find(suit => suit.assetId === asset.id)?.targetRoot || '';
      receipt.checkedAt = new Date().toISOString();
      return meta;
    });
  }
  pending.delete(options.suitInspectToken);
  return { ok: true, suitResult: { entries: publicRows(entries), inspectToken: options.suitInspectToken, manifestHash: cached.manifestHash,
    projectPath: editor.projectPath, materialRequests: [], phase: 'apply' }, message: '仅关联处理完成；未修改 UE 资源内容' };
}

function publicRows(rows) {
  return rows.map(row => Object.fromEntries(['assetId', 'key', 'name', 'kind', 'partSlot', 'targetPath', 'path', 'status', 'action', 'message'].filter(key => row[key] !== undefined).map(key => [key, row[key]])));
}
async function recordLinkInspection(assets, suits, rows, projectPath, projectId) {
  const editor = {projectPath, projectId};
  const projectKey = projectIdentity.projectKey(editor);
  for (const asset of assets) {
    const inspected = rows.filter(row => row.assetId === asset.id);
    if (!inspected.length) continue;
    await updateAssetMetadataFile(asset.metaPath, meta => {
      const receipt = (meta.characterUnrealExports ||= {})[projectKey] ||= projectIdentity.projectReceipt(meta, editor) || { entries: {} };
      receipt.entries ||= {};
      for (const row of inspected) {
        const previous = receipt.entries[row.key] || {};
        if (row.status === 'linked') {
          receipt.entries[row.key] = { ...previous, ...publicRows([row])[0], missingInUE: false,
            livePath: row.path, lastSuccessPath: row.path, associationPending: false };
          continue;
        }
        if (row.status === 'ready' && previous.lastSuccessPath && !previous.missingInUE && !previous.associationPending) continue;
        receipt.entries[row.key] = { ...previous, ...publicRows([row])[0], missingInUE: row.status === 'missing',
          livePath: row.status === 'missing' ? '' : row.path || previous.livePath || '', associationPending: row.status !== 'missing' };
      }
      receipt.projectPath = projectPath;
      receipt.projectId = projectIdentity.projectId(editor);
      receipt.targetRoot = suits.find(suit => suit.assetId === asset.id)?.targetRoot || '';
      receipt.checkedAt = new Date().toISOString();
      return meta;
    });
  }
}
module.exports = { sendCharacterLinkJob, publicRows, recordLinkInspection };
