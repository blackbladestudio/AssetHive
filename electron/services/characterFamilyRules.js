const path = require("node:path");
const { ownedWeaponIdentity } = require('../../shared/ownedWeaponNaming.mjs');
const gameplay = require('../../shared/gameplayCategories.mjs');
const { gameplayIdentity, gameplayFileStem, gameplayCategoryFromName } = require('../../shared/gameplayNaming.mjs');
const rules = require("../../shared/characterFamilyRules.json");
const filePatterns = require("../../shared/characterFilePatterns.json");
const { auditMonsterPackage, classifyMonsterSource, normalizeMonsterSourceStem, buildMonsterAssetName } = require("../../shared/monsterPackageAudit.mjs");
const { isAllowedCharacterPackageFile, characterRoleAllowsFile } = require("../../shared/characterFilePolicy.mjs");
const { parseWeaponIdentity, splitWeaponPackage, weaponFileSuffix, weaponModelSlot, weaponSideOutput, weaponPackageOutput } = require('../../shared/weaponRules.mjs');

const MAP_SUFFIX = new RegExp(filePatterns.textureSuffix, "i");
const MONSTER_IDENTITY = new RegExp(filePatterns.monsterIdentity, "i");
function getFamilyTextureMapCode(stem) {
  return filePatterns.textureMapCodes[String(stem || "").match(MAP_SUFFIX)?.[1]?.toLowerCase()] || "";
}
const NAME_PATTERN = /^([A-Za-z][A-Za-z0-9]*?)(\d{3})_([A-Za-z][A-Za-z0-9_]*)$/;
const NPC_IDENTITY = /^(?:SK_)?([A-Za-z][A-Za-z0-9_]*?)_(\d{2})$/;
const FOLDERS = {
  animation: "Animation", material: "Material", texture: "Texture",
  skeletalMesh: "Mesh/SkeletalMesh", physicsAsset: "Mesh/SkeletalMesh", skeleton: "Mesh/SkeletalMesh",
  staticMesh: "Mesh/StaticMesh", animationBlueprint: "ABP", blueprint: "BP", actionFile: "ActionFiles"
};

function getFamilyRule(family) {
  return rules[String(family || "").toLowerCase()] || null;
}

const { normalizeNpcCategory, inferNpcCategory } = require('../../shared/npcCategories.mjs');
function parsePackageName(family, value) {
  if (family === 'item') {
    const name = String(value || '').replace(/^(GamePlay|Item)_/i, '').replace(/^(SM|SK)_/i, '');
    const category = gameplayCategoryFromName(name);
    return /^[A-Za-z][A-Za-z0-9_]*$/.test(name) ? { family, category, categoryName: category, serial: '', name, packageName: name } : null;
  }
  if (family === 'weapon') {
    const identity = parseWeaponIdentity(value);
    return identity ? { ...identity, family, categoryName: identity.type, packageName: identity.assetName } : null;
  }
  if (family === 'npc') {
    const npc = String(value || '').trim().match(NPC_IDENTITY);
    if (npc) return { family, category: '', categoryName: '', serial: '', name: npc[1], formIds: [npc[2]], packageName: `SK_${npc[1]}_${npc[2]}` };
  }
  const rule = getFamilyRule(family);
  const match = String(value || "").trim().match(NAME_PATTERN);
  if (!rule || !match) return null;
  const category = rule.categoryMode === "fixed"
    ? rule.categories.find((item) => item.replace(/^\d+_/, "").toLowerCase() === match[1].toLowerCase())
    : family === 'npc' ? normalizeNpcCategory(match[1]) : match[1];
  if (!category) return null;
  return { family, category, categoryName: match[1], serial: match[2], name: match[3], packageName: match[0], ...(family === 'npc' ? { legacyNpcIdentity: true, formIds: [] } : {}) };
}

