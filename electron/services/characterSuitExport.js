const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectCharacterFile, inspectCharacterModel, inspectCharacterNormalAlpha } = require('./characterFileInspection');
const { activeCharacterFiles, listCharacterComponents, characterModelPreviewComponents } = require('../../shared/characterComponents.mjs');
const { weaponTargetRoot } = require('../../shared/weaponRules.mjs');
const { analyzeFbxInWorker } = require('./modelAnalysis');
const { updateAssetMetadataFile } = require('./assetMetadata');
const { appendCharacterUpdateHistory } = require('./characterUpdateHistory');
const { runImageTask } = require('./imageTasks');
const { listPermanentlyDeletedAssets } = require('./characterDeletion');

const VERSION = 1;
const ROOT = '/Game/Characters/Hero/Asset_PJZ';
const MONSTER_CATEGORIES = { boss: '1_Boss', miniboss: '2_MiniBoss', elite: '3_Elite', normal: '4_NormalMonster', normalmonster: '4_NormalMonster', minion: '5_Minion' };
const MONSTER_CLOTH_TEMPLATE = '/Game/MaterialLibrary/Character/Common/M_Char_Monster_ComplexShading';
const MONSTER_SKIN_TEMPLATE = '/Game/MaterialLibrary/Character/Common/M_Char_Monster_skin';
const DEFAULT_SKELETON = `${ROOT}/Common/SKEL_Character`;
let alphaChecks = new WeakMap();
const defaultHasAlpha = file => runImageTask('hasOpacityAlpha', [file]);
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const normalize = value => String(value || '').replaceAll('\\', '/').toLowerCase();
const token = value => String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
const safeName = value => {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(String(value))) throw new Error(`名称不符合 UE 规范：${value}`);
  return value;
};

async function managedFile(asset, relative) {
  if (!relative || path.isAbsolute(relative)) throw new Error('导出只允许管理目录内的相对文件');
  const root = await fs.realpath(asset.path);
  const file = await fs.realpath(path.resolve(root, relative));
  const rel = path.relative(root, file);
  if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) throw new Error('导出文件不在该资产管理目录内');
  return inspectCharacterFile(file);
}

function materialGroup(name, parentName) {
  return String(name || '').replace(/^(?:MI|M|T)_/i, '').replace(/_(D|N|ORM|A|E|Emissive|Emission)$/i, '').replace(new RegExp('^' + parentName + '_', 'i'), '');
}

function inferMonsterMaterialType(groupName) {
  const semantic = String(groupName || '').replace(/^\d+[_-]?/, '').replace(/([a-z])([A-Z])/g, '$1_$2');
  const skin = /(?:^|[_\s-])(?:skin|body|face|flesh)(?:[_\s-]|$)/i.test(semantic);
  const cloth = /(?:^|[_\s-])(?:hat|upper|skirt|cuish|shoulder[_-]arm|cloth|clothes|clothing|armor|armour|coat|jacket|pants|trousers|cape|cloak|helmet|gloves?|boots?|shoes?|belt|dress|shirt|robe|hood|gauntlet|greaves?|pauldron)(?:[_\s-]|$)/i.test(semantic);
  return skin === cloth ? '' : skin ? 'skin' : 'cloth';
}

function mergeSuitExportOptions(saved = {}, requested = {}) {
  return { ...saved, ...requested,
    materialMappings: { ...saved.materialMappings, ...requested.materialMappings },
    monsterMaterialTypes: { ...saved.monsterMaterialTypes, ...requested.monsterMaterialTypes } };
}

