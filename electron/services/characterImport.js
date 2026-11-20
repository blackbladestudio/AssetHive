const { heroSuitPart, heroPartKind, heroPartName, inferHeroPart, auditHeroPackage, cleanSuitName, heroModelStem } = require("../../shared/heroPackageRules.mjs");
const { heroTextureSuffix } = require('../../shared/heroMaterialRules.mjs');
const { reviewSuitMaterialSlots } = require('../../shared/suitMaterialMatching.mjs');
const gameplay = require('../../shared/gameplayCategories.mjs');
const { gameplayIdentity, gameplayCategoryFromName } = require('../../shared/gameplayNaming.mjs');
const { CHARACTER_MODEL_EXTENSIONS } = require("../../shared/characterFilePolicy.mjs");
const { inferCharacterChineseName } = require("../../shared/characterNames.mjs");
const CHARACTER_ASSET_TYPES = Object.freeze(["suit", "monster", "npc", "weapon", "item"]);
const CHARACTER_ASSET_TYPE_SET = new Set(CHARACTER_ASSET_TYPES);

const CHARACTER_DEFAULT_CATEGORIES = Object.freeze({
  suit: "Male_01",
  monster: "4_NormalMonster",
  npc: "Other",
  weapon: "Other",
  item: "Interactable"
});

const CHARACTER_FAMILY_FOLDERS = Object.freeze({
  suit: ["Character", "Hero"],
  monster: ["Character", "Monster"],
  npc: ["Character", "NPC"],
  weapon: ["Character", "Weapon"],
  item: ["Character", "GameplayItem"]
});

const SUIT_CLASS_BY_CODE = Object.freeze({ M: "Medium", H: "Heavy", L: "Light" });
const CHARACTER_PART_NAMES = Object.freeze({
  arm: "Arm",
  body: "Body",
  downbody: "Downbody",
  face: "Face",
  hair: "Hair",
  hand: "Hand",
  head: "Head",
  leg: "Leg",
  shoe: "Shoe",
  upbody: "Upbody"
});
const CHARACTER_TEXTURE_MAP_CODES = Object.freeze({
  a: "A",
  alpha: "A",
  opacity: "A",
  d: "D",
  albedo: "D",
  basecolor: "D",
  diffuse: "D",
  n: "N",
  normal: "N",
  orm: "ORM"
});