function parsePackagePath(family, sourcePath) {
  const rule = getFamilyRule(family);
  if (!rule) return null;
  const parts = String(sourcePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  const rootIndex = parts.findIndex((item) => item.toLowerCase() === rule.root.toLowerCase());
  if (family === 'item' && rootIndex >= 0) {
    const category = gameplay.inferCategory([sourcePath]);
    if (category) {
      const count = category.split('/').length;
      const parsed = parsePackageName(family, parts[rootIndex + count + 1]);
      if (parsed) return { ...parsed, category, categoryName: category, sourceRoot: parts.slice(0, rootIndex + count + 2).join('/') };
    }
  }
  if (rootIndex >= 0) {
    const category = family === 'npc' ? normalizeNpcCategory(parts[rootIndex + 1]) : parts[rootIndex + 1] || "";
    const parsed = parsePackageName(family, parts[rootIndex + 2]);
    if (!parsed || parsed.category && parsed.category.toLowerCase() !== category.toLowerCase()) return null;
    return { ...parsed, category: parsed.category || category, categoryName: parsed.categoryName || category,
      sourceRoot: parts.slice(0, rootIndex + 3).join("/") };
  }
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const parsed = parsePackageName(family, parts[index]);
    if (parsed) return { ...parsed, ...(family === 'npc' ? { category: inferNpcCategory([sourcePath]) || parsed.category } : {}), sourceRoot: parts.slice(0, index + 1).join("/") };
  }
  return null;
}

function classifyFamilyFile(family, filePath) {
  if (family === "monster") return classifyMonsterSource(filePath);
  const rule = getFamilyRule(family);
  if (!rule) return { role: "other", folder: "OtherFiles" };
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const filename = normalized.split("/").pop() || "";
  if (!isAllowedCharacterPackageFile(filename)) return { role: "other", folder: "OtherFiles", excluded: true };
  const stem = path.basename(filename, path.extname(filename));
  const parts = normalized.toLowerCase().split("/");
  let role = "other";
  if (/\.(ma|mb|blend|max|spp|ztl|swatches)$/i.test(filename)) role = "other";
  else if (/^SKEL_/i.test(stem)) role = "skeleton";
  else if (/^SK_.+_Physics$/i.test(stem)) role = "physicsAsset";
  else if (/^SK_/i.test(stem)) role = "skeletalMesh";
  else if (/^SM_/i.test(stem)) role = "staticMesh";
  else if (/^MI_/i.test(stem)) role = "material";
  else if (/^T_/i.test(stem) && MAP_SUFFIX.test(stem)) role = "texture";
  else if (/^ABP_/i.test(stem)) role = "animationBlueprint";
  else if (/^BP_/i.test(stem)) role = "blueprint";
  else if (/\.(png|jpe?g|tiff?|tga|webp|bmp|exr|hdr)$/i.test(filename)
    && /(?:preview|thumb|thumbnail|render|beauty)/i.test(stem)) role = "other";
  else if (parts.includes("actionfiles")) role = "actionFile";
  else if (parts.includes("animation")) role = "animation";
  else if (parts.includes("material")) role = "material";
  else if (parts.includes("texture")) role = "texture";
  else if (parts.includes("skeletalmesh")) role = "skeletalMesh";
  else if (parts.includes("staticmesh")) role = "staticMesh";
  else if (/\.(fbx|obj|abc|gltf|glb)$/i.test(filename)) role = "skeletalMesh";
  else if (/\.(png|jpe?g|tiff?|tga|webp|bmp|exr|hdr)$/i.test(filename)
    && !/(?:preview|thumb|thumbnail|render|beauty)/i.test(stem)) role = "texture";
  const allowed = rule.fileRoles.includes(role) && characterRoleAllowsFile(role, filename);
  return { role: allowed ? role : "other", folder: allowed ? FOLDERS[role] || "OtherFiles" : "OtherFiles" };
}

