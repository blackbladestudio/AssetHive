const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { transactionalFs, withFileTransaction } = require("./assetFileTransaction");
const { updateAssetMetadataFile } = require("./assetMetadata");
const { safePath, withRecycleLock } = require("./libraryRecycle");
const { loadParent, readSourcePackage, copyPreview, fileHash, syncActiveCharacterMetadata, markCharacterAutomaticPreviewsReloading } = require("./characterComponents");
const { buildFamilyPackagePlan, applyFamilyModelAnalyses } = require("./characterFamilyRules");
const { classifyCharacterPackageFile, buildCharacterModelBaseName, buildCharacterTextureBaseName, inferCharacterTextureGroup, inferCharacterTextureType } = require("./characterImport");
const { characterDisplayName, characterComponentLabel, listCharacterComponents: listOwnedParts, characterModelPreviewComponents, characterModelUpdateGroups, activeCharacterFiles, applyCharacterRigUpdateState } = require("../../shared/characterComponents.mjs");
const listCharacterComponents = asset => ['monster', 'npc'].includes(asset.assetType) ? characterModelPreviewComponents(asset) : listOwnedParts(asset);
const { auditHeroPackage, isHeroCache } = require("../../shared/heroPackageRules.mjs");
const { CHARACTER_MODEL_EXTENSIONS, CHARACTER_TEXTURE_EXTENSIONS, isAllowedCharacterPackageFile, isAllowedCharacterTextureFile } = require("../../shared/characterFilePolicy.mjs");
const { characterStatus } = require("../../shared/characterFilters.mjs");
const { appendCharacterUpdateHistory } = require("./characterUpdateHistory");
const { analyzeFbxInWorker } = require("./modelAnalysis");

const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const packageResourceState = parent => hash({ name: parent.meta.name, character: parent.meta.character,
  revision: parent.meta.characterComponents?.contentRevision || 'initial', files: activeCharacterFiles(parent) });
const snapshotKeys = ["name", "character", "characterManifest", "characterMetrics", "characterComponents", "modelFiles", "modelSlots", "textureFiles", "textureSlots", "textureEntries", "components", "previews", "previewImage", "detailImage"];

async function inspectCharacterMeshSource(sourcePath, analyzeModel = analyzeFbxInWorker) {
  if (path.extname(sourcePath).toLowerCase() !== ".fbx") {
    return { meshKind: "staticMesh", hasSkeleton: false, hasSkin: false, boneCount: 0, skinnedMeshCount: 0 };
  }
  const analysis = await require('./characterFileInspection').inspectCharacterModel(sourcePath, analyzeModel);
  if (analysis.error || !["staticMesh", "skeletalMesh"].includes(analysis.meshKind)) {
    throw new Error(`模型骨骼检查失败，未执行更新：${sourcePath}\n${analysis.error || "无法判断模型类型"}`);
  }
  return {
    meshKind: analysis.meshKind,
    hasSkeleton: analysis.hasSkeleton === true,
    hasSkin: analysis.hasSkin === true,
    boneCount: Number(analysis.boneCount) || 0,
    skinnedMeshCount: Number(analysis.skinnedMeshCount) || 0
  };
}

function expectedCharacterMeshRole(file) {
  return file?.role === "skeletalMesh" ? "skeletalMesh" : ["model", "staticMesh"].includes(file?.role) ? "staticMesh" : "";
}

function normalizeCharacterMeshPrefix(name, meshKind) {
  const prefix = meshKind === "skeletalMesh" ? "SK" : "SM";
  return String(name || "").replace(/^(?:SK|SM)_/i, `${prefix}_`);
}

function characterMeshIdentity(name) {
  return String(name || "").replace(/\.[^.]+$/, "").replace(/^(?:SK|SM)_/i, "").toLowerCase();
}

function newMeshTarget(targetPath, parent, slot) {
  const match = /^__new_character_mesh__:(staticMesh|skeletalMesh)(?::(.+))?$/.exec(targetPath);
  if (!match) return null;
  const targetSlot = match[2] ? decodeURIComponent(match[2]) : slot;
  const part = characterModelUpdateGroups(parent).find(item => item.slot === targetSlot);
  if (!part || (slot && slot !== targetSlot) || part.meshKinds?.[match[1]]) throw new Error("新增模型目标无效或已经存在，请重新检查");
  return { role: match[1], part };
}