// Legacy packages use _<form>_WP_<weapon>; newer ones carry ownership
// metadata or a Weapon directory. A body material suffix alone is not evidence.
function monsterWeaponSubject(file, ownerName) {
  const stem = String(file.normalizedName || file.storedPath || '').replaceAll('\\', '/').split('/').pop().replace(/\.[^.]+$/, '')
    .replace(/^(?:SM|SK|SKEL|MI|M|T)_/i, '').replace(/_(?:D|N|ORM|A|E|Emissive|Emission)$/i, '');
  const legacy = /(?:^|_)WP_(.+)$/i.exec(stem);
  if (legacy) return legacy[1];
  if (file.componentRole !== 'weapon' && !/(?:^|\/)Weapon\//i.test(String(file.storedPath || file.sourcePath || '').replaceAll('\\', '/'))) return '';
  return String(file.componentName || stem.replace(new RegExp('^' + ownerName + '(?:_\\d{2})?_', 'i'), '')).replace(/^WP_/i, '');
}

function sharedCharacterMaterial(slot, fields) {
  // Public character slots are distinct from suit material groups, even for arm/head.
  const match = /^(?:MI|M)_(?:Male|Female)_?\d*_(arm|body|foot|hand|leg|oral|underwear|head\d+|hair\d+|eyebrow\d+|EyeOcclusion)(?:SG|Material)?$/i.exec(slot);
  if (!match) return '';
  const family = `${fields.gender}${fields.bodyCode}`;
  const suffix = match[1].toLowerCase() === 'eyeocclusion' ? 'EyeOcclusion' : match[1].toLowerCase();
  return `${ROOT}/${fields.gender}_${fields.bodyCode}/Mesh/SK_${family}/Materials/MI_${family}_${suffix}`;
}

function recordUEPresenceChanges(meta, receipt, updates, projectPath) {
  const transitions = updates.filter(row => {
    const old = receipt.entries?.[row.key];
    return old && old.action !== 'retained' && (row.present ? old.missingInUE === true : old.missingInUE !== true);
  });
  const contentUpdatedAt = meta.characterManifest?.contentUpdatedAt;
  const summary = meta.characterManifest?.lastUpdateSummary;
  for (const present of [false, true]) {
    const changed = transitions.filter(row => row.present === present);
    if (!changed.length) continue;
    appendCharacterUpdateHistory(meta, {
      label: present ? '检测到 UE 资源恢复' : '检测到 UE 资源删除',
      details: { projectPath, observed: true },
      changes: changed.map(row => ({ key: row.key, status: present ? 'restored' : 'deleted', before: receipt.entries[row.key].livePath || receipt.entries[row.key].lastSuccessPath || receipt.entries[row.key].path, after: row.path })),
      files: changed.map(row => ({ name: receipt.entries[row.key].name, uePath: row.path || receipt.entries[row.key].lastSuccessPath || receipt.entries[row.key].path,
        message: present ? 'UE 中已存在' : 'UE 中已删除；AssetHive 素材保留，下次发送将重新导入' }))
    });
  }
  if (meta.characterManifest) { meta.characterManifest.contentUpdatedAt = contentUpdatedAt; meta.characterManifest.lastUpdateSummary = summary; }
}

async function buildSuitExport(asset, options = {}, analyze = analyzeFbxInWorker, hasAlpha = defaultHasAlpha) {
  const fields = asset.meta?.character || {};
  if (asset.assetType === 'suit' && ['Hair', 'Face'].includes(fields.variant)) return require('./heroPartExport').buildHeroPartExport(asset, options, analyze, managedFile);
  const weapon = asset.assetType === 'weapon';
  const monster = asset.assetType === 'monster';
  const family = monster ? 'monster' : weapon ? 'weapon' : 'suit';
  const ownSkeleton = weapon || monster;
  if (!isCharacterUEAsset(asset)) throw new Error('本入口用于套装、武器和怪物');
  if (!ownSkeleton && (!['Male', 'Female'].includes(fields.gender) || !/^\d{2}$/.test(fields.bodyCode || ''))) throw new Error('请先确认套装性别与体型编号');
  const name = safeName(monster ? fields.name || (asset.meta?.name || asset.name).replace(/^(SM|SK)_/i, '').replace(/_\d{2}$/, '') : asset.meta?.name || asset.name);
  const assetId = String(asset.id);
  const monsterCategory = monster && MONSTER_CATEGORIES[token(asset.meta?.category || asset.category).replace(/^\d+/, '')];
  if (monster && !monsterCategory) throw new Error('请先确认怪物类别');
  // UE directories use the category label and AssetHive name. The AssetHive
  // identity, serial/form metadata and managed filenames remain unchanged.
  const monsterFolder = monster ? `${monsterCategory.replace(/^\d_/, '')}_${name}` : name;
  const targetRoot = monster ? `/Game/Characters/Monster/${monsterCategory}/${monsterFolder}` : weapon ? weaponTargetRoot(name) : `${ROOT}/${fields.gender}_${fields.bodyCode}/Mesh/${name}`;
  const parts = ownSkeleton ? characterModelPreviewComponents(asset) : listCharacterComponents(asset);
  // Every suit send compares the entire owner, regardless of which card opened it.
  const selectedSlot = '';
  const allFiles = activeCharacterFiles(asset);
  const selectedParts = parts.filter(part => (monster || part.role === 'part') && (!selectedSlot || part.slot === selectedSlot));
  if (!selectedParts.length) throw new Error('没有可发送的模型记录');
  const entries = [];
  const textures = allFiles.filter(file => file.role === 'texture');
  // Resolve and inspect independent managed files in bounded batches. Keep the
  // manifest order deterministic and await every batch before reporting errors.
  const managedSources = new Map();
  const modelRoles = options.includeStaticMeshes === true ? ['model', 'staticMesh', 'skeletalMesh'] : ['model', 'skeletalMesh'];
  const sourceFiles = [...new Set([...textures, ...selectedParts.flatMap(part => part.files.filter(file =>
    modelRoles.includes(file.role)))].map(file => file.storedPath))];
  for (let offset = 0; offset < sourceFiles.length; offset += 4) {
    const batch = sourceFiles.slice(offset, offset + 4);
    const results = await Promise.allSettled(batch.map(relative => managedFile(asset, relative)));
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') throw results[i].reason;
      managedSources.set(batch[i], results[i].value);
    }
  }
  const groups = new Map();
  for (const file of textures) {
    const match = /_(D|N|ORM|A|E|Emissive|Emission)\.[^.]+$/i.exec(file.normalizedName || '');
    if (!match) throw new Error('待指定贴图类型：' + file.normalizedName);
    const rawGroup = materialGroup(file.materialName || file.normalizedName.replace(/\.[^.]+$/, ''), name);
    const group = weapon && rawGroup.toLowerCase() === name.toLowerCase() ? '' : monster && /^[A-Za-z0-9_]+$/.test(rawGroup) ? rawGroup : safeName(rawGroup);
    const groupKey = token(group) || 'main';
    const channel = /^e/i.test(match[1]) ? 'E' : match[1].toUpperCase();
    const weaponSubject = monster ? monsterWeaponSubject(file, name) : '';
    if (!groups.has(groupKey)) groups.set(groupKey, { name: weaponSubject || group, key: groupKey, monsterWeapon: Boolean(weaponSubject), files: [] });
    const record = groups.get(groupKey);
    const previous = record.files.find(item => item.channel === channel);
    if (previous) {
      // Legacy manifests can list the same archived texture twice (once from a
      // material slot, once from the source package). This is one UE resource.
      if (normalize(managedSources.get(previous.file.storedPath).sourcePath) === normalize(managedSources.get(file.storedPath).sourcePath)) continue;
      throw new Error('同材质组贴图类型重复：' + group + '/' + channel + '（' + previous.file.normalizedName + '、' + file.normalizedName + '）');
    }
    record.files.push({ file, channel });
  }
  const usedGroups = new Set();
  const materialRequests = [];
  for (const part of selectedParts) {
    // Static meshes are sent only when explicitly requested; content inspection
    // still determines the actual mesh kind, including unclassified legacy files.
    for (const file of part.files.filter(file => modelRoles.includes(file.role))) {
      if (!/\.fbx$/i.test(file.normalizedName)) throw new Error('套装 UE 模型目前需 FBX：' + file.normalizedName);
      const source = managedSources.get(file.storedPath);
      const analysis = await inspectCharacterModel(source.sourcePath, analyze);
      if (analysis.error || !analysis.meshKind) throw new Error('FBX 内容读取失败：' + file.normalizedName);
      const kind = analysis.meshKind;
      if (kind === 'staticMesh' && options.includeStaticMeshes !== true) continue;
      if (!['staticMesh', 'skeletalMesh'].includes(kind)) throw new Error('不支持的模型类型：' + file.normalizedName);
      if (kind === 'skeletalMesh' && (!analysis.hasSkin || !analysis.skinnedMeshCount)) throw new Error('文件有骨骼但没有可导入的蒙皮模型：' + file.normalizedName);
      const sourceSubject = file.normalizedName.replace(/\.[^.]+$/, '').replace(/^(?:SM|SK)_/i, '');
      const subject = weapon && sourceSubject.toLowerCase() === name.toLowerCase() ? '' : sourceSubject.replace(new RegExp('^' + name + '_', 'i'), '');
      const weaponSubject = monster ? monsterWeaponSubject(file, name) : '';
      const outputSubject = weaponSubject || subject;
      const resourceRoot = weaponSubject ? `${targetRoot}/Weapon` : targetRoot;
      const meshName = safeName(`${kind === 'skeletalMesh' ? 'SK' : 'SM'}_${name}${outputSubject ? '_' + outputSubject : ''}`);
      const meshKey = `${assetId}:${kind}:${token(subject) || 'main'}`;
      const materials = {};
      const externalMaterials = {};
      const sharedMaterialSlots = [];
      const unresolvedMaterials = [];
      for (const original of analysis.materialNames || []) {
        const shared = ownSkeleton ? '' : sharedCharacterMaterial(original, fields);
        if (shared) { externalMaterials[original] = shared; sharedMaterialSlots.push(original); continue; }
        const mappingKey = `${meshKey}|${original}`;
        const chosen = options.materialMappings?.[mappingKey];
        if (chosen?.startsWith('/Game/')) { externalMaterials[original] = chosen; continue; }
        const findCandidates = value => [...groups.values()].filter(group => {
          const normalized = token(value.replace(/(?:SG|Material)$/i, ''));
          return normalized === group.key || normalized.endsWith(group.key)
            || (Boolean(weaponSubject) === Boolean(group.monsterWeapon) && group.monsterWeapon && normalized.endsWith(token(group.name)));
        }).sort((a, b) => b.key.length - a.key.length);
        const directCandidates = findCandidates(original);
        const indexedCandidates = directCandidates.length ? [] : findCandidates(original.replace(/_\d+$/i, ''));
        const candidates = directCandidates.length ? directCandidates : indexedCandidates.length === 1 ? indexedCandidates : [];
        const group = chosen?.startsWith('group:') ? groups.get(chosen.slice(6))
          : candidates.length && !(candidates.length > 1 && candidates[0].key.length === candidates[1].key.length) ? candidates[0] : weapon && groups.size === 1 ? [...groups.values()][0] : null;
        if (!group) {
          unresolvedMaterials.push(original);
          materialRequests.push({ key: mappingKey, meshName, slot: original, groups: [...groups.values()].map(g => ({ key: g.key, name: g.name })) });
          continue;
        }
        usedGroups.add(group.key);
        materials[original] = `${assetId}:material:${group.key}`;
      }
      if (!weapon && !(analysis.materialNames || []).length) unresolvedMaterials.push('模型未提供材质槽');
      entries.push({ key: meshKey, kind, name: meshName, partSlot: part.slot,
        targetPath: `${resourceRoot}/Mesh/${kind === 'skeletalMesh' ? 'SkeletalMesh' : 'StaticMesh'}/${meshName}`,
        ...source, materials, externalMaterials, sharedMaterialSlots, unresolvedMaterials, bones: analysis.bones || [],
        ...(kind === 'skeletalMesh' ? { skeletonPath: ownSkeleton ? `${resourceRoot}/Mesh/SkeletalMesh/SKEL_${name}${outputSubject ? '_' + outputSubject : ''}` : String(options.skeletonPath || DEFAULT_SKELETON) } : {}),
        config: { version: VERSION, family, ...(ownSkeleton && kind === 'skeletalMesh' ? { ownSkeleton: true,
          physicsAssetPath: `${resourceRoot}/Mesh/SkeletalMesh/SK_${name}${outputSubject ? '_' + outputSubject : ''}_Physics` } : {}),
          importAnimations: false, createPhysicsAsset: ownSkeleton && kind === 'skeletalMesh', updateReferencePose: false } });
    }
  }
  if (!selectedSlot) for (const group of groups.values()) usedGroups.add(group.key);
  for (const groupKey of usedGroups) {
    const group = groups.get(groupKey);
    const resourceRoot = group.monsterWeapon ? `${targetRoot}/Weapon` : targetRoot;
    const textureKeys = {};
    for (const { file, channel } of group.files) {
      const textureName = safeName(`T_${name}${group.name ? '_' + group.name : ''}_${channel}`);
      const key = `${assetId}:texture:${groupKey}:${channel}`;
      textureKeys[channel] = key;
      const source = managedSources.get(file.storedPath);
      let validationError = '';
      if (channel === 'N') {
        try {
          if (!alphaChecks.has(hasAlpha)) alphaChecks.set(hasAlpha, new Map());
          const cache = alphaChecks.get(hasAlpha);
          if (!cache.has(source.sourceHash)) {
            if (cache.size >= 256) cache.delete(cache.keys().next().value);
            cache.set(source.sourceHash, await inspectCharacterNormalAlpha(source, hasAlpha, hasAlpha === defaultHasAlpha));
          }
          if (cache.get(source.sourceHash)) validationError = '法线图含额外 Alpha 数据，请先确认用途；Normalmap 压缩会丢弃此通道';
        }
        catch (error) { validationError = '法线图读取失败：' + error.message; }
      }
      entries.push({ key, kind: 'texture', name: textureName, groupName: group.name || name, channel, targetPath: `${resourceRoot}/${ownSkeleton ? 'Texture' : 'Textures'}/${textureName}`,
        ...source, validationError, config: { version: VERSION, ...(channel === 'N' ? { normalFormat: options.normalFormat || asset.meta.normalMapFormat || 'unknown' } : {}),
          family, virtualTexture: !(weapon || group.monsterWeapon), maxSize: 0, lodBias: 0, preserveAlpha: true } });
    }
    const materialName = `MI_${name}${group.name ? '_' + group.name : ''}`;
    const materialKey = `${assetId}:material:${groupKey}`;
    const bodyMaterial = monster && !group.monsterWeapon;
    const selectedType = bodyMaterial ? options.monsterMaterialTypes?.[materialKey] : '';
    if (selectedType && !['cloth', 'skin'].includes(selectedType)) throw new Error('无效的怪物材质类型');
    const materialType = bodyMaterial ? selectedType || inferMonsterMaterialType(group.name) : '';
    entries.push({ key: materialKey, kind: 'material', name: materialName, groupName: group.name,
      ...(bodyMaterial ? { materialType, validationError: materialType ? '' : '无法确定材质类型，请选择衣服或皮肤' } : {}),
      targetPath: `${resourceRoot}/${ownSkeleton ? 'Material' : 'Materials'}/${materialName}`, textures: textureKeys,
      config: weapon || group.monsterWeapon ? { version: VERSION, family,
        ...(group.monsterWeapon ? { materialRole: 'monsterWeapon' } : {}),
        parentPath: `/Game/MaterialLibrary/Weapon/Common/${group.monsterWeapon ? 'M_Weapon_Monster' : 'M_Weapon_Slab'}`,
        virtualTexture: false, useOpacityMasked: Boolean(textureKeys.A) }
        : monster ? (() => {
          const materialRole = materialType === 'skin' ? 'monsterSkin' : 'monsterCloth';
          return { version: VERSION, family, materialRole,
            parentPath: materialRole === 'monsterSkin' ? MONSTER_SKIN_TEMPLATE : MONSTER_CLOTH_TEMPLATE,
            virtualTexture: true, useOpacityMasked: Boolean(textureKeys.A) };
        })()
          : { version: VERSION, family, parentPath: `/Game/MaterialLibrary/Character/MI_Suit_ComplexShading/MI_Char_Suit_ComplexShading${textureKeys.A ? '_Masked' : ''}_VT` } });
  }
  if (new Set(entries.map(entry => entry.key)).size !== entries.length) throw new Error('导出身份重复，请核对部件/LOD');
  for (const entry of entries) entry.fingerprint = hash({ sourceHash: entry.sourceHash, config: entry.config,
    skeletonPath: entry.skeletonPath, materials: entry.materials, externalMaterials: entry.externalMaterials, textures: entry.textures });
  entries.sort((a, b) => ['texture', 'material', 'staticMesh', 'skeletalMesh'].indexOf(a.kind) - ['texture', 'material', 'staticMesh', 'skeletalMesh'].indexOf(b.kind));
  return { assetId, name, targetRoot, selectedSlot, family, entries, materialRequests, manifestHash: hash(entries) };
}

