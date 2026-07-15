import type { AppSettings } from "../../types";

export type SearchState = {
  text: string;
  tags: string[];
  assetTypes: string[];
  themes: string[];
  source: "all" | "quixel" | "custom";
  size: string;
  environment: string;
  color: string;
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
};

export type TextureEntry = {
  id: string;
  textureType: string;
  filePath: string;
  areaId: number;
};

export type ImportFormState = {
  assetName: string;
  assetType: string;
  subCategory: string;
  modelSlots: Record<string, string>;
  enabledModelTypes: string[];
  textureEntries: TextureEntry[];
  normalMapFormat: "dx" | "opengl";
  normalMapFormats: Record<number, "dx" | "opengl">;
  previewImagePath: string;
  tagsText: string;
};

export type EditFormState = {
  assetId: string;
  assetPath?: string;
  assetName: string;
  assetType: string;
  subCategory: string;
  modelSlots: Record<string, string>;
  enabledModelTypes: string[];
  textureEntries: TextureEntry[];
  normalMapFormat: "dx" | "opengl";
  normalMapFormats: Record<number, "dx" | "opengl">;
  previewImagePath: string;
  tagsText: string;
};

export type ModalAlertState = { visible: boolean; message: string; title?: string } | null;
export type ContextMenuState = { x: number; y: number; assetId: string } | null;
export type TagContextMenuState = { x: number; y: number; scope: "detail" | "edit"; tag?: string } | null;
export type AssetStageMetrics = { scrollTop: number; viewportHeight: number; viewportWidth: number };
export type CutoutTarget = "import" | "edit";
export type AppUpdateMode = "idle" | "checking" | "downloading" | "installing";

export const defaultSettings: AppSettings = {
  megascanLibraryPath: "",
  customLibraryPath: "",
  unrealEditorPath: "",
  unrealProjectPath: "",
  unrealLogPath: "",
  uiLanguage: "zh",
  uePluginPath: "",
  pluginRepo: "blackbladestudio/AssetHive",
  exportResolution: "4k"
};

export const defaultTextureTypes = ["Albedo", "Normal", "Roughness", "Displacement", "AO"];

export const defaultImportForm: ImportFormState = {
  assetName: "",
  assetType: "",
  subCategory: "",
  modelSlots: {},
  enabledModelTypes: ["Mesh"],
  textureEntries: defaultTextureTypes.map((textureType) => ({
    id: `import-default-${textureType.toLowerCase()}`,
    textureType,
    filePath: "",
    areaId: 1
  })),
  normalMapFormat: "dx",
  normalMapFormats: { 1: "dx" },
  previewImagePath: "",
  tagsText: ""
};

export const defaultEditForm: EditFormState = {
  assetId: "",
  assetPath: "",
  assetName: "",
  assetType: "",
  subCategory: "",
  modelSlots: {},
  enabledModelTypes: ["Mesh"],
  textureEntries: defaultTextureTypes.map((textureType) => ({
    id: `edit-default-${textureType.toLowerCase()}`,
    textureType,
    filePath: "",
    areaId: 1
  })),
  normalMapFormat: "dx",
  normalMapFormats: { 1: "dx" },
  previewImagePath: "",
  tagsText: ""
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
  repo: ""
};

export const defaultSearchState: SearchState = {
  text: "",
  tags: [],
  assetTypes: [],
  themes: [],
  source: "all",
  size: "all",
  environment: "all",
  color: "all",
  favoriteState: "all"
};
