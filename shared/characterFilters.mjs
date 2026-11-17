// Character-only view state. Never changes the legacy environment/animation search.
import { WEAPON_TYPES } from './weaponRules.mjs';
import { characterRigProgress } from './characterComponents.mjs';
export function characterStatus(value) {
  const key = String(value || "").toLowerCase();
  if (key === "approved" || key === "final") return { value: "approved", zh: "已定版", en: "Finalized" };
  if (key === "needs_rig") return { value: "needs_rig", zh: "需绑定", en: "Needs rigging" };
  if (key === "rigged") return { value: "rigged", zh: "已绑定", en: "Rigged" };
  return { value: "wip", zh: "需修改", en: "Needs changes" };
}
export const DEFAULT_CHARACTER_FILTERS = Object.freeze({ family: "all", display: "all", suitClass: "all", part: "all", form: "all", maturity: "all", weaponType: "all", rigging: "all", gender: "all", hairType: "all" });
export function defaultCharacterFilters(context) {
  return { ...DEFAULT_CHARACTER_FILTERS, display: context && !/^suit:(face|hair)$/.test(context.key) ? "parents" : "all" };
}
const families = new Set(["suit", "monster", "npc", "weapon"]);
const normalizeCategoryTag = value => String(value || "").trim().toLowerCase().replace(/[\s_-]+/gu, "");
export function matchesCharacterCategoryTag(tag, category, labels = []) {
  return Boolean(category && [category, ...labels].some(alias => normalizeCategoryTag(alias) === normalizeCategoryTag(tag)));
}
export function deduplicateCharacterCategoryTags(tags, category, labels = []) {
  let categorySeen = false;
  return tags.filter(tag => {
    if (!matchesCharacterCategoryTag(tag, category, labels)) return true;
    if (categorySeen) return false;
    categorySeen = true;
    return true;
  });
}
export function characterFilterContext(node) {
  if (node === "character") return { family: "all", category: "", key: "all" };
  const match = String(node).match(/^character-(suit|monster|npc|weapon)(?::(.+))?$/);
  if (!match) return null;
  let category;
  try { category = decodeURIComponent(match[2] || ""); } catch { return null; }
  const separate = match[1] === "suit" && /^(face|hair)$/i.test(category);
  return { family: match[1], category, key: separate ? `suit:${category.toLowerCase()}` : match[1] };
}
export function changeCharacterFilter(current, key, value) {
  const next = { ...DEFAULT_CHARACTER_FILTERS, ...current, [key]: value };
  if (key === "part" && value !== "all") next.display = "parts";
  if (key === "display" && !["parts", "staticParts", "skeletalParts"].includes(value)) next.part = "all";
  return next;
}
export function characterPartKind(asset) {
  const view = asset.meta?.componentView;
  if (!view) return "";
  return asset.assetType === "suit" ? String(view.slot).split("_").at(-1).toLowerCase() : view.role || "part";
}
export function characterFormIds(asset) {
  if (asset.meta?.componentView?.sharedAcrossForms) return ["shared"];
  const ids = asset.meta?.character?.formIds;
  return Array.isArray(ids) && ids.length ? ids.map(String) : ["unspecified"];
}
export function filterCharacterCards(cards, filters = DEFAULT_CHARACTER_FILTERS, matchedIds = null) {
  return cards.filter(asset => {
    if (!families.has(asset.assetType)) return false;
    if (matchedIds && !matchedIds.has(asset.id)) return false;
    const part = Boolean(asset.meta?.componentView);
    if (['monster', 'npc'].includes(asset.assetType) && part) return false;
    const fields = asset.meta?.character || {};
    if (part && asset.assetType === 'suit' && /^(Hair|Face)$/.test(fields.variant || '')) return false;
    if (filters.gender && filters.gender !== 'all' && fields.gender !== filters.gender) return false;
    if (filters.hairType && filters.hairType !== 'all') {
      const files = asset.meta?.characterManifest?.files || [];
      const paths = [...files.filter(file => ['model','staticMesh','skeletalMesh','groom'].includes(file.role)).map(file => file.storedPath || file.normalizedName), ...(asset.modelFiles || [])];
      if (fields.variant !== 'Hair' || !paths.some(file => (filters.hairType === 'groom' ? /\.abc$/i : /\.fbx$/i).test(file))) return false;
    }
    if (filters.weaponType && filters.weaponType !== 'all' && (asset.assetType !== 'weapon' || (fields.weaponType || fields.category) !== filters.weaponType)) return false;
    if (filters.rigging && filters.rigging !== 'all') {
      const rig = characterRigProgress(asset);
      if (filters.rigging === 'complete' ? !rig.complete : rig.complete) return false;
    }
    if (filters.family !== "all" && asset.assetType !== filters.family) return false;
    if (filters.display === "parents" && part || ["parts", "staticParts", "skeletalParts"].includes(filters.display) && !part) return false;
    if (filters.display === "staticParts" && !asset.meta?.componentView?.meshKinds?.staticMesh) return false;
    if (filters.display === "skeletalParts" && !asset.meta?.componentView?.meshKinds?.skeletalMesh) return false;
    if (filters.suitClass !== "all" && (asset.assetType !== "suit" || fields.suitClass !== filters.suitClass)) return false;
    if (filters.part !== "all" && characterPartKind(asset) !== filters.part) return false;
    if (filters.form !== "all" && (asset.assetType !== "monster" || !characterFormIds(asset).includes(filters.form))) return false;
    if (filters.maturity !== "all" && characterStatus(fields.maturity || asset.meta?.characterManifest?.maturity).value !== filters.maturity) return false;
    return true;
  }).map(asset => {
    const visibleMeshKind = filters.display === "staticParts" ? "staticMesh" : filters.display === "skeletalParts" ? "skeletalMesh" : "";
    return visibleMeshKind && asset.meta?.componentView
      ? { ...asset, meta: { ...asset.meta, componentView: { ...asset.meta.componentView, visibleMeshKind } } }
      : asset;
  });
}
const option = (value, zh, en) => ({ value, zh, en });
export function characterFilterDefinitions(context, cards) {
  const defs = [];
  if (context.family === "all") defs.push({ key: "family", zh: "角色类型", en: "Character type", options: [option("all", "所有角色类型", "All character types"), option("suit", "套装", "Outfits"), option("monster", "怪物", "Monsters"), option("npc", "NPC", "NPC"), option("weapon", "武器", "Weapons")] });
  const isOutfit = context.family === "suit" && !/^(face|hair)$/i.test(context.category);
  if (context.family === 'suit' && /^(face|hair)$/i.test(context.category)) {
    defs.push({ key: 'gender', zh: '性别', en: 'Gender', options: [option('all', '所有性别', 'All genders'), option('Male', '男', 'Male'), option('Female', '女', 'Female')] });
    if (/^hair$/i.test(context.category)) defs.push({ key: 'hairType', zh: '头发类型', en: 'Hair type', options: [option('all', '所有头发类型', 'All hair types'), option('haircard', 'HairCard', 'HairCard'), option('groom', 'Groom', 'Groom')] });
  }
  if (context.family === 'weapon') {
    const labels = { Bow: '弓', Arrow: '箭', GreatAxe: '巨斧', Jade: '玉器', LongSword: '长剑', PairedSwords: '双剑', ShieldAxe: '盾斧', Spear: '长枪', Sword: '短剑' };
    defs.push({ key: 'weaponType', zh: '武器类别', en: 'Weapon type', options: [option('all', '所有武器', 'All weapons'), ...WEAPON_TYPES.map(type => option(type, labels[type], type))] });
    defs.push({ key: 'rigging', zh: '绑定状态', en: 'Rigging', options: [option('all', '所有绑定状态', 'All rigging states'), option('pending', '待绑定 / 待确认', 'Pending rigging / review'), option('complete', '绑定已完成', 'Rigging complete')] });
  }
  if (isOutfit) defs.push({ key: "suitClass", zh: "套装规格", en: "Outfit class", options: [option("all", "所有套装规格", "All outfit classes"), option("Light", "轻甲", "Light"), option("Medium", "中甲", "Medium"), option("Heavy", "重甲", "Heavy")] });
  if (isOutfit || context.family === 'all') defs.push({ key: "display", zh: "展示内容", en: "Show", options: [option("all", "主体及部件", "Owners and parts"), option("parents", "仅主体", "Owners only"), option("staticParts", "仅部件（Static）", "Parts only (Static)"), option("skeletalParts", "仅部件（Skeletal）", "Parts only (Skeletal)")] });
  if (isOutfit) {
    const labels = { head: ["头部", "Head"], upbody: ["上装", "Upper body"], downbody: ["下装", "Lower body"], arm: ["臂部", "Arms"], weapon: ["武器", "Weapon"], part: ["其他模型部件", "Other model parts"] };
    const kinds = isOutfit ? ["head", "upbody", "downbody", "arm"] : [];
    for (const card of cards) { const kind = characterPartKind(card); if (kind && !kinds.includes(kind)) kinds.push(kind); }
    defs.push({ key: "part", zh: "部件", en: "Part", options: [option("all", "所有部件", "All parts"), ...kinds.map(kind => option(kind, ...(labels[kind] || [kind, kind])))] });
  }
  defs.push({ key: "maturity", zh: "制作状态", en: "Status", options: [option("all", "所有制作状态", "All statuses"), ...["needs_rig", "rigged", "wip", "approved"].map(characterStatus)] });
  return defs;
}