function expectedFamilyStem(family, packageInfo, role, sourceStem) {
  if (['staticMesh', 'skeletalMesh'].includes(role) && /_LOD\d+$/i.test(sourceStem)) {
    const lod = require('../../shared/characterLods.cjs');
    return expectedFamilyStem(family, packageInfo, role, lod.strip(sourceStem)) + lod.suffix(sourceStem);
  }
  if (family === "monster") sourceStem = normalizeMonsterSourceStem(sourceStem);
  const rule = getFamilyRule(family);
  if (!rule || !packageInfo) return "";
  if (family === 'item' && gameplay.categories.includes(packageInfo.category)) return gameplayFileStem(packageInfo.packageName, role, sourceStem,
    [packageInfo.sourcePackageName, packageInfo.sourceName, packageInfo.name]);
  const numberedNpc = family === 'npc' && packageInfo.formIds?.length === 1;
  const subject = numberedNpc ? packageInfo.name
    : rule.assetNameSubject === "package" || (family === "npc" && role === "staticMesh") ? packageInfo.packageName : packageInfo.name;
  const prefix = { skeletalMesh: "SK", physicsAsset: "SK", skeleton: "SKEL", staticMesh: "SM", material: "MI", texture: "T", animationBlueprint: "ABP", blueprint: "BP" }[role];
  if (!prefix) return "";
  const map = role === "texture" ? getFamilyTextureMapCode(sourceStem) : "";
  if (role === "texture" && !map) return "";
  const ownedWeapon = ['monster', 'npc'].includes(family) ? ownedWeaponIdentity(sourceStem, packageInfo.sourceName || packageInfo.name) : null;
  if (ownedWeapon && /^(?:SM|SK|SKEL|MI|T)_WP_/i.test(sourceStem)) {
    const suffix = role === 'texture' ? ownedWeapon.suffix.replace(MAP_SUFFIX, '') + '_' + map : ownedWeapon.suffix;
    return `${prefix}_WP_${packageInfo.name}_${suffix}`;
  }
  const monsterIdentity = family === "monster" || numberedNpc ? sourceStem.match(MONSTER_IDENTITY) : null;
  const confirmedForm = (family === 'monster' || numberedNpc) && packageInfo.formIds?.length === 1 ? packageInfo.formIds[0] : null;
  const formSuffix = confirmedForm === 'base' ? '' : confirmedForm ? `_${confirmedForm}` : '';
  if (family === "monster" && !monsterIdentity && /_WP_/i.test(sourceStem)) {
    return `${prefix}_${subject}${formSuffix}${sourceStem.slice(sourceStem.toUpperCase().indexOf("_WP_"))}`;
  }
  if (monsterIdentity) {
    const tail = `${confirmedForm !== null ? formSuffix : `_${monsterIdentity[2]}`}${monsterIdentity[3] ? `_${monsterIdentity[3]}` : ""}`;
    const base = `${prefix}_${subject}${tail}`;
    return role === "texture" ? `${base.replace(MAP_SUFFIX, "")}_${map}` : base;
  }
  if (numberedNpc && confirmedForm !== null) {
    let raw = String(sourceStem || '').replace(/^(?:SKEL|SK|SM|MI|T|ABP|BP)_/i, '');
    if (role === 'texture') raw = raw.replace(MAP_SUFFIX, '');
    if (role === 'physicsAsset') raw = raw.replace(/_Physics$/i, '');
    let suffix = '';
    const candidates = [packageInfo.sourcePackageName, packageInfo.sourceName, packageInfo.name]
      .map(value => String(value || '').replace(/^SK_/i, '')).filter(Boolean).sort((a, b) => b.length - a.length);
    for (const candidate of candidates) {
      if (raw.toLowerCase() === candidate.toLowerCase()) { raw = ''; suffix = ''; break; }
      if (raw.toLowerCase().startsWith(candidate.toLowerCase() + '_')) { suffix = raw.slice(candidate.length); break; }
      const legacy = raw.match(new RegExp(`^[A-Za-z][A-Za-z0-9]*?\\d{3}_${candidate.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}(.*)$`, 'i'));
      if (legacy) { suffix = legacy[1] || ''; break; }
    }
    if (!suffix && /_WP_/i.test(raw)) suffix = raw.slice(raw.toUpperCase().indexOf('_WP_'));
    const base = `${prefix}_${subject}${formSuffix}${suffix}`;
    if (role === 'physicsAsset') return `${base}_Physics`;
    if (role === 'texture') return `${base}_${map}`;
    return base;
  }
  const variant = family === "monster" || numberedNpc ? (confirmedForm !== null ? (confirmedForm === 'base' ? '' : confirmedForm) : sourceStem.match(/_(\d{2})(?:_(?:ORM|D|N|A|Physics))?$/i)?.[1] || "") : "";
  const suffix = family === 'weapon' ? weaponFileSuffix(sourceStem, role, packageInfo.sourcePackageName || packageInfo.packageName) : '';
  const rawBase = `${prefix}_${subject}${suffix}${variant ? `_${variant}` : ""}`;
  const base = family === 'weapon' ? weaponPackageOutput(weaponSideOutput(rawBase), subject) : rawBase;
  if (role === "physicsAsset") return `${base}_Physics`;
  if (role === "texture") return `${base}_${map}`;
  return base;
}

