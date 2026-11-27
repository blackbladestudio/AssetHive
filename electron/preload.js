const { contextBridge, ipcRenderer, webUtils } = require("electron");

ipcRenderer.send("app:startupMilestone", { stage: "preload-ready" });

contextBridge.exposeInMainWorld("arkhive", {
  reportStartupMilestone: (stage) => {
    const navigation = globalThis.performance?.getEntriesByType("navigation")[0];
    ipcRenderer.send("app:startupMilestone", { stage, navigation: navigation ? {
      responseEndMs: navigation.responseEnd,
      domInteractiveMs: navigation.domInteractive,
      dnsMs: navigation.domainLookupEnd - navigation.domainLookupStart,
      connectMs: navigation.connectEnd - navigation.connectStart,
      responseWaitMs: navigation.responseStart - navigation.requestStart
    } : undefined });
  },
  reportCharacterPreviewDiagnostic: (payload) => ipcRenderer.send("app:characterPreviewDiagnostic", payload),
  getThreeDCoatImportInfo: (assetId) => ipcRenderer.invoke("threeDCoat:info", assetId),
  getThreeDCoatStatus: () => ipcRenderer.invoke("threeDCoat:status"),
  configureThreeDCoat: (patch) => ipcRenderer.invoke("threeDCoat:configure", patch),
  importToThreeDCoat: (payload) => ipcRenderer.invoke("threeDCoat:import", payload),
  pickThreeDCoatProgram: () => ipcRenderer.invoke("threeDCoat:pickProgram"),
  pickThreeDCoatDataDirectory: () => ipcRenderer.invoke("threeDCoat:pickDataDirectory"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowToggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
  windowClose: () => ipcRenderer.invoke("window:close"),
  onWindowForegroundChange: (callback) => {
    const subscription = (_event, foreground) => callback(foreground);
    ipcRenderer.on("window:foregroundChanged", subscription);
    ipcRenderer.send("window:requestForeground");
    return () => ipcRenderer.removeListener("window:foregroundChanged", subscription);
  },
  setImportQueueActive: (active) => ipcRenderer.invoke("window:setImportQueueActive", active),
  shouldCloseAfterCurrentImport: () => ipcRenderer.invoke("window:shouldCloseAfterCurrentImport"),
  setTaskbarProgress: (value) => ipcRenderer.invoke("window:setTaskbarProgress", value),
  pickLibraryPath: () => ipcRenderer.invoke("library:pickPath"),
  pickEnginePath: () => ipcRenderer.invoke("settings:pickEngine"),
  pickProjectPath: () => ipcRenderer.invoke("settings:pickProject"),
  pickTargetPath: () => ipcRenderer.invoke("settings:pickTarget"),
  clearCaches: () => ipcRenderer.invoke("settings:clearCaches"),
  getAssetIndex: () => ipcRenderer.invoke("assets:getIndex"),
  getAssetById: (assetId) => ipcRenderer.invoke("assets:getById", assetId),
  renderGroomPreview: (sourcePath) => ipcRenderer.invoke("assets:renderGroomPreview", sourcePath),
  getUnrealConnectionStatus: () => ipcRenderer.invoke("unreal:getConnectionStatus"),
  getSuitUnrealStatus: (assetId) => ipcRenderer.invoke("character:suitUnrealStatus", assetId),
  downloadCharacterRigFiles: (assetId) => ipcRenderer.invoke('character:downloadRigFiles', assetId),
  pickBlenderExecutable: () => ipcRenderer.invoke("blender:pickExecutable"),
  getBlenderStatus: () => ipcRenderer.invoke("blender:getStatus"),
  installBlenderPlugin: () => ipcRenderer.invoke("blender:installPlugin"),
  rescanAssets: () => ipcRenderer.invoke("assets:rescan"),
  searchAssets: (query) => ipcRenderer.invoke("assets:search", query),
  pickAssetFolder: (options) => ipcRenderer.invoke("assets:pickFolder", options),
  pickAssetImage: () => ipcRenderer.invoke("assets:pickImage"),
  pickAssetFile: (kind) => ipcRenderer.invoke("assets:pickFile", kind),
  pickCharacterUpdateFiles: () => ipcRenderer.invoke("character:pickUpdateFiles"),
  materializeDroppedFile: (payload) => ipcRenderer.invoke("assets:materializeDroppedFile", payload),
  getAnimationPreview: (modelPath) => ipcRenderer.invoke("assets:getAnimationPreview", modelPath),
  cacheAnimationPreview: (payload) => ipcRenderer.invoke("assets:cacheAnimationPreview", payload),
  readClipboardImage: () => ipcRenderer.invoke("assets:readClipboardImage"),
  resolveDroppedItems: (payload) => ipcRenderer.invoke("assets:resolveDroppedItems", payload),
  cancelResolveDroppedItems: (payload) => ipcRenderer.invoke("assets:cancelResolveDroppedItems", payload),
  clearDroppedArchives: () => ipcRenderer.invoke("assets:clearDroppedArchives"),
  onResolveDroppedItemsProgress: (callback) => {
    const subscription = (event, payload) => callback(payload);
    ipcRenderer.on("assets:resolveDroppedItemsProgress", subscription);
    return () => ipcRenderer.removeListener("assets:resolveDroppedItemsProgress", subscription);
  },
  getDroppedFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  pathExists: (filePath) => ipcRenderer.invoke("assets:pathExists", filePath),
  analyzeCharacterModels: (filePaths) => ipcRenderer.invoke("assets:analyzeCharacterModels", filePaths),
  getPreviewThumbnail: (filePath, options) => ipcRenderer.invoke("assets:getPreviewThumbnail", filePath, options),
  importCustomAsset: (payload) => ipcRenderer.invoke("assets:importCustom", payload),
  loadImportQueue: (libraryPath) => ipcRenderer.invoke("importQueue:load", libraryPath),
  saveImportQueue: (snapshot) => ipcRenderer.invoke("importQueue:save", snapshot),
  foliageOpaqueStatus: () => ipcRenderer.invoke("assets:foliageOpaqueStatus"),
  regenerateFoliageOpaque: (payload) => ipcRenderer.invoke("assets:regenerateFoliageOpaque", payload),
  updateCustomAsset: (payload) => ipcRenderer.invoke("assets:updateCustom", payload),
  getAnimationUnrealStatus: (assetId) => ipcRenderer.invoke('animation:unrealStatus', assetId),
  getAnimationUnrealFolders: () => ipcRenderer.invoke('animation:unrealFolders'),
  pickAnimationUnrealFolder: (request) => ipcRenderer.invoke('animation:pickUnrealFolder', request),
  getAnimationExportTargets: (request) => ipcRenderer.invoke('animation:exportTargets', request),
  setZionExportSubfolder: (payload) => ipcRenderer.invoke("assets:setZionExportSubfolder", payload),
  cropPreviewSelection: (payload) => ipcRenderer.invoke("assets:cropPreviewSelection", payload),
  autoPreviewCutout: (payload) => ipcRenderer.invoke("assets:autoPreviewCutout", payload),
  cutoutPreviewMagic: (payload) => ipcRenderer.invoke("assets:cutoutPreviewMagic", payload),
  finalizePreviewCutout: (payload) => ipcRenderer.invoke("assets:finalizePreviewCutout", payload),
  deleteCustomAsset: (payload) => ipcRenderer.invoke("assets:deleteCustom", payload),
  previewAssetDeletion: (payload) => ipcRenderer.invoke("assets:previewDeletion", payload),
  updateCharacter: (action, payload) => ipcRenderer.invoke(`assets:${action}`, payload),
  inspectCharacterIdentity: (payload) => ipcRenderer.invoke("assets:inspectCharacterIdentity", payload),
  deduplicateCharacterTextures: (files) => ipcRenderer.invoke("assets:deduplicateCharacterTextures", files),
  revealCharacterHistorySource: (payload) => ipcRenderer.invoke("assets:revealCharacterHistorySource", payload),
  rewriteCustomJson: () => ipcRenderer.invoke("assets:rewriteCustomJson"),
  syncMetadata: () => ipcRenderer.invoke("assets:syncMetadata"),
  exportToUnreal: (payload) => ipcRenderer.invoke("assets:exportToUnreal", payload),
  exportToBlender: (payload) => ipcRenderer.invoke("assets:exportToBlender", payload),
  copyText: (text) => ipcRenderer.invoke("assets:copyText", text),
  openFolder: (path) => ipcRenderer.invoke("assets:openFolder", path),
  revealAssetArchive: (assetId) => ipcRenderer.invoke("assets:revealArchive", assetId),
  revealCharacterModel: (payload) => ipcRenderer.invoke("assets:revealCharacterModel", payload),
  revealCharacterTexture: (payload) => ipcRenderer.invoke("assets:revealCharacterTexture", payload),
  onExportProgress: (callback) => {
    const subscription = (event, payload) => callback(payload);
    ipcRenderer.on("assets:exportProgress", subscription);
    return () => ipcRenderer.removeListener("assets:exportProgress", subscription);
  },
  onAssetChange: (callback) => {
    const subscription = (event, ...args) => callback(...args);
    ipcRenderer.on("assets:change", subscription);
    return () => ipcRenderer.removeListener("assets:change", subscription);
  },
  onCharacterDeleted: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('assets:characterDeleted', listener);
    return () => ipcRenderer.removeListener('assets:characterDeleted', listener);
  },
  onScanProgress: (callback) => {
    const subscription = (event, payload) => callback(payload);
    ipcRenderer.on("assets:scanProgress", subscription);
    return () => ipcRenderer.removeListener("assets:scanProgress", subscription);
  },
  onRigDownloadProgress: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('character:rigDownloadProgress', listener);
    return () => ipcRenderer.removeListener('character:rigDownloadProgress', listener);
  },
  onCustomSaveProgress: (callback) => {
    const subscription = (event, payload) => callback(payload);
    ipcRenderer.on("assets:customSaveProgress", subscription);
    return () => ipcRenderer.removeListener("assets:customSaveProgress", subscription);
  },
  onCalculateBoundsRequest: (callback) => {
    const subscription = (event, payload) => callback(payload);
    ipcRenderer.on("assets:calculateBoundsRequest", subscription);
    return () => ipcRenderer.removeListener("assets:calculateBoundsRequest", subscription);
  },
  respondBounds: (payload) => ipcRenderer.invoke("assets:respondBounds", payload),
  recalculateSizes: () => ipcRenderer.invoke("assets:recalculateSizes"),
  toggleFavorite: (assetId, isFavorite) => ipcRenderer.invoke("assets:toggleFavorite", { assetId, isFavorite }),
  dropPlugin: (path) => ipcRenderer.invoke("settings:dropPlugin", path),
  checkAppUpdate: () => ipcRenderer.invoke("app:checkUpdate"),
  getAppVersion: () => ipcRenderer.invoke("app:getVersion"),
  openExternal: (url) => ipcRenderer.invoke("app:openExternal", url),
  downloadAppUpdate: () => ipcRenderer.invoke("app:downloadUpdate"),
  installDownloadedUpdate: (payload) => ipcRenderer.invoke("app:installDownloadedUpdate", payload),
  onAppUpdateState: (callback) => {
    const subscription = (_event, payload) => callback(payload);
    ipcRenderer.on("app:updateState", subscription);
    return () => ipcRenderer.removeListener("app:updateState", subscription);
  },
  onAppUpdateDownloadProgress: (callback) => {
    const subscription = (event, payload) => callback(payload);
    ipcRenderer.on("app:updateDownloadProgress", subscription);
    return () => ipcRenderer.removeListener("app:updateDownloadProgress", subscription);
  },
  checkPluginUpdate: () => ipcRenderer.invoke("plugins:checkUpdate"),
  installPluginFromGithub: () => ipcRenderer.invoke("plugins:installFromGithub"),
  installPlugin: (repo, targetPath) => ipcRenderer.invoke("plugins:install", { repo, targetPath }),
  onPluginInstallProgress: (callback) => {
    const subscription = (event, payload) => callback(payload);
    ipcRenderer.on("plugins:installProgress", subscription);
    return () => ipcRenderer.removeListener("plugins:installProgress", subscription);
  },
  getPluginStatus: (payload) => ipcRenderer.invoke("plugins:getStatus", payload),
  getAnimationGameTagOptions: () => ipcRenderer.invoke("animation:getGameTagOptions"),
  resolveAnimationPreviewRig: (payload) => ipcRenderer.invoke("animation:resolvePreviewRig", payload),
  // 不透明裁切的透明度来源体检（开启 OPAQUE 前先问一次，不可用就禁用入口）。
  getFoliageOpaqueMaskStatus: (payload) => ipcRenderer.invoke("assets:foliageOpaqueMaskStatus", payload),
  // 「输出日志」窗口：历史尾部读取 + 实时订阅 + 打开所在文件夹 / 清空。
  readLogs: (options) => ipcRenderer.invoke("logs:read", options),
  openLogFolder: () => ipcRenderer.invoke("logs:openFolder"),
  clearLogs: () => ipcRenderer.invoke("logs:clear"),
  onLogLine: (callback) => {
    const subscription = (event, payload) => callback(payload);
    ipcRenderer.on("logs:line", subscription);
    return () => ipcRenderer.removeListener("logs:line", subscription);
  }
});