const textureMapAliases = [
  ["ORM", /(?:^|_)(?:orm|ort|rma|occlusionroughnessmetallic)(?:_|$)/i],
  ["D", /(?:^|_)(?:d|diffuse|albedo|basecolor|base_color|bc)(?:_|$)/i],
  ["N", /(?:^|_)(?:n|normal|normalgl|normaldx|nrm)(?:_|$)/i],
  ["AO", /(?:^|_)(?:ao|ambientocclusion|occlusion)(?:_|$)/i],
  ["R", /(?:^|_)(?:r|rough|roughness)(?:_|$)/i],
  ["M", /(?:^|_)(?:m|metal|metallic|metalness)(?:_|$)/i],
  ["A", /(?:^|_)(?:a|alpha|opacity|opacitymask|mask)(?:_|$)/i],
  ["E", /(?:^|_)(?:e|emissive|emission)(?:_|$)/i]
];
const textureNoiseTokens = new Set(["t", "tex", "texture", "map", "sk", "sm", "mi"]);
function textureMatchSignature(filePath) {
  const stem = path.basename(filePath, path.extname(filePath)).replace(/[.\-\s]+/g, "_");
  const map = textureMapAliases.find(([, pattern]) => pattern.test(stem))?.[0] || "";
  const mapPattern = textureMapAliases.find(([code]) => code === map)?.[1];
  const groupStem = mapPattern ? stem.replace(new RegExp(mapPattern.source.replace('(?:_|$)', '$'), 'i'), '') : stem;
  const groupIndex = groupStem.match(/_(\d{1,2})$/)?.[1];
  const groupName = groupStem.replace(/^T_[MF]\d{2}_(?:Light|Medium|Heavy)\d{3}_[^_]+_/i, '')
    .replace(/^.*(?:^|_)[MHL]\d{3}_[MF]\d{2}_/i, '');
  const groupTokens = groupName.toLowerCase().split(/_+/).filter(token => token.length > 1 && !/^\d+$/.test(token));
  const tokens = stem.toLowerCase().split(/_+/).filter(token => token.length > 1 && !textureNoiseTokens.has(token)
    && !textureMapAliases.some(([, pattern]) => pattern.test(`_${token}_`)) && !/^\d+$/.test(token));
  return { map, tokens: new Set(tokens), groupTokens, groupIndex: groupIndex == null ? '' : String(Number(groupIndex)) };
}
function textureMatchScore(sourcePath, target, numberedSuitGroups = false) {
  const sourceName = path.basename(sourcePath);
  const targetName = target.normalizedName || path.basename(target.storedPath);
  if (sourceName.toLowerCase() === targetName.toLowerCase()) return 10000;
  if ([target.originalName, target.originalPath].some(value => value && path.basename(value).toLowerCase() === sourceName.toLowerCase())) return 10000;
  if (path.extname(sourceName).toLowerCase() !== path.extname(targetName).toLowerCase()) return -1;
  const source = textureMatchSignature(sourceName);
  const destination = textureMatchSignature(targetName);
  if (!source.map || !destination.map || source.map !== destination.map) return -1;
  // Suit texture group numbers are identity (Upbody_01 versus Upbody_02),
  // not noise or revision suffixes. Never cross those groups during an update.
  if (source.groupIndex !== destination.groupIndex) return -1;
  if (!numberedSuitGroups && ![...source.tokens].some(token => destination.tokens.has(token))) return -1;
  if (numberedSuitGroups && !source.groupTokens.some(token => destination.groupTokens.includes(token))) return -1;
  let score = 100;
  for (const token of source.tokens) if (destination.tokens.has(token)) score += 10;
  return score;
}

function characterTextureGroups(parent, slot) {
  const parts = listCharacterComponents(parent).filter(part => !slot || part.slot === slot);
  const files = slot ? parts.flatMap(part => part.files) : activeCharacterFiles(parent);
  return [...new Set([
    ...files.filter(file => file.role === 'texture').map(file => file.normalizedName.replace(/\.[^.]+$/, '').replace(/_(?:ORM|D|N|A|Emissive|Emission|E|OpacityMask|Opacity)$/i, '')),
    ...parts.map(part => part.name.replace(/^(?:SM|SK)_/i, 'T_'))
  ])];
}

function newSuitTextureName(parent, sourcePath, slot) {
  if (parent.assetType !== 'suit' || slot || !sourcePath) return '';
  const group = inferCharacterTextureGroup(sourcePath);
  if (!group || !/[a-z\u4e00-\u9fff]/i.test(group)) return '';
  const name = buildCharacterTextureBaseName(parent.name, group, inferCharacterTextureType(sourcePath), sourcePath, parent.meta.character)
    + path.extname(sourcePath).toLowerCase();
  return isAllowedCharacterTextureFile(name) && !/_MAP\./i.test(name) ? name : '';
}

function newTextureTarget(targetPath, parent, slot, sourcePath) {
  if (!targetPath.startsWith('__new_character_texture__:')) return '';
  const name = decodeURIComponent(targetPath.slice('__new_character_texture__:'.length));
  const group = name.replace(/\.[^.]+$/, '').replace(/_(?:ORM|D|N|A|E)$/i, '');
  if (path.basename(name) !== name || !isAllowedCharacterTextureFile(name) || (!characterTextureGroups(parent, slot).includes(group) && name !== newSuitTextureName(parent, sourcePath, slot))
    || activeCharacterFiles(parent).some(file => file.normalizedName.toLowerCase() === name.toLowerCase())) throw new Error('新增贴图目标无效或已经存在，请重新检查');
  return name;
}