function validateFamilyFileName(family, packageInfo, filePath, role) {
  if (!getFamilyRule(family) || !packageInfo) return "unrecognized";
  const filename = path.basename(String(filePath || "").replace(/\\/g, "/"));
  const stem = path.basename(filename, path.extname(filename));
  if (["animation", "actionFile", "other"].includes(role)) return "allowed";
  const expected = expectedFamilyStem(family, packageInfo, role, stem);
  if (!expected) return "unrecognized";
  if (stem.toLowerCase() === expected.toLowerCase()) return "valid";
  if (role === "material" && stem.toLowerCase().startsWith(`${expected.toLowerCase()}_`)) return "valid";
  if (role === "texture" && stem.toLowerCase().startsWith(`${expected.replace(MAP_SUFFIX, "").toLowerCase()}_`)
    && stem.match(MAP_SUFFIX)?.[1]?.toLowerCase() === getFamilyTextureMapCode(stem).toLowerCase()) return "valid";
  if (family === "npc" && !packageInfo.formIds?.length && role === "staticMesh" && stem.toLowerCase() === `sm_${packageInfo.packageName}`.toLowerCase()) return "valid";
  if (family === "npc" && !packageInfo.formIds?.length && role === "skeletalMesh" && stem.toLowerCase() === `sk_${packageInfo.packageName}`.toLowerCase()) return "valid";
  return "mismatch";
}

