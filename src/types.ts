export type AssetRecord = {
  id: string;
  assetID?: string;
  name: string;
  source: "quixel" | "custom";
  path: string;
  metaPath: string;
  meta: Record<string, unknown>;
  assetType: string;
  tags: string[];
  modelFiles: string[];
  textureFiles: string[];
  colorTags?: string[];
  themes?: string[] | null;
  categories?: string[] | null;
  preview: string | null;
  previewImage: string | null;
  detailImage: string | null;
  createdAt: string | null;
  favorite?: boolean;
};

export type AppSettings = {
  megascanLibraryPath: string;
  customLibraryPath: string;
  unrealEditorPath: string;
  unrealProjectPath: string;
  unrealLogPath: string;
  uiLanguage: "zh" | "en";
  uePluginPath: string;
  pluginRepo?: string;
  exportResolution: string;
};