async function matchCharacterTextureReplacements({ root, asset, slot, sourceFolder, sourcePaths }, scannedFiles) {
  const { parent } = await loadParent(root, asset, ["suit", "monster", "npc", "weapon"]);
  const scanned = scannedFiles || await readSourcePackage(sourcePaths || sourceFolder);
  const part = slot ? listCharacterComponents(parent).find(item => item.slot === slot) : null;
  if (slot && !part) throw new Error("目标部件不存在，请刷新后重试");
  const targets = (part ? part.files : activeCharacterFiles(parent)).filter(file => file.role === "texture");
  if (!targets.length) throw new Error("当前资产没有可更新的贴图目标");
  const sources = scanned.filter(file => !isHeroCache(file.sourcePath) && CHARACTER_TEXTURE_EXTENSIONS.has(path.extname(file.sourcePath).toLowerCase()));
  const excludedFiles = scanned.filter(file => !sources.includes(file)).map(file => file.sourcePath);
  if (!sources.length) throw new Error("没有识别到可匹配的贴图文件");
  const proposals = [];
  const unmatchedFiles = [];
  for (const source of sources) {
    const ranked = targets.map(target => ({ target, score: textureMatchScore(source.sourcePath, target, parent.assetType === 'suit') }))
      .filter(item => item.score >= 0).sort((a, b) => b.score - a.score);
    if (!ranked.length || (ranked.length > 1 && ranked[0].score === ranked[1].score)) {
      unmatchedFiles.push(source.sourcePath);
      continue;
    }
    proposals.push({ sourcePath: source.sourcePath, storedPath: ranked[0].target.storedPath, score: ranked[0].score });
  }
  const byTarget = new Map();
  for (const proposal of proposals) byTarget.set(proposal.storedPath, [...(byTarget.get(proposal.storedPath) || []), proposal]);
  const conflictFiles = [];
  const replacements = [];
  for (const [storedPath, group] of byTarget) {
    if (group.length > 1) conflictFiles.push({ storedPath, sourcePaths: group.map(item => item.sourcePath) });
    else replacements.push({ sourcePath: group[0].sourcePath, storedPath });
  }
  return { replacements, unmatchedFiles, conflictFiles, excludedFiles };
}

async function inspectCharacterUpdateInput(options) {
  const { parent } = await loadParent(options.root, options.asset, ["suit", "monster", "npc", "weapon"]);
  const scanned = await readSourcePackage(options.sourcePaths || options.sourceFolder);
  const parts = characterModelUpdateGroups(parent).filter(part => !options.slot || part.slot === options.slot);
  if (options.slot && !parts.length) throw new Error("目标部件不存在，请刷新后重试");
  const targets = options.slot ? parts[0].files : activeCharacterFiles(parent);
  const rows = [], excludedFiles = [];
  for (const source of scanned) {
    const ext = path.extname(source.sourcePath).toLowerCase();
    if (isHeroCache(source.sourcePath) || (!CHARACTER_TEXTURE_EXTENSIONS.has(ext) && !isAllowedCharacterPackageFile(source.sourcePath))) {
      excludedFiles.push(source.sourcePath); continue;
    }
    let candidates = [], suggested = "", role;
    if (CHARACTER_MODEL_EXTENSIONS.has(ext)) {
      const analysis = await inspectCharacterMeshSource(source.sourcePath, options.analyzeModel || analyzeFbxInWorker);
      role = analysis.meshKind;
      candidates = targets.filter(file => expectedCharacterMeshRole(file) === role && path.extname(file.normalizedName).toLowerCase() === ext)
        .map(file => ({ storedPath: file.storedPath, name: normalizeCharacterMeshPrefix(file.normalizedName, role) }));
      for (const part of parts) if (!part.meshKinds?.[role]) candidates.push({
        storedPath: `__new_character_mesh__:${role}:${encodeURIComponent(part.slot)}`,
        name: `${role === 'skeletalMesh' ? 'SK' : 'SM'}_${part.name.replace(/^(?:SK|SM)_/i, '')}${ext}`
      });
      const normalized = parent.assetType === 'suit'
        ? buildCharacterModelBaseName(parent.name, source.sourcePath, parent.meta.character, role)
        : path.basename(source.sourcePath, ext);
      // Original filenames remain a reliable identity after library normalization
      // or a name change. Never require a user to rename their working files.
      const originalTargets = targets.filter(file => [file.originalName, file.originalPath].some(value => value
        && characterMeshIdentity(path.basename(value)) === characterMeshIdentity(path.basename(source.sourcePath))));
      const matches = candidates.filter(item => characterMeshIdentity(item.name) === characterMeshIdentity(normalized)
        || characterMeshIdentity(item.name) === characterMeshIdentity(path.basename(source.sourcePath))
        || originalTargets.some(file => characterMeshIdentity(item.name) === characterMeshIdentity(file.normalizedName)));
      suggested = matches.length === 1 ? matches[0].storedPath : options.slot && candidates.length === 1 ? candidates[0].storedPath : "";
      // A renamed monster still has a body and its owned weapons. Propose a
      // target only when the semantic role and actual mesh kind are unique.
      if (!suggested && ['monster', 'npc'].includes(parent.assetType)) {
        const isWeapon = /(?:^|_)(?:WP|Weapon)(?:_|\.|$)/i.test(path.basename(source.sourcePath));
        const semanticParts = parts.filter(part => (part.role === 'weapon') === isWeapon);
        const semanticCandidates = candidates.filter(candidate => semanticParts.some(part =>
          part.files.some(file => file.storedPath === candidate.storedPath)
          || candidate.storedPath === `__new_character_mesh__:${role}:${encodeURIComponent(part.slot)}`));
        if (semanticCandidates.length === 1) suggested = semanticCandidates[0].storedPath;
      }
    } else if (CHARACTER_TEXTURE_EXTENSIONS.has(ext)) {
      role = 'texture';
      const ranked = targets.filter(file => file.role === 'texture' && path.extname(file.normalizedName).toLowerCase() === ext)
        .map(file => ({ storedPath: file.storedPath, name: file.normalizedName, score: textureMatchScore(source.sourcePath, file, parent.assetType === 'suit') }))
        .sort((a, b) => b.score - a.score);
      const map = textureMatchSignature(source.sourcePath).map;
      if (['D', 'N', 'ORM', 'A', 'E'].includes(map)) {
        for (const group of characterTextureGroups(parent, options.slot)) {
          const name = `${group}_${map}${ext}`;
          if (targets.some(file => file.normalizedName.toLowerCase() === name.toLowerCase())) continue;
          const storedPath = `__new_character_texture__:${encodeURIComponent(name)}`;
          ranked.push({ storedPath, name, score: textureMatchScore(source.sourcePath, { normalizedName: name, storedPath }, parent.assetType === 'suit') });
        }
        ranked.sort((a, b) => b.score - a.score);
      }
      const newName = newSuitTextureName(parent, source.sourcePath, options.slot);
      const newGroup = newName.replace(/\.[^.]+$/, '').replace(/_(?:ORM|D|N|A|E)$/i, '');
      const sourceHasSuitIdentity = /^T_[MF]\d{2}_(?:Light|Medium|Heavy)\d{3}_[^_]+_/i.test(path.basename(source.sourcePath));
      const isNewGroup = newName && !characterTextureGroups(parent, options.slot).some(group => group.toLowerCase() === newGroup.toLowerCase())
        && !targets.some(file => file.normalizedName.toLowerCase() === newName.toLowerCase());
      // A clearly named new material group is an addition, never a replacement
      // for an unrelated group that only happens to share the suit identity.
      if (isNewGroup && (sourceHasSuitIdentity || !ranked.some(item => item.score >= 0))) {
        candidates = [{ storedPath: `__new_character_texture__:${encodeURIComponent(newName)}`, name: newName }];
      } else candidates = ranked.filter(item => item.score >= 0).map(({ storedPath, name }) => ({ storedPath, name }));
      if (ranked[0]?.score >= 0 && (ranked.length === 1 || ranked[0].score > ranked[1].score)) suggested = ranked[0].storedPath;
      if (suggested && !candidates.some(candidate => candidate.storedPath === suggested)) suggested = '';
    } else {
      // Working files and package documents still follow the character allowlist.
      role = 'other';
      const name = path.basename(source.sourcePath);
      candidates = targets.filter(file => !expectedCharacterMeshRole(file) && file.role !== 'texture' && path.extname(file.normalizedName).toLowerCase() === ext)
        .map(file => ({ storedPath: file.storedPath, name: file.normalizedName }));
      const exact = candidates.filter(file => file.name.toLowerCase() === name.toLowerCase());
      if (exact.length === 1) suggested = exact[0].storedPath;
      else if (!options.slot) {
        suggested = `__new_character_source__:${encodeURIComponent(name)}`;
        candidates.push({ storedPath: suggested, name });
      }
    }
    rows.push({ sourcePath: source.sourcePath, role, candidates, storedPath: suggested });
  }
  const conflictFiles = [];
  for (const storedPath of new Set(rows.map(row => row.storedPath).filter(Boolean))) {
    const duplicates = rows.filter(row => row.storedPath === storedPath);
    if (duplicates.length > 1) {
      conflictFiles.push({ storedPath, sourcePaths: duplicates.map(row => row.sourcePath) });
      duplicates.forEach(row => { row.storedPath = ''; });
    }
  }
  return { rows, textureOnly: rows.length > 0 && rows.every(row => row.role === 'texture'), excludedFiles, conflictFiles,
    unmatchedFiles: rows.filter(row => !row.storedPath).map(row => row.sourcePath),
    replacements: rows.filter(row => row.storedPath).map(({ sourcePath, storedPath }) => ({ sourcePath, storedPath })) };
}

