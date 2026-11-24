/// <reference types="vite/client" />

import type { AssetRecord, AppSettings, ExportResultItem, ImportQueueSnapshot } from "./types";
import type { ThreeDCoatConnection, ThreeDCoatImportInfo, ThreeDCoatImportPayload, ThreeDCoatQueuedImport, ThreeDCoatResult } from "./threeDCoat";

export type AppUpdateDownloadProgress = {
  phase?: string;
  progress?: number | null;
  source?: string;
  loaded?: number;
  total?: number;
};

export type AppUpdateSnapshot = {
  phase?: "idle" | "downloading";
  hasUpdate?: boolean;
  updateReady?: boolean;
  localPackagePath?: string;
  currentVersion?: string;
  latestVersion?: string;
  releaseUrl?: string;
  name?: string;
  publishedAt?: string;
  releaseNotes?: string;
  repo?: string;
  downloadUrl?: string;
  packageSize?: number;
  message?: string;
  downloadProgress?: AppUpdateDownloadProgress | null;
};

export type DroppedAsset = {
  files: string[];
  preferredName?: string;
  folderName?: string;
  sourceArchivePath?: string;
  metadata?: {
    name?: string;
    assetType?: string;
    category?: string;
    topCategory?: "environment" | "character" | "animation";
    standardAssetTags?: string[];
    zionTags?: string[];
    nativePlantWind?: Record<string, unknown> | null;
    nativePlantWindWarnings?: string[];
    tags?: string[];
    modelFiles?: string[];
    materialNames?: Record<string, string>;
    modelVariants?: Array<Record<string, unknown>> | Record<string, unknown>;
    modelLods?: Array<Record<string, unknown>>;
    components?: Array<Record<string, unknown>>;
    textureSlots?: Array<{ filePath: string; textureType: string; areaId?: number; materialRole?: "atlas" | "billboard" }>;
    previewImagePath?: string;
    sourceSemanticTags?: Record<string, unknown>;
    sourceClassification?: Record<string, unknown>;
    sourceIdentity?: {
      sourceKey?: string;
      sourceKind?: "megascans" | "pbrmax" | "zion";
      sourceAssetId?: string;
      sourceVersion?: string;
      sourceRevision?: string;
    };
  } | null;
};