function buildFamilyPackagePlan(family, sourcePath, files = [], confirmed = {}) {
  if (family === 'npc') confirmed = { ...confirmed, category: normalizeNpcCategory(confirmed.category || inferNpcCategory([sourcePath])) };
  files = files.filter(isAllowedCharacterPackageFile);
  const rule = getFamilyRule(family);
  if (!rule) return { ok: false, errors: ["未知角色资产类型"], files: [] };
  const sourceIdentity = parsePackagePath(family, sourcePath);
  // Source folders are hints. Confirmed fields define the destination identity.
  let identity = confirmed.assetName ? parsePackageName(family, confirmed.assetName) : sourceIdentity;
  if (family === 'item' && identity) {
    identity.category = gameplay.normalizeCategory(confirmed.category || sourceIdentity?.category || '');
    identity.categoryName = identity.category;
    if (gameplay.categories.includes(identity.category)) {
      const result = gameplayIdentity(identity.category, confirmed.name || identity.name);
      const sourceCategory = gameplayCategoryFromName(sourceIdentity?.packageName || '');
      identity = result.assetName ? { ...identity, name: result.name, packageName: result.assetName,
        sourcePackageName: sourceIdentity?.packageName || '', sourceName: gameplayIdentity(sourceCategory, sourceIdentity?.name || '').name } : null;
    }
  }
  if (family === 'weapon' && identity) {
    const sourceGroups = splitWeaponPackage(files).groups;
    identity.sourcePackageName = sourceGroups.length === 1 ? sourceGroups[0].assetName : sourceIdentity?.packageName;
  }
  if (family === "monster") {
    const name = String(confirmed.name || identity?.name || confirmed.assetName || "").trim();
    const category = String(confirmed.category || identity?.category || "").trim();
    identity = /^[A-Za-z][A-Za-z0-9_]*$/.test(name) ? {
      ...(identity || {}), family, category, categoryName: category.replace(/^\d+_/, ""),
      name, serial: identity?.serial || "", packageName: identity?.packageName || name, formIds: confirmed.formIds
    } : null;
  }
  if (family === 'npc' && identity) {
    const name = String(confirmed.name || identity.name || '').trim();
    const category = String(confirmed.category || identity.category || '').trim();
    const formIds = Array.isArray(confirmed.formIds) && confirmed.formIds.length ? confirmed.formIds.map(String) : identity.formIds || [];
    identity = /^[A-Za-z][A-Za-z0-9_]*$/.test(name) && category ? {
      ...identity, family, category, categoryName: category, name, formIds, serial: identity.legacyNpcIdentity ? identity.serial : '',
      packageName: identity.legacyNpcIdentity && !formIds.length ? identity.packageName : buildMonsterAssetName(name, formIds),
      sourcePackageName: sourceIdentity?.packageName || '', sourceName: sourceIdentity?.name || ''
    } : null;
  }
  const errors = identity ? [] : [family === "monster" ? "请确认怪物类别和名称"
    : family === 'npc' ? '请确认 NPC 类别、英文名和两位形态编号'
      : family === 'item' ? '请确认玩法物件类别和英文名' : "请补齐类别、三位编号和名称，生成规范资产名称"];
  if (family === 'item' && ![...gameplay.categories, ...rule.categories].includes(identity?.category)) errors.push('请选择玩法物件类别');
  const monsterAudit = family === "monster" ? auditMonsterPackage(files, { expectedName: identity?.name, modelAnalyses: confirmed.modelAnalyses }) : null;
  if (identity && monsterAudit?.sourceName) identity.sourceName = monsterAudit.sourceName;
  if (monsterAudit) errors.push(...monsterAudit.issues.map((issue) => issue.message));
  if (family === 'monster' && confirmed.formIds?.length && (confirmed.formIds.length !== 1 || !/^(?:base|\d{2})$/.test(confirmed.formIds[0]))) errors.push('请填写两位形态编号');
  if (['monster', 'npc'].includes(family) && confirmed.monsterVariant && !/^[A-Za-z][A-Za-z0-9_]*$/.test(confirmed.monsterVariant)) errors.push('变体以字母开头，仅使用字母、数字和下划线');
  if (family === 'npc' && !identity?.legacyNpcIdentity && (identity?.formIds?.length !== 1 || !/^\d{2}$/.test(identity.formIds[0]))) errors.push('请填写 NPC 两位形态编号');
  if (family === "monster" && !rule.importCategories.includes(identity?.category)) {
    errors.push("请选择怪物类别：大首领、小首领、精英怪、普通怪或杂兵怪");
  }
  if (identity && confirmed.category && (family === 'item' ? gameplay.normalizeCategory(confirmed.category) : confirmed.category).toLowerCase() !== identity.category.toLowerCase()) errors.push("资产类别与规范资产名称不一致");
  const sourcePackages = new Set(files.map((file) => parsePackagePath(family, file)?.packageName.toLowerCase()).filter(Boolean));
  if (family !== 'item' && sourcePackages.size > 1) errors.push("文件来自另一资产包：请分别导入每个资产包");
  const seen = new Set();
  const planned = files.map((sourceFile) => {
    const classification = classifyFamilyFile(family, sourceFile);
    const modelAnalysis = confirmed.modelAnalyses?.get(path.resolve(sourceFile).toLowerCase());
    if (['staticMesh', 'skeletalMesh'].includes(classification.role) && ['staticMesh', 'skeletalMesh'].includes(modelAnalysis?.meshKind)) {
      classification.role = modelAnalysis.meshKind;
      classification.folder = FOLDERS[classification.role];
    }
    const basename = path.basename(String(sourceFile || "").replace(/\\/g, "/"));
    const stem = monsterAudit?.modelAliases[sourceFile] || path.basename(basename, path.extname(basename));
    const status = validateFamilyFileName(family, identity, sourceFile, classification.role);
    if (classification.role === "texture" && status === "unrecognized") {
      errors.push(`贴图缺少 D / N / ORM / A 类型标记：${basename}`);
    }
    const expected = expectedFamilyStem(family, identity, classification.role, stem);
    const normalizedName = status === "mismatch" && expected ? `${expected}${path.extname(basename)}` : basename;
    const sourceParts = String(sourceFile || "").replace(/\\/g, "/").split("/").filter(Boolean);
    const packageIndex = sourceParts.findIndex((part) => part.toLowerCase() === (sourceIdentity || identity)?.packageName.toLowerCase());
    const otherSubfolders = classification.role === "other" && packageIndex >= 0
      ? sourceParts.slice(packageIndex + 1, -1).filter((part) => part !== "." && part !== "..")
      : [];
    const relativePath = [classification.folder, ...otherSubfolders, normalizedName].join("/");
    if (seen.has(relativePath.toLowerCase())) errors.push(`目标文件重名：${relativePath}`);
    seen.add(relativePath.toLowerCase());
    const formId = family === "monster" || family === 'npc' && identity?.formIds?.length
      ? (normalizedName.replace(/\.[^.]+$/, "").match(MONSTER_IDENTITY)?.[2]
        || (classification.role === "other" ? [...sourceParts].reverse().map((part) => part.match(MONSTER_IDENTITY)?.[2]).find(Boolean) : "")
        || (["skeletalMesh", "staticMesh"].includes(classification.role) ? "base" : ""))
      : "";
    const modernWeapon = ['monster', 'npc'].includes(family) && /^(?:SM|SK|SKEL|MI|T)_WP_/i.test(normalizedName) ? ownedWeaponIdentity(normalizedName.replace(/\.[^.]+$/, ''), identity?.name) : null;
    const componentName = modernWeapon ? modernWeapon.suffix.replace(MAP_SUFFIX, '') : family === 'weapon' ? weaponModelSlot(normalizedName) || stem.match(/_Part_(.+?)(?:_(?:D|N|ORM|A|Physics))?$/i)?.[1] || '' : ['monster', 'npc'].includes(family)
      ? normalizedName.replace(/\.[^.]+$/, "").match(/_WP_(.+?)(?:_(?:ORM|D|N|A|Emissive))?$/i)?.[1] || ""
      : "";
    return { sourcePath: sourceFile, sourceName: basename, normalizedName, role: classification.role, relativePath, nameStatus: status,
      ...(classification.role === "texture" ? { textureMapCode: getFamilyTextureMapCode(normalizedName.replace(/\.[^.]+$/, "")) } : {}),
      ...(componentName ? { componentRole: family === 'weapon' ? 'part' : 'weapon', componentName } : {}),
      ...(['monster', 'npc'].includes(family) ? { formId: modernWeapon ? '' : formId } : {}) };
  });
  if (identity?.category !== "0_Common" && !planned.some((item) => item.role === "skeletalMesh" || item.role === "staticMesh")) errors.push("未识别到 Mesh/SkeletalMesh 或 Mesh/StaticMesh 模型");
  if (!confirmed.partial) {
    try { require('../../shared/characterLods.cjs').validate(planned); } catch (error) { errors.push(error.message); }
  }
  // Only body mesh files establish forms. Texture/project numbers are association hints.
  const isMeshFile = (item) => ["skeletalMesh", "staticMesh"].includes(item.role)
    && filePatterns.meshExtensions.includes(path.extname(item.sourceName).slice(1).toLowerCase());
  const formIds = ['monster', 'npc'].includes(family) && confirmed.formIds?.length === 1
    ? [...confirmed.formIds] : family === 'npc' ? identity?.formIds || [] : monsterAudit?.formIds || [];
  if (family === "monster") {
    const weaponModels = planned.filter((item) => item.componentRole === "weapon" && isMeshFile(item));
    for (const model of weaponModels) {
      // Only a weapon with no form suffix is explicitly shared. A numbered weapon stays with its form.
      if ((/^(?:SM|SK)_WP_/i.test(model.normalizedName) || !model.normalizedName.replace(/\.[^.]+$/, "").match(MONSTER_IDENTITY))
        && weaponModels.filter((item) => item.componentName.toLowerCase() === model.componentName.toLowerCase()).length === 1) {
        model.sourceFormId = model.formId;
        model.formId = "";
        model.sharedAcrossForms = true;
      }
    }
    for (const item of planned) {
      if (item.formId && !formIds.includes(item.formId)) {
        item.unresolvedFormToken = item.formId;
        item.formId = "";
      }
    }
    if (!formIds.length) errors.push("未识别到怪物主体模型；武器、贴图和工程文件不能单独确认怪物形态");
    if (formIds.length > 1) errors.push(`检测到多个主体形态（${formIds.join(" / ")}）；请每个形态分别选择文件夹导入，再关联到同一怪物`);
  }
  return {
    ok: errors.length === 0, family, category: identity?.category || "", assetName: identity?.packageName || "",
    fields: identity ? { serial: identity.serial, name: identity.name, category: identity.category, ...(family === 'npc' ? { formIds } : {}), ...(family === 'monster' || (family === 'npc' && confirmed.monsterVariant) ? { monsterVariant: String(confirmed.monsterVariant || '').trim() } : {}) } : {},
    relativeDirectory: identity ? `${rule.root}/${identity.category}/${identity.packageName}` : "",
    files: planned, errors,
    ...(monsterAudit ? { validationIssues: monsterAudit.issues } : {}),
    ...(family === "monster" && identity ? {
      monsterNameKey: `monster:${identity.category.toLowerCase()}:${identity.name.toLowerCase()}`,
      forms: formIds.map((id) => ({
        id,
        hasMesh: true,
        files: planned.filter((item) => item.formId === id).map((item) => item.relativePath)
      })),
      sharedFiles: planned.filter((item) => !item.formId && !item.unresolvedFormToken).map((item) => item.relativePath),
      unassignedFiles: planned.filter((item) => item.unresolvedFormToken).map((item) => item.relativePath)
    } : {}),
    warnings: planned.filter((item) => ["mismatch", "unrecognized"].includes(item.nameStatus)).map((item) => `请核对命名：${item.sourceName}`)
  };
}

