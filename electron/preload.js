const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("arkhive", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowToggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
  windowClose: () => ipcRenderer.invoke("window:close"),
  pickLibraryPath: () => ipcRenderer.invoke("library:pickPath"),
  pickEnginePath: () => ipcRenderer.invoke("settings:pickEngine"),
  pickProjectPath: () => ipcRenderer.invoke("settings:pickProject"),
  pickTargetPath: () => ipcRenderer.invoke("settings:pickTarget"),
  pickLogPath: () => ipcRenderer.invoke("settings:pickLog"),
  clearCaches: () => ipcRenderer.invoke("settings:clearCaches"),
  getAssetIndex: () => ipcRenderer.invoke("assets:getIndex"),
  getAssetById: (assetId) => ipcRenderer.invoke("assets:getById", assetId),
  getUnrealConnectionStatus: () => ipcRenderer.invoke("unreal:getConnectionStatus"),
  rescanAssets: () => ipcRenderer.invoke("assets:rescan"),
  searchAssets: (query) => ipcRenderer.invoke("assets:search", query),
  pickAssetFolder: () => ipcRenderer.invoke("assets:pickFolder"),
  pickAssetImage: () => ipcRenderer.invoke("assets:pickImage"),
  pickAssetFile: (kind) => ipcRenderer.invoke("assets:pickFile", kind),
  materializeDroppedFile: (payload) => ipcRenderer.invoke("assets:materializeDroppedFile", payload),
  resolveDroppedItems: (payload) => ipcRenderer.invoke("assets:resolveDroppedItems", payload),
  cancelResolveDroppedItems: (payload) => ipcRenderer.invoke("assets:cancelResolveDroppedItems", payload),
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
  getPreviewThumbnail: (filePath) => ipcRenderer.invoke("assets:getPreviewThumbnail", filePath),
  importCustomAsset: (payload) => ipcRenderer.invoke("assets:importCustom", payload),
  updateCustomAsset: (payload) => ipcRenderer.invoke("assets:updateCustom", payload),
  cutoutPreviewMagic: (payload) => ipcRenderer.invoke("assets:cutoutPreviewMagic", payload),
  finalizePreviewCutout: (payload) => ipcRenderer.invoke("assets:finalizePreviewCutout", payload),
  deleteCustomAsset: (payload) => ipcRenderer.invoke("assets:deleteCustom", payload),
  rewriteCustomJson: () => ipcRenderer.invoke("assets:rewriteCustomJson"),
  exportToUnreal: (payload) => ipcRenderer.invoke("assets:exportToUnreal", payload),
  copyText: (text) => ipcRenderer.invoke("assets:copyText", text),
  openFolder: (path) => ipcRenderer.invoke("assets:openFolder", path),
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
  onScanProgress: (callback) => {
    const subscription = (event, payload) => callback(payload);
    ipcRenderer.on("assets:scanProgress", subscription);
    return () => ipcRenderer.removeListener("assets:scanProgress", subscription);
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
  downloadAppUpdate: () => ipcRenderer.invoke("app:downloadUpdate"),
  installDownloadedUpdate: (payload) => ipcRenderer.invoke("app:installDownloadedUpdate", payload),
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
  getPluginStatus: (payload) => ipcRenderer.invoke("plugins:getStatus", payload)
});
