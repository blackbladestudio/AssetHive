import type { CharacterImportFields } from "./hooks/types";
import type { MonsterModelAnalysis } from "../../shared/monsterPackageAudit.mjs";
import { heroPartKind, heroPartName, inferHeroPart, cleanSuitName } from "../../shared/heroPackageRules.mjs";
import { CHARACTER_MODEL_EXTENSIONS, isAllowedCharacterPackageFile, characterRoleAllowsFile } from "../../shared/characterFilePolicy.mjs";
import type { AssetRecord } from "../types";
import familyRules from "../../shared/characterFamilyRules.json";
import filePatterns from "../../shared/characterFilePatterns.json" with { type: "json" };
import { auditMonsterPackage, classifyMonsterSource, normalizeMonsterSourceStem, buildMonsterAssetName } from "../../shared/monsterPackageAudit.mjs";
import { inferCharacterChineseName, normalizeMonsterNames } from "../../shared/characterNames.mjs";
import { heroTextureChannel } from '../../shared/heroMaterialRules.mjs';
import { weaponCategory, splitWeaponPackage, weaponFileSuffix } from "../../shared/weaponRules.mjs";
export { auditMonsterPackage, buildMonsterAssetName };
export { displayMonsterFormNumbers } from "../../shared/monsterPackageAudit.mjs";

const MONSTER_FILE_IDENTITY = new RegExp(filePatterns.monsterIdentity, "i");
const CHARACTER_MAP_SUFFIX = new RegExp(filePatterns.textureSuffix, "i");
export function getFamilyTextureMapCode(stem: string) {
  return (filePatterns.textureMapCodes as Record<string, string>)[stem.match(CHARACTER_MAP_SUFFIX)?.[1]?.toLowerCase() || ""] || "";
}

export const CHARACTER_ASSET_TYPES = ["suit", "monster", "npc", "weapon"] as const;

export function isCharacterAssetType(assetType: string) {
  return CHARACTER_ASSET_TYPES.includes(String(assetType || "").trim().toLowerCase() as typeof CHARACTER_ASSET_TYPES[number]);
}

export const characterCategoryOptions: Record<string, string[]> = {
  suit: ["Male_01", "Female_01"],
  monster: familyRules.monster.importCategories,
  npc: [],
  weapon: familyRules.weapon.categories
};

export const characterDefaultRelativeDir: Record<string, string> = {
  suit: "Character\\Hero",
  monster: "Character\\Monster",
  npc: "Character\\NPC",
  weapon: "Character\\Weapon"
};

export function getCharacterLibraryCategory(asset: Pick<AssetRecord, "assetType" | "meta" | "categories">) {
  const family = String(asset.assetType || "").trim().toLowerCase();
  if (!isCharacterAssetType(family)) return "";
  const meta = asset.meta || {};
  const manifest = meta.characterManifest as { ruleCategory?: unknown } | undefined;
  const semantic = meta.semanticTags as { subject_matter?: unknown } | undefined;
  const fallback = (asset.categories || []).find((value) =>
    typeof value === "string" && value.trim() && !["character", family].includes(value.trim().toLowerCase()));
  const category = [meta.category, manifest?.ruleCategory, semantic?.subject_matter, fallback]
    .find((value) => typeof value === "string" && value.trim());
  const raw = typeof category === "string" ? category.trim() : "";
  if (family === 'weapon') return weaponCategory(raw) || raw;
  return characterCategoryOptions[family]?.find((value) => value.toLowerCase() === raw.toLowerCase()) || raw;
}

export function getCharacterNavigationSelection(nodeId: string | null) {
  const match = String(nodeId || "").match(/^character-(suit|monster|npc|weapon)(?::(.+))?$/);
  if (!match) return null;
  try {
    return { family: match[1], category: match[2] ? decodeURIComponent(match[2]) : "" };
  } catch {
    return null;
  }
}

export function characterImportDefaults(nodeId: string, family: string) {
  const selection = getCharacterNavigationSelection(nodeId);
  const category = selection?.family === family ? selection.category : '';
  const fields: Partial<CharacterImportFields> = {};
  if (family === 'suit') {
    if (['Face', 'Hair'].includes(category)) fields.variant = category;
    const body = category.match(/^(Male|Female)_(\d{2})$/);
    if (body) Object.assign(fields, { gender: body[1], bodyCode: body[2] });
  } else if (family === 'weapon' && category) fields.weaponType = category;
  return { category, fields };
}

