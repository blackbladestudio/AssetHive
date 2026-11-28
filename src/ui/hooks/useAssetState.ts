import { useCallback, useEffect, useState } from "react";
import type { AssetRecord } from "../../types";
import { defaultSearchState, type SearchState } from "./types";

const RECENT_ASSETS_STORAGE_KEY = "assethive.recentAssetIds";
const LAST_LIBRARY_CATEGORY_STORAGE_KEY = "assethive.lastLibraryCategory";
const MAX_RECENT_ASSETS = 24;

function loadLastLibraryCategory(getLibraryCategory: (menu: string) => string | undefined) {
  try {
    const saved = window.localStorage.getItem(LAST_LIBRARY_CATEGORY_STORAGE_KEY);
    if (saved && getLibraryCategory(saved) === saved) return saved;
  } catch {
    // Fall back to All when local storage is unavailable.
  }
  return "home";
}

function loadRecentAssetIds(): string[] {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(RECENT_ASSETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string").slice(0, MAX_RECENT_ASSETS);
  } catch {
    return [];
  }
}

function saveRecentAssetIds(ids: string[]) {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(RECENT_ASSETS_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // ignore quota / serialization errors
  }
}

export function useAssetState(getLibraryCategory: (menu: string) => string | undefined) {
  const [allAssets, setAllAssets] = useState<AssetRecord[]>([]);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [search, setSearch] = useState<SearchState>(defaultSearchState);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeMenu, setActiveMenuState] = useState(() => loadLastLibraryCategory(getLibraryCategory));
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [missingFilePathSet, setMissingFilePathSet] = useState<Set<string>>(new Set());
  const [deleteConfirmAsset, setDeleteConfirmAsset] = useState<AssetRecord | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<string[]>(() => activeMenu === "home" ? ["environment"] : ["home", activeMenu]);
  const [recentAssetIds, setRecentAssetIds] = useState<string[]>(() => loadRecentAssetIds());

  const setActiveMenu = useCallback((menu: string) => {
    setActiveMenuState(menu);
    const category = getLibraryCategory(menu);
    if (!category) return;
    try {
      window.localStorage.setItem(LAST_LIBRARY_CATEGORY_STORAGE_KEY, category);
    } catch {
      // Keep navigation available when local storage is unavailable.
    }
  }, [getLibraryCategory]);

  useEffect(() => {
    saveRecentAssetIds(recentAssetIds);
  }, [recentAssetIds]);

  const recordAssetUsage = useCallback((assetId: string) => {
    setRecentAssetIds((prev) => {
      const filtered = prev.filter((id) => id !== assetId);
      const next = [assetId, ...filtered];
      return next.slice(0, MAX_RECENT_ASSETS);
    });
  }, []);

  return {
    allAssets, setAllAssets,
    assets, setAssets,
    search, setSearch,
    selectedAssetId, setSelectedAssetId,
    selectedIds, setSelectedIds,
    activeMenu, setActiveMenu,
    favoriteIds, setFavoriteIds,
    missingFilePathSet, setMissingFilePathSet,
    deleteConfirmAsset, setDeleteConfirmAsset,
    expandedCategories, setExpandedCategories,
    recentAssetIds, setRecentAssetIds,
    recordAssetUsage
  };
}