// Preserve each family's identity/forms while routing meshes by inspected content.
function applyFamilyModelAnalyses(plan, analyses) {
  const remapped = new Map();
  for (const file of plan.files) {
    if (!["staticMesh", "skeletalMesh"].includes(file.role)) continue;
    const analysis = analyses.get(path.resolve(file.sourcePath).toLowerCase());
    if (!analysis || !["staticMesh", "skeletalMesh"].includes(analysis.meshKind)) continue;
    const oldPath = file.relativePath;
    file.role = analysis.meshKind;
    const prefix = file.role === "staticMesh" ? "SM" : "SK";
    file.normalizedName = /^(SM|SK)_/i.test(file.normalizedName)
      ? file.normalizedName.replace(/^(SM|SK)_/i, prefix + "_") : prefix + "_" + file.normalizedName;
    file.relativePath = `${file.role === "staticMesh" ? "Mesh/StaticMesh" : "Mesh/SkeletalMesh"}/${file.normalizedName}`;
    remapped.set(oldPath, file.relativePath);
  }
  const targets = plan.files.map(file => file.relativePath.toLowerCase());
  if (new Set(targets).size !== targets.length) throw new Error("模型检查后出现重复目标，请保留每个部件同一类型的一份模型");
  for (const form of plan.forms || []) form.files = form.files.map(file => remapped.get(file) || file);
  for (const key of ["sharedFiles", "unassignedFiles"]) if (plan[key]) plan[key] = plan[key].map(file => remapped.get(file) || file);
  return plan;
}