async function deletedSuitOwners(root, assets) {
  if (!root) return [];
  const library = await fs.realpath(root);
  const within = value => [library, path.resolve(root)].some(base => {
    const relative = path.relative(base, path.resolve(value));
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  });
  if (!assets.every(asset => within(asset.path))) return [];
  const current = new Set(assets.map(asset => String(asset.id)));
  const deleted = [];
  for (const record of await listPermanentlyDeletedAssets(library)) {
    if (current.has(record.assetId) || !record.path || !within(record.path)) continue;
    try { await fs.stat(record.path); }
    catch (error) { if (error.code === 'ENOENT') deleted.push(record.assetId); }
  }
  return [...new Set(deleted)].sort();
}

async function sendSuitJob(assets, options, onProgress, client) {
  const editor = await client.getEditorInfo();
  if (!editor?.capabilities?.includes('characterSuitV1')) throw new Error('请编译并加载支持套装导入的 AssetHive 插件');
  if (options.unrealProjectPath && normalize(options.unrealProjectPath) !== normalize(editor.projectPath)) throw new Error('连接的 UE 工程与所选目标不一致');
  const suits = [];
  const projectKey = hash(normalize(editor.projectPath));
  const effectiveOptions = new Map();
  for (const asset of new Map(assets.map(asset => [asset.id, asset])).values()) {
    const saved = asset.meta?.characterUnrealExports?.[projectKey]?.options || {};
    const selected = mergeSuitExportOptions(saved, options.suitOptions);
    effectiveOptions.set(asset.id, selected);
    const startedAt = Date.now();
    onProgress?.({ percent: 0, message: `正在检查 ${asset.name} 的模型与贴图…` });
    suits.push(await buildSuitExport(asset, selected));
    console.info(`[SuitExport] manifest ${asset.id}: ${Date.now() - startedAt}ms`);
  }
  // Selecting an owner and its parts (or multiple parts) must never duplicate a resource.
  const uniqueSuits = new Map();
  for (const suit of suits) {
    const previous = uniqueSuits.get(suit.assetId);
    if (!previous) uniqueSuits.set(suit.assetId, suit);
    else {
      previous.entries = [...new Map([...previous.entries, ...suit.entries].map(entry => [entry.key, entry])).values()];
      previous.materialRequests = [...new Map([...previous.materialRequests, ...suit.materialRequests].map(entry => [entry.key, entry])).values()];
      previous.selectedSlot = !previous.selectedSlot || !suit.selectedSlot ? '' : previous.selectedSlot;
    }
  }
  const mergedSuits = [...uniqueSuits.values()];
  for (const suit of mergedSuits) suit.entries.sort((a, b) => ['texture', 'material', 'staticMesh', 'skeletalMesh'].indexOf(a.kind) - ['texture', 'material', 'staticMesh', 'skeletalMesh'].indexOf(b.kind));
  const phase = options.suitPhase === 'apply' ? 'apply' : 'inspect';
  if (phase === 'apply' && options.suitManifestHash !== hash(mergedSuits)) throw new Error('资源在检查后已变化，请重新检查');
  onProgress?.({ percent: 0, message: phase === 'inspect' ? '正在核对 UE 中的整套资源…' : '正在发送整套中新增或变化的资源…' });
  const ueStartedAt = Date.now();
  const deletedOwnerIds = await deletedSuitOwners(options.customLibraryPath, assets);
  const reply = await client.importAssets({ characterSuit: { version: VERSION, phase, suits: mergedSuits,
    deletedOwnerIds, decisions: options.suitDecisions || {}, inspectToken: options.suitInspectToken || '' } }, { projectPath: editor.projectPath, onProgress });
  console.info(`[SuitExport] UE ${phase}: ${Date.now() - ueStartedAt}ms`);
  const result = reply.suitResult;
  if (result?.error) throw new Error(result.error);
  if (!result || !Array.isArray(result.entries)) throw new Error('插件没有返回套装逐项结果');
  const manifestEntries = new Map(mergedSuits.flatMap(suit => suit.entries).map(entry => [entry.key, entry]));
  result.entries = result.entries.map(row => ({ ...row, groupName: manifestEntries.get(row.key)?.groupName,
    partSlot: manifestEntries.get(row.key)?.partSlot || row.partSlot }));
  {
    for (const asset of new Map(assets.map(asset => [asset.id, asset])).values()) {
      const suit = uniqueSuits.get(asset.id);
      const rows = result.entries.filter(row => row.assetId === asset.id);
      if (phase === 'inspect' && !asset.meta?.characterUnrealExports?.[projectKey]) continue;
      await updateAssetMetadataFile(asset.metaPath, meta => {
        const receipts = meta.characterUnrealExports || {};
        const previous = receipts[projectKey] || { entries: {} };
        if (phase === 'inspect') recordUEPresenceChanges(meta, previous,
          rows.filter(row => row.status === 'missing').map(row => ({ key: row.key, present: false, path: '' })), editor.projectPath);
        const next = { ...previous.entries };
        for (const row of rows) {
          const success = ['success', 'unchanged'].includes(row.status) && row.action !== 'retained';
          next[row.key] = { ...next[row.key], ...row,
            ...(phase === 'apply' && success ? { lastSuccessPath: row.path, lastSuccessAt: new Date().toISOString(), missingInUE: false, livePath: row.path } : {}),
            ...(row.status === 'missing' ? { missingInUE: true, livePath: '' } : {}) };
        }
        const successful = rows.filter(row => ['success', 'unchanged'].includes(row.status) && row.action !== 'retained');
        receipts[projectKey] = { ...previous, projectPath: editor.projectPath, entries: next, checkedAt: new Date().toISOString(),
          ...(phase === 'apply' && successful.length ? { targetRoot: suit.targetRoot } : {}),
          ...(phase === 'apply' ? { options: effectiveOptions.get(asset.id) } : {}) };
        meta.characterUnrealExports = receipts;
        if (phase === 'apply' && successful.length && !suit.selectedSlot) meta.enginePath = suit.targetRoot;
        // Inspection, partial sends and kept/skipped UE resources do not confirm a rename.
        // A later rename during the send must retain its own pending reminder.
        const nameRevision = asset.meta?.character?.ueNameSyncPending;
        const succeededKeys = new Set(successful.map(row => row.key));
        if (phase === 'apply' && nameRevision && meta.character?.ueNameSyncPending === nameRevision
          && !suit.selectedSlot && suit.entries.length > 0
          && suit.entries.every(entry => succeededKeys.has(entry.key))
          && Object.values(previous.entries).every(entry => !entry.lastSuccessPath || succeededKeys.has(entry.key))) {
          delete meta.character.ueNameSyncPending;
        }
        if (phase === 'apply' && rows.some(row => row.status !== 'unchanged')) {
          const contentUpdatedAt = meta.characterManifest?.contentUpdatedAt;
          const summary = meta.characterManifest?.lastUpdateSummary;
          appendCharacterUpdateHistory(meta, { label: '发送到 UE', changes: rows, details: { projectPath: editor.projectPath },
            files: rows.map(row => ({ name: row.name, status: row.status, action: row.action, message: row.status === 'success' && row.action === 'restore' ? '重新导入（UE 中原资源已删除）' : row.message || row.action, uePath: row.path || row.targetPath })) });
          if (meta.characterManifest) { meta.characterManifest.contentUpdatedAt = contentUpdatedAt; meta.characterManifest.lastUpdateSummary = summary; }
        }
        return meta;
      });
    }
  }
  const monsterMaterialGroups = mergedSuits.flatMap(suit => suit.entries.filter(entry => entry.kind === 'material'
    && ['monsterCloth', 'monsterSkin'].includes(entry.config.materialRole)).map(entry => ({
      key: entry.key, name: entry.groupName || suit.name, assetName: suit.name, type: entry.materialType || ''
    })));
  return { ok: true, suitResult: { ...result, monsterMaterialGroups, materialRequests: mergedSuits.flatMap(suit => suit.materialRequests), projectPath: editor.projectPath, manifestHash: hash(mergedSuits), phase },
    message: phase === 'inspect' ? '套装检查完成' : '套装逐项处理完成' };
}