function newSourceTarget(targetPath, slot) {
  if (!targetPath.startsWith('__new_character_source__:')) return '';
  const name = decodeURIComponent(targetPath.slice('__new_character_source__:'.length));
  if (slot || path.basename(name) !== name || !isAllowedCharacterPackageFile(name)
    || CHARACTER_MODEL_EXTENSIONS.has(path.extname(name).toLowerCase()) || CHARACTER_TEXTURE_EXTENSIONS.has(path.extname(name).toLowerCase())) throw new Error('新增源文件目标无效');
  return name;
}

async function prepareCharacterPackageUpdate({ root, asset, slot, sourceFolder, sourcePaths, replacements, analyzeModel }) {
  const { parent } = await loadParent(root, asset, ["suit", "monster", "npc", "weapon"]);
  const scannedSources = await readSourcePackage(sourcePaths || sourceFolder);
  const oldFiles = activeCharacterFiles(parent);
  const targeted = Array.isArray(replacements) && replacements.length > 0;
  const targetedSourceAllowed = source => {
    if (!targeted) return false;
    return replacements.some(item => path.resolve(item.sourcePath) === path.resolve(source.sourcePath));
  };
  const excludedFiles = scannedSources.filter(file => isHeroCache(file.sourcePath) || (!isAllowedCharacterPackageFile(file.sourcePath) && !targetedSourceAllowed(file))).map(file => file.sourcePath);
  const sources = scannedSources.filter(file => !isHeroCache(file.sourcePath) && (isAllowedCharacterPackageFile(file.sourcePath) || targetedSourceAllowed(file)));
  if (!sources.length) throw new Error("更新内容为空");
  const modelAnalyses = new Map();
  for (const source of sources) {
    if (!CHARACTER_MODEL_EXTENSIONS.has(path.extname(source.sourcePath).toLowerCase())) continue;
    modelAnalyses.set(path.resolve(source.sourcePath).toLowerCase(), await inspectCharacterMeshSource(source.sourcePath, analyzeModel || analyzeFbxInWorker));
  }
  // Explicit detail-row drops preserve the destination identity, never infer another asset.
  if (targeted) {
    if (replacements.length !== sources.length) throw new Error("替换清单与文件数量不一致");
    const destinations = new Set();
    for (const source of sources) {
      const matches = replacements.filter(item => path.resolve(item.sourcePath) === path.resolve(source.sourcePath));
      const targetPath = matches.length === 1 ? matches[0].storedPath : "";
      const virtualTarget = newMeshTarget(targetPath, parent, slot);
      const virtualRole = virtualTarget?.role || "";
      const newSourceName = newSourceTarget(targetPath, slot);
      const newTextureName = newTextureTarget(targetPath, parent, slot, source.sourcePath);
      const previous = targetPath && oldFiles.find(file => file.storedPath === targetPath);
      const part = virtualTarget?.part;
      if ((!previous && !part && !newSourceName && !newTextureName) || destinations.has(targetPath)) throw new Error("替换目标无效或重复，请重新选择");
      if (slot && previous && !listCharacterComponents(parent).find(item => item.slot === slot)?.files.some(file => file.storedPath === previous.storedPath)) throw new Error("只能更新当前部件的资源");
      if (newSourceName && path.extname(source.sourcePath).toLowerCase() !== path.extname(newSourceName).toLowerCase()) throw new Error("源文件格式与目标不一致");
      if (newTextureName && path.extname(source.sourcePath).toLowerCase() !== path.extname(newTextureName).toLowerCase()) throw new Error("贴图格式与目标不一致");
      if (previous && path.extname(source.sourcePath).toLowerCase() !== path.extname(previous.normalizedName).toLowerCase()) throw new Error("定向替换需要与原文件格式一致");
      if (previous && !isAllowedCharacterPackageFile(previous.normalizedName)) throw new Error("目标文件格式不在白名单");
      if (virtualRole && !CHARACTER_MODEL_EXTENSIONS.has(path.extname(source.sourcePath).toLowerCase())) throw new Error("新增模型槽只接收模型文件");
      const expectedRole = virtualRole || expectedCharacterMeshRole(previous);
      const analysis = modelAnalyses.get(path.resolve(source.sourcePath).toLowerCase());
      if (expectedRole && (!analysis || analysis.meshKind !== expectedRole)) {
        const actual = analysis?.meshKind === "skeletalMesh" ? "骨骼模型" : "静态模型";
        const expected = expectedRole === "skeletalMesh" ? "骨骼模型" : "静态模型";
        throw new Error(`模型内容检查为“${actual}”，不能替换“${expected}”槽位：${source.sourcePath}`);
      }
      destinations.add(targetPath);
    }
  }
  const exactMatches = sources.map(source => oldFiles.filter(file => file.normalizedName.toLowerCase() === path.basename(source.sourcePath).toLowerCase()));
  if (parent.assetType === "suit" && !targeted) {
    const issues = auditHeroPackage(sources.map(file => file.sourcePath), parent.meta.character, {
      partial: true,
      modelAnalyses: Object.fromEntries(sources.map(file => [file.sourcePath, modelAnalyses.get(path.resolve(file.sourcePath).toLowerCase()) || {}]))
    });
    if (issues.length) throw new Error(issues.join("\n"));
  }
  let files;
  if (targeted) {
    files = sources.map(source => {
      const target = replacements.find(item => path.resolve(item.sourcePath) === path.resolve(source.sourcePath));
      const previous = oldFiles.find(file => file.storedPath === target.storedPath);
      const analysis = modelAnalyses.get(path.resolve(source.sourcePath).toLowerCase());
      const virtualTarget = newMeshTarget(target.storedPath, parent, slot);
      const virtualRole = virtualTarget?.role || "";
      const newSourceName = newSourceTarget(target.storedPath, slot);
      if (newSourceName) return { ...source, normalizedName: newSourceName, role: 'other', relativePath: `SourceFiles/${newSourceName}` };
      const newTextureName = newTextureTarget(target.storedPath, parent, slot, source.sourcePath);
      if (newTextureName) return { ...source, normalizedName: newTextureName, role: 'texture', relativePath: `Texture/${newTextureName}` };
      if (virtualRole) {
        const part = virtualTarget.part;
        const ext = path.extname(source.sourcePath).toLowerCase();
        const subject = part.name.replace(/^(?:SK|SM)_/i, "");
        const normalizedName = `${virtualRole === "skeletalMesh" ? "SK" : "SM"}_${subject}${ext}`;
        return { ...source, normalizedName, role: virtualRole, ...(analysis || {}), componentRole: part.role,
          sharedAcrossForms: part.sharedAcrossForms, relativePath: `Mesh/${virtualRole === "skeletalMesh" ? "SkeletalMesh" : "StaticMesh"}/${normalizedName}` };
      }
      const role = analysis?.meshKind || previous.role;
      const normalizedName = analysis ? normalizeCharacterMeshPrefix(previous.normalizedName, role) : previous.normalizedName;
      return { ...previous, ...source, normalizedName, role, replacesStoredPath: previous.storedPath, ...(analysis || {}),
        relativePath: `${previous.role === "texture" ? "Texture" : expectedCharacterMeshRole(previous) ? (role === "skeletalMesh" ? "Mesh/SkeletalMesh" : "Mesh/StaticMesh") : "SourceFiles"}/${normalizedName}` };
    });
  } else if (exactMatches.every(matches => matches.length === 1)) {
    files = sources.map((source, i) => {
      const previous = exactMatches[i][0];
      const analysis = modelAnalyses.get(path.resolve(source.sourcePath).toLowerCase());
      const role = analysis?.meshKind || previous.role;
      const normalizedName = analysis ? normalizeCharacterMeshPrefix(previous.normalizedName, role) : previous.normalizedName;
      return { ...previous, ...source, normalizedName, role, replacesStoredPath: previous.storedPath, ...(analysis || {}),
        relativePath: `${previous.role === "texture" ? "Texture" : expectedCharacterMeshRole(previous) ? (role === "skeletalMesh" ? "Mesh/SkeletalMesh" : "Mesh/StaticMesh") : "SourceFiles"}/${normalizedName}` };
    });
  } else if (["monster", "npc", "weapon"].includes(parent.assetType)) {
    const fields = parent.meta.character || {};
    const plan = buildFamilyPackagePlan(parent.assetType, sourceFolder || path.dirname(sources[0].sourcePath), sources.map(file => file.sourcePath), {
      assetName: characterDisplayName(parent), name: fields.name, category: parent.meta.category, modelAnalyses
    });
    if (!plan.ok) throw new Error(plan.errors.join("\n"));
    if (parent.assetType === "monster" && plan.forms.map(form => form.id).join("|") !== (fields.formIds || []).join("|")) throw new Error("整套更新不能改变怪物形态；新形态请独立导入并关联");
    applyFamilyModelAnalyses(plan, modelAnalyses);
    files = plan.files.map(item => ({ ...sources.find(file => file.sourcePath === item.sourcePath), ...item, ...modelAnalyses.get(path.resolve(item.sourcePath).toLowerCase()) }));
  } else {
    files = sources.map(source => {
      const ext = path.extname(source.sourcePath);
      const kind = classifyCharacterPackageFile(source.sourcePath);
      let normalizedName = path.basename(source.sourcePath), role = "other", folder = "SourceFiles";
      if (kind === "model") {
        const analysis = modelAnalyses.get(path.resolve(source.sourcePath).toLowerCase());
        role = analysis?.meshKind || "staticMesh"; folder = role === "skeletalMesh" ? "Mesh/SkeletalMesh" : "Mesh/StaticMesh";
        const lod = source.sourcePath.match(/(_LOD\d+)(?=\.[^.]+$)/i)?.[1] || "";
        normalizedName = buildCharacterModelBaseName(parent.name, source.sourcePath.replace(/_LOD\d+(?=\.[^.]+$)/i, ""), parent.meta.character, role) + lod + ext;
      } else if (kind === "texture") {
        role = "texture"; folder = "Texture";
        normalizedName = buildCharacterTextureBaseName(parent.name, inferCharacterTextureGroup(source.sourcePath), inferCharacterTextureType(source.sourcePath), source.sourcePath, parent.meta.character) + ext;
      } else if (kind === "preview") { role = "preview"; folder = "Preview"; }
      const analysis = modelAnalyses.get(path.resolve(source.sourcePath).toLowerCase());
      return { ...source, normalizedName, role, ...(analysis || {}), relativePath: `${folder}/${normalizedName}` };
    });
    if (!files.some(file => ["model", "staticMesh", "skeletalMesh", "texture"].includes(file.role))) throw new Error("更新必须包含模型或贴图");
  }
  const paths = new Set();
  if (parent.assetType === "suit") {
    const slots = new Set(files.filter(file => ["model", "staticMesh", "skeletalMesh"].includes(file.role)).map(file => file.normalizedName.replace(/\.[^.]+$/, "").replace(/_LOD\d+$/i, "").replace(/^(?:SK|SM)_/i, "").toLowerCase()));
    if (slots.size > require("../../shared/characterComponentRules.json").suit.maxSlots) throw new Error("套装最多 4 个独立部件槽，请整理后重新检查");
  }
  for (const file of files) {
    if (paths.has(file.relativePath.toLowerCase())) throw new Error("存在多个版本或同名资源，请整理：" + file.normalizedName);
    paths.add(file.relativePath.toLowerCase());
    file.sha256 = await fileHash(file.sourcePath);
  }
  const old = new Map(oldFiles.map(file => [file.normalizedName.toLowerCase(), file]));
  const changes = [];
  for (const file of files) {
    // Legacy static files can still carry SK_. Preserve them when a real SK is added.
    const sameName = old.get(file.normalizedName.toLowerCase());
    if (!file.replacesStoredPath && sameName && expectedCharacterMeshRole(sameName)
      && expectedCharacterMeshRole(sameName) !== file.role) {
      old.delete(sameName.normalizedName.toLowerCase());
      const normalizedName = normalizeCharacterMeshPrefix(sameName.normalizedName, expectedCharacterMeshRole(sameName));
      old.set(normalizedName.toLowerCase(), { ...sameName, normalizedName });
    }
    const previous = file.replacesStoredPath
      ? oldFiles.find(item => item.storedPath === file.replacesStoredPath)
      : old.get(file.normalizedName.toLowerCase()) || (["model", "staticMesh", "skeletalMesh"].includes(file.role)
        ? [...old.values()].find(item => ["model", "staticMesh", "skeletalMesh"].includes(item.role)
          && expectedCharacterMeshRole(item) === file.role
          && characterMeshIdentity(item.normalizedName) === characterMeshIdentity(file.normalizedName))
        : undefined);
    let beforeHash = "";
    if (previous) {
      const previousPath = path.resolve(parent.path, previous.storedPath);
      await safePath(path.resolve(root), previousPath);
      beforeHash = await fileHash(previousPath);
    }
    changes.push({ name: file.normalizedName, status: !previous ? "added" : beforeHash === file.sha256 ? "unchanged" : "changed" });
    if (previous) old.delete(previous.normalizedName.toLowerCase());
  }
  for (const previous of old.values()) changes.push({ name: previous.normalizedName, status: "retained" });
  const merged = [...files, ...old.values()];
  if (parent.assetType === "suit" && !["Hair", "Face"].includes(parent.meta.character?.variant)) {
    const slots = new Set(merged.filter(file => ["model", "skeletalMesh", "staticMesh"].includes(file.role)).map(file => characterMeshIdentity(file.normalizedName).replace(/_lod\d+$/, "")));
    if (slots.size > 4) throw new Error("更新后套装超过 4 个部件，请核对资源归属");
  }
  const plan = { parentId: parent.id, mode: "package", sourceFolder, sourcePaths, parentRevision: parent.meta.characterComponents?.contentRevision || "initial",
    resourceState: packageResourceState(parent), files, excludedFiles, retainedFiles: [...old.values()], changes, unchanged: changes.every(item => ["unchanged", "retained"].includes(item.status)),
    replacedComponentCount: listCharacterComponents(parent).filter(part => part.currentRevision !== part.revisions[0].id).length };
  return { ...plan, token: hash(plan) };
}

