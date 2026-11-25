const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const projectIdentity = require('./characterProjectIdentity');
const { ownedWeaponIdentity } = require('../../shared/ownedWeaponNaming.mjs');
const { gameplayIdentity, gameplayPrefix, gameplayFileStem } = require('../../shared/gameplayNaming.mjs');
const { applySkeletonOptions } = require('../../shared/characterSkeletonOptions.cjs');
const { inspectCharacterFile, inspectCharacterModel, inspectCharacterNormalAlpha } = require('./characterFileInspection');
const { activeCharacterFiles, listCharacterComponents, characterModelPreviewComponents } = require('../../shared/characterComponents.mjs');
const { weaponTargetRoot, weaponSideInternal, weaponPackageOutput } = require('../../shared/weaponRules.mjs');
const { analyzeFbxInWorker } = require('./modelAnalysis');
const { updateAssetMetadataFile } = require('./assetMetadata');
const { appendCharacterUpdateHistory } = require('./characterUpdateHistory');
const { runImageTask } = require('./imageTasks');
const { listPermanentlyDeletedAssets } = require('./characterDeletion');
const { characterTextureChannel } = require('../../shared/characterFilePolicy.mjs');
const { inferCharacterTextureGroup, canonicalizeCharacterPart } = require('./characterImport');
const { boundedMap } = require('./boundedMap');
const { matchSuitMaterialSlot, suitMaterialChoiceKey } = require('../../shared/suitMaterialMatching.mjs');
const { heroSuitPart } = require('../../shared/heroPackageRules.mjs');

const VERSION = 1;
const ROOT = '/Game/Characters/Hero/Asset_PJZ';
const MONSTER_CATEGORIES = { boss: '1_Boss', miniboss: '2_MiniBoss', elite: '3_Elite', normal: '4_NormalMonster', normalmonster: '4_NormalMonster', minion: '5_Minion' };
const MONSTER_CLOTH_TEMPLATE = '/Game/MaterialLibrary/Character/Common/M_Char_Monster_ComplexShading';
const MONSTER_SKIN_TEMPLATE = '/Game/MaterialLibrary/Character/Common/M_Char_Monster_skin';
const ITEM_TEMPLATE = '/Game/MaterialLibrary/Character/Common/M_GamePlayItem_Base_VT';
const ITEM_MASKED_TEMPLATE = '/Game/MaterialLibrary/Character/Common/M_GamePlayItem_Base_Masked_VT';
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
  return String(name || '').replace(/^(?:MI|M|T)_/i, '').replace(/_(ShadingMask|D|N|ORM|A|O|Opacity|OpacityMask|E|Emissive|Emission|SS|SSC|Dis|Root|ID|Height|Depth|Tangent|Flow|Scatter|SRMF|Mask)$/i, '').replace(new RegExp('^' + parentName + '_', 'i'), '');
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
  file = { ...file, normalizedName: require('../../shared/characterLods.cjs').strip(file.normalizedName) };
  const owned = ownedWeaponIdentity(String(file.normalizedName || '').replace(/\.[^.]+$/, ''), ownerName);
  if (owned) return owned.suffix.replace(/_(?:ShadingMask|D|N|ORM|A|E|Emissive|Emission)$/i, '');
  const stem = String(file.normalizedName || file.storedPath || '').replaceAll('\\', '/').split('/').pop().replace(/\.[^.]+$/, '')
    .replace(/^(?:SM|SK|SKEL|MI|M|T)_/i, '').replace(/_(?:ShadingMask|D|N|ORM|A|E|Emissive|Emission)$/i, '');
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
  // Scoped to one manifest build: checking/applying again still validates every
  // file stamp, while LOD attachment reuses the same already checked sources.
  const sources = new Map();
  const resolveSource = (owner, relative) => {
    if (!sources.has(relative)) sources.set(relative, managedFile(owner, relative));
    return sources.get(relative);
  };
  const result = await buildSuitExportBase(asset, options, analyze, hasAlpha, resolveSource);
  const outputWeaponName = value => weaponPackageOutput(value, result.name);
  result.entries = result.entries.map(entry => {
    if (asset.assetType === 'weapon' && outputWeaponName(entry.name) !== entry.name) {
      const outputPath = value => value ? value.slice(0, value.lastIndexOf('/') + 1) + outputWeaponName(value.slice(value.lastIndexOf('/') + 1)) : value;
      entry = { ...entry, name: outputWeaponName(entry.name), targetPath: outputPath(entry.targetPath),
        skeletonPath: outputPath(entry.skeletonPath), config: { ...entry.config,
          ...(entry.config.physicsAssetPath ? { physicsAssetPath: outputPath(entry.config.physicsAssetPath) } : {}) } };
      entry.fingerprint = hash({ sourceHash: entry.sourceHash, config: entry.config,
        skeletonPath: entry.skeletonPath, materials: entry.materials, externalMaterials: entry.externalMaterials, textures: entry.textures });
    }
    const next = applySkeletonOptions(entry, options);
    if (next === entry) return entry;
    return { ...next, fingerprint: hash({ sourceHash: next.sourceHash, config: next.config,
      skeletonPath: next.skeletonPath, materials: next.materials, externalMaterials: next.externalMaterials,
      textures: next.textures, heroSharedRoles: next.heroSharedRoles }) };
  });
  await require('./characterLodExport').attachCharacterLods(result, asset, options, analyze, resolveSource);
  // An adopted UE object can have a historical filename/location. Keep that
  // destination until the owner is actually renamed; editing bytes is not a move.
  const intake = asset.meta?.characterUEIntake;
  if (intake?.assetName === result.name) {
    for (const entry of result.entries) {
      const original = intake.resources?.[entry.key];
      if (original?.kind === entry.kind && original.path?.startsWith(intake.enginePath + '/')) {
        entry.targetPath = original.path;
        entry.name = original.path.slice(original.path.lastIndexOf('/') + 1);
        // Recovered monster meshes already have a rig (and may deliberately
        // have no physics asset). Do not propose new helpers during linking.
        const skeletonChoice = options.skeletonOverrides?.[entry.key] || options.skeletonSelection;
        if (entry.kind === 'skeletalMesh' && original.skeletonPath?.startsWith('/Game/')
          && (!skeletonChoice || skeletonChoice.mode === 'auto')) {
          entry.skeletonPath = original.skeletonPath.split('.')[0];
          entry.config = { ...entry.config, ownSkeleton: false, skeletonOverride: 'existing',
            skeletonOverridePath: entry.skeletonPath, createPhysicsAsset: false,
            physicsAssetPath: String(original.physicsAssetPath || '').split('.')[0] };
          entry.fingerprint = hash({ sourceHash: entry.sourceHash, config: entry.config,
            skeletonPath: entry.skeletonPath, materials: entry.materials, externalMaterials: entry.externalMaterials,
            textures: entry.textures, heroSharedRoles: entry.heroSharedRoles });
        }
      }
    }
  }
  result.manifestHash = hash(result.entries);
  if (asset.assetType === 'weapon') result.materialRequests = result.materialRequests.map(request => ({ ...request, meshName: outputWeaponName(request.meshName) }));
  return result;
}