function isSuitAsset(asset) {
  return asset?.assetType === 'suit';
}

function isCharacterUEAsset(asset) { return isSuitAsset(asset) || ['weapon', 'monster'].includes(asset?.assetType); }

async function refreshSuitStatus(asset, options, client) {
  if (!isCharacterUEAsset(asset) || !asset.meta?.characterUnrealExports) return false;
  const editor = await client.getEditorInfo();
  if (!editor?.capabilities?.includes('characterSuitV1')) return false;
  if (options.unrealProjectPath && normalize(options.unrealProjectPath) !== normalize(editor.projectPath)) return false;
  const projectKey = hash(normalize(editor.projectPath));
  if (!asset.meta.characterUnrealExports[projectKey]) return false;
  const reply = await client.importAssets({ characterSuit: { version: VERSION, phase: 'status', suits: [{ assetId: asset.id }] } }, { projectPath: editor.projectPath });
  if (reply.suitResult?.error || !Array.isArray(reply.suitResult?.entries)) return false;
  const updates = reply.suitResult.entries.filter(row => row.assetId === asset.id && typeof row.present === 'boolean');
  const current = asset.meta.characterUnrealExports[projectKey].entries || {};
  if (!updates.some(row => current[row.key] && (current[row.key].missingInUE !== !row.present || current[row.key].livePath !== row.path))) return false;
  await updateAssetMetadataFile(asset.metaPath, meta => {
    const receipt = meta.characterUnrealExports?.[projectKey];
    if (!receipt) return meta;
    recordUEPresenceChanges(meta, receipt, updates, editor.projectPath);
    for (const row of updates) if (receipt.entries[row.key]) {
      receipt.entries[row.key] = { ...receipt.entries[row.key], missingInUE: !row.present, livePath: row.path };
    }
    receipt.checkedAt = new Date().toISOString();
    return meta;
  });
  return true;
}

module.exports = { inferMonsterMaterialType, mergeSuitExportOptions, deletedSuitOwners, buildSuitExport, sendSuitJob, refreshSuitStatus, recordUEPresenceChanges, managedFile, materialGroup, isSuitAsset, isCharacterUEAsset,
  clearCharacterExportInspection: () => { alphaChecks = new WeakMap(); } };
