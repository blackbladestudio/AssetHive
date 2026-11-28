import type { AppSettings } from "../../types";
import type { AnimationGameTag } from "../../../shared/animationGameTags.mjs";

export type SearchState = {
  text: string;
  tags: string[];
  assetTypes: string[];
  themes: string[];
  source: "all" | "quixel" | "custom";
  sourceTag: string;
  size: string;
  environment: string;
  color: string;
  standardAssetTag: string;
  favoriteState?: "all" | "fav" | "not";
  onlyFavorites?: boolean;
};

export type AppUpdateState = {
  checked: boolean;
  hasUpdate: boolean;
  updateReady?: boolean;
  localPackagePath?: string;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  releaseName: string;
  publishedAt: string;
  releaseNotes: string;
  repo: string;
  downloadUrl: string;
  packageSize: number;
};

export type TextureMaterialRole = "atlas" | "billboard";

export type TextureEntry = {
  id: string;
  textureType: string;
  filePath: string;
  areaId: number;
  materialRole?: TextureMaterialRole;
};

export type ModelLodEntry = {
  filePath: string;
  lod: number;
};

export type ImportSourceIdentity = {
  sourceKey?: string;
  sourceKind?: "megascans" | "pbrmax" | "zion";
  sourceAssetId?: string;
  sourceVersion?: string;
  sourceRevision?: string;
};

export type CharacterImportFields = {
  materialSlotMappings?: Record<string, string>;
  editedFields?: string[];
  displayNameZh?: string;
  displayNameEn?: string;
  ueNameSyncPending?: string;
  nameConfirmed?: boolean;
  family: string;
  gender: string;
  bodyCode: string;
  suitClass: string;
  suitName: string;
  name?: string;
  weaponType?: string;
  weaponAssembly?: 'single' | 'combined';
  weaponLayout?: 'auto' | 'sharedPair' | 'separatePair' | 'bow' | 'custom';
  entityKey?: string;
  relatedAssetId?: string;
  formIds?: string[];
  monsterVariant?: string;
  monsterVariantOnly?: boolean;
  serial: string;
  variant: string;
  maturity: "wip" | "needs_rig" | "rigged" | "approved" | "final";
  confirmed: boolean;
  maturityConfirmed?: boolean;
  identityConfirmed?: boolean;
};

export type CharacterPreviewPaths = {
  front: string;
  left: string;
  right: string;
  back: string;
};

export type CharacterModelAnalysis = {
  materialNames?: string[];
  ok: boolean;
  sourceHash?: string;
  message?: string;
  meshKind?: "staticMesh" | "skeletalMesh";
  hasSkeleton?: boolean;
  hasSkin?: boolean;
  boneCount?: number;
  skinnedMeshCount?: number;
  triangleCount?: number | null;
};