export function getCharacterCategoryDisplayLabel(family: string, category: string, language = "zh") {
  const labels: Record<string, Record<string, [string, string]>> = {
    suit: { male_01: ["男装", "Male"], female_01: ["女装", "Female"], face: ["脸部", "Face"], hair: ["头发", "Hair"] },
    monster: {
      "1_boss": ["01大首领", "01 Boss"], "2_miniboss": ["02小首领", "02 MiniBoss"], "3_elite": ["03精英怪", "03 Elite"],
      "4_normalmonster": ["04普通怪", "04 NormalMonster"], "5_minion": ["05杂兵怪", "05 Minion"]
    },
    npc: { merchant: ["商人", "Merchant"], guard: ["守卫", "Guard"], scholar: ["学者", "Scholar"], other: ["其他", "Other"] },
    weapon: { bow: ["弓 / 箭", "Bow / Arrow"], greataxe: ["巨斧", "GreatAxe"], jade: ["玉器", "Jade"], longsword: ["长剑", "LongSword"], pairedswords: ["双剑", "PairedSwords"], shieldaxe: ["盾斧", "ShieldAxe"], spear: ["长枪", "Spear"], sword: ["短剑", "Sword"] }
  };
  const label = labels[family]?.[category.toLowerCase()];
  return label ? label[language === "en" ? 1 : 0] : category;
}

