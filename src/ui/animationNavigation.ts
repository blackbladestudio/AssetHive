import type { AssetRecord } from "../types";
import type { AnimationGameTagOption } from "../../shared/animationGameTags.mjs";
import rules from '../../shared/animation-import-rules.json';

const AFFILIATIONS: Record<string, string> = { "animation-hero": "主角", "animation-monster": "怪物", "animation-npc": "NPC" };
type AnimationAsset = Pick<AssetRecord, "assetType" | "topCategory" | "animationAffiliation" | "animationGameTag" | "tags" | "zionTags" | "themes" | "path" | "meta">;
export type AnimationNavigationSelection = { parent: string; affiliation: string; key?: string; animationType?: string };
export type AnimationNavigationNode = { id: string; label: string; children: AnimationNavigationNode[] };

export function getAnimationNavigationSelection(id: string): AnimationNavigationSelection | null {
  const [parent, encoded, type, ...extra] = id.split(":");
  const affiliation = AFFILIATIONS[parent];
  if (!affiliation || extra.length) return null;
  if (encoded === undefined) return { parent, affiliation };
  try { return { parent, affiliation, key: decodeURIComponent(encoded), ...(type !== undefined ? { animationType: decodeURIComponent(type) } : {}) }; } catch { return null; }
}

export function animationType(asset: AnimationAsset) {
  const tags = [...(asset.zionTags || []), ...(asset.meta?.zionTags as string[] || []), String(asset.meta?.category || ''), ...(asset.themes || [])];
  return rules.types.find(type => tags.includes(type.name))?.name || '未分类';
}

export function animationAffiliation(asset: AnimationAsset) {
  const stored = String(asset.animationAffiliation || asset.meta?.animationAffiliation || "").trim();
  if (Object.values(AFFILIATIONS).includes(stored)) return stored;
  const affiliation = [...(asset.tags || []), ...(asset.zionTags || []), ...(asset.themes || [])].find(tag => Object.values(AFFILIATIONS).includes(String(tag)));
  if (affiliation) return affiliation;
  const path = String(asset.path || "").replaceAll("\\", "/");
  return /\/Animation\/Hero(?:\/|$)/i.test(path) ? "主角" : /\/Animation\/Monster(?:\/|$)/i.test(path) ? "怪物" : /\/Animation\/NPC(?:\/|$)/i.test(path) ? "NPC" : "";
}

function identity(asset: AnimationAsset, options: AnimationGameTagOption[]) {
  const affiliation = animationAffiliation(asset);
  const expectedKind = affiliation === "主角" ? "weapon" : affiliation === "怪物" ? "monster" : "";
  const tag = asset.animationGameTag || asset.meta?.animationGameTag as AssetRecord["animationGameTag"];
  if (!tag || tag.kind !== expectedKind || !tag.id) return { key: "unassigned", label: "未指定" };
  const option = options.find(option => option.kind === tag.kind && option.id === tag.id);
  // Weapon rows such as Unarmed01/02 share one category; monster identity
  // remains the table row ID even when two monsters have the same Chinese name.
  const key = tag.kind === "weapon" ? (option?.group || tag.id.replace(/\d+$/, "")).toLowerCase() : tag.id;
  return { key, label: option?.name || tag.name || tag.id };
}

export function animationNavigationNodes(parent: string, assets: AnimationAsset[], options: AnimationGameTagOption[]): AnimationNavigationNode[] {
  const selection = getAnimationNavigationSelection(parent);
  if (!selection || selection.affiliation === "NPC") return [];
  const groups = new Map<string, string>();
  for (const asset of assets) {
    if (String(asset.assetType).toLowerCase() !== "animation" || animationAffiliation(asset) !== selection.affiliation) continue;
    const { key, label } = identity(asset, options);
    groups.set(key, label);
  }
  return [...groups].sort(([a, labelA], [b, labelB]) => a === "unassigned" ? 1 : b === "unassigned" ? -1 : labelA.localeCompare(labelB, "zh-CN", { numeric: true }) || a.localeCompare(b))
    .map(([key, label]) => {
      const nodeId = `${parent}:${encodeURIComponent(key)}`;
      const available = new Set(assets.filter(asset => matchesAnimationNavigation(asset, nodeId, options)).map(animationType));
      return { id: nodeId, label, children: [...rules.types.map(type => type.name), '未分类'].filter(type => available.has(type)).map(type => ({ id: `${nodeId}:${encodeURIComponent(type)}`, label: type, children: [] })) };
    });
}

export function matchesAnimationNavigation(asset: AnimationAsset, id: string, options: AnimationGameTagOption[]) {
  const selection = getAnimationNavigationSelection(id);
  if (!selection || String(asset.assetType).toLowerCase() !== "animation" || animationAffiliation(asset) !== selection.affiliation) return false;
  return (selection.key === undefined || identity(asset, options).key === selection.key)
    && (selection.animationType === undefined || animationType(asset) === selection.animationType);
}

export function animationNodeForAsset(asset: AnimationAsset, options: AnimationGameTagOption[]) {
  const parent = Object.keys(AFFILIATIONS).find(id => AFFILIATIONS[id] === animationAffiliation(asset));
  return parent ? parent === "animation-npc" ? parent : `${parent}:${encodeURIComponent(identity(asset, options).key)}:${encodeURIComponent(animationType(asset))}` : "animation";
}