export type ImportFormState = {
  queueId?: string;
  assetName: string;
  assetType: string;
  subCategory: string;
  destinationPath: string;
  animationArchiveManual?: boolean;
  skeletonPath: string;
  skeletalMeshPath: string;
  modelSlots: Record<string, string>;
  modelVariantKeys: Record<string, string>;
  modelLodFiles: Record<string, ModelLodEntry[]>;
  enabledModelTypes: string[];
  textureEntries: TextureEntry[];
  materialNames?: Record<string, string>;
  maskGroups?: import("../../../shared/maskMaterials.mjs").MaskGroups;
  textureGroupMode?: "texture" | "channel";
  baseTiling: string;
  normalMapFormat: "dx" | "opengl";
  normalMapFormats: Record<number, "dx" | "opengl">;
  previewImagePath: string;
  tagsText: string;
  zionTags: string[];
  animationAffiliation: string;
  animationLabelsText: string;
  animationMotionContext?: string;
  animationGait?: string;
  animationPhase?: string;
  animationPlanningManualFields?: Array<"animationMotionContext" | "animationGait" | "animationPhase">;
  animationPlanningSourceName?: string;
  animationGameTag: AnimationGameTag | null;
  animationGameTagManual?: boolean;
  characterFields: CharacterImportFields;
  characterPackageFiles: string[];
  characterLodConfirmation?: string;
  characterModelAnalysis: Record<string, CharacterModelAnalysis>;
  characterExcludedFiles: string[];
  characterManualExclusions?: { filePath: string; textureEntries: TextureEntry[] }[];
  characterDuplicateTextures?: { sourcePath: string; keptPath: string }[];
  characterFileScopes: Record<string, "suit" | "weapon">;
  characterScopesConfirmed: boolean;
  characterRelationGroupId?: string;
  characterPreviewPaths: CharacterPreviewPaths;
  characterPartPreviews?: { sourcePath: string; sourceHash?: string; meshKind: "staticMesh" | "skeletalMesh"; paths: CharacterPreviewPaths }[];
  characterExtraPreviewPaths?: string[];
  characterPreviewError?: string;
  sourceIdentity?: ImportSourceIdentity;
  sourceSemanticTags?: Record<string, unknown>;
  sourceClassification?: Record<string, unknown>;
  sourceArchivePath?: string;
  plantAssetType?: "standard" | "naniteFoliage";
  naniteFoliage?: Record<string, unknown>;
  nativePlantWind?: Record<string, unknown>;
  nativePlantWindWarnings?: string[];
  foliageOpaque: boolean;
  // _OPAQUE 裁切：面数上限（空 = 默认 200,000，0 = 不限制）、轮廓精度（空 = 默认 1 纹素）、
  // 遮罩内缩（空 = 0）、孔洞填充（默认开启；把白色区域内含的黑色孔洞填成白色，边界只留
  // 外轮廓；空上限 = 不限）与细碎面片清理（默认关闭；开启后按「区域大小比率阈值」清理，空 = 默认 1%）。
  foliageOpaqueFaceBudget: string;
  foliageOpaqueContourPrecision: string;
  foliageOpaqueMaskErodeTexels: string;
  foliageOpaqueFillHolesEnabled: boolean;
  foliageOpaqueHoleMaxAreaTexels: string;
  foliageOpaqueCleanupEnabled: boolean;
  foliageOpaqueCleanupPercent: string;
  // 细分目标（纹素，空 = 不细分）：先把源三角形细分到 UV 边长不超过该值再裁切，
  // 让边界贴合遮罩；多出的面数由面数上限处的减面收回。仅「裁切」路线生效。
  foliageOpaqueSubdivideTexels: string;
  // Trace 面片间距（纹素，空 = 用裁切路线）：改走「按遮罩直接生成面片并投射回源表面」
  // 的路线（对应 Houdini HDA GrassMaskedToOpaque），边界精度由它决定，与源网格密度无关。
  // 默认 8 纹素：实测该档在面数阈值内轮廓重合度最高、细长三角形占比最低。
  foliageOpaqueTraceStepTexels: string;
  // Trace 面数上限（面，空 = 默认 100 万）：trace 路线唯一的面数闸门，直接决定内存峰值
  // （约 1.1KB/面片）。默认 100 万是稳定性上限 —— Electron 的 JS 堆硬顶约 3.78GB，
  // worker OOM 会终止整个应用；调大更贴合边界但逼近该上限即闪退。
  foliageOpaqueTraceMaxFaces: string;
};

export type EditFormState = {
  plantAssetType?: "standard" | "naniteFoliage";
  naniteFoliage?: Record<string, unknown>;
  assetId: string;
  hasEmptySlots?: boolean;
  assetPath?: string;
  assetName: string;
  assetType: string;
  subCategory: string;
  modelSlots: Record<string, string>;
  modelVariantKeys: Record<string, string>;
  modelLodFiles: Record<string, ModelLodEntry[]>;
  enabledModelTypes: string[];
  textureEntries: TextureEntry[];
  materialNames?: Record<string, string>;
  maskGroups?: import("../../../shared/maskMaterials.mjs").MaskGroups;
  textureGroupMode?: "texture" | "channel";
  baseTiling: string;
  normalMapFormat: "dx" | "opengl";
  normalMapFormats: Record<number, "dx" | "opengl">;
  previewImagePath: string;
  tagsText: string;
  zionTags: string[];
  animationAffiliation: string;
  animationLabelsText: string;
  animationGameTag: AnimationGameTag | null;
};

export type ModalAlertState = { visible: boolean; message: string; title?: string } | null;
export type ContextMenuState = { x: number; y: number; assetId: string } | null;
export type TagContextMenuState = { x: number; y: number; scope: "detail" | "edit"; tag?: string } | null;
export type AssetStageMetrics = { scrollTop: number; viewportHeight: number; viewportWidth: number };
export type CutoutTarget = "import" | "edit";
export type AppUpdateMode = "idle" | "checking" | "downloading" | "installing";

export const defaultSettings: AppSettings = {
  exportTarget: "unreal",
  blenderExecutablePath: "",
  blenderDecimationRatio: 1,
  customLibraryPath: "\\\\fileshare\\share\\Artist\\AssetLibrary",
  unrealEditorPath: "",
  unrealProjectPath: "",
  uiLanguage: "zh",
  uePluginPath: "",
  pluginRepo: "Biscuits-Lab/AssetHivePlugin",
  exportResolution: "4k",
  decalExportMode: "decal",
  plantExportMode: "opaque",
  meshOverwritePolicy: ["material", "texture", "mesh"],
  plantSyntheticWind: "auto"
};

export const defaultTextureTypes = ["Diffuse", "Normal", "Roughness", "Displacement", "AO"];

