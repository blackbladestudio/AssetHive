import type { AssetRecord } from "../types";

export function normalizeSearchText(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim().toLowerCase();
}

export function createSearchTermMatcher(text: string): (value: unknown) => boolean {
  const query = normalizeSearchText(text);
  if (!/[a-z]/u.test(query)) return value => normalizeSearchText(value).includes(query);
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const start = /^[a-z0-9]/u.test(query) ? "(?:^|[^a-z0-9])" : "";
  const end = /[a-z0-9]$/u.test(query) ? "(?=$|[^a-z0-9])" : "";
  const pattern = new RegExp(`${start}${escaped}${end}`, "u");
  return value => pattern.test(normalizeSearchText(value));
}

export function filterAssetsByText(assets: AssetRecord[], text: string): AssetRecord[] {
  const query = normalizeSearchText(text);
  if (!query) return assets;
  const matches = createSearchTermMatcher(query);

  return assets.filter((asset) => [
    asset.name,
    ...(asset.tags || []),
    ...(asset.standardAssetTags || []),
    ...(asset.zionTags || []),
    asset.meta?.slug
  ].some(matches) || [
    asset.id,
    asset.assetID,
    asset.meta?.assetID
  ].some((value) => normalizeSearchText(value).includes(query)));
}

export function parseSearchTags(text: string): string[] {
  return [...new Set([...normalizeSearchText(text).matchAll(/"([^"]+)"|(\S+)/gu)].map(match => match[1] || match[2]).filter(Boolean))];
}

// Committed search chips are search terms, so they use the same fields as typing.
export function filterAssetsBySearchTags(assets: AssetRecord[], tags: string[]): AssetRecord[] {
  return tags.reduce((candidates, tag) => filterAssetsByText(candidates, tag), assets);
}