async function updateCharacterPackage(options) {
  const note = String(options.note || "").trim();
  if (!note) throw new Error("请填写更新备注");
  const { root, parent } = await loadParent(options.root, options.asset, ["suit", "monster", "npc", "weapon"]);
  return withRecycleLock(root, () => withFileTransaction({ root, owner: "character-components", key: parent.metaPath }, async () => {
    const plan = await prepareCharacterPackageUpdate(options);
    if (!options.token || options.token !== plan.token || options.confirmWholePackage !== true) throw new Error("请重新检查并确认整套更新范围");
    if (plan.unchanged) return { ok: true, parentId: parent.id, unchanged: true, message: "文件内容没有变化，未创建新版本；修改预览请使用更新预览" };
    const revision = crypto.randomUUID();
    const nextFiles = [...plan.retainedFiles];
    const existing = new Map(activeCharacterFiles(parent).map(file => [file.normalizedName.toLowerCase(), file]));
    let completed = 0;
    for (const file of plan.files) {
      options.onProgress?.(10 + completed / plan.files.length * 60, `正在写入更新文件 ${completed + 1}/${plan.files.length}`);
      const previous = existing.get(file.normalizedName.toLowerCase());
      // Unchanged resources keep their existing stored path; only changed bytes are copied.
      if (previous && plan.changes.find(item => item.name === file.normalizedName)?.status === "unchanged") {
        nextFiles.push({ ...previous, sha256: file.sha256 });
        completed++;
        continue;
      }
      const storedPath = `Versions/${revision}/${file.relativePath}`;
      const destination = path.join(parent.path, storedPath);
      await safePath(root, destination, { missing: true });
      await transactionalFs.mkdir(path.dirname(destination), { recursive: true });
      await transactionalFs.copyFile(file.sourcePath, destination);
      if (await fileHash(destination) !== file.sha256) throw new Error("源文件在更新中发生变化，未发布：" + file.sourcePath);
      nextFiles.push({ ...file, originalName: path.basename(file.sourcePath), mtimeMs: undefined, storedPath });
      completed++;
    }
    options.onProgress?.(75, '正在保存更新记录…');
    await safePath(root, path.join(parent.path, "Preview"), { missing: true });
    const previewUri = await copyPreview(parent, options.previewPath, revision);
    await updateAssetMetadataFile(parent.metaPath, async meta => {
      if (packageResourceState({ ...parent, meta }) !== plan.resourceState) throw new Error("整套资产已变化，请重新检查");
      const currentStatus = characterStatus(meta.character?.maturity || meta.characterManifest?.maturity).value;
      if (options.expectedStatus && currentStatus !== options.expectedStatus) throw new Error("制作状态已被其他人修改，请刷新后重试");
      const maturity = options.maturity ? characterStatus(options.maturity).value : currentStatus;
      if (!["wip", "needs_rig", "rigged", "approved"].includes(maturity)) throw new Error("制作状态无效");
      const snapshot = Object.fromEntries(snapshotKeys.map(key => [key, meta[key]]));
      meta.characterPackageHistory = [...(meta.characterPackageHistory || []), { id: crypto.randomUUID(), createdAt: new Date().toISOString(), snapshot }];
      const at = new Date().toISOString();
      const changedNames = new Set(plan.changes.filter(item => ["changed", "added"].includes(item.status)).map(item => item.name.toLowerCase()));
      const parts = listCharacterComponents({ ...parent, meta });
      const affectedParts = parts.filter(part => part.files.some(file => changedNames.has(file.normalizedName.toLowerCase())));
      const textureOnly = plan.files.filter(file => changedNames.has(file.normalizedName.toLowerCase())).every(file => file.role === "texture");
      const label = `${affectedParts.length ? affectedParts.map(part => characterComponentLabel(part, "zh")).join("、") : "资产"}${textureOnly ? "贴图更新" : "资源更新"}`;
      const slots = Object.fromEntries(parts.map(part => [part.slot, {
        meshPreviews: part.meshPreviews,
        updatedAt: part.files.some(file => changedNames.has(file.normalizedName.toLowerCase())) ? at : part.updatedAt,
        ...(part.previewUri ? { previewUri: part.previewUri, previewRevision: affectedParts.includes(part) || part.previewState !== "current" ? `previous:${part.previewRevision}` : revision, previewOrigin: part.previewOrigin,
          previewImages: part.previewImages, previewGalleryRevision: part.previewGalleryRevision,
          previewReloading: affectedParts.includes(part) && part.previewOrigin === "rendered-front" } : {})
      }]));
      const nextState = { schemaVersion: 1, baseRevision: revision, contentRevision: revision,
        suitPreviewNeedsUpdate: parent.assetType === 'suit' && !parent.meta.character?.variant && (meta.characterComponents?.suitPreviewNeedsUpdate === true
          || plan.files.some(file => changedNames.has(file.normalizedName.toLowerCase()) && ['model', 'staticMesh', 'texture'].includes(file.role))),
        previewRevision: previewUri ? revision : (meta.characterComponents?.previewRevision || "initial"),
        previewGalleryRevision: meta.characterComponents?.previewGalleryRevision, slots };
      const pendingViews = parent.assetType === 'suit' && !parent.meta.character?.variant ? [] : markCharacterAutomaticPreviewsReloading(meta, nextState);
      if (previewUri && pendingViews.length) nextState.previewRevision = meta.characterComponents?.previewRevision || "initial";
      meta.characterComponents = nextState;
      meta.characterManifest = { ...meta.characterManifest, files: applyCharacterRigUpdateState(nextFiles, plan.changes), fileCount: nextFiles.length, contentUpdatedAt: at, lastUpdateSummary: label };
      meta.character = { ...meta.character, maturity };
      meta.characterManifest.maturity = maturity;
      if (meta.characterManifest.fields) meta.characterManifest.fields.maturity = maturity;
      const sourcePaths = plan.files.map(file => file.sourcePath);
      const historyFiles = plan.files.map((file, sourceIndex) => ({ name: file.normalizedName, status: plan.changes.find(change => change.name === file.normalizedName)?.status || "changed", sourcePath: file.sourcePath, sourceIndex, storedPath: file.storedPath }));
      meta.characterUpdateHistory = [...(meta.characterUpdateHistory || []), { id: revision, at, label, note, changes: plan.changes, sourcePaths, files: historyFiles }];
      meta.name = characterDisplayName(parent);
      await syncActiveCharacterMetadata(meta, parent);
      if (previewUri) {
        meta.previewImage = previewUri; meta.detailImage = previewUri;
        meta.previews = { ...meta.previews, images: [{ uri: previewUri, tags: ["preview", "cover"] }, ...(meta.previews?.images || []).map(item => ({ ...item, tags: (item.tags || []).filter(tag => tag !== "cover") }))] };
      }
      meta.updatedAt = new Date().toISOString();
      return meta;
    });
    return { ok: true, parentId: parent.id, message: "整套已更新，资产 ID 不变，旧版本及文件已保留" };
  }));
}

