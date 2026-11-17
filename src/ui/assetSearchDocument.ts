import type { AssetRecord } from "../types";

export type SearchDocument = { id: string; name: string; fields: string[]; identifiers?: string[] };

export function sameSearchFields(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function createSearchDocument(asset: AssetRecord): SearchDocument {
  const strings = (values: unknown[]) => [...new Set(values.filter((value): value is string => typeof value === "string"))];
  const characterNames = asset.meta?.character as { displayNameZh?: string; displayNameEn?: string } | undefined;
  return {
    id: asset.id, name: asset.name,
    fields: strings([asset.name, asset.id, asset.assetID, asset.meta?.assetID, asset.meta?.slug,
      ...(["suit", "monster", "npc", "weapon"].includes(String(asset.assetType))
        ? [characterNames?.displayNameZh, characterNames?.displayNameEn] : []),
      ...(asset.tags || []), ...(asset.standardAssetTags || []), ...(asset.zionTags || [])]),
    identifiers: strings([asset.id, asset.assetID, asset.meta?.assetID])
  };
}