function resolveMonsterAssociation(plan, relatedAssetId, records = []) {
  if (!relatedAssetId) return { ok: true, entityKey: "" };
  const target = records.find((record) => record.id === relatedAssetId && record.assetType === "monster");
  if (!target) return { ok: false, message: "关联怪物已不存在，请重新选择" };
  const fields = target.meta?.character || {};
  const category = target.meta?.category || target.meta?.characterManifest?.ruleCategory || "";
  if (category.toLowerCase() !== plan.category.toLowerCase()
    || String(fields.name || target.name || "").toLowerCase() !== plan.fields.name.toLowerCase()) {
    return { ok: false, message: "关联怪物的类别或名称不一致，请核对归属" };
  }
  const entityKey = fields.entityKey || `monster:asset:${target.id}`;
  const duplicate = records.some((record) => record.assetType === "monster"
    && (record.meta?.character?.entityKey || `monster:asset:${record.id}`) === entityKey
    && String(record.meta?.character?.monsterVariant || '').toLowerCase() === String(plan.fields.monsterVariant || '').toLowerCase()
    && record.meta?.character?.formIds?.some((id) => plan.forms.some((form) => form.id === id)));
  if (duplicate) return { ok: false, message: "该怪物已有相同形态，请查看已有记录；新增形态不会覆盖旧形态" };
  return { ok: true, entityKey };
}

module.exports = { getFamilyRule, parsePackageName, parsePackagePath, classifyFamilyFile, expectedFamilyStem, validateFamilyFileName, buildFamilyPackagePlan, applyFamilyModelAnalyses, getFamilyTextureMapCode, resolveMonsterAssociation, buildMonsterAssetName };