async function restoreCharacterPackageVersion(options) {
  const { root, parent } = await loadParent(options.root, options.asset, ["suit", "monster", "npc", "weapon"]);
  return withRecycleLock(root, async () => {
    const historical = (parent.meta.characterPackageHistory || []).find(item => item.id === options.revisionId);
    if (!historical) throw new Error("整套历史版本不存在");
    for (const file of activeCharacterFiles({ ...parent, meta: { ...parent.meta, ...historical.snapshot } })) {
      await safePath(root, path.resolve(parent.path, file.storedPath));
    }
    await updateAssetMetadataFile(parent.metaPath, async meta => {
      if ((meta.characterComponents?.contentRevision || "initial") !== options.expectedRevision) throw new Error("当前整套版本已变化，请刷新");
      const snapshot = Object.fromEntries(snapshotKeys.map(key => [key, meta[key]]));
      meta.characterPackageHistory = [...(meta.characterPackageHistory || []), { id: crypto.randomUUID(), createdAt: new Date().toISOString(), snapshot }];
      for (const key of snapshotKeys) {
        if (historical.snapshot[key] === undefined) delete meta[key]; else meta[key] = historical.snapshot[key];
      }
      await syncActiveCharacterMetadata(meta, parent);
      const at = new Date().toISOString();
      appendCharacterUpdateHistory(meta, { at, label: "整套版本切换",
        changes: [{ name: "整套版本", status: "changed", before: options.expectedRevision, after: options.revisionId }] });
      meta.updatedAt = at;
      return meta;
    });
    return { ok: true, parentId: parent.id, message: "已切换到整套历史版本，所有文件仍保留" };
  });
}
module.exports = { inspectCharacterUpdateInput, matchCharacterTextureReplacements, prepareCharacterPackageUpdate, updateCharacterPackage, restoreCharacterPackageVersion, fileHash };