export function getCharacterCategoryNodes(family: string, assets: AssetRecord[]) {
  if (!isCharacterAssetType(family)) return [];
  const fixed = family === "suit" ? ["Male_01", "Female_01", "Face", "Hair"] : characterCategoryOptions[family] || [];
  const categories = fixed.length ? fixed : [...new Map(
    assets.filter((asset) => String(asset.assetType || "").trim().toLowerCase() === family)
      .map(getCharacterLibraryCategory).filter(Boolean)
      .map((category) => [category.toLowerCase(), category])
  ).values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  return categories.map((category) => ({
    id: `character-${family}:${encodeURIComponent(category)}`,
    label: getCharacterCategoryDisplayLabel(family, category),
    children: []
  }));
}

export function matchesCharacterNavigation(asset: AssetRecord, nodeId: string) {
  const selected = getCharacterNavigationSelection(nodeId);
  return Boolean(selected
    && String(asset.assetType || "").trim().toLowerCase() === selected.family
    && (!selected.category || getCharacterLibraryCategory(asset).toLowerCase() === selected.category.toLowerCase()));
}

const suitClassByCode: Record<string, string> = {
  M: "Medium",
  H: "Heavy",
  L: "Light"
};

function findGenderToken(text: string) {
  const compact = text.match(/(?:^|[\\/_\s-])([MF])(\d{2})(?=$|[\\/_\s.-])/i);
  if (compact) return { gender: compact[1].toUpperCase() === "F" ? "Female" : "Male", bodyCode: compact[2] };
  const named = text.match(/(?:^|[\\/_\s-])(Male|Female)[_-]?(\d{2})(?=$|[\\/_\s.-])/i);
  if (named) return { gender: named[1].toLowerCase() === "female" ? "Female" : "Male", bodyCode: named[2] };
  return { gender: "", bodyCode: "" };
}

function findSuitToken(text: string) {
  const named = text.match(/(?:^|[\\/_\s-])(Medium|Heavy|Light)(\d{3})(?=$|[\\/_\s.-])/i);
  if (named) {
    const suitClass = `${named[1][0].toUpperCase()}${named[1].slice(1).toLowerCase()}`;
    return { suitClass, serial: named[2] };
  }
  const compact = text.match(/(?:^|[\\/_\s-])([MHL])(\d{3})(?=$|[\\/_\s.-])/i);
  return compact ? { suitClass: suitClassByCode[compact[1].toUpperCase()] || "", serial: compact[2] } : { suitClass: "", serial: "" };
}

function inferSuitName(values: string[]) {
  for (const value of values) {
    const stem = String(value || "").replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") || "";
    const match = stem.match(/^(?:SK_|SM_|MI_|T_)?(?:M|F)\d{2}_(?:Medium|Heavy|Light)\d{3}_(.+)$/i);
    const name = match?.[1]?.replace(/_(?:Arm|Downbody|Head|Upbody|Physics)(?:_.*)?$/i, '');
    if (name && /^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return name;
  }
  return "";
}

export function inferCharacterAssetType(values: string[]) {
  const text = values.join(" ");
  if (/(?:^|[\\/])weapon(?:[\\/]|$)/i.test(text)) return "weapon";
  if (/(?:^|[\\/])npc(?:[\\/]|$)/i.test(text)) return "npc";
  if (/(?:^|[\\/])monster(?:[\\/]|$)/i.test(text)) return "monster";
  if (/(?:^|[\\/_\s-])(weapon|bow|arrow|greataxe|jade|longsword|pairedswords|shieldaxe|sword|blade|spear|shield|axe|gun)\d*(?:$|[\\/_\s.-])/i.test(text)) return "weapon";
  if (/(?:^|[\\/_\s-])(npc|merchant|keeper|vendor)\d*(?:$|[\\/_\s.-])/i.test(text)) return "npc";
  if (/(?:^|[\\/_\s-])(monster|boss|miniboss|elite|minion)(?:$|[\\/_\s.-])/i.test(text)) return "monster";
  return "suit";
}

export function inferFamilyPackageIdentity(assetType: string, sourcePath: string, files: string[], modelAnalyses?: Record<string, MonsterModelAnalysis>) {
  if (!(["monster", "npc", "weapon"] as string[]).includes(assetType)) return null;
  if (assetType === 'weapon') {
    const identity = splitWeaponPackage(files).groups[0];
    if (identity) return { ...identity, weaponType: identity.type, variant: '', formIds: [] as string[] };
  }
  if (assetType === "monster") {
    const values = [sourcePath, ...files];
    const parts = values.flatMap((value) => value.replace(/\\/g, "/").split("/").filter(Boolean));
    const category = familyRules.monster.importCategories.find((value) =>
      parts.some((part) => [value.toLowerCase(), value.replace(/^\d+_/, "").toLowerCase()].includes(part.toLowerCase()))) || "";
    const packages = parts.map((part) => part.match(/^(?:Boss|MiniBoss|Elite|NormalMonster|Minion)(\d{3})_([A-Za-z][A-Za-z0-9_]*)$/i)).filter(Boolean);
    const identified = parts.map((part) => part.replace(/\.[^.]+$/, "").match(MONSTER_FILE_IDENTITY)).filter(Boolean);
    const unnumberedMeshes = parts.map((part) => part.replace(/\.[^.]+$/, "").match(/^(?:SK|SM)_(.+)$/i)).filter(Boolean);
    const names = [...new Set(packages.length ? packages.map((match) => match![2])
      : identified.length ? identified.map((match) => match![1]) : unnumberedMeshes.map((match) => match![1]))];
    const audit = auditMonsterPackage(files, { modelAnalyses });
    const forms = audit.formIds;
    const name = audit.sourceName || (names.length === 1 ? names[0] : "");
    return { assetName: buildMonsterAssetName(name, forms) || name, category, serial: "", name, variant: forms.length === 1 ? forms[0] : "", formIds: forms };
  }
  const rule = familyRules[assetType as "monster" | "npc" | "weapon"];
  const pathParts = String(sourcePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  const filePathParts = files.flatMap((file) => String(file || "").replace(/\\/g, "/").split("/"));
  const rootPresent = [...pathParts, ...filePathParts].some((part) => part.toLowerCase() === rule.root.toLowerCase());
  const meshCandidates = files.map((file) => file.replace(/\\/g, "/").split("/").pop() || "")
    .filter((file) => /^(SK|SM)_/i.test(file) && !/_Physics\.[^.]+$/i.test(file))
    .map((file) => file.replace(/\.[^.]+$/, "").replace(/^(SK|SM)_/i, ""));
  const folderCandidates = [...new Set([...pathParts].reverse().concat([...filePathParts].reverse(), meshCandidates))];
  for (const folder of folderCandidates) {
    const match = folder.match(/^([A-Za-z][A-Za-z0-9]*?)(\d{3})_([A-Za-z][A-Za-z0-9_]*)$/);
    if (!match) continue;
    const category = rule.categoryMode === "fixed"
      ? rule.categories.find((candidate) => candidate.replace(/^\d+_/, "").toLowerCase() === match[1].toLowerCase())
      : assetType === 'weapon' ? weaponCategory(match[1]) : match[1];
    if (!category) continue;
    if (assetType === "monster") {
      const parent = pathParts[pathParts.lastIndexOf(folder) - 1] || "";
      if (parent && parent !== category && rootPresent) continue;
    }
    return { assetName: folder, category, serial: match[2], name: match[3], variant: "", formIds: [] as string[], ...(assetType === 'weapon' ? { weaponType: match[1] } : {}) };
  }
  return null;
}

export function inferCharacterFields(assetType: string, values: string[]): CharacterImportFields {
  const text = values.join(" ");
  const body = findGenderToken(text);
  const suit = findSuitToken(text);
  const displayNameZh = inferCharacterChineseName(values);
  const suitName = inferSuitName(values);
  return {
    ...(displayNameZh ? { displayNameZh } : {}),
    ...(assetType === 'suit' && suitName ? { displayNameEn: suitName } : {}),
    family: isCharacterAssetType(assetType) ? assetType : inferCharacterAssetType(values),
    gender: body.gender,
    bodyCode: body.bodyCode,
    suitClass: suit.suitClass,
    suitName,
    serial: suit.serial,
    variant: "",
    ...(assetType === "suit" ? inferHeroPart(values) || {} : {}),
    maturity: "wip",
    confirmed: false
  };
}

export function getCharacterCategoryFromFields(assetType: string, fields: CharacterImportFields) {
  if (assetType !== "suit") return "";
  if (heroPartKind(fields)) return heroPartKind(fields);
  if (fields.gender === "Male") return "Male_01";
  if (fields.gender === "Female") return "Female_01";
  return "";
}

export function buildCharacterAssetName(assetType: string, fields: CharacterImportFields, category = "") {
  if (assetType === "suit" && heroPartKind(fields)) return heroPartName(fields);
  if (assetType === "monster") {
    const name = normalizeMonsterNames(fields).name;
    return characterCategoryOptions.monster.includes(category) ? buildMonsterAssetName(name, fields.formIds) : "";
  }
  if (assetType !== "suit") {
    if (!(["monster", "npc", "weapon"] as string[]).includes(assetType)) return "";
    const prefix = assetType === "monster" ? category.replace(/^\d+_/, "") : assetType === 'weapon' && fields.weaponType && weaponCategory(fields.weaponType) === category ? fields.weaponType : category;
    const serial = String(fields.serial || "").trim();
    const name = String(fields.name || "").trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    return /^[A-Za-z][A-Za-z0-9]*$/.test(prefix) && /^\d{3}$/.test(serial) && name
      ? `${prefix}${serial}_${name}`
      : "";
  }
  const genderCode = fields.gender === "Female" ? "F" : (fields.gender === "Male" ? "M" : "");
  const bodyCode = String(fields.bodyCode || "").replace(/\D/g, "").padStart(2, "0").slice(-2);
  const serial = String(fields.serial || "").replace(/\D/g, "").padStart(3, "0").slice(-3);
  const suitName = fields.displayNameEn !== undefined ? String(fields.displayNameEn).trim() : cleanSuitName(fields.suitName || "");
  if (!genderCode || !fields.bodyCode || !fields.suitClass || !fields.serial || !suitName) return "";
  return `${genderCode}${bodyCode}_${fields.suitClass}${serial}_${suitName}`;
}

export function getMonsterFieldIssues(fields: Partial<CharacterImportFields>, category: string) {
  return {
    category: !characterCategoryOptions.monster.includes(category),
    name: !/^[A-Za-z][A-Za-z0-9_]*$/.test(normalizeMonsterNames(fields).name),
    form: fields.formIds?.length !== 1 || !/^(?:base|\d{2})$/.test(fields.formIds?.[0] || '')
  };
}

export function getCharacterAssetNamePreview(assetType: string, fields: CharacterImportFields) {
  if (assetType !== "suit") return "";
  if (heroPartKind(fields)) return heroPartName(fields) || "<待确认体型及三位编号>";
  const genderCode = fields.gender === "Female" ? "F" : (fields.gender === "Male" ? "M" : "?");
  const bodyCode = String(fields.bodyCode || "??").padStart(2, "0");
  const serial = String(fields.serial || "???").padStart(3, "0");
  return `${genderCode}${bodyCode}_${fields.suitClass || "<套装类型>"}${serial}_${fields.suitName || "<待填写套装名字>"}`;
}

export function inferCharacterSourcePackageName(folderName: string, files: string[]) {
  const rawFolder = String(folderName || "").trim();
  if (!/^(?:scenes?|source|sources)$/i.test(rawFolder)) return rawFolder;
  for (const filePath of files) {
    const parts = String(filePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
    const sceneIndex = parts.findIndex((part) => part.toLowerCase() === rawFolder.toLowerCase());
    if (sceneIndex > 0) return parts[sceneIndex - 1];
  }
  return rawFolder;
}

export function inferCharacterTextureType(filePath: string) {
  const stem = String(filePath || "").replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") || "";
  const hairChannel = /_(Opacity|Alpha|Root|ID|Height|Depth|Tangent|Flow)$/i.test(stem) ? heroTextureChannel(filePath) : '';
  return hairChannel || (/(?:^|_)A$/i.test(stem) ? "Opacity" : "");
}

export function inferCharacterTextureGroup(filePath: string) {
  const stem = String(filePath || "").replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") || "";
  const withoutMap = stem.replace(/_(?:ORM|D|N|A)$/i, "");
  if (!withoutMap || withoutMap === stem) return "";
  const suitPart = withoutMap.match(/(?:^|_)[MHL]\d{3}_[MF]\d{2}_(.+)$/i)?.[1];
  const canonicalPart = withoutMap.match(/^T_[MF]\d{2}_(?:Light|Medium|Heavy)\d{3}_[^_]+_(.+)$/i)?.[1];
  return String(suitPart || canonicalPart || withoutMap.replace(/^T_/i, "")).trim();
}

export function classifyCharacterPackageFile(filePath: string) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const name = normalized.split("/").pop() || "";
  if (!isAllowedCharacterPackageFile(name)) return "other";
  const ext = (name.match(/\.[^.]+$/)?.[0] || "").toLowerCase();
  if (CHARACTER_MODEL_EXTENSIONS.has(ext)) return "model";
  if ([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".tga", ".webp", ".bmp", ".exr", ".hdr"].includes(ext)) {
    return /(?:preview|thumb|thumbnail|render|beauty)/i.test(name) ? "preview" : "texture";
  }
  if ([".ma", ".mb", ".blend", ".max", ".spp", ".psd", ".json", ".txt", ".md"].includes(ext)) return "source";
  return "other";
}

export function classifyFamilyPackageFile(family: string, filePath: string) {
  if (family === "monster") return classifyMonsterSource(filePath);
  const rule = familyRules[family as "monster" | "npc" | "weapon"];
  if (!rule) return { role: classifyCharacterPackageFile(filePath), folder: "SourceFiles" };
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const name = normalized.split("/").pop() || "";
  if (!isAllowedCharacterPackageFile(name)) return { role: "other", folder: "OtherFiles", excluded: true };
  const stem = name.replace(/\.[^.]+$/, "");
  const parts = normalized.toLowerCase().split("/");
  let role = "other";
  if (/\.(ma|mb|blend|max|spp|ztl|swatches)$/i.test(name)) role = "other";
  else if (/^SKEL_/i.test(stem)) role = "skeleton";
  else if (/^SK_.+_Physics$/i.test(stem)) role = "physicsAsset";
  else if (/^SK_/i.test(stem)) role = "skeletalMesh";
  else if (/^SM_/i.test(stem)) role = "staticMesh";
  else if (/^MI_/i.test(stem)) role = "material";
  else if (/^T_/i.test(stem) && getFamilyTextureMapCode(stem)) role = "texture";
  else if (/^ABP_/i.test(stem)) role = "animationBlueprint";
  else if (/^BP_/i.test(stem)) role = "blueprint";
  else if (/\.(png|jpe?g|tiff?|tga|webp|bmp|exr|hdr)$/i.test(name) && /(?:preview|thumb|thumbnail|render|beauty)/i.test(stem)) role = "other";
  else if (parts.includes("actionfiles")) role = "actionFile";
  else if (parts.includes("animation")) role = "animation";
  else if (parts.includes("material")) role = "material";
  else if (parts.includes("texture")) role = "texture";
  else if (parts.includes("skeletalmesh")) role = "skeletalMesh";
  else if (parts.includes("staticmesh")) role = "staticMesh";
  else if (/\.(fbx|obj|abc|gltf|glb)$/i.test(name)) role = "skeletalMesh";
  else if (/\.(png|jpe?g|tiff?|tga|webp|bmp|exr|hdr)$/i.test(name) && !/(?:preview|thumb|render|beauty)/i.test(stem)) role = "texture";
  const folders: Record<string, string> = {
    animation: "Animation", material: "Material", texture: "Texture",
    skeletalMesh: "Mesh/SkeletalMesh", physicsAsset: "Mesh/SkeletalMesh", skeleton: "Mesh/SkeletalMesh",
    staticMesh: "Mesh/StaticMesh", animationBlueprint: "ABP", blueprint: "BP", actionFile: "ActionFiles"
  };
  const allowed = rule.fileRoles.includes(role) && characterRoleAllowsFile(role, name);
  return { role: allowed ? role : "other", folder: allowed ? folders[role] || "OtherFiles" : "OtherFiles" };
}

export function previewFamilyFileName(family: string, assetName: string, filePath: string, monsterName = "", modelAliases: Record<string, string> = {}) {
  const original = String(filePath || "").replace(/\\/g, "/").split("/").pop() || "";
  const parsed = String(assetName || "").match(/^[A-Za-z][A-Za-z0-9]*?\d{3}_([A-Za-z][A-Za-z0-9_]*)$/)
    || (family === "monster" && /^[A-Za-z][A-Za-z0-9_]*$/.test(assetName) ? [assetName, assetName] : null);
  const rule = familyRules[family as "monster" | "npc" | "weapon"];
  if (!rule || !parsed) return original;
  const role = classifyFamilyPackageFile(family, filePath).role;
  const prefix = ({ skeletalMesh: "SK", physicsAsset: "SK", skeleton: "SKEL", staticMesh: "SM", material: "MI", texture: "T", animationBlueprint: "ABP", blueprint: "BP" } as Record<string, string>)[role];
  if (!prefix) return original;
  const ext = original.match(/\.[^.]+$/)?.[0] || "";
  const rawStem = modelAliases[filePath] || original.slice(0, original.length - ext.length);
  const stem = family === "monster" ? normalizeMonsterSourceStem(rawStem) : rawStem;
  const map = role === "texture" ? getFamilyTextureMapCode(stem) : "";
  if (role === "texture" && !map) return original;
  const variant = family === "monster" ? (stem.match(/_(\d{2})(?:_(?:ORM|D|N|A|Physics))?$/i)?.[1] || "") : "";
  const subject = family === "monster" && monsterName ? monsterName : rule.assetNameSubject === "package" || (family === "npc" && role === "staticMesh") ? assetName : parsed[1];
  const monsterIdentity = family === "monster" ? stem.match(MONSTER_FILE_IDENTITY) : null;
  const targetForm = family === 'monster' && monsterName && assetName.startsWith(`SK_${monsterName}`) ? assetName.slice(`SK_${monsterName}`.length) : null;
  if (family === "monster" && !monsterIdentity && /_WP_/i.test(stem)) {
    return `${prefix}_${subject}${targetForm || ''}${stem.slice(stem.toUpperCase().indexOf("_WP_"))}${ext}`;
  }
  if (monsterIdentity) {
    const base = `${prefix}_${subject}${targetForm !== null ? targetForm : `_${monsterIdentity[2]}`}${monsterIdentity[3] ? `_${monsterIdentity[3]}` : ""}`;
    return `${role === "texture" ? base.replace(CHARACTER_MAP_SUFFIX, "") + "_" + map : base}${ext}`;
  }
  const suffix = family === 'weapon' ? weaponFileSuffix(stem, role) : '';
  const expected = `${prefix}_${subject}${suffix}${targetForm !== null ? targetForm : variant ? `_${variant}` : ""}${role === "physicsAsset" ? "_Physics" : ""}${map ? `_${map}` : ""}`;
  const valid = stem.toLowerCase() === expected.toLowerCase()
    || (role === "material" && stem.toLowerCase().startsWith(`${expected.toLowerCase()}_`))
    || (role === "texture" && stem.toLowerCase().startsWith(`${expected.replace(/_(ORM|D|N|A)$/i, "").toLowerCase()}_`) && /_(ORM|D|N|A)$/i.test(stem))
    || (family === "npc" && ["skeletalMesh", "staticMesh"].includes(role) && stem.toLowerCase() === `${prefix}_${assetName}`.toLowerCase());
  return valid && stem === rawStem ? original : `${expected}${ext}`;
}

export function getMonsterFormSummary(files: string[], modelAnalyses?: Record<string, MonsterModelAnalysis>) {
  return auditMonsterPackage(files, { modelAnalyses }).formIds.map((id) => ({ id, hasMesh: true }));
}

export function getMonsterEntityKey(asset: AssetRecord) {
  if (asset.assetType !== "monster") return "";
  const fields = asset.meta?.character as Partial<CharacterImportFields> | undefined;
  return fields?.entityKey || `monster:asset:${asset.id}`;
}

export function buildMonsterGroups(assets: AssetRecord[]) {
  const groups = new Map<string, AssetRecord[]>();
  for (const asset of assets) {
    const key = getMonsterEntityKey(asset);
    if (!key) continue;
    const group = groups.get(key) || [];
    group.push(asset);
    groups.set(key, group);
  }
  for (const group of groups.values()) group.sort((a, b) => {
    const fieldsA = a.meta?.character as Partial<CharacterImportFields> | undefined;
    const fieldsB = b.meta?.character as Partial<CharacterImportFields> | undefined;
    return (fieldsA?.formIds?.[0] || "").localeCompare(fieldsB?.formIds?.[0] || "", undefined, { numeric: true })
      || a.id.localeCompare(b.id);
  });
  return groups;
}

export function groupMonsterCards(assets: AssetRecord[]) {
  const groups = buildMonsterGroups(assets);
  const visited = new Set<string>();
  return assets.flatMap((asset) => {
    const key = getMonsterEntityKey(asset);
    if (!key) return [asset];
    if (visited.has(key)) return [];
    visited.add(key);
    return groups.get(key) || [asset];
  });
}

export function getMonsterLinkCandidates(assets: AssetRecord[], name: string, category: string) {
  const compatible = assets.filter((asset) => {
    const fields = asset.meta?.character as Partial<CharacterImportFields> | undefined;
    return asset.assetType === "monster" && asset.source === "custom"
      && String(fields?.name || asset.name).toLowerCase() === name.trim().toLowerCase()
      && getCharacterLibraryCategory(asset).toLowerCase() === category.toLowerCase();
  });
  return [...buildMonsterGroups(compatible).values()].map((group) => ({
    asset: group[0],
    formIds: [...new Set(group.flatMap((asset) => (asset.meta?.character as Partial<CharacterImportFields>)?.formIds || []))]
  }));
}

export function getMonsterUnassignedResourceTokens(files: string[]) {
  const forms = new Set(getMonsterFormSummary(files).map((form) => form.id));
  return [...new Set(files.flatMap((file) => {
    const role = classifyFamilyPackageFile("monster", file).role;
    // A mesh belonging to an owned weapon never establishes a body form.
    if (["skeletalMesh", "staticMesh"].includes(role)) return [];
    const parts = file.replace(/\\/g, "/").split("/").filter(Boolean);
    const token = parts.at(-1)?.replace(/\.[^.]+$/, "").match(MONSTER_FILE_IDENTITY)?.[2]
      || (role === "other" ? parts.reverse().map((part) => part.match(MONSTER_FILE_IDENTITY)?.[2]).find(Boolean) : "");
    return token && !forms.has(token) ? [token] : [];
  }))].sort();
}

export function getCharacterDestinationRelativePath(assetType: string, category: string) {
  const root = characterDefaultRelativeDir[assetType] || "Character";
  const safeCategory = String(category || "Other").trim().replace(/[<>:"/\\|?*]+/g, "_");
  return `${root}\\${safeCategory || "Other"}`;
}