function normalizeCharacterToken(value) {
  return String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isCharacterAssetType(assetType) {
  return CHARACTER_ASSET_TYPE_SET.has(String(assetType || "").trim().toLowerCase());
}

function getCharacterDefaultCategory(assetType) {
  return CHARACTER_DEFAULT_CATEGORIES[String(assetType || "").trim().toLowerCase()] || "Other";
}

function buildCharacterRelativeRoot(assetType, category) {
  const normalizedType = String(assetType || "").trim().toLowerCase();
  if (!isCharacterAssetType(normalizedType)) return [];
  if (normalizedType === 'item' && gameplay.categories.includes(gameplay.normalizeCategory(category))) return [...CHARACTER_FAMILY_FOLDERS.item, ...gameplay.normalizeCategory(category).split('/')];
  const safeCategory = normalizeCharacterToken(category) || getCharacterDefaultCategory(normalizedType);
  return [...CHARACTER_FAMILY_FOLDERS[normalizedType], safeCategory];
}

function inferCharacterAssetType(values = []) {
  if (values.some(gameplayCategoryFromName)) return 'item';
  if (gameplay.inferCategory(values)) return 'item';
  const text = values.map((value) => String(value || "")).join(" ");
  if (/(?:^|[\\/])(?:GameplayItems?|Chest|FormationFlag|Interactable|ThrowingKnife|Consumable|DroppedGear)(?:[\\/]|$)/i.test(text)) return 'item';
  if (/(?:^|[\\/_\s-])(weapon|bow|arrow|dagger|dualhands|dualaxe|greataxe|greatsword|jade|longsword|pairedswords|shieldaxe|sword|blade|spear|shield|axe|gun)\d*(?:$|[\\/_\s.-])/i.test(text)
    || /(?:^|[_.-])(?:SK|SM|T|MI)_?(?:Bow|Arrow|Dagger|DualHands|DualAxe|GreatAxe|GreatSword|Jade|LongSword|PairedSwords|ShieldAxe|Sword|Spear|Shield|Axe)/i.test(text)) return "weapon";
  if (/(?:^|[\\/_\s-])(npc|merchant|keeper|vendor)\d*(?:$|[\\/_\s.-])/i.test(text)) return "npc";
  if (/(?:^|[\\/_\s-])(monster|boss|miniboss|elite|minion)(?:$|[\\/_\s.-])/i.test(text)) return "monster";
  return "suit";
}

function inferCharacterFields(assetType, values = []) {
  const normalizedType = isCharacterAssetType(assetType) ? String(assetType).toLowerCase() : inferCharacterAssetType(values);
  const text = values.map((value) => String(value || "")).join(" ");
  const compactBody = text.match(/(?:^|[\\/_\s-])([MF])(\d{2})(?=$|[\\/_\s.-])/i);
  const namedBody = text.match(/(?:^|[\\/_\s-])(Male|Female)[_-]?(\d{2})(?=$|[\\/_\s.-])/i);
  const namedSuit = text.match(/(?:^|[\\/_\s-])(Medium|Heavy|Light)(\d{3})(?=$|[\\/_\s.-])/i);
  const compactSuit = text.match(/(?:^|[\\/_\s-])([MHL])(\d{3})(?=$|[\\/_\s.-])/i);
  const gender = compactBody ? (compactBody[1].toUpperCase() === "F" ? "Female" : "Male")
    : (namedBody ? (namedBody[1].toLowerCase() === "female" ? "Female" : "Male") : "");
  const suitClass = namedSuit
    ? `${namedSuit[1][0].toUpperCase()}${namedSuit[1].slice(1).toLowerCase()}`
    : (compactSuit ? SUIT_CLASS_BY_CODE[compactSuit[1].toUpperCase()] || "" : "");
  let suitName = "";
  for (const value of values) {
    const stem = String(value || "").replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") || "";
    const match = stem.match(/^(?:SK_|SM_|MI_|T_)?(?:M|F)\d{2}_(?:Medium|Heavy|Light)\d{3}_(.+)$/i);
    const name = match?.[1]?.replace(/_(?:Arm|Downbody|Head|Upbody|Physics)(?:_.*)?$/i, '');
    if (name && /^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
      suitName = name;
      break;
    }
  }
  const displayNameZh = inferCharacterChineseName(values);
  return {
    ...(displayNameZh ? { displayNameZh } : {}),
    ...(normalizedType === 'suit' && suitName ? { displayNameEn: suitName } : {}),
    family: normalizedType,
    gender,
    bodyCode: compactBody?.[2] || namedBody?.[2] || "",
    suitClass,
    suitName,
    serial: namedSuit?.[2] || compactSuit?.[2] || "",
    variant: "",
    ...(normalizedType === "suit" ? inferHeroPart(values) || {} : {}),
    maturity: "wip",
    confirmed: false
  };
}

function getCharacterCategoryFromFields(assetType, fields = {}) {
  if (String(assetType || "").toLowerCase() !== "suit") return "";
  if (heroPartKind(fields)) return heroPartKind(fields);
  if (fields.gender === "Male") return "Male_01";
  if (fields.gender === "Female") return "Female_01";
  return "";
}

function buildCharacterAssetName(assetType, fields = {}) {
  if (String(assetType || "").toLowerCase() !== "suit") return "";
  if (heroPartKind(fields)) return heroPartName(fields);
  const genderCode = fields.gender === "Female" ? "F" : (fields.gender === "Male" ? "M" : "");
  const bodyCode = String(fields.bodyCode || "");
  const serial = String(fields.serial || "");
  const suitName = fields.displayNameEn !== undefined ? String(fields.displayNameEn).trim() : cleanSuitName(fields.suitName);
  if (!genderCode || !/^\d{2}$/.test(bodyCode) || !["Light", "Medium", "Heavy"].includes(fields.suitClass)
    || !/^\d{3}$/.test(serial) || !suitName) return "";
  return `${genderCode}${bodyCode}_${fields.suitClass}${serial}_${suitName}`;
}

function inferCharacterSourcePackageName(folderName, files = []) {
  const rawFolder = String(folderName || "").trim();
  if (!/^(?:scenes?|source|sources)$/i.test(rawFolder)) return rawFolder;
  for (const filePath of files) {
    const parts = String(filePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
    const sceneIndex = parts.findIndex((part) => part.toLowerCase() === rawFolder.toLowerCase());
    if (sceneIndex > 0) return parts[sceneIndex - 1];
  }
  return rawFolder;
}

function inferCharacterTextureType(filePath) {
  const stem = String(filePath || "").replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") || "";
  const hairChannel = /_(Opacity|Alpha|Root|ID|Height|Depth|Tangent|Flow|Scatter|SRMF|Mask)$/i.test(stem) ? require('../../shared/heroMaterialRules.mjs').heroTextureChannel(filePath) : '';
  return hairChannel || (/(?:^|_)A$/i.test(stem) ? "Opacity" : "");
}

function inferCharacterTextureGroup(filePath) {
  const stem = String(filePath || "").replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") || "";
  const withoutMap = require('../../shared/characterFilePolicy.mjs').characterTextureChannel(filePath) ? stem.slice(0, stem.lastIndexOf('_')) : stem;
  if (!withoutMap || withoutMap === stem) return "";
  const suitPart = withoutMap.match(/(?:^|_)[MHL]\d{3}_[MF]\d{2}_(.+)$/i)?.[1];
  const canonicalPart = withoutMap.match(/^T_[MF]\d{2}_(?:Light|Medium|Heavy)\d{3}_[^_]+_(.+)$/i)?.[1];
  return String(suitPart || canonicalPart || withoutMap.replace(/^T_/i, "")).trim();
}

function canonicalizeCharacterPart(value, suitName = "") {
  const normalized = normalizeCharacterToken(value).replace(/^(?:SK|SM|MI|T)_/i, "");
  const match = normalized.match(/^(.*?)(?:_(\d{1,2}))?$/);
  const base = String(match?.[1] || normalized).replace(/_+/g, "_");
  const index = match?.[2] ? String(Number(match[2])).padStart(2, "0") : "";
  const compact = base.replace(/_/g, "").toLowerCase();
  const normalizedSuitName = normalizeCharacterToken(suitName);
  let canonical = CHARACTER_PART_NAMES[compact] || "";
  if (!canonical && normalizedSuitName && compact === normalizedSuitName.replace(/_/g, "").toLowerCase()) {
    canonical = normalizedSuitName;
  }
  if (!canonical) {
    canonical = base
      .split("_")
      .filter(Boolean)
      .map((token) => `${token.charAt(0).toUpperCase()}${token.slice(1)}`)
      .join("_");
  }
  return `${canonical || "Part"}${index ? `_${index}` : ""}`;
}

function inferCharacterModelPart(filePath, assetName = "", suitName = "") {
  const stem = String(filePath || "").replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") || "";
  const escapedAssetName = String(assetName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const assetPrefix = escapedAssetName ? new RegExp(`^(?:SK|SM)_${escapedAssetName}_`, "i") : null;
  let raw = assetPrefix?.test(stem) ? stem.replace(assetPrefix, "") : "";
  if (!raw) raw = stem.match(/(?:^|_)[MHL]\d{3}_[MF]\d{2}_(.+)$/i)?.[1] || "";
  if (!raw) {
    const trailingPart = stem.match(/(?:^|_)(Arm|Body|Downbody|Face|Hair|Hand|Head|Leg|Shoe|Upbody)(?:_(\d{1,2}))?$/i);
    raw = trailingPart?.[1] ? `${trailingPart[1]}${trailingPart[2] ? `_${trailingPart[2]}` : ""}` : "";
  }
  return canonicalizeCharacterPart(raw || "Mesh", suitName);
}

function normalizeCharacterTextureMapCode(textureType, filePath = "") {
  const typeCode = String(textureType || "").replace(/[^a-z]/gi, "").toLowerCase();
  return require('../../shared/characterFilePolicy.mjs').characterTextureChannel(filePath, typeCode) || CHARACTER_TEXTURE_MAP_CODES[typeCode] || "MAP";
}

function buildCharacterModelBaseName(assetName, sourcePath, fields = {}, meshKind = "staticMesh") {
  const canonical = heroModelStem(assetName, sourcePath, fields, meshKind);
  if (canonical) return canonical;
  return `${meshKind === "skeletalMesh" ? "SK" : "SM"}_${assetName}_${inferCharacterModelPart(sourcePath, assetName, fields.suitName)}`;
}

function buildCharacterMaterialBaseName(assetName, groupName, fields = {}) {
  if (heroPartKind(fields)) return `MI_${assetName}`;
  return `MI_${assetName}_${canonicalizeCharacterPart(groupName, fields.suitName)}`;
}

function buildCharacterTextureBaseName(assetName, groupName, textureType, sourcePath, fields = {}) {
  if (heroPartKind(fields)) return `T_${assetName}_${heroTextureSuffix(sourcePath, fields.variant) || normalizeCharacterTextureMapCode(textureType, sourcePath)}`;
  const part = canonicalizeCharacterPart(groupName || inferCharacterTextureGroup(sourcePath) || "Texture", fields.suitName);
  const mapCode = normalizeCharacterTextureMapCode(textureType, sourcePath);
  return `T_${assetName}_${part}_${mapCode}`;
}

function normalizeCharacterFields(assetType, input = {}) {
  const family = isCharacterAssetType(assetType) ? String(assetType).trim().toLowerCase() : "";
  input = { ...input, ...require('../../shared/characterNames.mjs').syncCharacterNames(family, input) };
  return {
    ...require("../../shared/characterNames.mjs").normalizeCharacterNames(input),
    family,
    ...(family === 'suit' && input.materialSlotMappings ? { materialSlotMappings: Object.fromEntries(Object.entries(input.materialSlotMappings).filter(([key, value]) => key.includes('|') && typeof value === 'string' && /^[a-z0-9]+$/.test(value))) } : {}),
    gender: normalizeCharacterToken(input.gender),
    bodyCode: normalizeCharacterToken(input.bodyCode),
    suitClass: normalizeCharacterToken(input.suitClass),
    suitName: normalizeCharacterToken(input.suitName),
    ...(family !== "suit" && input.name ? { name: normalizeCharacterToken(input.name) } : {}),
    ...(family === 'weapon' ? { weaponType: normalizeCharacterToken(input.weaponType),
      ...(['single', 'combined'].includes(input.weaponAssembly) ? { weaponAssembly: input.weaponAssembly } : {}),
      ...(['auto', 'sharedPair', 'separatePair', 'bow', 'custom'].includes(input.weaponLayout) ? { weaponLayout: input.weaponLayout } : {}),
      relatedAssetId: String(input.relatedAssetId || '').trim() } : {}),
    ...(['monster', 'npc'].includes(family) ? {
      ...(family === 'monster' ? { relatedAssetId: String(input.relatedAssetId || "").trim() } : {}),
      formIds: Array.isArray(input.formIds) ? input.formIds.map(String) : []
    } : {}),
    serial: normalizeCharacterToken(input.serial),
    variant: normalizeCharacterToken(input.variant),
    maturity: String(input.maturity || "").toLowerCase() === "final" ? "approved" : ["wip", "needs_rig", "rigged", "approved"].includes(String(input.maturity || "").toLowerCase())
      ? String(input.maturity).toLowerCase()
      : "wip",
    confirmed: input.confirmed === true,
    nameConfirmed: input.nameConfirmed === true
  };
}

function validateCharacterImport({ assetType, assetName, category, characterFields, packageFiles, previewPaths, modelAnalyses = {}, materialNames = {} }) {
  const errors = [];
  const independentPart = assetType === 'suit' && heroPartKind(characterFields);
  if (assetType === 'item' && gameplay.categories.includes(gameplay.normalizeCategory(category))) {
    const identity = gameplayIdentity(category, characterFields?.displayNameEn);
    if (!identity.assetName) errors.push(category.startsWith('Item/') ? '请填写数字资源 ID' : '请填写英文名，以英文字母开头，仅使用字母、数字和下划线');
    else if (assetName !== identity.assetName) errors.push(`规范资产名应为：${identity.assetName}`);
  } else if (!independentPart && !require('../../shared/characterNames.mjs').validCharacterEnglishName(characterFields?.displayNameEn)) errors.push('请填写英文名，以英文字母开头，仅使用字母、数字和下划线');
  if (!independentPart && characterFields?.nameConfirmed !== true) errors.push('请核对中文名和英文名并勾选确认');
  if (!(assetType === "suit" && heroPartKind(characterFields)) && !require("../../shared/characterNames.mjs").validCharacterChineseName(characterFields?.displayNameZh)) errors.push("请填写包含汉字的中文名（最多32字），不能只填写英文或拼音");
  if (!isCharacterAssetType(assetType)) errors.push("请选择角色资产类型");
  if (!normalizeCharacterToken(assetName)) errors.push("请填写资产名称");
  if (!normalizeCharacterToken(category)) errors.push("请选择角色分类");
  if (!Array.isArray(packageFiles) || packageFiles.length === 0) errors.push("角色资产包中没有可入库文件");
  if (assetType === "suit") errors.push(...auditHeroPackage(packageFiles || [], characterFields, { modelAnalyses }));
  if (assetType === "suit" && heroPartKind(characterFields)) {
    const expected = heroPartName(characterFields);
    if (!expected || assetName !== expected || category !== heroPartKind(characterFields)) errors.push("请确认头发／脸部的体型、三位编号和规范名称");
  }
  if (assetType === "suit" && !heroPartKind(characterFields)) {
    const groupNames = Object.values(materialNames).filter(Boolean);
    const groups = groupNames.length ? groupNames : (packageFiles || []).filter(file => classifyCharacterPackageFile(file) === 'texture').map(inferCharacterTextureGroup);
    const unresolved = reviewSuitMaterialSlots((packageFiles || []).filter(file => /\.fbx$/i.test(file)).map(file => ({ file, part: heroSuitPart(file), slots: modelAnalyses[file]?.materialNames })), groups, characterFields?.materialSlotMappings).filter(row => !row.key);
    if (unresolved.length) errors.push('请在入库确认中选择材质槽对应的贴图组：' + [...new Set(unresolved.map(row => row.slot))].join('、'));
    const maxSlots = require("../../shared/characterComponentRules.json").suit.maxSlots;
    const slots = new Set((packageFiles || []).filter(file => /\.(fbx|obj|abc|gltf|glb)$/i.test(file))
      .map(file => buildCharacterModelBaseName(assetName, String(file).replace(/_LOD\d+(?=\.[^.]+$)/i, ""), characterFields).toLowerCase()));
    if (slots.size > maxSlots) errors.push(`套装最多 ${maxSlots} 个独立部件槽（LOD、骨骼、物理资产和贴图不占槽），请整理后重新导入`);
    if (!characterFields?.gender || !characterFields?.bodyCode) errors.push("请确认套装性别和角色编号");
    if (!characterFields?.suitClass || !characterFields?.serial) errors.push("请确认套装类型和套装编号");
    if (!normalizeCharacterToken(characterFields?.suitName)) errors.push("请填写套装名字");
    const expectedAssetName = buildCharacterAssetName(assetType, characterFields);
    if (expectedAssetName && assetName !== expectedAssetName) errors.push(`套装名称必须严格使用：${expectedAssetName}`);
    const expectedCategory = getCharacterCategoryFromFields(assetType, characterFields);
    if (expectedCategory && category !== expectedCategory) errors.push("套装分类与性别 / 角色编号不一致");
    if (!["front", "left", "right", "back"].every((view) => String(previewPaths?.[view] || "").trim())) {
      errors.push("套装必须包含正面、左面、右面和背面四张预览");
    }
  }
  if (characterFields?.confirmed !== true) errors.push("请确认结构化字段和目标路径");
  return errors;
}

function classifyCharacterPackageFile(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const name = normalized.split("/").pop() || "";
  const ext = (name.match(/\.[^.]+$/)?.[0] || "").toLowerCase();
  if (CHARACTER_MODEL_EXTENSIONS.has(ext)) return "model";
  if ([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".tga", ".webp", ".bmp", ".exr", ".hdr"].includes(ext)) {
    return /(?:preview|thumb|thumbnail|render|beauty)/i.test(name) ? "preview" : "texture";
  }
  if ([".ma", ".mb", ".blend", ".max", ".spp", ".psd", ".json", ".txt", ".md"].includes(ext)) return "source";
  return "other";
}

module.exports = {
  CHARACTER_ASSET_TYPES,
  CHARACTER_DEFAULT_CATEGORIES,
  buildCharacterAssetName,
  buildCharacterMaterialBaseName,
  buildCharacterModelBaseName,
  buildCharacterRelativeRoot,
  buildCharacterTextureBaseName,
  canonicalizeCharacterPart,
  classifyCharacterPackageFile,
  getCharacterDefaultCategory,
  getCharacterCategoryFromFields,
  inferCharacterAssetType,
  inferCharacterFields,
  inferCharacterModelPart,
  inferCharacterSourcePackageName,
  inferCharacterTextureGroup,
  inferCharacterTextureType,
  isCharacterAssetType,
  normalizeCharacterFields,
  normalizeCharacterTextureMapCode,
  normalizeCharacterToken,
  validateCharacterImport
};