declare global {
  interface Window {
    arkhive: {
      getThreeDCoatImportInfo: (assetId: string) => Promise<ThreeDCoatResult<ThreeDCoatImportInfo>>;
      getThreeDCoatStatus?: () => Promise<ThreeDCoatResult<ThreeDCoatConnection>>;
      configureThreeDCoat?: (patch: { executable?: string; dataDirectory?: string }) => Promise<ThreeDCoatResult<ThreeDCoatConnection>>;
      importToThreeDCoat: (payload: ThreeDCoatImportPayload) => Promise<ThreeDCoatResult<ThreeDCoatQueuedImport>>;
      pickThreeDCoatProgram: () => Promise<ThreeDCoatResult<ThreeDCoatConnection | { canceled: true }>>;
      pickThreeDCoatDataDirectory: () => Promise<ThreeDCoatResult<ThreeDCoatConnection | { canceled: true }>>;
      reportStartupMilestone?: (stage: "modules-ready" | "ui-mounted") => void;
      reportCharacterPreviewDiagnostic?: (payload: {
        stage: "load" | "render" | "webgl-context-lost" | "render-ended";
        modelCount: number;
        textureCount: number;
        viewCount: number;
        imageSize: number;
        skeletonPreview: boolean;
      }) => void;
      getSettings: () => Promise<AppSettings>;
      updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
      windowMinimize?: () => Promise<{ ok: boolean }>;
      windowToggleMaximize?: () => Promise<{ ok: boolean; maximized?: boolean }>;
      windowClose?: () => Promise<{ ok: boolean }>;
      setImportQueueActive?: (active: boolean) => Promise<{ ok: boolean }>;
      shouldCloseAfterCurrentImport?: () => Promise<boolean>;
      setTaskbarProgress?: (value: number) => Promise<{ ok: boolean }>;
      pickLibraryPath: () => Promise<string | null>;
      pickEnginePath: () => Promise<string | null>;
      pickProjectPath: () => Promise<string | null>;
      pickTargetPath?: () => Promise<{ type: "engine" | "project"; path: string } | null>;
      clearCaches?: () => Promise<{
        ok: boolean;
        removed: string[];
        failed: Array<{ path: string; message: string }>;
        message: string;
      }>;
      getAssetIndex: () => Promise<AssetRecord[]>;
      loadImportQueue?: (libraryPath?: string) => Promise<ImportQueueSnapshot>;
      saveImportQueue?: (snapshot: ImportQueueSnapshot) => Promise<ImportQueueSnapshot>;
      getAssetById?: (assetId: string) => Promise<{ ok: boolean; asset: AssetRecord | null; listAsset?: AssetRecord | null }>;
      getAnimationUnrealStatus?: (assetId: string) => Promise<{ state: string; projectPath?: string; targetPath?: string; at?: string; message?: string }>;
      getAnimationUnrealFolders?: () => Promise<{ projectPath: string; folders: string[]; truncated: boolean }>;
      pickAnimationUnrealFolder?: (request: { projectPath: string; folder?: string }) => Promise<string | null>;
      getAnimationExportTargets?: (request: { projectPath: string; targets: { key: string; targetPath: string }[] }) => Promise<{ key: string; exists: boolean; targetPath: string }[]>;
      getUnrealConnectionStatus: () => Promise<{ connected: boolean; projectPath?: string; projectId?: string; targetName?: string; reason?: string; message?: string; port?: number }>;
      getSuitUnrealStatus: (assetId: string) => Promise<{ ok: boolean; changed?: boolean; message?: string }>;
      downloadCharacterRigFiles: (assetId: string) => Promise<{ ok: boolean; canceled?: boolean; path?: string; count?: number; message?: string }>;
      pickBlenderExecutable: () => Promise<string | null>;
      getBlenderStatus: () => Promise<{ installed: boolean; connected: boolean; path?: string; targetName?: string; message?: string }>;
      installBlenderPlugin: () => Promise<{ ok: boolean; path?: string; message?: string }>;
      rescanAssets: () => Promise<AssetRecord[]>;
      searchAssets: (query: { text: string; tags: string[]; assetTypes: string[]; themes: string[]; source: string }) => Promise<AssetRecord[]>;
      pickAssetFolder: (options?: { defaultPath?: string; nearestExistingParent?: boolean }) => Promise<string | null>;
      pickAssetImage: () => Promise<string | null>;
      pickAssetFile: (kind: "model" | "hairModel" | "animation" | "texture" | "displacement" | "hdri" | "any") => Promise<string | null>;
      renderGroomPreview?: (sourcePath: string) => Promise<Record<'front' | 'left' | 'right' | 'back', string>>;
      pickCharacterUpdateFiles: () => Promise<string[]>;
      materializeDroppedFile?: (payload: { name: string; bytes: ArrayBuffer }) => Promise<string>;
      getAnimationPreview?: (modelPath: string) => Promise<{ key: string; path: string } | null>;
      cacheAnimationPreview?: (payload: { assetId: string; modelPath: string; key: string; bytes: ArrayBuffer }) => Promise<string>;
      readClipboardImage?: () => Promise<{ name: string; bytes: Uint8Array } | null>;
      resolveDroppedItems?: (payload: { paths: string[]; requestId?: string; includeCharacterSourceFiles?: boolean }) => Promise<DroppedAsset & { assets?: DroppedAsset[]; failedArchives?: Array<{ name?: string }> }>;
      cancelResolveDroppedItems?: (payload: { requestId: string }) => Promise<{ ok: boolean }>;
      clearDroppedArchives?: () => Promise<{ ok: boolean }>;
      onResolveDroppedItemsProgress?: (callback: (payload: { requestId?: string; active?: boolean; percent?: number; message?: string }) => void) => () => void;
      getDroppedFilePath?: (file: File) => string;
      pathExists?: (filePath: string) => Promise<boolean>;
      deduplicateCharacterTextures: (files: string[]) => Promise<{ files: string[]; duplicates: { sourcePath: string; keptPath: string }[] }>;
      analyzeCharacterModels?: (filePaths: string[]) => Promise<{ ok: boolean; message?: string; analyses: Record<string, { materialNames?: string[]; ok: boolean; message?: string; meshKind?: "staticMesh" | "skeletalMesh"; hasSkeleton?: boolean; hasSkin?: boolean; boneCount?: number; skinnedMeshCount?: number; triangleCount?: number | null }> }>;
      getPreviewThumbnail?: (filePath: string, options?: { character?: boolean }) => Promise<string>;
      foliageOpaqueStatus?: () => Promise<{ available: boolean; workerPath: string; message: string }>;
      // 资产库内「重新 Opaque 裁切」：仅 Megascans 植被（3D Plants）可用。
      regenerateFoliageOpaque?: (payload: {
        assetId: string;
        options?: {
          contourPrecisionTexels?: number;
          maskErodeTexels?: number;
          // 孔洞填充（默认开）+ 它的面积上限（0 = 不限）：见 App.tsx 的
          // resolveFoliageOpaqueFillHoles / resolveFoliageOpaqueHoleMaxAreaTexels。
          fillHoles?: boolean;
          holeMaxAreaTexels?: number;
          faceBudget?: number;
          cleanupPercent?: number;
        };
      }) => Promise<{
        ok: boolean;
        message: string;
        assetId?: string;
        asset?: AssetRecord | null;
        generated?: number;
        removed?: number;
        restored?: number;
        warnings?: string[];
      }>;
      importCustomAsset: (payload: {
        queueId?: string;
        __action?: string;
        assetId?: string;
        assetName: string;
        assetType: string;
        topCategory?: "environment" | "character" | "animation";
        standardAssetTags?: string[];
        zionTags?: string[];
        category?: string;
        destinationPath?: string;
        previewSkeletonPath?: string;
        previewSkeletalMeshPath?: string;
        animationAffiliation?: string;
        baseTiling?: number;
        sourcePath?: string;
        modelPath?: string;
        modelSlots?: Record<string, string>;
        modelLodFiles?: Record<string, Array<{ filePath: string; lod: number }>>;
        textureSlots?: Record<string, string>;
        textureEntries?: Array<{ textureType: string; filePath: string; areaId: number; materialRole?: "atlas" | "billboard" }>;
        textureAreaCount?: number;
        materialNames?: Record<string, string>;
        foliageOpaque?: boolean | { enabled?: boolean; faceBudget?: number; contourPrecisionTexels?: number; maskErodeTexels?: number; fillHoles?: boolean; holeMaxAreaTexels?: number; cleanupPercent?: number };
        normalMapFormat?: "dx" | "opengl";
        normalMapFormats?: Record<number, "dx" | "opengl">;
        previewImagePath?: string;
        character?: import("./ui/hooks/types").CharacterImportFields;
        characterPackageFiles?: string[];
        characterAnalysisSourcePaths?: string[];
        characterPreviewPaths?: import("./ui/hooks/types").CharacterPreviewPaths;
        characterPartPreviews?: import("./ui/hooks/types").ImportFormState['characterPartPreviews'];
        characterExtraPreviewPaths?: string[];
        characterRelationGroupId?: string;
        tags: string[];
        sourceSemanticTags?: Record<string, unknown>;
        sourceClassification?: Record<string, unknown>;
        sourceIdentity?: {
          sourceKey?: string;
          sourceKind?: "megascans" | "pbrmax" | "zion";
          sourceAssetId?: string;
          sourceVersion?: string;
          sourceRevision?: string;
        };
        dedupeAction?: "inspect" | "skip" | "update" | "new";
        contentIdentity?: {
          fingerprintVersion?: string;
          contentFingerprint: string;
          modelFingerprints?: Record<string, string>;
          textureFingerprint?: string;
        };
      }) => Promise<{
        ok: boolean;
        message: string;
        assetId?: string;
        assetPath?: string;
        metaPath?: string;
        previewWarning?: boolean;
        warnings?: string[];
        duplicate?: boolean;
        skipped?: boolean;
        action?: "inspect" | "skip" | "update" | "new";
        matchKind?: "identical" | "source" | "content" | "name";
        defaultAction?: "skip" | "update" | "new";
        sameContent?: boolean;
        contentFingerprint?: string;
        contentIdentity?: {
          fingerprintVersion?: string;
          contentFingerprint: string;
          modelFingerprints?: Record<string, string>;
          textureFingerprint?: string;
        };
        candidate?: {
          id: string;
          name: string;
          assetType: string;
          path: string;
          source: string;
        };
      }>;
      setZionExportSubfolder: (payload: {
        assetId: string;
        subfolder: string;
      }) => Promise<{ ok: boolean; assetId?: string; subfolder?: string; message?: string }>;
      updateCustomAsset: (payload: {
        assetId: string;
        assetName?: string;
        assetType?: string;
        topCategory?: "environment" | "character" | "animation";
        standardAssetTags?: string[];
        zionTags?: string[];
        category?: string;
        baseTiling?: number;
        modelSlots?: Record<string, string>;
        modelLodFiles?: Record<string, Array<{ filePath: string; lod: number }>>;
        textureSlots?: Record<string, string>;
        textureEntries?: Array<{ textureType: string; filePath: string; areaId: number; materialRole?: "atlas" | "billboard" }>;
        normalMapFormats?: Record<number, "dx" | "opengl">;
        removeModelSlots?: string[];
        materialNames?: Record<string, string>;
        removeTextureSlots?: string[];
        previewImagePath?: string;
        previewSkeletonPath?: string;
        previewSkeletalMeshPath?: string;
        animationAffiliation?: string;
        clearPreview?: boolean;
        tags?: string[];
        sourceSemanticTags?: Record<string, unknown>;
        sourceClassification?: Record<string, unknown>;
        sourceIdentity?: {
          sourceKey?: string;
          sourceKind?: "megascans" | "pbrmax" | "zion";
          sourceAssetId?: string;
          sourceVersion?: string;
          sourceRevision?: string;
        };
        dedupeAction?: "inspect" | "skip" | "update" | "new";
        contentIdentity?: {
          fingerprintVersion?: string;
          contentFingerprint: string;
          modelFingerprints?: Record<string, string>;
          textureFingerprint?: string;
        };
      }) => Promise<{
        ok: boolean;
        message: string;
        assetId?: string;
        asset?: AssetRecord;
        listAsset?: AssetRecord;
      }>;
      cropPreviewSelection: (payload: {
        sourcePath: string;
        selection: { x: number; y: number; width: number; height: number };
      }) => Promise<{ ok: boolean; message: string; path?: string }>;
      autoPreviewCutout: (payload: {
        sourcePath: string;
        tolerance?: number;
        filterNoise?: boolean;
      }) => Promise<{ ok: boolean; message: string; path?: string }>;
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
        preserveCanvas?: boolean;
        padding?: number;
        maxSize?: number;
      }) => Promise<{
        ok: boolean;
        message: string;
        path?: string;
      }>;
      deleteCustomAsset: (payload: {
        assetId: string;
        token?: string;
        confirmPermanent?: boolean;
      }) => Promise<{
        ok: boolean;
        message: string;
        assetId?: string;
        indexPending?: boolean;
        cleanupPending?: boolean;
        cachesCleared?: boolean;
      }>;
      previewAssetDeletion?: (payload: { assetId: string }) => Promise<{
        ok: boolean; message?: string;
        plan?: { token: string; path: string; flat: boolean; permanent?: boolean; fileCount: number; bytes: number; entries: Array<{ relativePath: string }> };
      }>;
      updateCharacter?: (action: "reviewCharacterRig" | "updateCharacterPreviewBatch" | "inspectCharacterUpdateInput" | "updateCharacterStatus" | "updateCharacterNames" | "relinkCharacterHistory" | "previewPartUpdate" | "updatePart" | "updateCharacterPreview" | "updateCharacterGallery" | "updateCharacterAutoPreviews" | "selectPartRevision" | "matchCharacterUpdateTextures" | "previewPackageUpdate" | "updatePackage" | "selectPackageRevision", payload: {
        previewBatch?: Array<{ slot?: string; meshKind?: string; expectedRevision?: string; expectedPreviewUri?: string; images?: Array<{ view?: string; sourcePath?: string }> }>;
        assetId: string; slot?: string; meshKind?: string; suitPreviewRevision?: string; sourceFolder?: string; token?: string; note?: string; previewPath?: string; expectedRevision?: string; revisionId?: string; confirmWholePackage?: boolean; automatic?: boolean; expectedPreviewUri?: string; historyId?: string; sourceIndex?: number; sourcePath?: string;
        needsRigging?: boolean; maturity?: string; expectedStatus?: string; displayNameZh?: string; displayNameEn?: string; nameConfirmed?: boolean; expectedEnglishName?: string; expectedName?: string; expectedAssetName?: string; sourcePaths?: string[]; replacements?: Array<{ sourcePath: string; storedPath: string }>; images?: Array<{ uri?: string; sourcePath?: string; tags?: string[]; view?: string }>;
      }) => Promise<{
        ok: boolean; message?: string; asset?: import("./types").AssetRecord; unchanged?: boolean; indexPending?: boolean; previewErrors?: string[];
        plan?: { token: string; unchanged: boolean; changes: Array<{ name: string; status: string }>; replacedComponentCount?: number;
          replacements?: Array<{ sourcePath: string; storedPath: string }>; unmatchedFiles?: string[]; conflictFiles?: Array<{ storedPath: string; sourcePaths: string[] }>; excludedFiles?: string[] };
      }>;
      inspectCharacterIdentity?: (payload: unknown) => Promise<{ ok: boolean; message?: string; asset?: import("./types").AssetRecord }>;
      revealCharacterHistorySource?: (payload: { assetId: string; historyId: string; sourceIndex: number }) => Promise<{ ok: boolean; message?: string }>;
      rewriteCustomJson?: () => Promise<{
        ok: boolean;
        updatedCount: number;
        skippedCount: number;
        failedCount: number;
      }>;
      syncMetadata?: () => Promise<{
        ok: boolean;
        updatedCount: number;
        skippedCount: number;
        failedCount: number;
        animationSkippedCount: number;
        fingerprintCreatedCount: number;
      }>;
      copyText: (text: string) => Promise<{ ok: boolean }>;
      openFolder: (path: string) => Promise<void>;
      revealAssetArchive: (assetId: string) => Promise<{ ok: boolean; message?: string }>;
      revealCharacterModel?: (payload: { assetId: string; storedPath: string }) => Promise<{ ok: boolean; message?: string }>;
      revealCharacterTexture?: (payload: { assetId: string; storedPath: string }) => Promise<{ ok: boolean; message?: string }>;
      onExportProgress: (callback: (payload: { percent: number; message: string }) => void) => () => void;
      onRigDownloadProgress?: (callback: (payload: { assetId: string; percent: number }) => void) => () => void;
      onAssetChange: (callback: (payload?: { incremental?: boolean; count?: number; records?: AssetRecord[] }) => void) => () => void;
      onCharacterDeleted?: (callback: (payload: { assetId: string; assetPath: string; paths: string[]; clearedDraftIds: string[] }) => void) => () => void;
      onScanProgress?: (
        callback: (payload: { active: boolean; progress: number; source?: string; phase?: string; processed?: number; total?: number; message?: string }) => void
      ) => () => void;
      onCustomSaveProgress?: (callback: (payload: { assetId: string; progress: number; message?: string; failed?: boolean }) => void) => () => void;
      // 不透明裁切的透明度来源体检：不可用时 available=false + message 给出原因。
      getFoliageOpaqueMaskStatus?: (payload: {
        textureEntries: Array<{ filePath: string; textureType: string; areaId?: number; materialRole?: "atlas" | "billboard" }>;
      }) => Promise<{
        ok: boolean;
        available: boolean;
        message: string;
        filePath?: string;
        textureType?: string;
        channel?: string;
        width?: number;
        height?: number;
      }>;
      // 「输出日志」窗口：历史尾部 + 实时订阅 + 打开所在文件夹 / 清空。
      readLogs?: (options?: { maxLines?: number }) => Promise<{ ok: boolean; path: string; lines: string[]; truncated?: boolean; message?: string }>;
      openLogFolder?: () => Promise<{ ok: boolean; path?: string; message?: string }>;
      clearLogs?: () => Promise<{ ok: boolean; message?: string }>;
      onLogLine?: (callback: (payload: { line: string }) => void) => () => void;
      onCalculateBoundsRequest?: (
        callback: (payload: { requestId: string; filePath: string }) => void | Promise<void>
      ) => () => void;
      respondBounds?: (payload: {
        requestId: string;
        bounds: { x: number; y: number; z: number } | null;
        triangleCount?: number | null;
        collision?: {
          checked: true;
          hasCollision: boolean;
          nodeCount: number;
        } | null;
      }) => Promise<{ ok: boolean }>;
      recalculateSizes?: () => Promise<{ ok: boolean; count: number }>;
      toggleFavorite?: (assetId: string, isFavorite: boolean) => Promise<boolean>;
      onPluginInstallProgress?: (
        callback: (payload: { stage: string; progress: number }) => void
      ) => () => void;
      getPluginStatus?: (payload: { projectPath?: string; editorPath?: string }) => Promise<{ installed: boolean; enabled?: boolean; canInstall?: boolean; message?: string }>;
      getAnimationGameTagOptions?: () => Promise<{ weapons: import("../shared/animationGameTags.mjs").AnimationGameTagOption[]; monsters: import("../shared/animationGameTags.mjs").AnimationGameTagOption[]; source: string; partial: boolean }>;
      resolveAnimationPreviewRig?: (payload: { rigRoot: string; animationPath: string; gameTagId?: string }) => Promise<string>;
      installPlugin?: (repo: string, targetPath: string) => Promise<{ ok: boolean; message?: string; path?: string; version?: string }>;
      installPluginFromGithub?: () => Promise<{ ok: boolean; message?: string; path?: string; version?: string }>;
      checkAppUpdate?: () => Promise<AppUpdateSnapshot & { ok: boolean }>;
      getAppVersion?: () => Promise<{
        ok: boolean;
        version?: string;
        message?: string;
      }>;
      openExternal?: (url: string) => Promise<{ ok: boolean; message?: string }>;
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
        busy?: boolean;
        message?: string;
      }>;
      onAppUpdateState?: (
        callback: (state: AppUpdateSnapshot & { showPrompt?: boolean }) => void
      ) => () => void;
      onAppUpdateDownloadProgress?: (
        callback: (payload: AppUpdateDownloadProgress) => void
      ) => () => void;
      exportToBlender: Window["arkhive"]["exportToUnreal"];
      exportToUnreal: (payload: {
        assetIds: string[];
        options: Partial<AppSettings> & import('./ui/suitExportTypes').SuitExportRequest
          & { animationExport?: Partial<import('../shared/animationUnrealExport.mjs').AnimationExportOptions> };
      }) => Promise<{
        ok: boolean;
        message: string;
        output?: string;
        jobFile?: string;
        logFile?: string;
        pluginState?: { copied: boolean; reason?: string };
        results?: ExportResultItem[];
        partial?: boolean;
        suitResult?: import('./ui/suitExportTypes').SuitExportResult;
        animationResult?: { projectPath: string; entries: Array<{ key: string; assetId: string; name: string; status: string; action?: string; path: string; targetPath: string; skeletonPath?: string; message?: string }> };
      }>;
    };
  }
}

export {};