export const defaultImportForm: ImportFormState = {
  assetName: "New Asset",
  assetType: "",
  subCategory: "",
  destinationPath: "",
  skeletonPath: "\\\\fileshare\\share\\Artist\\Animation\\Rig\\Character\\SK_Male\\SK_Male.fbx",
  skeletalMeshPath: "",
  modelSlots: {},
  modelVariantKeys: {},
  modelLodFiles: {},
  enabledModelTypes: ["Mesh"],
  textureEntries: defaultTextureTypes.map((textureType) => ({
    id: `import-default-${textureType.toLowerCase()}`,
    textureType,
    filePath: "",
    areaId: 1
  })),
  baseTiling: "1",
  normalMapFormat: "dx",
  normalMapFormats: { 1: "dx" },
  previewImagePath: "",
  tagsText: "",
  zionTags: [],
  animationAffiliation: "",
  animationLabelsText: "",
  animationGameTag: null,
  characterFields: {
    family: "",
    gender: "",
    bodyCode: "",
    suitClass: "",
    suitName: "",
    serial: "",
    variant: "",
    maturity: "wip",
    confirmed: false
  },
  characterPackageFiles: [],
  characterModelAnalysis: {},
  characterExcludedFiles: [],
  characterFileScopes: {},
  characterScopesConfirmed: false,
  characterPreviewPaths: { front: "", left: "", right: "", back: "" },
  foliageOpaque: false,
  // 面数预设：0（或留空）= 按植被档位自动（Grass 15 万 / Bush 30 万）；
  // 填数值 = 覆盖预设。导出不再自动减面，该值只作闸门与超限提示，
  // 实际收敛交给 UE 侧 Nanite（按预设设保留百分比）。
  foliageOpaqueFaceBudget: "0",
  foliageOpaqueContourPrecision: "",
  foliageOpaqueMaskErodeTexels: "",
  // 孔洞填充默认关闭：填孔会改变遮罩轮廓，是否该填取决于资产（有些白区内部本来就该镂空）。
  // 需要时显式开启；上限留空/0 = 不限（全部填充），填数值 = 只填不超过该面积的孔洞。
  foliageOpaqueFillHolesEnabled: false,
  foliageOpaqueHoleMaxAreaTexels: "",
  foliageOpaqueCleanupEnabled: false,
  foliageOpaqueCleanupPercent: "",
  // 默认开启「精细」档（细到 16 纹素）+ 减面：实测比不细分时 sliver 占比减半、薄度减半，
  // 而面数仍收敛到面数上限内。不需要时可切到「关闭」。
  foliageOpaqueSubdivideTexels: "16",
  // 默认走 Trace 6 纹素：对应 Houdini HDA 的做法 —— 由遮罩生成面片再投射回源表面。
  // 实测同一 20 万面预算下 6 纹素的轮廓重合度 95.8%（8 纹素 94.3%）。
  // 不留空是因为空 = 4 纹素的采样密度，那档生成量约 780 万面片、约 9.2GB 堆；
  // 现在面数由「Trace 面数上限」统一控制（默认 100 万面），所以 6 纹素配 100 万上限
  // 既保留精度又稳定落在内存预算内。需要更高密度时在界面上调大上限并确认机器内存。
  foliageOpaqueTraceStepTexels: "6",
  // 留空 = 默认 100 万面（见 resolveFoliageOpaqueTraceMaxFaces 与 foliageOpaque.js）。
  foliageOpaqueTraceMaxFaces: ""
};

export const defaultEditForm: EditFormState = {
  assetId: "",
  assetPath: "",
  assetName: "",
  assetType: "",
  subCategory: "",
  modelSlots: {},
  modelVariantKeys: {},
  modelLodFiles: {},
  enabledModelTypes: ["Mesh"],
  textureEntries: defaultTextureTypes.map((textureType) => ({
    id: `edit-default-${textureType.toLowerCase()}`,
    textureType,
    filePath: "",
    areaId: 1
  })),
  baseTiling: "1",
  normalMapFormat: "dx",
  normalMapFormats: { 1: "dx" },
  previewImagePath: "",
  tagsText: "",
  zionTags: [],
  animationAffiliation: "",
  animationLabelsText: "",
  animationGameTag: null
};

export const defaultAppUpdateState: AppUpdateState = {
  checked: false,
  hasUpdate: false,
  updateReady: false,
  localPackagePath: "",
  currentVersion: "",
  latestVersion: "",
  releaseUrl: "",
  releaseName: "",
  publishedAt: "",
  releaseNotes: "",
  repo: "",
  downloadUrl: "",
  packageSize: 0
};

export const defaultSearchState: SearchState = {
  text: "",
  tags: [],
  assetTypes: [],
  themes: [],
  source: "all",
  sourceTag: "all",
  size: "all",
  environment: "all",
  color: "all",
  standardAssetTag: "all",
  favoriteState: "all"
};
