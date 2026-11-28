import type { AssetRecord } from "../types";

// 仅用于导出面板预览；实际分类目录仍由 UE 插件按标准标签推导。
export function resolveZion3DCategoryFolder(asset: Partial<AssetRecord> & { category?: string }): string {
  const meta = asset.meta || {};
  const key = (value: unknown) => String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  const keys = (value: unknown): string[] => Array.isArray(value) ? value.map(key).filter(Boolean) : [];
  const standardTags = keys(Array.isArray(asset.standardAssetTags) ? asset.standardAssetTags : meta.standardAssetTags);
  const explicitTags = new Set([
    ...keys(asset.standardAssetTags), ...keys(meta.standardAssetTags),
    ...keys(asset.zionTags), ...keys(meta.zionTags)
  ]);
  const derivedTags = new Set([
    asset.assetType, asset.subType, meta.subType,
    meta.category ?? asset.category, meta.animationAffiliation ?? asset.animationAffiliation
  ].map(key));
  const jobTags = keys(asset.tags).filter((tag) => explicitTags.has(tag) || !derivedTags.has(tag));
  const profileTags = new Set(standardTags.length ? standardTags : jobTags);
  const allTags = new Set([...profileTags, ...jobTags]);
  if (["thirdparty", "第三方", "megascans", "pbrmax"].some((tag) => allTags.has(tag))) return "Objects";
  if (profileTags.has("kit") || profileTags.has("kits")) return "Kit";
  if (profileTags.has("destructible")) return "Destructible";
  if (profileTags.has("props")) return "Props";
  return "Objects";
}
