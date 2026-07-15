/// <reference types="vite/client" />

import type { AssetRecord, AppSettings } from "./types";

declare global {
  interface Window {
    arkhive: {
      getSettings: () => Promise<AppSettings>;
      updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
      windowMinimize?: () => Promise<{ ok: boolean }>;
      windowToggleMaximize?: () => Promise<{ ok: boolean; maximized?: boolean }>;
      windowClose?: () => Promise<{ ok: boolean }>;
      pickLibraryPath: () => Promise<string | null>;
      pickEnginePath: () => Promise<string | null>;
      pickProjectPath: () => Promise<string | null>;
      pickTargetPath?: () => Promise<{ type: "engine" | "project"; path: string } | null>;
      pickLogPath: () => Promise<string | null>;
      clearCaches?: () => Promise<{
        ok: boolean;
        removed: string[];
        failed: Array<{ path: string; message: string }>;
        message: string;
      }>;
      getAssetIndex: () => Promise<AssetRecord[]>;
      getAssetById?: (assetId: string) => Promise<{ ok: boolean; asset: AssetRecord | null }>;
      getUnrealConnectionStatus: () => Promise<{ connected: boolean; targetName?: string }>;
      rescanAssets: () => Promise<AssetRecord[]>;
      searchAssets: (query: { text: string; tags: string[]; assetTypes: string[]; themes: string[]; source: string }) => Promise<AssetRecord[]>;
      pickAssetFolder: () => Promise<string | null>;
      pickAssetImage: () => Promise<string | null>;
      pickAssetFile: (kind: "model" | "texture" | "hdri" | "any") => Promise<string | null>;
      materializeDroppedFile?: (payload: { name: string; bytes: ArrayBuffer }) => Promise<string>;
      resolveDroppedItems?: (payload: { paths: string[]; requestId?: string }) => Promise<{ files: string[]; preferredName?: string }>;
      cancelResolveDroppedItems?: (payload: { requestId: string }) => Promise<{ ok: boolean }>;
      onResolveDroppedItemsProgress?: (callback: (payload: { requestId?: string; active?: boolean; percent?: number; message?: string }) => void) => () => void;
      getDroppedFilePath?: (file: File) => string;
      pathExists?: (filePath: string) => Promise<boolean>;
      getPreviewThumbnail?: (filePath: string) => Promise<string>;
      importCustomAsset: (payload: {
        __action?: string;
        assetId?: string;
        assetName: string;
        assetType: string;
        category?: string;
        sourcePath?: string;
        modelPath?: string;
        modelSlots?: Record<string, string>;
        textureSlots?: Record<string, string>;
        textureEntries?: Array<{ textureType: string; filePath: string; areaId: number }>;
        textureAreaCount?: number;
        normalMapFormat?: "dx" | "opengl";
        normalMapFormats?: Record<number, "dx" | "opengl">;
        previewImagePath?: string;
        tags: string[];
      }) => Promise<{
        ok: boolean;
        message: string;
        assetId?: string;
        assetPath?: string;
        metaPath?: string;
      }>;
      updateCustomAsset: (payload: {
        assetId: string;
        assetName?: string;
        assetType?: string;
        category?: string;
        modelSlots?: Record<string, string>;
        textureSlots?: Record<string, string>;
        textureEntries?: Array<{ textureType: string; filePath: string; areaId: number }>;
        normalMapFormats?: Record<number, "dx" | "opengl">;
        removeModelSlots?: string[];
        removeTextureSlots?: string[];
        previewImagePath?: string;
        clearPreview?: boolean;
        tags?: string[];
      }) => Promise<{
        ok: boolean;
        message: string;
        assetId?: string;
        asset?: AssetRecord;
      }>;
      cutoutPreviewMagic: (payload: {
        sourcePath: string;
        x: number;
        y: number;
        tolerance?: number;
      }) => Promise<{
        ok: boolean;
        message: string;
        path?: string;
      }>;
      finalizePreviewCutout: (payload: {
        sourcePath: string;
        padding?: number;
        maxSize?: number;
      }) => Promise<{
        ok: boolean;
        message: string;
        path?: string;
      }>;
      deleteCustomAsset: (payload: {
        assetId: string;
      }) => Promise<{
        ok: boolean;
        message: string;
        assetId?: string;
      }>;
      rewriteCustomJson?: () => Promise<{
        ok: boolean;
        updatedCount: number;
        skippedCount: number;
        failedCount: number;
      }>;
      copyText: (text: string) => Promise<{ ok: boolean }>;
      openFolder: (path: string) => Promise<void>;
      onExportProgress: (callback: (payload: { percent: number; message: string }) => void) => () => void;
      onAssetChange: (callback: () => void) => () => void;
      onScanProgress?: (
        callback: (payload: { active: boolean; progress: number; source?: string; phase?: string; processed?: number; total?: number; message?: string }) => void
      ) => () => void;
      onCustomSaveProgress?: (callback: (payload: { assetId: string; progress: number; message?: string }) => void) => () => void;
      onCalculateBoundsRequest?: (
        callback: (payload: { requestId: string; filePath: string }) => void | Promise<void>
      ) => () => void;
      respondBounds?: (payload: {
        requestId: string;
        bounds: { x: number; y: number; z: number } | null;
      }) => Promise<{ ok: boolean }>;
      recalculateSizes?: () => Promise<{ ok: boolean; count: number }>;
      toggleFavorite?: (assetId: string, isFavorite: boolean) => Promise<boolean>;
      onPluginInstallProgress?: (
        callback: (payload: { stage: string; progress: number }) => void
      ) => () => void;
      getPluginStatus?: (payload: { projectPath?: string; editorPath?: string }) => Promise<{ installed: boolean; enabled?: boolean; canInstall?: boolean; message?: string }>;
      installPlugin?: (repo: string, targetPath: string) => Promise<{ ok: boolean; message?: string; path?: string; version?: string }>;
      installPluginFromGithub?: () => Promise<{ ok: boolean; message?: string; path?: string; version?: string }>;
      checkAppUpdate?: () => Promise<{
        ok: boolean;
        repo?: string;
        currentVersion?: string;
        latestVersion?: string;
        hasUpdate?: boolean;
        localPackagePath?: string;
        updateReady?: boolean;
        name?: string;
        publishedAt?: string;
        releaseNotes?: string;
        releaseUrl?: string;
        message?: string;
      }>;
      getAppVersion?: () => Promise<{
        ok: boolean;
        version?: string;
        message?: string;
      }>;
      downloadAppUpdate?: () => Promise<{
        ok: boolean;
        repo?: string;
        hasUpdate?: boolean;
        updateReady?: boolean;
        message?: string;
        currentVersion?: string;
        latestVersion?: string;
        filePath?: string;
        releaseUrl?: string;
      }>;
      installDownloadedUpdate?: (payload: {
        filePath: string;
      }) => Promise<{
        ok: boolean;
        message?: string;
      }>;
      onAppUpdateDownloadProgress?: (
        callback: (payload: { phase?: string; progress?: number | null; source?: string; loaded?: number; total?: number }) => void
      ) => () => void;
      exportToUnreal: (payload: {
        assetIds: string[];
        options: Partial<AppSettings>;
      }) => Promise<{
        ok: boolean;
        message: string;
        output?: string;
        jobFile?: string;
        logFile?: string;
        pluginState?: { copied: boolean; reason?: string };
      }>;
    };
  }
}

export {};
