import { defaultSearchState, type SearchState } from "./hooks/types";

export const SEARCH_PRESETS_KEY = "assethive.searchPresets.v1";
export type SearchPreset = { name: string; menu: string; search: SearchState };

export function readSearchPresets(storage: Pick<Storage, "getItem">): SearchPreset[] {
  try {
    const parsed = JSON.parse(storage.getItem(SEARCH_PRESETS_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(item => item && typeof item.name === "string" && typeof item.menu === "string" && item.search
      && ["tags", "assetTypes", "themes"].every(key => Array.isArray(item.search[key]) && item.search[key].every((value: unknown) => typeof value === "string")))
      .slice(0, 20).map(item => {
        const search = { ...defaultSearchState, ...item.search };
        for (const key of ["text", "size", "environment", "color", "standardAssetTag", "sourceTag"] as const) {
          if (typeof search[key] !== "string") search[key] = defaultSearchState[key];
        }
        if (!["all", "custom", "quixel"].includes(search.source)) search.source = "all";
        if (!["all", "fav", "not"].includes(search.favoriteState || "all")) search.favoriteState = "all";
        return { name: item.name, menu: item.menu, search };
      });
  } catch { return []; }
}