async function buildSuitExportBase(asset, options = {}, analyze = analyzeFbxInWorker, hasAlpha = defaultHasAlpha, managedFile) {
  const fields = asset.meta?.character || {};
  if (asset.assetType === 'suit' && ['Hair', 'Face'].includes(fields.variant)) return require('./heroPartExport').buildHeroPartExport(asset, options, analyze, managedFile);
  const weapon = asset.assetType === 'weapon';
  const item = asset.assetType === 'item';
  const npc = asset.assetType === 'npc';
  const monster = asset.assetType === 'monster' || npc;
  const family = item ? 'item' : npc ? 'npc' : monster ? 'monster' : weapon ? 'weapon' : 'suit';
  const ownSkeleton = weapon || monster || item;
  if (!isCharacterUEAsset(asset)) throw new Error('本入口用于套装、脸部、头发、武器、怪物、NPC 和玩法物件');
  if (!ownSkeleton && (!['Male', 'Female'].includes(fields.gender) || !/^\d{2}$/.test(fields.bodyCode || ''))) throw new Error('请先确认套装性别与体型编号');
  const itemCategory = String(asset.meta?.category || asset.category || '');
  const modernItem = item && Boolean(gameplayPrefix(itemCategory));
  const sourceName = asset.meta?.name || asset.name;
  const name = safeName(modernItem ? gameplayIdentity(itemCategory, fields.displayNameEn || fields.name || sourceName).assetName : monster ? fields.name || sourceName.replace(/^(SM|SK)_/i, '').replace(/_\d{2}$/, '') : sourceName);
  const assetId = String(asset.id);
  const npcCategory = npc && require('../../shared/npcCategories.mjs').normalizeNpcCategory(asset.meta?.category || fields.category || asset.category || '');
  const monsterCategory = npc ? safeName(({ Human: 'H', Nonhuman: 'NH' })[npcCategory] || npcCategory) : monster && MONSTER_CATEGORIES[token(asset.meta?.category || asset.category).replace(/^\d+/, '')];
  if (monster && !monsterCategory) throw new Error('请先确认怪物类别');
  // UE directories use the category label and AssetHive name. The AssetHive
  // identity, serial/form metadata and managed filenames remain unchanged.
  const monsterFolder = monster ? `${monsterCategory.replace(/^\d_/, '')}_${name}` : name;
  // New classification paths are library metadata; UE subfolder mapping is not configured yet.
  // Preserve existing legacy destinations so an update does not move an imported asset.
  const itemRoot = !item || itemCategory.includes('/') ? '/Game/Characters/GameplayItem' : `/Game/Characters/GameplayItem/${safeName(itemCategory)}`;
  const variant = monster ? String(fields.monsterVariant || '').trim() : '';
  const outputName = variant ? safeName(variant.toLowerCase().startsWith(name.toLowerCase() + '_') ? variant : `${name}_${variant}`) : name;
  const targetRoot = item ? `${itemRoot}/${name}` : monster ? `/Game/Characters/${npc ? 'NPC' : 'Monster'}/${monsterCategory}/${monsterFolder}` : weapon ? weaponTargetRoot(name) : `${ROOT}/${fields.gender}_${fields.bodyCode}/Mesh/${name}`;
  // Variants are optional children of Mesh. Forms remain filename suffixes,
  // never extra directories. Independent weapon/item layouts are unchanged.
  const monsterMeshRoot = `${targetRoot}/Mesh${variant ? '/' + outputName : ''}`;
  const outputSuffix = value => {
    if (!variant) return value;
    const suffix = outputName.slice(name.length + 1);
    return value.toLowerCase() === suffix.toLowerCase() ? '' : value.replace(new RegExp('^' + suffix + '_', 'i'), '');
  };
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
  let checkedFiles = 0;
  await boundedMap(sourceFiles, 4, async relative => {
    managedSources.set(relative, await managedFile(asset, relative));
    options.onPreparationProgress?.(++checkedFiles / sourceFiles.length * 0.6, `正在检查文件 ${checkedFiles}/${sourceFiles.length}`);
  });
  const modelFiles = selectedParts.flatMap(part => part.files.filter(file => modelRoles.includes(file.role)
    && !require('../../shared/characterLods.cjs').level(file.normalizedName || file.storedPath)));
  const modelAnalyses = new Map();
  let checkedModels = 0;
  await boundedMap(modelFiles, 3, async file => {
    if (!/\.fbx$/i.test(file.normalizedName)) throw new Error('套装 UE 模型目前需 FBX：' + file.normalizedName);
    const source = managedSources.get(file.storedPath);
    modelAnalyses.set(file.storedPath, await inspectCharacterModel(source.sourcePath, analyze));
    options.onPreparationProgress?.(0.6 + ++checkedModels / modelFiles.length * 0.3, `正在检查模型 ${checkedModels}/${modelFiles.length}`);
  });
  const groups = new Map();
  for (const file of textures) {
    const legacyMap = /_MAP\.[^.]+$/i.test(file.normalizedName || '');
    const channel = characterTextureChannel(legacyMap ? file.originalName : file.normalizedName, legacyMap ? file.textureType : '');
    if (!channel) throw new Error('待指定贴图类型：' + file.normalizedName);
    // Earlier outfit imports lost auxiliary map channels and assigned a default
    // material group. Recover only from the recorded original name, not image color.
    const recoveredGroup = legacyMap && family === 'suit' ? inferCharacterTextureGroup(file.originalName) : '';
    const groupSource = recoveredGroup ? `MI_${name}_${canonicalizeCharacterPart(recoveredGroup, fields.suitName)}`
      : modernItem ? gameplayFileStem(name, 'texture', file.normalizedName.replace(/\.[^.]+$/, ''), [sourceName, fields.name]) : file.materialName || file.normalizedName.replace(/\.[^.]+$/, '');
    const rawGroup = materialGroup(weapon ? weaponSideInternal(groupSource, name) : groupSource, name);
    const group = (weapon || item) && rawGroup.toLowerCase() === name.toLowerCase() ? '' : monster && /^[A-Za-z0-9_]+$/.test(rawGroup) ? rawGroup : safeName(rawGroup);
    const groupKey = token(group) || 'main';
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
  if (item && !groups.size) groups.set('main', { name: '', key: 'main', files: [] });
  const usedGroups = new Set();
  const materialRequests = [];
  for (const part of selectedParts) {
    // Static meshes are sent only when explicitly requested; content inspection
    // still determines the actual mesh kind, including unclassified legacy files.
    for (const file of part.files.filter(file => modelRoles.includes(file.role) && !require('../../shared/characterLods.cjs').level(file.normalizedName || file.storedPath))) {
      if (!/\.fbx$/i.test(file.normalizedName)) throw new Error('套装 UE 模型目前需 FBX：' + file.normalizedName);
      const source = managedSources.get(file.storedPath);
      const analysis = modelAnalyses.get(file.storedPath);
      if (analysis.error || !analysis.meshKind) throw new Error('FBX 内容读取失败：' + file.normalizedName);
      const kind = analysis.meshKind;
      if (kind === 'staticMesh' && options.includeStaticMeshes !== true) continue;
      if (!['staticMesh', 'skeletalMesh'].includes(kind)) throw new Error('不支持的模型类型：' + file.normalizedName);
      if (kind === 'skeletalMesh' && (!analysis.hasSkin || !analysis.skinnedMeshCount)) throw new Error('文件有骨骼但没有可导入的蒙皮模型：' + file.normalizedName);
      const baseFileName = require('../../shared/characterLods.cjs').strip(file.normalizedName);
      const fileStem = modernItem ? gameplayFileStem(name, kind, baseFileName.replace(/\.[^.]+$/, ''), [sourceName, fields.name]) : baseFileName.replace(/\.[^.]+$/, '');
      const sourceSubject = (weapon ? weaponSideInternal(fileStem, name) : fileStem).replace(/^(?:SM|SK)_/i, '');
      const subject = (weapon || item) && sourceSubject.toLowerCase() === name.toLowerCase() ? '' : sourceSubject.replace(new RegExp('^' + name + '_', 'i'), '');
      const weaponSubject = monster ? monsterWeaponSubject(file, name) : '';
      const outputSubject = weaponSubject || outputSuffix(subject);
      const resourceRoot = monster ? `${monsterMeshRoot}${weaponSubject ? '/Weapon' : ''}` : weaponSubject ? `${targetRoot}/Weapon` : targetRoot;
      const componentFolder = weapon && selectedParts.length > 1 && outputSubject ? '/' + safeName(outputSubject) : '';
      const meshDirectory = monster && !weaponSubject ? resourceRoot : `${resourceRoot}/Mesh`;
      const skeletalDirectory = `${meshDirectory}/SkeletalMesh${componentFolder}`;
      const meshName = safeName(`${kind === 'skeletalMesh' ? 'SK' : 'SM'}_${weaponSubject && !monster ? 'WP_' : ''}${outputName}${outputSubject ? '_' + outputSubject : ''}`);
      const meshKey = `${assetId}:${kind}:${token(subject) || 'main'}`;
      const materials = {};
      const externalMaterials = {};
      const linkMaterialPaths = {};
      const sharedMaterialSlots = [];
      const unresolvedMaterials = [];
      const blockout = options.materialMode === 'blockout' && !options.linkOnly;
      for (const original of (analysis.materialNames?.length ? analysis.materialNames : blockout ? ['DefaultMaterial'] : [])) {
        if (blockout) {
          const materialKey = `${meshKey}:blockout:${hash(original).slice(0, 16)}:mi`;
          const materialName = `MI_BO_${meshName}_${hash(original).slice(0, 12)}`;
          const appearance = analysis.sourceMaterials?.[original] || { color: [1, 1, 1], opacity: 1, emissive: [0, 0, 0], roughness: 1 };
          materials[original] = materialKey;
          entries.push({ key: materialKey, kind: 'material', name: materialName, partSlot: part.slot,
            targetPath: `${resourceRoot}/Material/Blockout/${materialName}`, textures: {},
            sourceHash: hash(appearance), config: { version: VERSION, family, parentPath: '/Game/MaterialLibrary/Character/Common/M_Blockout', blockoutMaterial: appearance, blockoutInstanceVersion: 1 } });
          continue;
        }
        const mappingKey = `${meshKey}|${original}`;
        const recovered = asset.meta?.characterUEIntake?.materialBindings?.[mappingKey];
        const importChoice = family === 'suit' && fields.materialSlotMappings?.[suitMaterialChoiceKey(heroSuitPart(file.normalizedName), original)];
        // Explicit user choices win. Adopted slots otherwise retain the actual
        // UE material (including shared resources and hand-authored parameters).
        if (!options.materialMappings?.[mappingKey] && !importChoice && asset.meta?.characterUEIntake?.preserveMaterialBindings
          && /^\/(?:Game|Engine)\//.test(recovered || '')) {
          if (recovered.startsWith('/Game/')) externalMaterials[original] = recovered;
          else linkMaterialPaths[original] = recovered;
          // Engine placeholders are not owned materials and need no binding.
          continue;
        }
        const shared = ownSkeleton ? '' : sharedCharacterMaterial(original, fields);
        if (shared) { externalMaterials[original] = shared; sharedMaterialSlots.push(original); continue; }
        const chosen = options.materialMappings?.[mappingKey] || (importChoice ? `group:${importChoice}` : '');
        if (chosen?.startsWith('/Game/')) { externalMaterials[original] = chosen; continue; }
        const findCandidates = value => [...groups.values()].filter(group => {
          const normalized = token(value.replace(/(?:SG|Material)$/i, ''));
          return normalized === group.key || normalized.endsWith(group.key)
            || (Boolean(weaponSubject) === Boolean(group.monsterWeapon) && group.monsterWeapon && normalized.endsWith(token(group.name)));
        }).sort((a, b) => b.key.length - a.key.length);
        const directCandidates = findCandidates(weapon ? weaponSideInternal(original, name) : original);
        const indexedCandidates = directCandidates.length ? [] : findCandidates(original.replace(/_\d+$/i, ''));
        const candidates = directCandidates.length ? directCandidates : indexedCandidates.length === 1 ? indexedCandidates : [];
        const suitMatch = family === 'suit' ? matchSuitMaterialSlot(original, [...groups.values()], heroSuitPart(file.normalizedName)) : null;
        const group = chosen?.startsWith('group:') ? groups.get(chosen.slice(6))
          : suitMatch?.key ? groups.get(suitMatch.key)
          : candidates.length && !(candidates.length > 1 && candidates[0].key.length === candidates[1].key.length) ? candidates[0] : (weapon || item) && groups.size === 1 ? [...groups.values()][0] : null;
        if (!group) {
          // Known UE blockout placeholder, including exporter slot aliases.
          // Association still verifies this exact material on every triangle.
          if (!chosen && /^WorldGridMaterial(?:_\d+)?$/i.test(original)) {
            externalMaterials[original] = '/Engine/EngineMaterials/WorldGridMaterial';
            continue;
          }
          // UE intake keeps existing materials until a matching managed texture group is supplied.
          const recovered = asset.meta?.characterUEIntake?.materialBindings?.[mappingKey];
          if (!chosen && recovered?.startsWith('/Game/')) { externalMaterials[original] = recovered; continue; }
          unresolvedMaterials.push(original);
          materialRequests.push({ key: mappingKey, meshName, slot: original, groups: [...groups.values()].map(g => ({ key: g.key, name: g.name })) });
          continue;
        }
        // Recovered SM FBXs can retain artist slot names while UE records the
        // renamed MI slots. Resolve the same unique material group within this
        // exact mesh; never borrow bindings from another mesh or shared folder.
        const intake = asset.meta?.characterUEIntake;
        if (family === 'suit' && !chosen && intake?.preserveMaterialBindings) {
          const paths = [...new Set(Object.entries(intake.materialBindings || {}).filter(([key, value]) =>
            key.startsWith(meshKey + '|') && String(value).startsWith(intake.enginePath + '/')
            && matchSuitMaterialSlot(key.slice(meshKey.length + 1), [...groups.values()], heroSuitPart(file.normalizedName)).key === group.key
          ).map(([, value]) => value))];
          if (paths.length === 1) { externalMaterials[original] = paths[0]; continue; }
        }
        usedGroups.add(group.key);
        materials[original] = `${assetId}:material:${group.key}`;
      }
      if (!blockout && !weapon && !item && !(analysis.materialNames || []).length) unresolvedMaterials.push('模型未提供材质槽');
      entries.push({ key: meshKey, kind, name: meshName, partSlot: part.slot,
        targetPath: `${kind === 'skeletalMesh' ? skeletalDirectory : meshDirectory + '/StaticMesh'}/${meshName}`,
        ...source, materials, externalMaterials, linkMaterialPaths, sharedMaterialSlots, unresolvedMaterials, bones: analysis.bones || [],
        ...(kind === 'skeletalMesh' ? { skeletonPath: ownSkeleton ? `${skeletalDirectory}/SKEL_${outputName}${outputSubject ? '_' + outputSubject : ''}` : String(options.skeletonPath || DEFAULT_SKELETON) } : {}),
        config: { version: VERSION, family, ...(blockout ? { materialMode: 'blockout', blockoutFallback: !analysis.materialNames?.length } : {}), ...(item && !blockout ? { itemMaterialVersion: 1 } : {}), ...(ownSkeleton && kind === 'skeletalMesh' ? { ownSkeleton: true,
          physicsAssetPath: `${skeletalDirectory}/SK_${outputName}${outputSubject ? '_' + outputSubject : ''}_Physics` } : {}),
          importAnimations: false, createPhysicsAsset: ownSkeleton && kind === 'skeletalMesh', updateReferencePose: false } });
    }
  }
  if (!selectedSlot && !(options.materialMode === 'blockout' && !options.linkOnly)) for (const group of groups.values()) usedGroups.add(group.key);
  for (const groupKey of usedGroups) {
    const group = groups.get(groupKey);
    const suitHair = family === 'suit' && /(?:^|_)(?:hair|fur)(?:_|$)/i.test(group.name.replace(/([a-z])([A-Z])/g, '$1_$2'));
    const resourceRoot = monster ? `${monsterMeshRoot}${group.monsterWeapon ? '/Weapon' : ''}` : group.monsterWeapon ? `${targetRoot}/Weapon` : targetRoot;
    const groupOutputName = group.monsterWeapon ? group.name : outputSuffix(group.name);
    const textureKeys = {};
    const groupUsesVT = item || !(weapon || group.monsterWeapon) || group.files.some(file => file.channel === 'ShadingMask');
    for (const { file, channel } of group.files) {
      const textureName = safeName(`T_${group.monsterWeapon && !monster ? 'WP_' : ''}${outputName}${groupOutputName ? '_' + groupOutputName : ''}_${channel}`);
      const key = `${assetId}:texture:${groupKey}:${channel}`;
      // Auxiliary textures remain available in UE; only documented parameters
      // of the existing parent material receive automatic bindings.
      if (suitHair) {
        if (['D', 'A', 'Root', 'ID', 'Height', 'Tangent', 'ShadingMask'].includes(channel)) textureKeys[channel === 'A' ? 'Opacity' : channel] = key;
      } else if (['D', 'N', 'ORM', 'A', 'E', 'ShadingMask'].includes(channel) || item && ['SS', 'SSC', 'Dis'].includes(channel)) textureKeys[channel] = key;
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
          family, virtualTexture: groupUsesVT, maxSize: item ? 2048 : 0, lodBias: 0, preserveAlpha: true,
          ...(item ? { itemMaterialVersion: 1 } : {}) } });
    }
    const materialName = `MI_${group.monsterWeapon && !monster ? 'WP_' : ''}${outputName}${groupOutputName ? '_' + groupOutputName : ''}`;
    const materialKey = `${assetId}:material:${groupKey}`;
    // These texture groups already feed an existing UE material. Updating a
    // texture updates that same object; do not invent a second material instance.
    if (asset.meta?.characterUEIntake?.preserveMaterialBindings
      && asset.meta.characterUEIntake.externalMaterialGroups?.includes(groupKey)
      && !entries.some(entry => Object.values(entry.materials || {}).includes(materialKey))) continue;
    const bodyMaterial = monster && !group.monsterWeapon;
    const selectedType = bodyMaterial ? options.monsterMaterialTypes?.[materialKey] : '';
    if (selectedType && !['cloth', 'skin'].includes(selectedType)) throw new Error('无效的怪物材质类型');
    const materialType = bodyMaterial ? selectedType || inferMonsterMaterialType(group.name) : '';
    entries.push({ key: materialKey, kind: 'material', name: materialName, groupName: group.name,
      ...(bodyMaterial ? { materialType, validationError: materialType ? '' : '无法确定材质类型，请选择衣服或皮肤' } : {}),
      targetPath: `${resourceRoot}/${ownSkeleton ? 'Material' : 'Materials'}/${materialName}`, textures: textureKeys,
        config: suitHair ? { version: VERSION, family, materialRole: 'hero_hair', hairDefaultsVersion: 1,
          virtualTexture: true, parentPath: '/Game/MaterialLibrary/Character/Common/M_Char_Hair' }
        : item ? { version: VERSION, family, materialRole: 'gameplayItem', parentPath: textureKeys.A ? ITEM_MASKED_TEMPLATE : ITEM_TEMPLATE, virtualTexture: true, itemMaterialVersion: 2 }
        : weapon || group.monsterWeapon ? { version: VERSION, family,
        ...(group.monsterWeapon ? { materialRole: 'monsterWeapon' } : {}),
        parentPath: `/Game/MaterialLibrary/Weapon/Common/${group.monsterWeapon ? 'M_Weapon_Monster' : 'M_Weapon_Slab'}`,
        virtualTexture: groupUsesVT, useOpacityMasked: Boolean(textureKeys.A) }
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
  if (options.suitOptions?.linkOnly) return require('./characterLinkOnly').sendCharacterLinkJob(assets, options, onProgress, client);
  const editor = await client.getEditorInfo();
  if (!editor?.capabilities?.includes('characterSuitV1')) throw new Error('请编译并加载支持套装导入的 AssetHive 插件');
  if (options.unrealProjectPath && normalize(options.unrealProjectPath) !== normalize(editor.projectPath)) throw new Error('连接的 UE 工程与所选目标不一致');
  const suits = [];
  const projectKey = projectIdentity.projectKey(editor);
  const effectiveOptions = new Map();
  const uniqueAssets = [...new Map(assets.map(asset => [asset.id, asset])).values()];
  for (const [assetIndex, asset] of uniqueAssets.entries()) {
    const saved = projectIdentity.projectReceipt(asset.meta, editor)?.options || {};
    const selected = mergeSuitExportOptions(saved, options.suitOptions);
    if (selected.materialMode === 'blockout'
      && !await require('./characterPluginCapabilities').hasCharacterCapability(client, editor, 'characterBlockoutInstancesV2')) {
      throw new Error('请更新 AssetHive UE 插件，以保留 Blockout 的多材质槽和基础颜色。');
    }
    const overrides = [selected.skeletonSelection, ...Object.values(selected.skeletonOverrides || {})];
    if ((asset.assetType !== 'suit' || overrides.some(choice => choice && choice.mode !== 'auto'))
      && !editor.capabilities.includes('characterUpgradeV1')) {
      throw new Error('请先更新 AssetHive UE 插件并重启编辑器，以使用角色模块的新导入规则和骨架设置');
    }
    effectiveOptions.set(asset.id, selected);
    const startedAt = Date.now();
    const reportPreparation = (fraction, message) => onProgress?.({ percent: (assetIndex + fraction) / uniqueAssets.length * 25, message });
    reportPreparation(0, `正在检查 ${asset.name} 的模型与贴图…`);
    suits.push(await buildSuitExport(asset, { ...selected, ...(selected.inspectAllMeshes ? { includeStaticMeshes: true } : {}), onPreparationProgress: reportPreparation }));
    reportPreparation(1, '文件检查完成');
    console.info(`[SuitExport] manifest ${asset.id}: ${Date.now() - startedAt}ms`);
  }
  if (suits.some(suit => suit.entries.some(entry => entry.channel === 'ShadingMask'))
    && !await require('./characterPluginCapabilities').hasCharacterCapability(client, editor, 'characterShadingMaskV1')) {
    throw new Error('请更新 AssetHive UE 插件，以支持 ShadingMask 贴图及材质参数绑定。');
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
  if (mergedSuits.some(suit => suit.entries.some(entry => entry.config?.lodReset))
    && !await require('./characterPluginCapabilities').hasCharacterCapability(client, editor, 'characterLodResetV2')) {
    throw new Error('请更新 AssetHive UE 插件：当前插件不能验证 LOD0 替换后的旧 LOD 清理，未发送模型。');
  }
  if (mergedSuits.some(suit => suit.entries.some(entry => entry.config?.lodPolicy === 'lod1-reduction-v2'))
    && !editor.capabilities.includes('characterLodsV2')) {
    throw new Error('请更新 AssetHive UE 插件并重启编辑器：当前插件不支持 SM/SK LOD 导入验证与 LOD1 自动减面。');
  }
  for (const suit of mergedSuits) suit.entries.sort((a, b) => ['texture', 'material', 'staticMesh', 'skeletalMesh'].indexOf(a.kind) - ['texture', 'material', 'staticMesh', 'skeletalMesh'].indexOf(b.kind));
  const phase = options.suitPhase === 'apply' ? 'apply' : 'inspect';
  if (phase === 'apply' && options.suitManifestHash !== hash(mergedSuits)) throw new Error('资源在检查后已变化，请重新检查');
  onProgress?.({ percent: 25, message: phase === 'inspect' ? '正在核对 UE 中的整套资源…' : '正在发送整套中新增或变化的资源…' });
  const ueStartedAt = Date.now();
  const deletedOwnerIds = await deletedSuitOwners(options.customLibraryPath, assets);
  const reply = await client.importAssets({ characterSuit: { version: VERSION, phase, suits: mergedSuits,
    deletedOwnerIds, decisions: options.suitDecisions || {}, inspectToken: options.suitInspectToken || '' } }, { projectPath: editor.projectPath,
      onProgress: progress => onProgress?.({ ...progress, percent: 25 + Math.max(0, Math.min(100, Number(progress.percent) || 0)) * 0.7 }) });
  console.info(`[SuitExport] UE ${phase}: ${Date.now() - ueStartedAt}ms`);
  const result = reply.suitResult;
  if (result?.error) throw new Error(result.error);
  if (!result || !Array.isArray(result.entries)) throw new Error('插件没有返回套装逐项结果');
  const manifestEntries = new Map(mergedSuits.flatMap(suit => suit.entries).map(entry => [entry.key, entry]));
  if (phase === 'apply') result.entries = result.entries.map(row =>
    require('./characterLodReceipt').verifyCharacterLodReceipt(manifestEntries.get(row.key), row));
  result.entries = result.entries.map(row => ({ ...row,
    ...(row.kind === 'skeletalMesh' ? { skeletonSelection: effectiveOptions.get(row.assetId)?.skeletonOverrides?.[row.key]
      || effectiveOptions.get(row.assetId)?.skeletonSelection || { mode: 'auto' },
      skeletonPath: manifestEntries.get(row.key)?.skeletonPath } : {}),
    dependencies: Object.values(manifestEntries.get(row.key)?.materials || manifestEntries.get(row.key)?.textures || {}),
    groupName: manifestEntries.get(row.key)?.groupName,
    partSlot: manifestEntries.get(row.key)?.partSlot || row.partSlot }));
  {
    for (const asset of new Map(assets.map(asset => [asset.id, asset])).values()) {
      const suit = uniqueSuits.get(asset.id);
      const rows = result.entries.filter(row => row.assetId === asset.id);
      if (phase === 'inspect' && !projectIdentity.projectReceipt(asset.meta, editor)) continue;
      await updateAssetMetadataFile(asset.metaPath, meta => {
        const receipts = meta.characterUnrealExports || {};
        const previous = projectIdentity.projectReceipt(meta, editor) || { entries: {} };
        if (phase === 'inspect') recordUEPresenceChanges(meta, previous,
          rows.filter(row => row.status === 'missing').map(row => ({ key: row.key, present: false, path: '' })), editor.projectPath);
        const next = { ...previous.entries };
        for (const row of rows) {
          const success = ['success', 'unchanged'].includes(row.status) && row.action !== 'retained';
          next[row.key] = { ...next[row.key], ...row,
            ...(row.lodReport ? { lodCheckedAt: new Date().toISOString() } : {}),
            ...(phase === 'apply' && success ? { lastSuccessPath: row.path, lastSuccessAt: new Date().toISOString(), missingInUE: false, livePath: row.path } : {}),
            ...(row.status === 'missing' ? { missingInUE: true, livePath: '' } : {}) };
        }
        const successful = rows.filter(row => ['success', 'unchanged'].includes(row.status) && row.action !== 'retained');
        receipts[projectKey] = { ...previous, projectPath: editor.projectPath, projectId: projectIdentity.projectId(editor), entries: next, checkedAt: new Date().toISOString(),
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
  onProgress?.({ percent: 100, message: phase === 'inspect' ? '检查完成' : '发送完成' });
  return { ok: true, suitResult: { ...result, materialMode: [...effectiveOptions.values()].every(value => value.materialMode === 'blockout') ? 'blockout' : 'formal', monsterMaterialGroups, materialRequests: mergedSuits.flatMap(suit => suit.materialRequests), projectPath: editor.projectPath, manifestHash: hash(mergedSuits), phase },
    message: phase === 'inspect' ? '套装检查完成' : '套装逐项处理完成' };
}

function isSuitAsset(asset) {
  return asset?.assetType === 'suit';
}

function isCharacterUEAsset(asset) { return isSuitAsset(asset) || ['weapon', 'monster', 'npc', 'item'].includes(asset?.assetType); }

async function refreshSuitStatus(asset, options, client) {
  if (!isCharacterUEAsset(asset)) return false;
  const editor = await client.getEditorInfo();
  if (!await require('./characterPluginCapabilities').hasCharacterCapability(client, editor, 'characterStatusV2')) throw new Error('请更新目标 UE 的 AssetHive 插件，以刷新实际资源状态');
  if (options.unrealProjectPath && normalize(options.unrealProjectPath) !== normalize(editor.projectPath)) throw new Error('连接的 UE 工程与所选目标不一致，未更新路径记录');
  const projectKey = projectIdentity.projectKey(editor);
  const savedReceipt = projectIdentity.projectReceipt(asset.meta, editor);
  const plan = savedReceipt && Object.keys(savedReceipt.entries || {}).length ? null : await buildSuitExport(asset, { includeStaticMeshes: true });
  const current = savedReceipt?.entries && Object.keys(savedReceipt.entries).length ? savedReceipt.entries : Object.fromEntries((plan?.entries || []).map(entry => [entry.key,
    { key: entry.key, kind: entry.kind, name: entry.name, partSlot: entry.partSlot, targetPath: entry.targetPath }]));
  const expected = Object.entries(current).filter(([, row]) => row.action !== 'retained').map(([key, row]) => ({ key, path: row.livePath || row.path || row.lastSuccessPath || row.targetPath, kind: row.kind }));
  const reply = await client.importAssets({ characterSuit: { version: VERSION, phase: 'status', suits: [{ assetId: asset.id, entries: expected }] } }, { projectPath: editor.projectPath });
  if (reply.suitResult?.error || !Array.isArray(reply.suitResult?.entries)) throw new Error(reply.suitResult?.error || 'UE 未返回资源状态');
  const updates = reply.suitResult.entries.filter(row => row.assetId === asset.id && typeof row.present === 'boolean');
  if (expected.some(row => !updates.some(update => update.key === row.key))) throw new Error('UE 状态回执不完整，未改动已有路径记录');
  if (savedReceipt?.projectId === projectIdentity.projectId(editor) && !updates.some(row => current[row.key] && (current[row.key].missingInUE !== !row.present || current[row.key].livePath !== row.path || Boolean(current[row.key].associationPending) !== Boolean(row.associationPending)))) return false;
  await updateAssetMetadataFile(asset.metaPath, meta => {
    const receipt = (meta.characterUnrealExports ||= {})[projectKey] ||= { ...savedReceipt, targetRoot: savedReceipt?.targetRoot || plan?.targetRoot || '', entries: current };
    receipt.projectPath = editor.projectPath;
    receipt.projectId = projectIdentity.projectId(editor);
    recordUEPresenceChanges(meta, receipt, updates, editor.projectPath);
    for (const row of updates) if (receipt.entries[row.key]) {
      receipt.entries[row.key] = { ...receipt.entries[row.key], missingInUE: !row.present, livePath: row.path, associationPending: Boolean(row.associationPending),
        ...(row.present && !row.associationPending ? { lastSuccessPath: row.path } : {}) };
    }
    receipt.checkedAt = new Date().toISOString();
    return meta;
  });
  return true;
}

module.exports = { inferMonsterMaterialType, mergeSuitExportOptions, deletedSuitOwners, buildSuitExport, sendSuitJob, refreshSuitStatus, recordUEPresenceChanges, managedFile, materialGroup, isSuitAsset, isCharacterUEAsset,
  clearCharacterExportInspection: () => { alphaChecks = new WeakMap(); } };
