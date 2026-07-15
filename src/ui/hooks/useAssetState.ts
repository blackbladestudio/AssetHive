import { useState } from "react";
import type { AssetRecord } from "../../types";
import { defaultSearchState, type SearchState } from "./types";

export function useAssetState() {
  const [allAssets, setAllAssets] = useState<AssetRecord[]>([]);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [previewThumbByPath, setPreviewThumbByPath] = useState<Record<string, string>>({});
  const [search, setSearch] = useState<SearchState>(defaultSearchState);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeMenu, setActiveMenu] = useState("home");
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [missingFilePathSet, setMissingFilePathSet] = useState<Set<string>>(new Set());
  const [deleteConfirmAsset, setDeleteConfirmAsset] = useState<AssetRecord | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<string[]>(["3d-assets"]);

  return {
    allAssets, setAllAssets,
    assets, setAssets,
    previewThumbByPath, setPreviewThumbByPath,
    search, setSearch,
    selectedAssetId, setSelectedAssetId,
    selectedIds, setSelectedIds,
    activeMenu, setActiveMenu,
    favoriteIds, setFavoriteIds,
    missingFilePathSet, setMissingFilePathSet,
    deleteConfirmAsset, setDeleteConfirmAsset,
    expandedCategories, setExpandedCategories
  };
}
