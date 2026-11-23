export type AssetRecord = {
  id: string;
  assetID?: string;
  name: string;
  source: "quixel" | "custom";
  path: string;
  metaPath: string;
  meta: Record<string, unknown>;
  assetType: string;
  topCategory?: "environment" | "character" | "animation";
  standardAssetTags?: string[];
  zionTags?: string[];
  // Zion 资产导出目标二级目录（Objects 之后的部分，可多级）。写在资产自身的
  // asset_info.json 里，与资产一起走库同步，而不是只存在应用设置里。
  zionExportSubfolder?: string;
  baseTiling?: number;
  subType?: string;
  hasCollision?: boolean;
  tags: string[];
  modelFiles: string[];
  previewSkeletonPath?: string;
  previewSkeletalMeshPath?: string;
  textureFiles: string[];
  animationAffiliation?: string;
  animationLabels?: string[];
  animationGameTag?: { kind: "weapon" | "monster"; id: string; name: string };
  animationContentFingerprint?: string;
  animationSendReceipts?: { projectPath: string; at?: string; contentFingerprint?: string }[];
  colorTags?: string[];
  themes?: string[] | null;
  categories?: string[] | null;
  preview: string | null;
  previewImage: string | null;
  detailImage: string | null;
  previewImages?: Array<{ path: string; tags: string[] }>;
  createdAt: string | null;
  favorite?: boolean;
  textureAnalysis?: TextureAnalysis;
};

export type TextureAnalysis = {
  version: number;
  status?: "analyzed" | "large" | "unknown" | "unreadable" | string;
  smallAsset?: boolean | null;
  uses4KTexture?: boolean;
  requiresReview?: boolean;
  dimensions?: { x: number; y: number; z: number } | null;
  dimensionsSource?: string;
  maxDimensionMeters?: number | null;
  sizeThresholdMeters?: number;
  textureThresholdPixels?: number;
  maxTextureDimension?: number;
  textureCount?: number;
  inspectedTextureCount?: number;
  unreadableTextureCount?: number;
  fourKTextureCount?: number;
  fourKTextureFiles?: string[];
  textureFingerprint?: string;
  dimensionFingerprint?: string;
  analyzedAt?: string;
};

export type ExportResultItem = {
  assetId: string;
  name: string;
  status: "success" | "failed" | "skipped" | "unconfirmed";
  message: string;
};

export type ImportQueueSnapshot = {
  libraryPath?: string;
  drafts: Array<{ form: import("./ui/hooks/types").ImportFormState; tagInput: string }>;
  activeIndex: number;
  selectedIndexes: number[];
};

export type AppSettings = {
  customLibraryPath: string;
  exportTarget: "unreal" | "blender" | "3dcoat";
  blenderExecutablePath: string;
  blenderDecimationRatio: number;
  unrealEditorPath: string;
  unrealProjectPath: string;
  uiLanguage: "zh" | "en";
  uePluginPath: string;
  pluginRepo?: string;
  exportResolution: string;
  decalExportMode: string;
  // Grass / Bush 植被导出方式：opaque = _OPAQUE 裁切模型（Opaque 材质、不带 LOD），
  // lod = 原始 Masked 模型 + LOD 链。仅原始资产为 FBX 的植被生效，SpeedTree st9 不适用。
  plantExportMode: string;
  meshOverwritePolicy: "all" | "meshOnly" | ("material" | "texture" | "mesh")[];
  // 合成 SpeedTree 风（导出面板选择）：""（无）| "grass" | "bush" | "fern"。
  // 导出到引擎时由插件写入风动 UV 并改用 ST 风母材质；仅原始资产为 FBX 的植被生效。
  plantSyntheticWind: string;
  // UE 目录独立手选，按目标工程和归档组记住；Skeleton 按角色记住。
  animationUnrealExport?: { root?: string; projectFolders?: Record<string, Record<string, string>>; skeletons?: Record<string, string>; enableRootMotion?: boolean; forceRootLock?: boolean; showImportDialog?: boolean; allowEngineCompressionFallback?: boolean };
};
