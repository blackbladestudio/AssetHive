const { saveUpdateResponse, verifyCachedUpdatePackage } = require("./services/updatePackage");
const { windowsPackageType, pickWindowsUpdateAsset, findLocalUpdatePackage, detectWindowsInstallation } = require("./services/windowsUpdate");
const { createAppUpdateController } = require("./services/appUpdateController");
const { createStartupWindow } = require("./services/startupWindow");
const { createSharedDerivedCache } = require("./services/sharedDerivedCache");
const { createCacheProcess } = require("./services/cacheProcess");
const { hasPreviewSize, populatePreviewSize } = require("./services/previewSize");
const { runImageTask } = require("./services/imageTasks");
const { imageDimensions } = require("./services/imageDimensions");
const { analyzeFbxInWorker } = require("./services/modelAnalysis");
const { analyzeAssetTextureUsage } = require("./services/textureAnalysis");
const { stopLibraryWatch } = require("./services/libraryWatchService");
const { opaqueBounds } = require("./services/previewCutout");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");
const fsSync = require("node:fs");
const { transactionalFs: fs, protectFile, commitFileTransaction, withFileTransaction, recoverFileTransactions } = require("./services/assetFileTransaction");
const { execFile } = require("node:child_process");
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, powerMonitor } = require("electron");
const { createScanSchedule, CHANGE_CHECK_INTERVAL_MS } = require("./services/scanSchedule");
const { recordLibraryChanges } = require("./services/libraryChanges");
const { boundedMap } = require('./services/boundedMap');
const { startupScanDelay, periodicScanDelay } = require("./services/scanTiming");
const { toAssetListRecord, toAssetIndexRecord } = require("./services/assetListRecord");
const { createImportQueueStore } = require("./services/importQueue");
const { writeFileAtomic } = require("./services/atomicFile");
const { normalizeAssetTag, normalizeStandardAssetTag } = require("./services/assetTags");
const { detectSourceStandardAssetTags } = require("./services/sourceDetection");
const { isBridgeMicroPlant } = require("./services/plantWindPreset");
const { importPlantLayers } = require("./services/plantWindLayers");
const { resolveMegascansSourceIdentity } = require("./services/megascansIdentity");
const { resolveMegascansName } = require("./services/megascansName");
const { resolvePbrMaxSourceAssetId } = require("./services/pbrMaxIdentity");
const {
  IDENTITY_SCHEMA_VERSION,
  FINGERPRINT_VERSION,
  deriveSourceIdentity,
  computeContentIdentity,
  normalizeSourceToken
} = require("./services/assetIdentity");
const { getAnimationIdentitySidecarPath, writeAnimationIdentitySidecar } = require("./services/animationIdentity");
const { normalizeTextureMaterialRole, isThumbsFolderPath } = require("./services/textureMaterialRole");
const { isDropCandidateFile, parse7zTechnicalListing, selectDropArchiveEntries } = require("./services/dropArchiveSelection");
const { evaluateSourceMatch, deriveStoredSourceIdentityFromMetadata } = require("./services/duplicateSourceMatch");
const { resolveSyncedTextureMaterialRole, buildSyncedTextureToken, splitSyncedTextureToken } = require("./services/textureEntrySync");
const { normalizeMegascansTextureType, collectMegascansTextureHints } = require("./services/megascansTextures");
const { TEXTURE_TYPES, detectTextureTypeFromFileName, normalizeTextureType, normalizePbrMaxDecalTextureType } = require("./services/textureTypes");
const { resolveMegascansCategory } = require("./services/megascansCategory");
const { isImperfectionMetadata } = require("./services/imperfectionClassification");
const { isDisplacementMetadata } = require("./services/displacementClassification");
const { buildFoliageOpaqueVariants } = require("./services/foliageOpaqueVariants");
const { foliageOpaqueStatus, resolveFoliageMaskSource, describeFoliageMaskSource } = require("./services/foliageOpaque");
const { regenerateFoliageOpaqueVariants } = require("./services/foliageOpaqueRegenerate");
const { resolvePlantOpaqueBudgetRange } = require("./services/plantOpaqueBudget");
const { parseModelVariantKey, normalizeModelVariantKey, modelVariantNumberFromKey, buildModelVariantKeyMap, compareModelVariantKeys, toOpaqueVariantFileStem } = require("./services/modelVariants");
const { buildModelLodPlan } = require("./services/modelLods");
const { buildSyncedAssetMetadataFields, isAnimationLibraryAsset, hasCurrentMetadataUpdateMarker, buildMetadataUpdateMarker, normalizeAssetType } = require("./services/libraryMetadataSync");
const { prepareOpaqueFilenameMigration, applyOpaqueRenamePlan, rollbackOpaqueRenamePlan } = require("./services/opaqueFilenameMigration");
const { ASSET_METADATA_FILE_NAME, createAssetMetadata, writeAssetMetadata, updateAssetMetadataFile, isSidecarAssetMetaFileName, pruneEmptyAssetSlots } = require("./services/assetMetadata");
const { materialPreview } = require("./services/megascansPreview");
const {
  buildCharacterMaterialBaseName,
  buildCharacterModelBaseName,
  buildCharacterRelativeRoot,
  buildCharacterTextureBaseName,
  classifyCharacterPackageFile,
  inferCharacterTextureGroup,
  inferCharacterTextureType,
  isCharacterAssetType,
  normalizeCharacterFields,
  validateCharacterImport
} = require("./services/characterImport");
const { buildFamilyPackagePlan, getFamilyTextureMapCode, resolveMonsterAssociation, buildMonsterAssetName } = require("./services/characterFamilyRules");
const {
  applyPreservedAnimationPreview,
  buildAnimationMetaFromModel,
  isAnimationModelMetaPath,
  isFlatCustomAssetType,
  listAnimationArchiveExtras,
  pickPreservedAnimationPreview,
  resolveCustomAssetLayout
} = require("./services/customAssetLayout");
const { createUserFavorites } = require("./services/userFavorites");
const { resolveAssetModelPath, normalizeAssetModelPaths } = require("./services/assetModelPaths");
const { listRecycledAssets } = require("./services/libraryRecycle");
const { preparePermanentCharacterDeletion, deleteCharacterPermanently, listPermanentlyDeletedAssets } = require("./services/characterDeletion");
const { removeLibraryPathWithRetries, purgeTrashEntry } = require("./services/libraryRemoval");
const { updateCharacterStatus, prepareComponentReplacement, replaceCharacterComponent, updateCharacterComponentPreview, updateCharacterPreviewGallery, updateCharacterAutomaticPreviews, selectCharacterComponentRevision, resolveCharacterModelFile, resolveCharacterTextureFile } = require("./services/characterComponents");
const { updateCharacterNames } = require("./services/characterNames");
const { inspectCharacterUpdateInput, matchCharacterTextureReplacements, prepareCharacterPackageUpdate, updateCharacterPackage, restoreCharacterPackageVersion } = require("./services/characterPackageUpdates");
const { characterIdentity, resolveHistorySource, relinkHistorySource } = require("./services/characterUpdateHistory");
const { partitionCharacterPackageFiles, isAllowedCharacterPackageFile } = require("../shared/characterFilePolicy.mjs");
const { refreshCharacterTriangleMetrics } = require("./services/characterModelMetrics");
const { activeCharacterFiles, componentParentId, characterModelPreviewComponents: listCharacterComponents } = require("../shared/characterComponents.mjs");
const { sendSuitJob, refreshSuitStatus, isCharacterUEAsset } = require("./services/characterSuitExport");
let userFavorites;
function getUserFavorites() {
  return userFavorites ||= createUserFavorites(path.join(app.getPath("userData"), "favorites.json"));
}
const droppedArchiveDirs = new Set();
const droppedMaterializedFiles = new Set();
const backgroundImportOwners = new Set();
const observedImportOwners = new Set();
let activeImportCalls = 0;
let activeExportCalls = 0;
let appUpdates = null;
let quitting = false;
let quitAfterImport = false;
let quitForceExitTimer = null;
let rendererRecoveryPending = false;
const startupWindows = new Map();

function hasActiveBackgroundImport() {
  return backgroundImportOwners.size > 0 || activeImportCalls > 0;
}

function finishImportBeforeQuit() {
  if (!quitAfterImport || quitting || hasActiveBackgroundImport()) return;
  writeLog("INFO", "current import finished after close request, quitting app");
  app.quit();
}

function showMainWindow() {
  // A second launch must not revive a process already shutting down.
  if (quitting) return;
  const win = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
  if (!win) {
    createWindow();
    return;
  }
  const startupWindow = startupWindows.get(win.id);
  if (startupWindow) {
    startupWindow.focus();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function confirmQuitAfterImport(window) {
  const options = {
    type: "warning",
    title: "导入任务尚未完成",
    message: "当前有资产正在导入。",
    detail: "选择关闭后，窗口会保持打开。当前资产处理完成后自动退出，队列中的后续资产不会开始导入。",
    buttons: ["继续使用", "完成导入后关闭"],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
  const response = window ? dialog.showMessageBoxSync(window, options) : dialog.showMessageBoxSync(options);
  if (response !== 1) return false;
  quitAfterImport = true;
  writeLog("INFO", "close requested during import, waiting for queue");
  return true;
}

app.on("before-quit", (event) => {
  if (hasActiveBackgroundImport()) {
    event.preventDefault();
    if (!quitAfterImport) confirmQuitAfterImport(BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]);
    return;
  }
  quitting = true;
  // 兜底：优雅退出可能因后台 worker 线程/异步任务卡住而无法走完 will-quit，
  // 导致主进程 + GPU/网络子进程残留并占用单实例锁。确认退出后若数秒内仍未结束，
  // 强制结束进程（正常退出会在毫秒级完成，此定时器不会触发）。
  if (!quitForceExitTimer) {
    quitForceExitTimer = globalThis.setTimeout(() => {
      writeLog("WARN", "graceful quit stalled, forcing exit");
      app.exit(0);
    }, 5000);
    quitForceExitTimer.unref?.();
  }
});
let sharp = null;
try {
  sharp = require("sharp");
} catch {
  sharp = null;
}
if (sharp && typeof sharp.concurrency === "function") {
  const configuredSharpConcurrency = Number(process.env.ASSETHIVE_SHARP_CONCURRENCY);
  const cpuCount = Array.isArray(os.cpus?.()) ? os.cpus().length : 0;
  const fallbackSharpConcurrency = cpuCount > 0 ? Math.max(1, Math.min(2, Math.floor(cpuCount / 2))) : 1;
  const sharpConcurrency = Number.isFinite(configuredSharpConcurrency) && configuredSharpConcurrency > 0
    ? Math.floor(configuredSharpConcurrency)
    : fallbackSharpConcurrency;
  sharp.concurrency(sharpConcurrency);
}
let pinyinLib = null;
try {
  const pinyinModule = require("pinyin");
  pinyinLib = pinyinModule?.pinyin || pinyinModule?.default || pinyinModule;
  if (typeof pinyinLib !== "function") {
    pinyinLib = null;
  }
} catch {
  pinyinLib = null;
}
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const {
  scanLibrary,
  scanLibraryInWorker,
  stopLibraryScans,
  searchAssets,
  getAssetDetails,
  getAssetDetailsByMetaPath,
  watchLibrary,
  inferColorTagsFromTextureFiles,
  collectColorTagsFromMeta
} = require("./services/assetScanner");
const { exportToUnreal, isZionPlantAsset } = require("./services/unrealExporter");
const { exportToBlender, normalizeBlenderDecimationRatio } = require("./services/blenderExporter");
const { getBlenderStatus, installBlenderPlugin } = require("./services/blenderIntegration");
const { normalizeNativePlantWind, detectNativePlantWind } = require("./services/nativePlantWind");
const { resolveNativePlantGroups } = require("./services/nativePlantGroups");
const { tcpClient } = require("./services/unrealDiscovery");
const { matchesUnrealConnection } = require("./services/unrealConnection");
const { registerThreeDCoatIpc } = require("./services/threeDCoat");
const { fetchLatestRelease, installPluginFromGithub, installPluginToEngine } = require("./services/githubInstaller");
const logManager = require("./logManager");
const { writeLog, setupLogger } = logManager;

// 把每一行日志推给所有窗口的「输出日志」面板。窗口还没建好时静默丢弃：
// 历史部分由 logs:read 补，实时部分从这里来，两边合起来就是完整输出。
logManager.onLogLine((line) => {
  for (const target of BrowserWindow.getAllWindows()) {
    if (!target.isDestroyed() && !target.webContents.isDestroyed()) {
      target.webContents.send("logs:line", { line });
    }
  }
});

const DISABLE_GPU_ACCELERATION = process.env.ASSETHIVE_DISABLE_GPU === "1";
if (DISABLE_GPU_ACCELERATION) {
  app.disableHardwareAcceleration();
}
app.setName("AssetHive");
if (process.platform === "win32") {
  // Windows groups taskbar / Start entries and resolves their icon by AUMID.
  // A dev Electron instance must never share the installed app's identity:
  // otherwise a pinned `electron.exe` shortcut (from preview or another Electron
  // tool) can take over AssetHive's icon and launch target. Keep the installed
  // ID in sync with the MSI / Inno Setup shortcuts.
  app.setAppUserModelId(app.isPackaged ? "com.blackblade.assethive" : "com.blackblade.assethive.preview");
}
const previewUserDataPath = String(process.env.ASSETHIVE_PREVIEW_USER_DATA || "").trim();
const resolvedPreviewUserDataPath = previewUserDataPath ? path.resolve(previewUserDataPath) : "";
if (resolvedPreviewUserDataPath) {
  fsSync.mkdirSync(resolvedPreviewUserDataPath, { recursive: true });
  app.setPath("userData", resolvedPreviewUserDataPath);
}
// 预览模式下把库索引 / 缩略图 / 动画预览缓存持久化到启动器的 shared 目录，否则每次
// 冷启动都要重新扫描网络库、重新生成缩略图，界面长时间空白。shared 目录是本地临时
// 目录，不落在网络共享库上，因此不会触发 SQLite 的 SMB 阻塞风险。
const previewSharedPath = String(process.env.ASSETHIVE_PREVIEW_SHARED || "").trim();
const resolvedPreviewSharedPath = previewSharedPath ? path.resolve(previewSharedPath) : "";

function getPersistentCacheRoot() {
  return resolvedPreviewSharedPath || app.getPath("userData");
}

let importQueueStore = null;
function getImportQueueStore() {
  return importQueueStore ||= createImportQueueStore(path.join(getPersistentCacheRoot(), "ImportQueue"));
}

function getImportSourceRoot() {
  return path.join(getPersistentCacheRoot(), "ImportSources");
}

const editRecoveryPromises = new Map();
function ensureLibraryEditsRecovered(assetId = "") {
  const root = settings.customLibraryPath;
  if (!root) return Promise.resolve();
  const owner = crypto.createHash("sha256").update(`${os.hostname()}|${getPersistentCacheRoot()}`).digest("hex").slice(0, 24);
  const key = `${root}|${owner}|${assetId}`;
  if (!editRecoveryPromises.has(key)) {
    const asset = assetId ? index.find(item => item.id === assetId && item.source === "custom") : null;
    const paths = asset ? [asset.metaPath, !isFlatLibraryAsset(asset.assetType, asset.metaPath) && asset.path].filter(Boolean) : [];
    const recovery = recoverFileTransactions(root, owner, [getAnimationPreviewCacheDir()], assetId
      ? { key: `${root}|${assetId}`, paths } : {}).catch(error => {
      editRecoveryPromises.delete(key);
      throw error;
    });
    editRecoveryPromises.set(key, recovery);
  }
  return editRecoveryPromises.get(key);
}

function rememberQueueSources(snapshot) {
  const archiveRoot = path.resolve(getImportSourceRoot(), "DroppedArchives");
  const fileRoot = path.resolve(getImportSourceRoot(), "DroppedFiles");
  const visit = value => {
    if (typeof value === "string") {
      const absolute = path.resolve(value);
      const relative = path.relative(archiveRoot, absolute);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) droppedArchiveDirs.add(path.join(archiveRoot, relative.split(path.sep)[0]));
      if (path.dirname(absolute) === fileRoot) droppedMaterializedFiles.add(absolute);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(snapshot.drafts);
  return snapshot;
}
app.commandLine.appendSwitch(
  "disk-cache-dir",
  resolvedPreviewUserDataPath
    ? path.join(getPersistentCacheRoot(), "chromium-cache")
    : path.join(os.tmpdir(), "AssetHive", "chromium-cache")
);
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");

// 预览模式：监视预览启动器持有的独占锁文件（<userData>\launcher.lock）。
// 直接关闭终端窗口 / 强制结束启动脚本时，Electron 收不到任何退出事件，会继续占用
// node_modules\electron\dist 下的运行时文件与临时 userData，导致下一次预览出现
// “Electron download or runtime validation failed” 或窗口始终不出现。
// 启动器持有该文件（FileShare.None）期间探测会被拒绝；一旦探测成功，说明启动器
// 进程已经结束（操作系统已释放句柄），此时自行退出，避免留下残留进程。
const PREVIEW_LAUNCHER_LOCK_FILE = "launcher.lock";
if (resolvedPreviewUserDataPath) {
  const launcherLockPath = path.join(resolvedPreviewUserDataPath, PREVIEW_LAUNCHER_LOCK_FILE);
  let launcherLockObserved = false;
  const previewLauncherWatcher = globalThis.setInterval(() => {
    let handle = null;
    try {
      handle = fsSync.openSync(launcherLockPath, "r+");
    } catch {
      // 打不开说明启动器仍在运行并持有独占锁。
      launcherLockObserved = true;
      return;
    } finally {
      if (handle !== null) {
        try { fsSync.closeSync(handle); } catch { /* 句柄关闭失败不影响退出判断 */ }
      }
    }
    if (!launcherLockObserved) {
      // 从未确认过锁存在时不退出，避免与不写锁文件的启动器版本冲突。
      return;
    }
    globalThis.clearInterval(previewLauncherWatcher);
    writeLog("INFO", "preview launcher exited, closing preview");
    app.exit(0);
  }, 5000);
  previewLauncherWatcher.unref?.();
  app.on("will-quit", () => globalThis.clearInterval(previewLauncherWatcher));
}
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", showMainWindow);
}

let index = [];
let settings = {
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
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".exr", ".hdr", ".tga"]);
const IMPORT_TEXTURE_MAX_RESOLUTION_PIXELS = 8192;
const LIBRARY_TEXTURE_MAX_RESOLUTION_PIXELS = 4096;
const MODEL_EXTENSIONS = new Set([".fbx", ".st9", ".obj", ".abc", ".gltf", ".glb", ".ztl"]);
const TEXTURE_SUFFIXES = [...TEXTURE_TYPES];
const TEXTURE_SUFFIX_SET = new Set(TEXTURE_SUFFIXES.map((name) => name.toLowerCase()));
const MODEL_SLOT_SUFFIXES = ["Ztool", "HighPoly", "Lod0", "Lod1", "Lod2", "Lod3"];
const APP_UPDATE_REPO_CANDIDATES = ["blackbladestudio/AssetHive"];
const GITHUB_DOWNLOAD_PROXY_PREFIXES = [
  "https://ghfast.top/",
  "https://ghproxy.net/",
  "https://gh-proxy.com/",
  "https://mirror.ghproxy.com/",
  "https://ghp.ci/",
  "https://v6.gh-proxy.org/",
  "https://ghproxy.vip/",
  "https://gh.api.99988866.xyz/",
  ""
];
const DOWNLOAD_REQUEST_TIMEOUT_MS = 45 * 1000;
const DOWNLOAD_REQUEST_RETRY_COUNT = 2;
const DOWNLOAD_PROBE_TIMEOUT_MS = 1800;
const DOWNLOAD_PROBE_MAX_BYTES = 65535;
const DOWNLOAD_PROBE_CACHE_TTL_MS = 10 * 60 * 1000;
const downloadProbeCache = new Map();
const pendingBoundsRequests = new Map();
const WATCH_SCAN_COOLDOWN_MS = 10 * 60 * 1000;
const LIBRARY_SQLITE_CACHE_FILE_NAME = "HiveIndex.sqlite";
const LIBRARY_JSON_CACHE_FILE_NAME = "index.json";
const RUNTIME_CACHE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
// 合成缓存池稳态上限：贴图合成/转换产物按最旧优先（LRU）淘汰到该值的 80%。
// 引擎启动缓存不再参与自动淘汰，因此这里只约束合成池，不再和引擎缓存争配额。
const COMPOSITED_CACHE_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const COMPOSITED_CACHE_TARGET_RATIO = 0.8;
const COLOR_TAG_INFER_TIMEOUT_MS = 3500;
const ENABLE_STARTUP_AUTO_SCAN = process.env.ASSETHIVE_AUTO_SCAN_ON_STARTUP !== "0";
const ENABLE_WATCH_AUTO_SCAN = process.env.ASSETHIVE_WATCH_AUTO_SCAN !== "0";
const ENABLE_PERIODIC_SCAN = process.env.ASSETHIVE_PERIODIC_SCAN !== "0";
const PERIODIC_SCAN_INTERVAL_MS = Number(process.env.ASSETHIVE_PERIODIC_SCAN_INTERVAL_MS) || CHANGE_CHECK_INTERVAL_MS;
let scanInProgress = false;
// 索引是否已由库扫描产出（权威数据）。后台恢复缓存时据此避免用旧缓存覆盖扫描结果。
let scanIndexAuthoritative = false;
let sharedIndexComplete = false;
let sharedSnapshotVersion = 0;
let sharedPublishedVersion = -1;
let sharedPublishInFlight = false;
let sharedPublishRetryAt = 0;
// 后台索引缓存恢复任务（见 restoreLibraryIndexCache）：启动扫描会等待它，避免退化成全量扫描。
let libraryCacheRestorePromise = null;
let librarySelectionGeneration = 0;
let activeScanGeneration = 0;
// 扫描进行中收到的强制重扫请求（手动重扫 / 清缓存 / 设置变更）。不排队的话
// 这些请求会被直接丢弃：界面提示“已开始重扫”，但实际什么都不会发生。
let pendingScanRequest = null;
let lastWatcherScanAt = 0;
let suppressWatcherScanUntil = 0;
let runtimeCacheMonitorTimer = null;
let periodicScanTimer = null;
const libraryScanSchedules = new Map();
let lastScanSnapshotRoot = "";
let pendingIndexSaveTimer = 0;

function normalizeVersionTag(value) {
  // Release tag 可能带产品前缀（如 AssetHive-v1.1.7 / omni-v0.1.2），
  // 只抽取第一个 x.y.z 三段数字用于比较。
  const match = String(value || "").trim().match(/(\d+)[.](\d+)[.](\d+)/);
  if (!match) {
    return "0.0.0";
  }
  return `${Number.parseInt(match[1], 10) || 0}.${Number.parseInt(match[2], 10) || 0}.${Number.parseInt(match[3], 10) || 0}`;
}

function compareVersions(a, b) {
  const left = normalizeVersionTag(a).split(".").map((item) => Number.parseInt(item, 10) || 0);
  const right = normalizeVersionTag(b).split(".").map((item) => Number.parseInt(item, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] > right[i]) {
      return 1;
    }
    if (left[i] < right[i]) {
      return -1;
    }
  }
  return 0;
}

async function fetchLatestAppRelease(repoCandidates = APP_UPDATE_REPO_CANDIDATES) {
  const candidates = Array.isArray(repoCandidates) ? repoCandidates : [String(repoCandidates || "").trim()];
  const normalizedCandidates = candidates.map((item) => String(item || "").trim()).filter(Boolean);
  let lastErrorMessage = "未找到可用更新源";
  let sawReachableRepo = false;
  let sawNoReleaseRepo = false;
  for (const repo of normalizedCandidates) {
    try {
      const headers = {
        "User-Agent": "AssetHive-App",
        "Accept": "application/vnd.github+json"
      };
      let releaseData = null;
      try {
        releaseData = await fetchGithubJsonWithFallback(`https://api.github.com/repos/${repo}/releases/latest`, headers);
        sawReachableRepo = true;
      } catch {
        const list = await fetchGithubJsonWithFallback(`https://api.github.com/repos/${repo}/releases?per_page=20`, headers);
        sawReachableRepo = true;
        const picked = Array.isArray(list) ? list.find((item) => item && !item.draft) : null;
        if (!picked) {
          sawNoReleaseRepo = true;
          throw new Error(`仓库 ${repo} 暂无已发布版本`);
        }
        releaseData = picked;
      }
      return {
        repo,
        version: String(releaseData?.tag_name || "").trim(),
        name: String(releaseData?.name || "").trim(),
        publishedAt: String(releaseData?.published_at || "").trim(),
        releaseNotes: String(releaseData?.body || "").trim(),
        htmlUrl: String(releaseData?.html_url || "").trim(),
        assets: Array.isArray(releaseData?.assets) ? releaseData.assets : []
      };
    } catch (error) {
      lastErrorMessage = error?.message || String(error);
    }
  }
  if (sawReachableRepo && sawNoReleaseRepo) {
    throw new Error("当前更新源暂无已发布版本，请先在 GitHub Releases 发布安装包");
  }
  if (sawReachableRepo) {
    throw new Error("当前更新源不可用，请稍后重试");
  }
  throw new Error(lastErrorMessage);
}

function getUpdateStorageContext() {
  const appRootPath = app.isPackaged ? path.dirname(app.getPath("exe")) : app.getAppPath();
  const updateDir = path.join(app.getPath("userData"), ".update");
  return { appRootPath, updateDir };
}

async function getAppInstallation() {
  // Preview can still manually download the standalone installer; installation
  // remains disabled and its controller never downloads automatically.
  if (!app.isPackaged) return { type: "exe", scope: "user" };
  return detectWindowsInstallation(getUpdateStorageContext().appRootPath);
}

async function extractZipForUpdate(zipPath, extractDir) {
  const { updateDir } = getUpdateStorageContext();
  if (path.dirname(path.resolve(extractDir)) !== path.resolve(updateDir)) throw new Error("更新解压目录无效");
  await fs.rm(extractDir, { recursive: true, force: true });
  await fs.mkdir(extractDir, { recursive: true });
  const { spawn } = require("child_process");
  await new Promise((resolve, reject) => {
    const quote = value => `'${value.replace(/'/g, "''")}'`;
    const psCommand = `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(extractDir)} -Force`;
    const child = spawn("powershell", ["-NoProfile", "-Command", psCommand], { windowsHide: true });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Unzip failed with code ${code}`));
    });
    child.on("error", reject);
  });
}

async function findExeInDirForUpdate(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const appExe = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === "assethive.exe");
  if (appExe) return path.join(dir, appExe.name);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findExeInDirForUpdate(fullPath);
      if (found) return found;
    }
  }
  return "";
}

async function launchDownloadedUpdatePackage(packagePath) {
  if (!app.isPackaged) return { ok: false, message: "开发预览不支持覆盖更新，请在已安装的 AssetHive 中更新" };
  const normalizedPath = String(packagePath || "").trim();
  if (!normalizedPath) {
    return { ok: false, message: "未找到可安装的更新包路径" };
  }
  const stat = await fs.stat(normalizedPath).catch(() => null);
  if (!stat || !stat.isFile()) {
    return { ok: false, invalidPackage: true, message: "更新包不存在，请先下载" };
  }
  const integrity = await verifyCachedUpdatePackage(normalizedPath);
  if (!integrity.ok) {
    await fs.rm(normalizedPath, { force: true }).catch(() => { });
    return { ok: false, invalidPackage: true, message: `安装包完整性校验失败，已删除损坏文件：${integrity.reason}` };
  }
  const { appRootPath, updateDir } = getUpdateStorageContext();
  let installation;
  try {
    installation = await getAppInstallation();
  } catch (error) {
    return { ok: false, message: error.message };
  }
  if (windowsPackageType(normalizedPath) !== installation.type) {
    return { ok: false, invalidPackage: true, message: "更新包类型与当前安装类型不一致，请重新下载对应的更新包" };
  }
  const lowerPath = normalizedPath.toLowerCase();
  let sourceDir = "";
  if (lowerPath.endsWith(".zip")) {
    const extractDir = path.join(updateDir, `${path.basename(normalizedPath, path.extname(normalizedPath))}-extracted`);
    try {
      await extractZipForUpdate(normalizedPath, extractDir);
      const extractedExe = await findExeInDirForUpdate(extractDir);
      if (!extractedExe) {
        return { ok: false, message: "压缩包中未找到可执行安装文件" };
      }
      sourceDir = path.dirname(extractedExe);
    } catch (error) {
      writeLog("ERROR", "Failed to launch zip update package", error);
      return { ok: false, message: `安装失败：${String(error?.message || error || "")}` };
    }
  }
  if (!/\.(exe|msi|zip)$/.test(lowerPath)) return { ok: false, message: "不支持的更新包格式" };
  // The helper waits for this process, installs into the current directory, then restarts.
  const updaterPath = path.join(updateDir, "AssetHiveUpdater.exe");
  try {
    await fs.copyFile(path.join(appRootPath, "AssetHiveUpdater.exe"), updaterPath);
    const { spawn } = require("node:child_process");
    const child = spawn(updaterPath, [
      "--package", normalizedPath, "--target", appRootPath,
      "--install-type", installation.type, "--install-scope", installation.scope,
      "--source", sourceDir, "--wait-pid", String(process.pid), "--restart", app.getPath("exe")
    ], { detached: true, stdio: "ignore", windowsHide: true });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    globalThis.setTimeout(() => app.quit(), 500);
    return { ok: true, message: "正在退出并覆盖更新，完成后将自动重新打开" };
  } catch (error) {
    return { ok: false, message: `无法启动覆盖更新：${error.message}` };
  }
}

async function downloadReleaseAsset(url, targetFilePath, onProgress, metadata) {
  const candidateUrls = buildGithubDownloadCandidates(url);
  const requestHeaders = {
    "User-Agent": "AssetHive-App",
    "Accept": "application/octet-stream"
  };
  const orderedCandidateUrls = await sortDownloadCandidatesBySpeed(candidateUrls, requestHeaders);
  let response = null;
  let lastError = "";
  for (const candidateUrl of orderedCandidateUrls) {
    try {
      response = await fetchWithTimeout(candidateUrl, { headers: requestHeaders });
      if (!response.ok) {
        lastError = `Download failed: ${response.status} ${response.statusText}`;
        continue;
      }
      break;
    } catch (error) {
      lastError = error?.message || String(error);
    }
  }
  if (!response || !response.ok) {
    throw new Error(lastError || "Download failed");
  }
  if (!response.body) {
    throw new Error("Download failed: empty response body");
  }
  await saveUpdateResponse(response, targetFilePath, metadata, onProgress);
}

async function sortDownloadCandidatesBySpeed(candidateUrls, headers = {}) {
  const normalized = Array.isArray(candidateUrls)
    ? candidateUrls.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const unique = [...new Set(normalized)];
  if (unique.length <= 1) {
    return unique;
  }
  const now = Date.now();
  const cachedScores = new Map();
  const pendingProbeUrls = [];
  for (const url of unique) {
    const cached = downloadProbeCache.get(url);
    if (cached && cached.expiresAt > now && Number.isFinite(cached.elapsedMs)) {
      cachedScores.set(url, cached.elapsedMs);
    } else {
      pendingProbeUrls.push(url);
    }
  }
  const probeResults = await Promise.all(pendingProbeUrls.map((url) => probeDownloadCandidate(url, headers)));
  for (const result of probeResults) {
    if (result.ok && Number.isFinite(result.elapsedMs)) {
      cachedScores.set(result.url, result.elapsedMs);
      downloadProbeCache.set(result.url, {
        elapsedMs: result.elapsedMs,
        expiresAt: now + DOWNLOAD_PROBE_CACHE_TTL_MS
      });
    }
  }
  const ranked = unique
    .map((url, index) => ({ url, index, elapsedMs: cachedScores.has(url) ? cachedScores.get(url) : Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => {
      if (a.elapsedMs === b.elapsedMs) {
        return a.index - b.index;
      }
      return a.elapsedMs - b.elapsedMs;
    })
    .map((item) => item.url);
  return ranked;
}

async function probeDownloadCandidate(url, headers = {}) {
  const startedAt = Date.now();
  try {
    const headResponse = await fetchWithTimeout(url, {
      method: "HEAD",
      headers
    }, DOWNLOAD_PROBE_TIMEOUT_MS);
    if (headResponse.ok) {
      return { url, ok: true, elapsedMs: Date.now() - startedAt };
    }
    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: {
        ...headers,
        Range: `bytes=0-${DOWNLOAD_PROBE_MAX_BYTES}`
      }
    }, DOWNLOAD_PROBE_TIMEOUT_MS);
    if (!response.ok) {
      return { url, ok: false, elapsedMs: Number.MAX_SAFE_INTEGER };
    }
    const reader = response.body ? response.body.getReader() : null;
    if (reader) {
      await reader.read().catch(() => ({ done: true }));
      await reader.cancel().catch(() => { });
    }
    return { url, ok: true, elapsedMs: Date.now() - startedAt };
  } catch {
    return { url, ok: false, elapsedMs: Number.MAX_SAFE_INTEGER };
  }
}

function buildGithubDownloadCandidates(url) {
  const normalized = String(url || "").trim();
  if (!normalized) {
    return [];
  }
  const lower = normalized.toLowerCase();
  const isGithubLike = lower.startsWith("https://github.com/")
    || lower.startsWith("http://github.com/")
    || lower.startsWith("https://api.github.com/")
    || lower.startsWith("http://api.github.com/")
    || lower.startsWith("https://raw.githubusercontent.com/")
    || lower.startsWith("http://raw.githubusercontent.com/")
    || lower.startsWith("https://codeload.github.com/")
    || lower.startsWith("http://codeload.github.com/");
  if (!isGithubLike) {
    return [normalized];
  }
  const unique = new Set([normalized]);
  for (const prefix of GITHUB_DOWNLOAD_PROXY_PREFIXES) {
    if (!prefix) {
      continue;
    }
    const next = prefix ? `${prefix}${normalized}` : normalized;
    unique.add(next);
  }
  return [...unique];
}

async function fetchGithubJsonWithFallback(url, headers = {}) {
  const candidateUrls = buildGithubDownloadCandidates(url);
  const orderedCandidateUrls = await sortDownloadCandidatesBySpeed(candidateUrls, headers);
  let lastError = "";
  for (const candidateUrl of orderedCandidateUrls) {
    for (let attempt = 1; attempt <= DOWNLOAD_REQUEST_RETRY_COUNT; attempt += 1) {
      try {
        const response = await fetchWithTimeout(candidateUrl, { headers });
        if (!response.ok) {
          lastError = `GitHub API ${response.status} ${response.statusText}`;
          continue;
        }
        const raw = await response.text();
        let data = null;
        try {
          data = JSON.parse(raw);
        } catch {
          lastError = "GitHub API 返回了非 JSON 数据";
          continue;
        }
        if (data && typeof data === "object" && !Array.isArray(data) && Number(data?.status) === 403 && String(data?.message || "").toLowerCase().includes("rate limit")) {
          lastError = "GitHub API 触发频率限制，请稍后重试";
          continue;
        }
        return data;
      } catch (error) {
        lastError = error?.message || String(error);
      }
    }
  }
  throw new Error(lastError || "GitHub API unavailable");
}

async function fetchWithTimeout(url, init = {}, timeoutMs = DOWNLOAD_REQUEST_TIMEOUT_MS) {
  const controller = new globalThis.AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function requestModelAnalysis(sender, filePath) {
  if (path.extname(String(filePath || "")).toLowerCase() === ".fbx") {
    const result = await analyzeFbxInWorker(filePath);
    if (result.error) {
      writeLog("WARN", "FBX model analysis failed", { filePath, message: result.error });
    }
    return { bounds: result.bounds, collision: result.collision, triangleCount: result.triangleCount,
      meshKind: result.meshKind, hasSkeleton: result.hasSkeleton, hasSkin: result.hasSkin,
      boneCount: result.boneCount, skinnedMeshCount: result.skinnedMeshCount };
  }
  return new Promise((resolve) => {
    const requestId = Math.random().toString(36).slice(2);
    const timeout = globalThis.setTimeout(() => {
      pendingBoundsRequests.delete(requestId);
      resolve({ bounds: null, collision: null, triangleCount: null });
    }, 15000);
    pendingBoundsRequests.set(requestId, { resolve, timeout });
    sender.send("assets:calculateBoundsRequest", { requestId, filePath });
  });
}

async function inferColorTagsSafely(textureFiles) {
  const candidates = Array.isArray(textureFiles) ? textureFiles.filter(Boolean) : [];
  if (candidates.length === 0) {
    return [];
  }
  return await new Promise((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve([]);
    }, COLOR_TAG_INFER_TIMEOUT_MS);
    inferColorTagsFromTextureFiles(candidates, { minColorTags: 1, maxColorTags: 4, maxCandidateImages: 4 })
      .then((result) => {
        if (settled) {
          return;
        }
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(Array.isArray(result) ? result : []);
      })
      .catch(() => {
        if (settled) {
          return;
        }
        settled = true;
        globalThis.clearTimeout(timer);
        resolve([]);
      });
  });
}

function markInternalLibraryMutation(durationMs = 20000) {
  const nextDuration = Math.max(1000, Number(durationMs) || 0);
  const nextUntil = Date.now() + nextDuration;
  suppressWatcherScanUntil = Math.max(suppressWatcherScanUntil, nextUntil);
}

function normalizeComparePath(value) {
  try {
    return path.resolve(String(value || "")).replace(/\\/g, "/").toLowerCase();
  } catch {
    return String(value || "").replace(/\\/g, "/").toLowerCase();
  }
}

function isUnderRoot(rootPath, candidatePath) {
  const root = normalizeComparePath(rootPath);
  const candidate = normalizeComparePath(candidatePath);
  if (!root || !candidate) {
    return false;
  }
  return candidate === root || candidate.startsWith(`${root}/`);
}

function getSettingsFilePath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function getDataFilePath(fileName) {
  return path.join(app.getPath("userData"), fileName);
}

async function loadLibraryJsonCache(cachePath = getLibraryJsonCachePath()) {
  const candidates = [cachePath]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));

  for (const candidate of candidates) {
    const stat = await statOrNull(candidate);
    if (!stat?.isFile()) {
      continue;
    }
    const loaded = await loadJson(candidate, null);
    const list = Array.isArray(loaded) ? loaded : Array.isArray(loaded?.assets) ? loaded.assets : null;
    if (!Array.isArray(list)) {
      continue;
    }
    if (list.length === 0) return [];
    const normalized = list
      .map((item) => (item && typeof item === "object" ? item : null))
      .filter(Boolean)
      .map((asset) => ({
        ...toAssetListRecord(asset),
        id: String(asset?.id || "").trim(),
        name: String(asset?.name || "").trim() || String(asset?.id || "").trim(),
        source: String(asset?.source || "").trim() || "custom",
        path: String(asset?.path || "").trim(),
        metaPath: String(asset?.metaPath || "").trim(),
        previewImage: String(asset?.previewImage || asset?.preview || "").trim() || null,
        detailImage: String(asset?.detailImage || "").trim() || null,
        favorite: false,
        assetType: String(asset?.assetType || "").trim(),
        hasCollision: typeof asset?.hasCollision === "boolean" ? asset.hasCollision : undefined,
        tags: Array.isArray(asset?.tags) ? asset.tags : [],
        zionTags: Array.isArray(asset?.zionTags) ? asset.zionTags : [],
        themes: Array.isArray(asset?.themes) ? asset.themes : [],
        colorTags: Array.isArray(asset?.colorTags) ? asset.colorTags : [],
        createdAt: asset?.createdAt || null,
        relativeSize: extractAssetRelativeSize(asset),
        textureAnalysisJson: asset.textureAnalysis && typeof asset.textureAnalysis === "object" ? JSON.stringify(asset.textureAnalysis) : null,
        meta: {
          ...toAssetListRecord(asset)?.meta,
          previews: (() => {
            const relativeSize = extractAssetRelativeSize(asset);
            return relativeSize ? { relativeSize } : {};
          })()
        }
      }))
      .filter((asset) => asset.id);
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return null;
}

async function saveLibraryJsonCache(nextIndex, cachePath = getLibraryJsonCachePath()) {
  const normalizedIndex = Array.isArray(nextIndex) ? nextIndex : [];
  await saveJson(cachePath, normalizedIndex.map(({ favorite, ...asset }) => asset));
}

function getLibraryRootPath() {
  const preferredRoot = String(settings.customLibraryPath || "").trim();
  if (!preferredRoot) {
    return "";
  }
  return path.resolve(preferredRoot);
}

function getThumbCacheDir() {
  return path.join(getPersistentCacheRoot(), "ThumbCache");
}

let sharedDerivedCache = null;
let sharedDerivedCacheRoot = "";
const previewThumbnailTasks = new Map();
const deletingCharacterCachePaths = new Set();
function getSharedDerivedCache() {
  const root = getLibraryRootPath();
  if (!sharedDerivedCache || sharedDerivedCacheRoot !== root) {
    sharedDerivedCache?.dispose();
    sharedDerivedCacheRoot = root;
    let lastWarmLog = 0;
    sharedDerivedCache = createSharedDerivedCache({
      libraryRoot: root, localRoot: getThumbCacheDir(),
      canWarm: () => !scanInProgress && !hasActiveBackgroundImport() && !recycleInProgress && activeExportCalls === 0,
      onWarmProgress: progress => {
        if (Date.now() - lastWarmLog < 60000 && (progress.queued || progress.active)) return;
        lastWarmLog = Date.now();
        writeLog("INFO", "shared thumbnail warmup", progress);
      },
      onFailure: error => writeLog("WARN", "optional derived cache unavailable; using local fallback", { message: error.message })
    });
  }
  return sharedDerivedCache;
}

app.on("will-quit", () => sharedDerivedCache?.dispose());

function getAnimationPreviewCacheDir() {
  return path.join(getPersistentCacheRoot(), "AnimationPreviews");
}

function sanitizeAnimationPreviewId(assetId) {
  return String(assetId || "").trim().replace(/[\\/:*?"<>|]+/g, "_") || "animation";
}

async function persistLocalAnimationPreview(assetId, sourcePath) {
  const resolved = path.resolve(String(sourcePath || "").trim());
  const stats = await statOrNull(resolved);
  if (!stats?.isFile()) {
    return "";
  }
  const destDir = getAnimationPreviewCacheDir();
  const dest = await compressPreviewImage(resolved, destDir, `${sanitizeAnimationPreviewId(assetId)}_preview`);
  return dest ? normalizePath(dest) : "";
}

async function cacheAnimationPreview(payload) {
  const assetId = String(payload?.assetId || "").trim();
  const modelPath = String(payload?.modelPath || "").trim();
  const key = String(payload?.key || "");
  const bytes = payload?.bytes;
  if (!assetId || !/\.fbx$/i.test(modelPath) || !/^[a-f0-9]{64}$/.test(key) || !(bytes instanceof ArrayBuffer)) return "";
  // The canvas records at most two seconds at 700 kbps.
  if (bytes.byteLength < 32 || bytes.byteLength > 2 * 1024 * 1024) return "";

  const generation = librarySelectionGeneration;
  const modelKey = normalizeComparePath(modelPath);
  const matches = asset => asset?.id === assetId && asset.source === "custom" && asset.assetType === "animation"
    && asset.metaPath && normalizeComparePath(asset.metaPath) === modelKey;
  if (!index.some(matches)) return "";
  const file = await getSharedDerivedCache().saveAnimationPreview(modelPath, key, Buffer.from(bytes));
  if (!file || generation !== librarySelectionGeneration || recycleInProgress || !index.some(matches)) return "";
  return normalizePath(file);
}

// 批量导入的会话工作区：解压产物（DroppedArchives）与拖拽物化文件（DroppedFiles）
// 放在本机持久目录 ImportSources 下。它们不是可重算缓存，不能被
// 缓存监控/手动清缓存删除；导入完成后由 clearDroppedArchiveDirs 主动清理。
function getImportSessionTempDirs() {
  const assetHiveRoot = path.join(os.tmpdir(), "AssetHive");
  const dirs = [
    getImportSourceRoot(),
    path.join(assetHiveRoot, "DroppedArchives"),
    path.join(assetHiveRoot, "DroppedFiles")
  ];
  if (resolvedPreviewUserDataPath) {
    dirs.push(path.resolve(resolvedPreviewUserDataPath));
  }
  return dirs.map((dir) => path.resolve(dir));
}

function isPathWithinAny(targetPath, dirs) {
  const lower = path.resolve(String(targetPath || "")).toLowerCase();
  for (const dir of dirs) {
    const dirLower = path.resolve(dir).toLowerCase();
    if (lower === dirLower || lower.startsWith(dirLower + path.sep)) {
      return true;
    }
  }
  return false;
}

async function removeDirectoryContentsExcept(dirPath, protectedDirs) {
  let entries = [];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (isPathWithinAny(fullPath, protectedDirs)) {
      continue;
    }
    await fs.rm(fullPath, { recursive: true, force: true });
  }
}

// 合成缓存池：贴图合成（pack/merge/gloss→rough）、转换（exr→png / resize / normalize）
// 与 HDRI 缩略图等可重算产物。随库规模与导出量增长，由自动监控按“最旧优先”LRU 淘汰
// 到水位以下，避免“满→整目录清空→重建”的抖动。
function getCompositedCacheTargets() {
  return [...new Set([
    path.join(os.tmpdir(), "assethive"),
    path.join(os.tmpdir(), "AssetHive", "Thumbs"),
    getThumbCacheDir(),
    getAnimationPreviewCacheDir()
  ].map((entry) => path.resolve(entry)))];
}

// 引擎缓存池：Chromium/Electron 自管理缓存（HTTP disk cache 已重定向到 temp 的
// chromium-cache、V8 code cache、GPU/WebGPU cache、网络/会话存储等）。体积基本恒定、
// 不随库增长，主动删除只会拖慢下次冷启动，因此不参与自动淘汰，仅在手动“清理缓存”时清除。
function getEngineCacheTargets() {
  const userData = app.getPath("userData");
  return [
    path.join(os.tmpdir(), "AssetHive", "chromium-cache"),
    path.join(userData, "Cache"),
    path.join(userData, "Code Cache"),
    path.join(userData, "GPUCache"),
    path.join(userData, "DawnGraphiteCache"),
    path.join(userData, "DawnWebGPUCache"),
    path.join(userData, "Network"),
    path.join(userData, "blob_storage"),
    path.join(userData, "Session Storage"),
    path.join(userData, "Shared Dictionary")
  ].map((entry) => path.resolve(entry));
}

// 手动“清理缓存”用的全量目标：合成池 + 引擎池。不再把 %TEMP%\AssetHive 整目录列入，
// 改为精确子目录，因此导入会话工作区（DroppedArchives/DroppedFiles）、7za 物化目录
// 与预览 userData 天然不会被误删。
function getRuntimeCacheTargets() {
  return [...new Set([
    ...getCompositedCacheTargets(),
    ...getEngineCacheTargets()
  ])];
}

/**
 * 递归收集目录下所有文件（路径、大小、mtime），跳过受保护目录。
 * 合成缓存池的 LRU 淘汰需要完整文件列表，才能按“最旧优先”删到水位。
 */
async function collectCacheFiles(targetPath, protectedDirs, files = []) {
  let entries = [];
  try {
    entries = await fs.readdir(targetPath, { withFileTypes: true });
  } catch {
    return files;
  }
  const subdirs = [];
  const fileBatches = [];
  let currentBatch = [];
  for (const entry of entries) {
    const fullPath = path.join(targetPath, entry.name);
    if (isPathWithinAny(fullPath, protectedDirs)) {
      continue;
    }
    if (entry.isDirectory()) {
      subdirs.push(fullPath);
    } else if (entry.isFile()) {
      currentBatch.push(fullPath);
      if (currentBatch.length >= 96) {
        fileBatches.push(currentBatch);
        currentBatch = [];
      }
    }
  }
  if (currentBatch.length > 0) fileBatches.push(currentBatch);
  for (const batch of fileBatches) {
    const stats = await Promise.all(
      batch.map(async (filePath) => {
        try {
          const st = await fs.stat(filePath);
          return { path: filePath, size: Number(st?.size) || 0, mtimeMs: Number(st?.mtimeMs) || 0 };
        } catch {
          return null;
        }
      })
    );
    for (const item of stats) if (item && item.size > 0) files.push(item);
  }
  for (const sub of subdirs) {
    await collectCacheFiles(sub, protectedDirs, files);
  }
  return files;
}

// 合成缓存池的自动淘汰：总大小超过上限时，按 mtime 从最旧开始删除文件，直到降到
// 上限的 COMPOSITED_CACHE_TARGET_RATIO（留余量，减少“刚删完又超限”的频繁触发）。
async function pruneCompositedCaches(reason) {
  const targets = getCompositedCacheTargets();
  const protectedDirs = getImportSessionTempDirs();
  const files = [];
  for (const targetPath of targets) {
    const stats = await statOrNull(targetPath);
    if (!stats?.isDirectory()) {
      continue;
    }
    await collectCacheFiles(targetPath, protectedDirs, files);
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes <= COMPOSITED_CACHE_MAX_BYTES) {
    return { reason, totalBytes, removedCount: 0 };
  }
  const targetBytes = Math.floor(COMPOSITED_CACHE_MAX_BYTES * COMPOSITED_CACHE_TARGET_RATIO);
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let bytes = totalBytes;
  let removedCount = 0;
  let failedCount = 0;
  for (const file of files) {
    if (bytes <= targetBytes) break;
    try {
      await fs.rm(file.path, { force: true });
      bytes -= file.size;
      removedCount += 1;
    } catch {
      failedCount += 1;
    }
  }
  writeLog("INFO", "composited caches pruned", {
    reason,
    totalBytes,
    removedCount,
    failedCount
  });
  return { reason, totalBytes, removedCount, failedCount };
}

async function clearRuntimeCaches(reason = "manual") {
  const targets = getRuntimeCacheTargets();
  const protectedDirs = getImportSessionTempDirs();
  const removed = [];
  const failed = [];
  for (const targetPath of targets) {
    try {
      if (isPathWithinAny(targetPath, protectedDirs)) {
        continue;
      }
      const stats = await statOrNull(targetPath);
      if (!stats?.isDirectory()) {
        continue;
      }
      await removeDirectoryContentsExcept(targetPath, protectedDirs);
      removed.push(targetPath);
    } catch (error) {
      failed.push({ path: targetPath, message: error?.message || String(error) });
    }
  }
  writeLog("INFO", "runtime caches cleared", {
    reason,
    removedCount: removed.length,
    failedCount: failed.length
  });
  return { removed, failed };
}

function startRuntimeCacheMonitor() {
  const checkAndPurge = async (reason) => {
    try {
      await pruneCompositedCaches(reason);
    } catch (error) {
      writeLog("WARN", "runtime cache monitor failed", { reason, message: error?.message || String(error) });
    }
  };
  void checkAndPurge("startup");
  if (runtimeCacheMonitorTimer) {
    globalThis.clearInterval(runtimeCacheMonitorTimer);
  }
  runtimeCacheMonitorTimer = globalThis.setInterval(() => {
    void checkAndPurge("size-limit");
  }, RUNTIME_CACHE_CHECK_INTERVAL_MS);
}

function getLibrarySqlCachePath() {
  // SQLite uses synchronous calls. Never place this database on a shared
  // library: a stalled SMB open can block the Electron main thread and leave
  // the app invisible and difficult to terminate. Scope the local cache to
  // the selected library so switching libraries cannot show stale records.
  const root = String(settings.customLibraryPath || "").trim();
  const token = root ? path.resolve(root).toLowerCase() : "no-library";
  const key = crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
  return path.join(getPersistentCacheRoot(), "LibraryCache", `${key}.sqlite`);
}

function getLibraryJsonCachePath() {
  return getLibrarySqlCachePath().replace(/\.sqlite$/, ".json");
}

function getScanClientId() {
  return `${os.hostname()}|${getPersistentCacheRoot()}|${getLibraryRootPath()}`;
}

function getFallbackLibrarySqlCachePath() {
  return path.join(app.getPath("userData"), LIBRARY_SQLITE_CACHE_FILE_NAME);
}

let libraryDb = null;
let libraryDbPath = "";

function ensureLibraryDbSchema(db) {
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(assets)")
      .all()
      .map((row) => String(row?.name || "").trim().toLowerCase())
      .filter(Boolean)
  );
  if (!columns.has("detailimage")) {
    db.exec("ALTER TABLE assets ADD COLUMN detailImage TEXT;");
  }
  if (!columns.has("lastseenscan")) {
    db.exec("ALTER TABLE assets ADD COLUMN lastSeenScan INTEGER;");
  }
  if (!columns.has("topcategory")) {
    db.exec("ALTER TABLE assets ADD COLUMN topCategory TEXT;");
  }
  if (!columns.has("subtype")) {
    db.exec("ALTER TABLE assets ADD COLUMN subType TEXT;");
  }
  if (!columns.has("relativesize")) {
    db.exec("ALTER TABLE assets ADD COLUMN relativeSize TEXT;");
  }
  if (!columns.has("textureanalysisjson")) {
    db.exec("ALTER TABLE assets ADD COLUMN textureAnalysisJson TEXT;");
  }
  if (!columns.has("hascollision")) {
    db.exec("ALTER TABLE assets ADD COLUMN hasCollision INTEGER;");
  }
  if (!columns.has("ziontagsjson")) {
    db.exec("ALTER TABLE assets ADD COLUMN zionTagsJson TEXT;");
  }
  if (!columns.has("zionexportsubfolder")) {
    db.exec("ALTER TABLE assets ADD COLUMN zionExportSubfolder TEXT;");
  }
  if (!columns.has("listrecordjson")) {
    db.exec("ALTER TABLE assets ADD COLUMN listRecordJson TEXT;");
  }
}

// Windows 上 node:sqlite 会持有缓存文件句柄，不先关掉既删不掉旧缓存，
// 也不能保证下一次读取到的是重扫结果。
function closeLibraryDb() {
  if (!libraryDb) {
    libraryDbPath = "";
    return;
  }
  try {
    libraryDb.close();
  } catch {
  }
  libraryDb = null;
  libraryDbPath = "";
}

function getLibraryDb() {
  if (!DatabaseSync) {
    throw new Error("node:sqlite is not available in this runtime");
  }
  const preferredPath = getLibrarySqlCachePath();
  const candidates = [preferredPath]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));
  if (candidates.length === 0) {
    return null;
  }
  const sameAsCurrent = libraryDb && libraryDbPath
    ? candidates.some((candidate) => path.resolve(libraryDbPath).toLowerCase() === candidate.toLowerCase())
    : false;
  if (sameAsCurrent) {
    return libraryDb;
  }
  closeLibraryDb();

  const openDbAt = (resolvedPath) => {
    fsSync.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    const db = new DatabaseSync(resolvedPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA temp_store = MEMORY;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        name TEXT,
        source TEXT,
        path TEXT,
        metaPath TEXT,
        previewImage TEXT,
        detailImage TEXT,
        assetType TEXT,
        topCategory TEXT,
        subType TEXT,
        tagsJson TEXT,
        zionTagsJson TEXT,
        themesJson TEXT,
        colorTagsJson TEXT,
        createdAt TEXT,
        favorite INTEGER DEFAULT 0,
        lastSeenScan INTEGER DEFAULT 0,
        textureAnalysisJson TEXT,
        hasCollision INTEGER,
        zionExportSubfolder TEXT,
        listRecordJson TEXT
      );
    `);
    ensureLibraryDbSchema(db);
    db.exec("CREATE INDEX IF NOT EXISTS idx_assets_source ON assets(source);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_assets_path ON assets(path);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_assets_topCategory ON assets(topCategory);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_assets_lastSeenScan ON assets(lastSeenScan);");
    return db;
  };

  for (const candidate of candidates) {
    try {
      const db = openDbAt(candidate);
      libraryDb = db;
      libraryDbPath = candidate;
      return libraryDb;
    } catch (error) {
      writeLog("WARN", "open library sqlite cache failed", { path: candidate, message: error?.message || String(error) });
    }
  }
  return null;
}

async function resolvePreviewThumbnailPath(rawSourcePath) {
  const sourcePath = String(rawSourcePath || "").trim();
  if (!sourcePath) return "";
  return getSharedDerivedCache().thumbnail(sourcePath);
}

async function loadFavoriteIds() {
  return new Set((await getUserFavorites().load(getLibraryRootPath())).map(entry => entry.id).filter(Boolean));
}

async function loadFavoriteMetaTokens() {
  return new Set((await getUserFavorites().load(getLibraryRootPath()))
    .map(entry => entry.metaPath ? normalizeComparePath(entry.metaPath) : "").filter(Boolean));
}

async function applyUserFavorites(assets) {
  applyFavoriteIds(assets, await loadFavoriteIds(), await loadFavoriteMetaTokens());
}

function applyFavoriteIds(nextIndex, favoriteIds, favoriteMetaTokens) {
  const idSet = favoriteIds instanceof Set ? favoriteIds : new Set();
  const metaSet = favoriteMetaTokens instanceof Set ? favoriteMetaTokens : new Set();
  for (const asset of Array.isArray(nextIndex) ? nextIndex : []) {
    if (!asset || typeof asset !== "object") {
      continue;
    }
    const id = String(asset.id || "").trim();
    const metaToken = normalizeComparePath(String(asset.metaPath || "").trim());
    asset.favorite = Boolean((id && idSet.has(id)) || (metaToken && metaSet.has(metaToken)));
  }
}

function extractAssetRelativeSize(asset) {
  if (!asset || typeof asset !== "object") {
    return "";
  }
  const meta = asset.meta && typeof asset.meta === "object" ? asset.meta : null;
  const previews = meta?.previews && typeof meta.previews === "object" ? meta.previews : null;
  const relativeSize = previews ? String(previews.relativeSize || "").trim() : "";
  if (relativeSize) {
    return relativeSize;
  }
  const raw = String(asset.relativeSize || "").trim();
  return raw || "";
}

function toSqlCacheAssetRow(asset, options = {}) {
  if (!asset || typeof asset !== "object") {
    return null;
  }
  const id = String(asset.id || "").trim();
  if (!id) {
    return null;
  }
  const lastSeenScan = Number(options?.lastSeenScan) || 0;
  return {
    id,
    name: String(asset.name || "").trim() || id,
    source: String(asset.source || "").trim() || "custom",
    path: String(asset.path || "").trim() || "",
    metaPath: String(asset.metaPath || "").trim() || "",
    previewImage: String(asset.previewImage || asset.preview || "").trim() || null,
    detailImage: String(asset.detailImage || "").trim() || null,
    assetType: String(asset.assetType || "").trim() || "",
    topCategory: String(asset.topCategory || "").trim() || "",
    subType: String(asset.subType || "").trim() || "",
    tagsJson: JSON.stringify(Array.isArray(asset.tags) ? asset.tags : []),
    zionTagsJson: JSON.stringify(Array.isArray(asset.zionTags) ? asset.zionTags : []),
    themesJson: JSON.stringify(Array.isArray(asset.themes) ? asset.themes : []),
    colorTagsJson: JSON.stringify(Array.isArray(asset.colorTags) ? asset.colorTags : []),
    createdAt: asset.createdAt || null,
    favorite: 0, // Compatibility column; personal state never enters the shared cache.
    lastSeenScan,
    relativeSize: extractAssetRelativeSize(asset),
    textureAnalysisJson: asset.textureAnalysis && typeof asset.textureAnalysis === "object" ? JSON.stringify(asset.textureAnalysis) : null,
    hasCollision: typeof asset.hasCollision === "boolean" ? (asset.hasCollision ? 1 : 0) : null,
    // Zion 资产导出目标二级目录：由导出面板的按钮弹层写入资产元数据，
    // 这里缓存进库，避免每次导出都要重读 asset_info.json。
    zionExportSubfolder: String(asset.zionExportSubfolder || "").trim() || null,
    // Preserve every field used by search, categories and filters at startup.
    // The projection excludes editing inventories and export counters.
    listRecordJson: JSON.stringify(toAssetListRecord({ ...asset, favorite: false }))
  };
}

async function saveLibrarySqlCache(nextIndex, options = {}) {
  const db = getLibraryDb();
  if (!db) {
    return;
  }
  ensureLibraryDbSchema(db);
  const scanToken = Number(options?.scanToken) || Date.now();
  const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;
  const rows = (Array.isArray(nextIndex) ? nextIndex : [])
    .map((asset) => toSqlCacheAssetRow(asset, { lastSeenScan: scanToken }))
    .filter(Boolean);
  try {
    db.exec("BEGIN;");
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO assets (
        id, name, source, path, metaPath, previewImage, detailImage, assetType,
        topCategory, subType,
        tagsJson, zionTagsJson, themesJson, colorTagsJson, createdAt, favorite, lastSeenScan, relativeSize, textureAnalysisJson, hasCollision,
        zionExportSubfolder, listRecordJson
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?
      );
    `);
    const total = rows.length;
    const batchSize = Math.max(100, Math.min(2000, Number(options?.batchSize) || 800));
    let processed = 0;
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize);
      for (const item of batch) {
        stmt.run(
          item.id,
          item.name,
          item.source,
          item.path,
          item.metaPath,
          item.previewImage,
          item.detailImage,
          item.assetType,
          item.topCategory,
          item.subType,
          item.tagsJson,
          item.zionTagsJson,
          item.themesJson,
          item.colorTagsJson,
          item.createdAt,
          item.favorite,
          item.lastSeenScan,
          item.relativeSize,
          item.textureAnalysisJson,
          item.hasCollision,
          item.zionExportSubfolder,
          item.listRecordJson
        );
      }
      processed += batch.length;
      if (onProgress && total > 0) {
        onProgress(processed / total);
      }
    }
    db.prepare("DELETE FROM assets WHERE lastSeenScan <> ?;").run(scanToken);
    db.exec("COMMIT;");
    writeLog("INFO", "library sql cache saved", {
      path: getLibrarySqlCachePath(),
      count: rows.length
    });
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
    }
    throw error;
  }
}

async function applyLibrarySqlCacheChanges(payload = {}) {
  const changeRoot = getLibraryRootPath();
  const changedPaths = [...(payload.changedDirectories || []),
    ...(payload.upsertAssets || []).map(asset => asset?.path).filter(Boolean)];
  if (changeRoot && changedPaths.length) {
    await recordLibraryChanges(changeRoot, changedPaths).catch(error => {
      writeLog("WARN", "library change journal write failed", { message: error.message });
    });
  }
  if (changeRoot !== getLibraryRootPath()) return;
  const db = getLibraryDb();
  if (!db) {
    return;
  }
  ensureLibraryDbSchema(db);
  const upsertAssets = Array.isArray(payload?.upsertAssets) ? payload.upsertAssets : [];
  await applyUserFavorites(upsertAssets);
  const deleteIds = Array.isArray(payload?.deleteIds) ? payload.deleteIds : [];

  const upsertRows = upsertAssets
    .map((asset) => toSqlCacheAssetRow(asset, { lastSeenScan: Date.now() }))
    .filter(Boolean);
  const normalizedDeleteIds = deleteIds
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  if (upsertRows.length === 0 && normalizedDeleteIds.length === 0) {
    return;
  }

  try {
    db.exec("BEGIN;");
    if (normalizedDeleteIds.length > 0) {
      const stmt = db.prepare("DELETE FROM assets WHERE id = ?;");
      for (const id of normalizedDeleteIds) {
        stmt.run(id);
      }
    }
    if (upsertRows.length > 0) {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO assets (
          id, name, source, path, metaPath, previewImage, detailImage, assetType,
          topCategory, subType,
          tagsJson, zionTagsJson, themesJson, colorTagsJson, createdAt, favorite, lastSeenScan, relativeSize, textureAnalysisJson, hasCollision,
          zionExportSubfolder, listRecordJson
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?
        );
      `);
      for (const item of upsertRows) {
        stmt.run(
          item.id,
          item.name,
          item.source,
          item.path,
          item.metaPath,
          item.previewImage,
          item.detailImage,
          item.assetType,
          item.topCategory,
          item.subType,
          item.tagsJson,
          item.zionTagsJson,
          item.themesJson,
          item.colorTagsJson,
          item.createdAt,
          item.favorite,
          item.lastSeenScan,
          item.relativeSize,
          item.textureAnalysisJson,
          item.hasCollision,
          item.zionExportSubfolder,
          item.listRecordJson
        );
      }
    }
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      void 0;
    }
    writeLog("WARN", "library sql cache incremental update failed", { message: error?.message || String(error) });
  }
}

async function loadLocalScanMemoRecords(cachePath) {
  const reader = createCacheProcess({ timeoutMs: 5000 });
  try {
    return await reader.run("readScanMemoRecords", {
      memoPath: cachePath.replace(/\.sqlite$/, ".memo.json.gz"), root: getLibraryRootPath()
    });
  } finally { reader.dispose(); }
}

async function loadLibrarySqlCache(cachePath = getLibrarySqlCachePath()) {
  const safeJson = (value, fallback) => {
    try {
      const parsed = JSON.parse(String(value || ""));
      return Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  };
  const safeJsonObject = (value) => {
    try {
      const parsed = JSON.parse(String(value || ""));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  const readFromPath = (resolvedPath) => {
    const startedAt = Date.now();
    writeLog("INFO", "library sqlite cache read started", { path: resolvedPath });
    let db;
    try {
      db = new DatabaseSync(resolvedPath);
      ensureLibraryDbSchema(db);
      const rows = db.prepare("SELECT id, name, source, path, metaPath, previewImage, detailImage, assetType, topCategory, subType, tagsJson, zionTagsJson, themesJson, colorTagsJson, createdAt, favorite, relativeSize, textureAnalysisJson, hasCollision, zionExportSubfolder, listRecordJson FROM assets").all();
      writeLog("INFO", "library sqlite cache read finished", { path: resolvedPath, count: rows.length, durationMs: Date.now() - startedAt });
      return rows;
    } catch (error) {
      writeLog("WARN", "library sqlite cache read failed", { path: resolvedPath, message: error?.message || String(error), durationMs: Date.now() - startedAt });
      return null;
    } finally {
      try { db?.close(); } catch { /* A failed open may not have a handle. */ }
    }
  };
  // Probe the local cache asynchronously before a synchronous SQLite open,
  // so a missing first-run cache does not create an empty database.
  const readFromPathSafely = async (resolvedPath) => {
    const stats = await statOrNull(resolvedPath);
    if (!stats || !stats.isFile() || Number(stats.size) <= 0) {
      return null;
    }
    return readFromPath(resolvedPath);
  };
  const preferredPath = cachePath;
  const candidates = [preferredPath]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));
  let mergedRows = null;
  for (const candidate of candidates) {
    const rows = await readFromPathSafely(candidate);
    if (rows !== null) {
      mergedRows = rows;
      break;
    }
  }
  if (mergedRows === null) return null;
  const records = new Map(mergedRows.map(row => {
    const stored = safeJsonObject(row.listRecordJson);
    return [row.id, stored?.id === row.id ? toAssetListRecord(stored) : null];
  }));
  if (mergedRows.some(row => !records.get(row.id))) {
    const legacy = await loadLocalScanMemoRecords(cachePath);
    const rows = new Map(mergedRows.map(row => [row.id, row]));
    let restored = 0;
    for (const record of legacy || []) {
      const row = rows.get(record.id);
      if (row && !records.get(record.id) && row.metaPath && record.metaPath
        && path.resolve(row.metaPath).toLowerCase() === path.resolve(record.metaPath).toLowerCase()) {
        records.set(record.id, record); restored++;
      }
    }
    if (restored) writeLog("INFO", "legacy cache fields restored from local scan memo", { count: restored });
  }
  return mergedRows
    .map((row) => {
      const record = records.get(row.id);
      return {
        ...record,
        id: String(row?.id || "").trim(),
        name: String(row?.name || "").trim() || String(row?.id || "").trim(),
        source: String(row?.source || "").trim() || "custom",
        path: String(row?.path || "").trim(),
        metaPath: String(row?.metaPath || "").trim(),
        previewImage: String(row?.previewImage || "").trim() || null,
        detailImage: String(row?.detailImage || "").trim() || null,
        favorite: false,
        assetType: String(row?.assetType || "").trim(),
        hasCollision: row?.hasCollision == null ? undefined : Boolean(row.hasCollision),
        topCategory: String(row?.topCategory || "").trim(),
        subType: String(row?.subType || "").trim(),
        tags: safeJson(row?.tagsJson, []),
        zionTags: safeJson(row?.zionTagsJson, []),
        // 空串是有效取值：表示用户明确清空了该资产的二级目录，导出时不得回退到
        // 应用设置里的上次输入；只有 null（从未设置）才映射为 undefined 以允许回退。
        zionExportSubfolder: row?.zionExportSubfolder == null
          ? undefined
          : String(row.zionExportSubfolder).trim(),
        themes: safeJson(row?.themesJson, []),
        colorTags: safeJson(row?.colorTagsJson, []),
        createdAt: row?.createdAt || null,
        relativeSize: String(row?.relativeSize || "").trim(),
        textureAnalysis: safeJsonObject(row?.textureAnalysisJson),
        meta: {
          ...record?.meta,
          previews: (() => {
            const relativeSize = String(row?.relativeSize || "").trim();
            return relativeSize ? { relativeSize } : {};
          })()
        }
      };
    })
    .filter((asset) => asset.id);
}

async function backfillMissingRelativeSize(list) {
  const items = Array.isArray(list) ? list : [];
  const pending = items.filter((asset) => {
    if (!asset || typeof asset !== "object") {
      return false;
    }
    if (hasPreviewSize(extractAssetRelativeSize(asset))) {
      return false;
    }
    return Boolean(asset.metaPath || asset.previewImage || asset.preview);
  });
  if (pending.length === 0) {
    return 0;
  }
  const CONCURRENCY = 16;
  let backfilled = 0;
  const applyRelativeSize = (asset, relativeSize) => {
    if (!(asset.meta && typeof asset.meta === "object")) {
      asset.meta = {};
    }
    if (!(asset.meta.previews && typeof asset.meta.previews === "object")) {
      asset.meta.previews = {};
    }
    asset.meta.previews.relativeSize = relativeSize;
    asset.relativeSize = relativeSize;
  };
  for (let offset = 0; offset < pending.length; offset += CONCURRENCY) {
    const batch = pending.slice(offset, offset + CONCURRENCY);
    const results = await Promise.all(batch.map(async (asset) => {
      const meta = await loadJson(String(asset.metaPath || ""), null);
      const relativeSize = meta && typeof meta === "object" ? String(meta?.previews?.relativeSize || "").trim() : "";
      if (hasPreviewSize(relativeSize)) applyRelativeSize(asset, relativeSize);
      await populatePreviewSize(asset);
      return { asset, relativeSize: extractAssetRelativeSize(asset) };
    }));
    for (const result of results) {
      if (!hasPreviewSize(result.relativeSize)) {
        continue;
      }
      applyRelativeSize(result.asset, result.relativeSize);
      backfilled += 1;
    }
  }
  if (backfilled > 0) {
    writeLog("INFO", "backfilled missing preview dimensions", { count: backfilled, total: pending.length });
    scheduleIndexSnapshotSave("backfill_relative_size");
  }
  return backfilled;
}

async function loadJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function saveJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

async function saveIndexSnapshot(nextIndex, options = {}) {
  const snapshotRoot = getLibraryRootPath();
  const snapshotGeneration = librarySelectionGeneration;
  const jsonPath = getLibraryJsonCachePath();
  const normalizedIndex = Array.isArray(nextIndex) ? nextIndex : [];
  await applyUserFavorites(normalizedIndex);
  if (snapshotGeneration !== librarySelectionGeneration || snapshotRoot !== getLibraryRootPath()) return false;
  let sqliteSaved = false;
  let jsonSaved = false;
  if (DatabaseSync) {
    sqliteSaved = await saveLibrarySqlCache(normalizedIndex, options)
      .then(() => true)
      .catch((error) => {
        writeLog("WARN", "library sql cache save failed", { message: error?.message || String(error) });
        return false;
      });
  }
  if (snapshotGeneration !== librarySelectionGeneration || snapshotRoot !== getLibraryRootPath()) return false;
  if (sqliteSaved) {
    // A JSON fallback from an earlier failed SQLite write must not resurrect
    // assets after a newer SQLite snapshot becomes empty.
    await fs.rm(jsonPath, { force: true }).catch(() => {});
  } else {
    jsonSaved = await saveLibraryJsonCache(normalizedIndex, jsonPath).then(() => true).catch((error) => {
      writeLog("WARN", "library json cache save failed", { message: error?.message || String(error) });
      return false;
    });
  }
  writeLog("INFO", "library sql cache snapshot saved", {
    count: normalizedIndex.length
  });
  if (options.publishShared && snapshotGeneration === librarySelectionGeneration
    && snapshotRoot === getLibraryRootPath() && (sqliteSaved || jsonSaved)) {
    // Only complete scans publish. Never wait for SMB during a local save, and
    // never publish personal state or machine-local animation previews.
    sharedSnapshotVersion++;
    publishSharedIndexSnapshot(normalizedIndex);
  }
  return sqliteSaved || jsonSaved;
}

// An optional NAS publication must never trigger another full local SQLite write.
// Keep one publication in flight and back off when the shared cache cannot accept it.
function publishSharedIndexSnapshot(assets = index) {
  if (sharedPublishedVersion === sharedSnapshotVersion || sharedPublishInFlight || Date.now() < sharedPublishRetryAt) return;
  const root = getLibraryRootPath(), generation = librarySelectionGeneration, version = sharedSnapshotVersion;
  sharedPublishInFlight = true;
  void Promise.resolve().then(() => getSharedDerivedCache().publishSnapshot(assets.map(toAssetListRecord)))
    .then(published => {
      if (generation === librarySelectionGeneration && root === getLibraryRootPath()) {
        if (published) sharedPublishedVersion = version;
        else sharedPublishRetryAt = Date.now() + 60000;
      }
    }).catch(error => {
      sharedPublishRetryAt = Date.now() + 60000;
      writeLog('WARN', 'shared snapshot publication deferred', { message: error.message });
    }).finally(() => { sharedPublishInFlight = false; });
}

function scheduleIndexSnapshotSave(reason = "") {
  sharedSnapshotVersion++;
  if (pendingIndexSaveTimer) {
    globalThis.clearTimeout(pendingIndexSaveTimer);
  }
  pendingIndexSaveTimer = globalThis.setTimeout(async () => {
    pendingIndexSaveTimer = 0;
    await saveIndexSnapshot(index, { publishShared: sharedIndexComplete && !scanInProgress }).catch((error) => {
      writeLog("WARN", "library cache snapshot save failed", { reason, message: error?.message || String(error) });
    });
  }, 2500);
}

async function resolveProjectFilePath(targetProjectPath) {
  const normalizedProject = String(targetProjectPath || "").trim();
  if (!normalizedProject) {
    return "";
  }
  const resolvedPath = path.resolve(normalizedProject);
  const projectStat = await statOrNull(resolvedPath);
  if (projectStat?.isFile() && path.extname(resolvedPath).toLowerCase() === ".uproject") {
    return resolvedPath;
  }
  if (!projectStat?.isDirectory()) {
    return "";
  }
  try {
    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const projectEntry = entries.find((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".uproject");
    return projectEntry ? path.join(resolvedPath, projectEntry.name) : "";
  } catch {
    return "";
  }
}

async function resolveLiveEditorProjectPath() {
  const info = await tcpClient.getEditorInfo();
  return info?.projectPath || "";
}

async function hasProjectAssetHivePlugin(targetProjectPath) {
  const resolvedProjectFile = await resolveProjectFilePath(targetProjectPath);
  if (!resolvedProjectFile) {
    return false;
  }
  const projectDir = path.dirname(resolvedProjectFile);
  const pluginDescriptor = path.join(projectDir, "Plugins", "AssetHive", "AssetHive.uplugin");
  const pluginStat = await statOrNull(pluginDescriptor);
  return Boolean(pluginStat?.isFile());
}

async function isProjectAssetHiveEnabled(targetProjectPath) {
  const resolvedProjectFile = await resolveProjectFilePath(targetProjectPath);
  if (!resolvedProjectFile) {
    return false;
  }
  const projectJson = await loadJson(resolvedProjectFile, null);
  if (!projectJson || typeof projectJson !== "object") {
    return true;
  }
  if (!Array.isArray(projectJson.Plugins)) {
    return true;
  }
  const pluginEntry = projectJson.Plugins.find((plugin) => {
    if (!plugin || typeof plugin !== "object") {
      return false;
    }
    const pluginName = String(plugin.Name || "").trim().toLowerCase();
    return pluginName === "assethive";
  });
  if (!pluginEntry) {
    return true;
  }
  return pluginEntry.Enabled !== false;
}

async function ensureProjectAssetHiveEnabled(targetProjectPath) {
  const resolvedProjectFile = await resolveProjectFilePath(targetProjectPath);
  if (!resolvedProjectFile) {
    return false;
  }
  const projectJson = await loadJson(resolvedProjectFile, {});
  const nextProjectJson = projectJson && typeof projectJson === "object" && !Array.isArray(projectJson) ? projectJson : {};
  const plugins = Array.isArray(nextProjectJson.Plugins) ? nextProjectJson.Plugins : [];
  const nextPlugins = [...plugins];
  const existingIndex = nextPlugins.findIndex((plugin) => {
    if (!plugin || typeof plugin !== "object") {
      return false;
    }
    return String(plugin.Name || "").trim().toLowerCase() === "assethive";
  });
  if (existingIndex >= 0) {
    nextPlugins[existingIndex] = { ...nextPlugins[existingIndex], Name: "AssetHive", Enabled: true };
  } else {
    nextPlugins.push({ Name: "AssetHive", Enabled: true });
  }
  nextProjectJson.Plugins = nextPlugins;
  await saveJson(resolvedProjectFile, nextProjectJson);
  return true;
}

async function hasEngineAssetHivePlugin(editorPath) {
  if (!editorPath) return false;
  // editorPath: .../Engine/Binaries/Win64/UnrealEditor.exe
  const engineRoot = path.resolve(path.dirname(editorPath), "..", "..", "..");
  const candidates = [
    path.join(engineRoot, "Engine", "Plugins", "AssetHive", "AssetHive.uplugin"),
    path.join(engineRoot, "Engine", "Plugins", "Marketplace", "AssetHive", "AssetHive.uplugin"),
    path.join(engineRoot, "Engine", "Plugins", "Runtime", "AssetHive", "AssetHive.uplugin"),
    path.join(engineRoot, "Plugins", "AssetHive", "AssetHive.uplugin"),
  ];
  for (const candidate of candidates) {
    const pluginStat = await statOrNull(candidate);
    if (pluginStat?.isFile()) return true;
  }
  return false;
}

async function getUnrealConnectionStatus(targetProjectPath, targetEditorPath) {
  const target = await resolveProjectFilePath(targetProjectPath);
  const selection = { projectPath: target || targetProjectPath, editorPath: targetEditorPath };
  const info = await tcpClient.getEditorInfo(2500, selection);
  const diagnostic = tcpClient.getDiagnostics(selection);
  const displayPath = info?.projectPath || target || targetEditorPath || "";
  const reasons = {
    "target-mismatch": `已连接其他 Unreal 项目：${diagnostic.projectPath}；请打开设置中选择的目标项目`,
    incompatible: "AssetHive 插件协议不兼容，请更新插件并重启 Unreal",
    handshaking: "正在等待 Unreal 插件握手，编辑器可能正在加载项目",
    "handshake-timeout": "Unreal 插件握手超时，请检查编辑器是否仍在加载或被其他 AssetHive 实例连接",
    "editor-busy": "此 UE 已被另一个 AssetHive 连接，请关闭另一个正式版或测试版后重试",
    "heartbeat-timeout": "Unreal 插件响应超时，正在自动重连",
    unavailable: "未发现目标插件服务（127.0.0.1:13430–13439），请确认目标项目已打开且 AssetHive 插件已启用"
  };
  return { connected: Boolean(info), targetName: displayPath ? path.basename(displayPath, path.extname(displayPath)) : "",
    reason: diagnostic.state, message: info ? "" : reasons[diagnostic.state] || reasons.unavailable, port: diagnostic.port };
}

function normalizePath(filePath) {
  return String(filePath || "").replaceAll("\\", "/");
}

function isAnimationAssetType(assetType) {
  return sanitizeToken(assetType) === "animation";
}

function isModelAssetType(assetType) {
  return assetType === "3d" || assetType === "3dplant" || isAnimationAssetType(assetType) || isCharacterAssetType(assetType);
}

function normalizeCollisionRuleValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function isCollisionCheckRequired(assetType, standardAssetTags = [], category = "") {
  const normalizedAssetType = String(assetType || "").trim().toLowerCase();
  if (normalizedAssetType === "3d") {
    return true;
  }
  if (normalizedAssetType !== "3dplant") {
    return false;
  }

  const candidates = [
    category,
    ...(Array.isArray(standardAssetTags) ? standardAssetTags : [])
  ].map(normalizeCollisionRuleValue);
  return candidates.some((value) => value === "tree" || value === "trees" || value === "herofoliage" || value === "herofoliages");
}

function sanitizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function convertChineseToPinyin(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (!/[\u4e00-\u9fff]/.test(raw)) {
    return raw;
  }
  if (!pinyinLib) {
    return raw;
  }
  try {
    const result = pinyinLib(raw, { style: pinyinLib.STYLE_NORMAL, segment: true });
    const tokens = (Array.isArray(result) ? result : [])
      .flat()
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    const joined = tokens.join(" ").replace(/\s+/g, " ").trim();
    if (!joined) {
      return raw;
    }
    return joined
      .split(" ")
      .filter(Boolean)
      .map((word) => (word ? `${word[0].toUpperCase()}${word.slice(1)}` : ""))
      .join(" ");
  } catch {
    return raw;
  }
}

function getMainWindowBySender(sender) {
  // sender 可能不可用（后台任务、窗口已销毁或非 IPC 调用方），此时退回主窗口而不是抛异常。
  if (!sender || typeof sender.isDestroyed !== "function" || sender.isDestroyed()) {
    return BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed()) || null;
  }
  try {
    return BrowserWindow.fromWebContents(sender) || BrowserWindow.getAllWindows()[0] || null;
  } catch {
    return BrowserWindow.getAllWindows()[0] || null;
  }
}

// 清理上次保存失败留下的临时文件。这里会遍历整个资产库，网络共享库上单线程
// 逐目录 stat 会非常慢，所以改成有限并发，并把进度回报给界面。
async function cleanupFailedSaveArtifacts(customLibraryPath, options = {}) {
  const root = String(customLibraryPath || "").trim();
  if (!root) {
    return 0;
  }
  const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;
  const resolvedRoot = path.resolve(root);
  const rootStat = await statOrNull(resolvedRoot);
  if (!rootStat?.isDirectory()) {
    return 0;
  }
  const tempFilePattern = /^__assethive_tmp_(model|texture)_/i;
  // 2 万资产的库启动时要遍历两万多个目录；8 路并发在共享盘上仍是串行等待，
  // 提到 16 路能把这段巡检的时间大致减半。
  const concurrency = 16;
  let removedCount = 0;
  let visitedDirs = 0;
  const readDir = async (currentDir) => {
    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return { subDirs: [] };
    }
    const subDirs = [];
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        subDirs.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!tempFilePattern.test(entry.name)) {
        continue;
      }
      try {
        await fs.rm(entryPath, { force: true });
        removedCount += 1;
      } catch {
        // 文件被占用时留给下次扫描处理。
      }
    }
    return { subDirs };
  };
  const frontier = [resolvedRoot];
  let cursor = 0;
  let lastReportAt = 0;
  while (cursor < frontier.length) {
    const batch = [];
    while (cursor < frontier.length && batch.length < concurrency * 4) {
      batch.push(frontier[cursor]);
      cursor += 1;
    }
    const scanned = await Promise.all(batch.map(readDir));
    for (const item of scanned) {
      for (const subDir of item.subDirs) {
        frontier.push(subDir);
      }
    }
    visitedDirs += batch.length;
    const now = Date.now();
    if (onProgress && (now - lastReportAt >= 400 || cursor >= frontier.length)) {
      lastReportAt = now;
      onProgress({ visitedDirs, removedCount });
    }
  }
  return removedCount;
}

// 记录每个渲染进程最近一次上报进度的资产，导入失败时用它通知界面清理进度环。
const customSaveProgressOwner = new Map();

function emitCustomSaveProgress(sender, assetId, progress, message = "") {
  const win = getMainWindowBySender(sender);
  if (!win || !assetId) {
    return;
  }
  const senderId = win.webContents.id;
  if (progress >= 100) {
    customSaveProgressOwner.delete(senderId);
  } else {
    customSaveProgressOwner.set(senderId, assetId);
  }
  win.webContents.send("assets:customSaveProgress", { assetId, progress, message });
}

function emitCustomSaveFailure(sender, message = "") {
  const win = getMainWindowBySender(sender);
  if (!win) {
    return;
  }
  const senderId = win.webContents.id;
  const assetId = customSaveProgressOwner.get(senderId) || "";
  customSaveProgressOwner.delete(senderId);
  if (!assetId) {
    return;
  }
  win.webContents.send("assets:customSaveProgress", { assetId, progress: 0, failed: true, message });
}

async function decodeHdrOrExrToPng(sourcePath, outputPath, options = {}) {
  await protectFile(outputPath);
  return runImageTask("hdrPreview", [sourcePath, outputPath, options]);
}

async function compressPreviewImage(sourcePath, destinationDir, baseName, options = {}) {
  const resolved = path.resolve(sourcePath);
  const stats = await statOrNull(resolved);
  if (!stats?.isFile()) {
    return null;
  }
  const destination = String(destinationDir || "");
  if (/(^|[\\/])animation([\\/]|$)/i.test(destination) && /(^|[\\/])previews?$/i.test(destination)) {
    return null;
  }
  await fs.mkdir(destinationDir, { recursive: true });
  const sourceExt = path.extname(resolved).toLowerCase();
  if (sourceExt === ".webm" || sourceExt === ".mp4" || sourceExt === ".gif") {
    const outputPath = path.join(destinationDir, `${baseName}${sourceExt}`);
    await fs.copyFile(resolved, outputPath);
    const copied = await statOrNull(outputPath);
    return copied?.isFile() ? outputPath : null;
  }
  if (sourceExt === ".hdr" || sourceExt === ".exr") {
    try {
      return await decodeHdrOrExrToPng(resolved, path.join(destinationDir, `${baseName}.png`), options);
    } catch (error) {
      writeLog("WARN", "HDRI preview decode failed", { sourcePath: resolved, message: error?.message || String(error) });
      return null;
    }
  }
  let decodeError = null;
  if (sharp) {
    try {
      const maxWidth = Math.max(64, Number(options?.maxWidth) || 1024);
      const maxHeight = Math.max(64, Number(options?.maxHeight) || 1024);
      const jpegQuality = Math.max(40, Math.min(95, Number(options?.jpegQuality) || 72));
      let pipeline = sharp(resolved, { failOn: "none", sequentialRead: true }).rotate();
      const metadata = await pipeline.metadata().catch(() => null);
      const hasAlpha = Boolean(metadata?.hasAlpha);
      const outputPath = path.join(destinationDir, `${baseName}.${hasAlpha ? "png" : "jpg"}`);
      await protectFile(outputPath);
      if (metadata && (metadata.width > maxWidth || metadata.height > maxHeight)) {
        pipeline = pipeline.resize(maxWidth, maxHeight, { fit: "inside", withoutEnlargement: true });
      }
      if (hasAlpha) {
        await pipeline.png({ compressionLevel: 6, effort: 4 }).toFile(outputPath);
      } else {
        await pipeline.jpeg({ quality: jpegQuality, mozjpeg: false }).toFile(outputPath);
      }
      const st = await statOrNull(outputPath);
      return st?.isFile() ? outputPath : null;
    } catch (error) {
      decodeError = error;
    }
  }
  try {
    const image = nativeImage.createFromPath(resolved);
    if (!image.isEmpty()) {
      const originalSize = image.getSize();
      const maxWidth = Math.max(64, Number(options?.maxWidth) || 1024);
      const maxHeight = Math.max(64, Number(options?.maxHeight) || 1024);
      let width = originalSize.width || maxWidth;
      let height = originalSize.height || maxHeight;
      const ratio = Math.min(maxWidth / width, maxHeight / height, 1);
      width = Math.max(1, Math.round(width * ratio));
      height = Math.max(1, Math.round(height * ratio));
      const resized = image.resize({ width, height, quality: "good" });
      const bitmap = resized.toBitmap();
      let hasAlpha = false;
      for (let i = 3; i < bitmap.length; i += 4) {
        if (bitmap[i] < 255) {
          hasAlpha = true;
          break;
        }
      }
      const outputPath = path.join(destinationDir, `${baseName}.${hasAlpha ? "png" : "jpg"}`);
      const jpegQuality = Math.max(40, Math.min(95, Number(options?.jpegQuality) || 72));
      const outputBuffer = hasAlpha ? resized.toPNG() : resized.toJPEG(jpegQuality);
      await fs.writeFile(outputPath, outputBuffer);
      return outputPath;
    }
  } catch (error) {
    decodeError = decodeError || error;
  }
  writeLog("WARN", "preview image decode failed", {
    sourcePath: resolved,
    extension: path.extname(resolved).toLowerCase(),
    sharpAvailable: Boolean(sharp),
    message: decodeError?.message || "unsupported or invalid image"
  });
  return null;
}

async function clearPreviewDir(previewDir, keepPath = "") {
  const dirStat = await statOrNull(previewDir);
  if (!dirStat?.isDirectory()) {
    return;
  }
  const normalizedKeepPath = keepPath ? path.resolve(keepPath).toLowerCase() : "";
  const entries = await fs.readdir(previewDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(previewDir, entry.name);
    const normalizedCurrent = path.resolve(fullPath).toLowerCase();
    if (normalizedKeepPath && normalizedCurrent === normalizedKeepPath) {
      continue;
    }
    if (entry.isDirectory()) {
      await fs.rm(fullPath, { recursive: true, force: true });
      continue;
    }
    await fs.rm(fullPath, { force: true });
  }
}

function inferModelSlotFromFileName(filePath) {
  const name = path.basename(String(filePath || "")).toLowerCase();
  if (name.endsWith(".ztl")) return "Ztool";
  if (name.includes("high")) return "HighPoly";
  if (name.includes("lod0")) return "Lod0";
  if (name.includes("lod1")) return "Lod1";
  if (name.includes("lod2")) return "Lod2";
  if (name.includes("lod3")) return "Lod3";
  return "";
}

function normalizeModelSlotName(value) {
  return MODEL_SLOT_SUFFIXES.find((item) => item.toLowerCase() === String(value || "").trim().toLowerCase()) || "";
}

function isMeshSlotName(value) {
  return /^mesh(?:\d+)?$/i.test(String(value || "").trim());
}

function getMeshSlotOrder(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (/^mesh$/i.test(normalized)) {
    return 1;
  }
  const matched = normalized.match(/^mesh(\d+)$/i);
  if (!matched) {
    return Number.MAX_SAFE_INTEGER;
  }
  const parsed = Number(matched[1]);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function formatMeshSlotName(order) {
  if (order <= 1) {
    return "Mesh";
  }
  return `Mesh${String(order).padStart(2, "0")}`;
}

function sortModelSlotEntries(entries) {
  const legacyOrder = new Map(MODEL_SLOT_SUFFIXES.map((slot, index) => [slot.toLowerCase(), index]));
  return [...entries].sort((a, b) => {
    const slotA = String(a?.[0] || "");
    const slotB = String(b?.[0] || "");
    const meshA = isMeshSlotName(slotA);
    const meshB = isMeshSlotName(slotB);
    if (meshA && meshB) {
      return getMeshSlotOrder(slotA) - getMeshSlotOrder(slotB);
    }
    if (meshA) return -1;
    if (meshB) return 1;
    const orderA = legacyOrder.has(slotA.toLowerCase()) ? legacyOrder.get(slotA.toLowerCase()) : Number.MAX_SAFE_INTEGER;
    const orderB = legacyOrder.has(slotB.toLowerCase()) ? legacyOrder.get(slotB.toLowerCase()) : Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return slotA.localeCompare(slotB);
  });
}

function normalizeTextureSlotName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return TEXTURE_SUFFIXES.find((item) => item.toLowerCase() === raw.toLowerCase())
    || normalizeTextureType(raw);
}

function isMissingPathError(error) {
  const code = String(error?.code || "").toUpperCase();
  if (code === "ENOENT") {
    return true;
  }
  const message = String(error?.message || "");
  return message.includes("源路径不存在") || message.includes("no such file or directory");
}

function parseTextureSlotToken(value) {
  const raw = String(value || "").trim();

  // Extract entry ID if present (e.g. Displacement_import-default-displacement-2)
  let baseToken = raw;
  let entryId = "";
  const entryIdMatch = raw.match(/^(.+?)(_import-default-.+|_edit-default-.+|_edit-.*|_import-.*)?$/i);
  // Only extract entry id for displacement
  if (entryIdMatch && entryIdMatch[2] && entryIdMatch[1].toLowerCase().includes("displacement")) {
    baseToken = entryIdMatch[1];
    entryId = entryIdMatch[2]; // Includes the leading underscore
  }

  const prefixed = baseToken.match(/^(\d{3})[_-](.+)$/);
  if (prefixed) {
    const areaIndex = Math.max(1, Number(prefixed[1]) || 1);
    const textureType = normalizeTextureSlotName(prefixed[2]);
    if (!textureType) {
      return null;
    }
    return { areaIndex, textureType, token: `${String(areaIndex).padStart(3, "0")}_${textureType}${entryId}` };
  }
  const textureType = normalizeTextureSlotName(baseToken);
  if (!textureType) {
    return null;
  }
  return { areaIndex: 1, textureType, token: `${textureType}${entryId}` };
}

function applyColorTagsToMeta(meta, colorTags) {
  const uniqueColorTags = [...new Set((Array.isArray(colorTags) ? colorTags : []).map((tag) => String(tag || "").trim().toLowerCase()).filter(Boolean))];
  if (!meta || typeof meta !== "object") {
    return;
  }
  if (uniqueColorTags.length === 0) {
    return;
  }
  meta.colorTags = uniqueColorTags;
  meta.semanticTags = meta.semanticTags && typeof meta.semanticTags === "object" ? meta.semanticTags : {};
  meta.semanticTags.color = uniqueColorTags;
}

function normalizeNormalMapFormatValue(value, fallback = "dx") {
  const nextFallback = String(fallback || "dx").trim().toLowerCase() === "opengl" ? "opengl" : "dx";
  return String(value || "").trim().toLowerCase() === "opengl" ? "opengl" : nextFallback;
}

// Zion 资产导出目标二级目录（Objects 之后的部分，可多级）。
// 该值会随导入 job 进入 Unreal 包路径，因此逐段净化：去掉非法字符、横线折下划线、
// 丢弃空段与 "." / ".."（防路径穿越），最多 4 段以免超出 Windows 路径长度限制。
function normalizeZionExportSubfolder(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const segments = [];
  for (const piece of raw.replace(/\\/g, "/").split("/")) {
    const trimmed = piece.trim();
    if (!trimmed || trimmed === "." || trimmed === "..") continue;
    const token = trimmed.replace(/[^A-Za-z0-9_-]/g, "").replace(/-/g, "_");
    if (token) segments.push(token);
    if (segments.length >= 4) break;
  }
  return segments.join("/");
}

// Surface assets store a base tiling value (md 3.5.4). Missing or invalid values
// fall back to the previous value, then to 1.0.
function normalizeBaseTilingValue(value, fallback = 1) {
  const parsed = Number(String(value ?? "").trim());
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  const fallbackParsed = Number(String(fallback ?? "").trim());
  return Number.isFinite(fallbackParsed) && fallbackParsed > 0 ? fallbackParsed : 1;
}

function buildAreaNormalMapFormats(entries, sourceMap, fallback = "dx") {
  const result = {};
  const areaIds = [...new Set((Array.isArray(entries) ? entries : []).map((entry) => Math.max(1, Number(entry?.areaIndex || entry?.areaId) || 1)))];
  if (areaIds.length === 0) {
    areaIds.push(1);
  }
  for (const areaId of areaIds) {
    result[areaId] = normalizeNormalMapFormatValue(sourceMap?.[areaId] ?? sourceMap?.[String(areaId)], fallback);
  }
  if (!result[1]) {
    result[1] = normalizeNormalMapFormatValue(sourceMap?.[1] ?? sourceMap?.["1"], fallback);
  }
  return result;
}

function inferTextureSlotFromFileName(filePath) {
  const resolvedPath = String(filePath || "");
  const inferredFromName = detectTextureTypeFromFileName(resolvedPath);
  if (inferredFromName) {
    return inferredFromName;
  }
  const parentSegments = path.dirname(resolvedPath)
    .split(/[\\/]+/)
    .filter(Boolean)
    .reverse();
  for (const segment of parentSegments) {
    const inferred = detectTextureTypeFromFileName(segment)
      || normalizeTextureType(segment)
      || normalizeMegascansTextureType(segment);
    if (inferred) {
      return inferred;
    }
  }
  return detectTextureSuffix(filePath);
}

const ASSET_TYPE_TO_TOP_CATEGORY = {
  "3d": "environment",
  "3dplant": "environment",
  surface: "environment",
  decal: "environment",
  atlas: "environment",
  imperfection: "environment",
  displacement: "environment",
  hdri: "environment",
  animation: "animation",
  suit: "character",
  monster: "character",
  npc: "character",
  weapon: "character"
};

// 主角 Locomotion 先落到 Standard Library 下的固定目录，扫描才能按 asset_info.json 收录。
const ANIMATION_LIBRARY_RELATIVE_DIR = path.join("Animation", "Hero", "Male_01", "WP00_Unarm", "Locomotion");

function getTopCategoryForAssetType(assetType) {
  const normalized = sanitizeToken(assetType);
  return ASSET_TYPE_TO_TOP_CATEGORY[normalized] || "";
}

function resolveImportDestinationRoot(assetType, requestedPath, category = "") {
  const libraryRoot = path.resolve(String(settings.customLibraryPath || "").trim());
  const characterRoot = buildCharacterRelativeRoot(assetType, category);
  const defaultRoot = characterRoot.length > 0
    ? path.join(libraryRoot, ...characterRoot)
    : path.join(libraryRoot, getCustomAssetTypeFolder(assetType));
  if (isCharacterAssetType(assetType)) {
    return { ok: true, destinationRoot: defaultRoot };
  }
  const raw = String(requestedPath || "").trim();
  if (!raw) {
    return { ok: true, destinationRoot: defaultRoot };
  }
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(libraryRoot, raw);
  if (!isUnderRoot(libraryRoot, resolved)) {
    return { ok: false, message: "导入目标必须在 Standard Library 目录内" };
  }
  return { ok: true, destinationRoot: resolved };
}

function getCustomAssetTypeFolder(assetType) {
  const normalized = sanitizeToken(assetType);
  if (normalized === "3d") {
    return path.join("Environment", "3D Assets");
  }
  if (normalized === "3dplant") {
    return path.join("Environment", "Foliage");
  }
  if (normalized === "surface") {
    return path.join("Environment", "Surfaces");
  }
  if (normalized === "decal") {
    return path.join("Environment", "Decals");
  }
  if (normalized === "atlas") {
    return path.join("Environment", "Atlases");
  }
  if (normalized === "imperfection") {
    return path.join("Environment", "Imperfections");
  }
  if (normalized === "displacement") {
    return path.join("Environment", "Displacements");
  }
  if (normalized === "hdri") {
    return path.join("Environment", "HDRI");
  }
  if (normalized === "animation") {
    return ANIMATION_LIBRARY_RELATIVE_DIR;
  }
  if (normalized === "suit") return path.join("Character", "Hero");
  if (normalized === "monster") return path.join("Character", "Monster");
  if (normalized === "npc") return path.join("Character", "NPC");
  if (normalized === "weapon") return path.join("Character", "Weapon");
  return normalized || "custom";
}

function makeCustomAnimationBaseName(sourcePath) {
  const stem = path.basename(String(sourcePath || ""), path.extname(String(sourcePath || "")));
  return stem || "AS_Animation";
}

function modelVariantMetadataFields(value) {
  const variantKey = normalizeModelVariantKey(value, "01");
  const variantNumber = modelVariantNumberFromKey(variantKey);
  return {
    variantKey,
    ...(variantNumber > 0 ? { variantNumber } : {})
  };
}

function makeCustomModelBaseName(slot, assetName, assetId, options = {}) {
  const assetNameToken = sanitizeToken(assetName) || "asset";
  const normalizedSlot = String(slot || "").trim().toLowerCase();
  if (isMeshSlotName(normalizedSlot)) {
    const variantKey = normalizeModelVariantKey(options.variantKey ?? options.variantNumber, "01");
    const modelStem = "SM_" + assetNameToken + "_" + assetId + "_" + variantKey;
    return toOpaqueVariantFileStem(modelStem) || modelStem;
  }
  if (normalizedSlot === "highpoly") {
    return `SM_${assetNameToken}_${assetId}`;
  }
  if (normalizedSlot === "ztool") {
    return `${assetNameToken}_${assetId}`;
  }
  if (normalizedSlot.startsWith("lod")) {
    return `SM_${assetNameToken}_${assetId}_${normalizedSlot.toUpperCase()}`;
  }
  return `SM_${assetNameToken}_${assetId}_${sanitizeToken(slot).toUpperCase()}`;
}

function makeCustomModelLodBaseName(assetName, assetId, variantKey, lod) {
  const assetNameToken = sanitizeToken(assetName) || "asset";
  const normalizedVariant = normalizeModelVariantKey(variantKey, "01");
  const normalizedLod = Math.max(0, Math.floor(Number(lod) || 0));
  return `SM_${assetNameToken}_${assetId}_${normalizedVariant}_LOD${normalizedLod}`;
}

async function normalizeModelFileNamesForAsset(modelSlotMap, assetDir, assetName, assetId) {
  const orderedEntries = sortModelSlotEntries([...modelSlotMap.entries()]);
  const meshVariantKeys = buildModelVariantKeyMap(
    orderedEntries.filter(([slot]) => isMeshSlotName(slot))
  );
  const renamePlans = orderedEntries.map(([slot, filePath]) => {
    const currentPath = path.resolve(String(filePath || ""));
    const ext = path.extname(currentPath);
    const slotKey = String(slot || "").toLowerCase();
    const desiredBase = makeCustomModelBaseName(slot, assetName, assetId, {
      variantKey: meshVariantKeys.get(slotKey) || parseModelVariantKey(currentPath)
    });
    const desiredPath = path.resolve(path.join(assetDir, `${desiredBase}${ext}`));
    return { slot, currentPath, desiredPath, ext };
  });
  for (let index = 0; index < renamePlans.length; index += 1) {
    const plan = renamePlans[index];
    if (!plan.currentPath || !plan.desiredPath || plan.currentPath.toLowerCase() === plan.desiredPath.toLowerCase()) {
      continue;
    }
    const stat = await statOrNull(plan.currentPath);
    if (!stat?.isFile()) {
      continue;
    }
    const tempPath = path.join(assetDir, `__assethive_tmp_model_${Date.now()}_${index}${plan.ext}`);
    try {
      await renamePathSafely(plan.currentPath, tempPath);
    } catch (error) {
      if (isMissingPathError(error)) {
        modelSlotMap.delete(plan.slot);
        continue;
      }
      throw error;
    }
    plan.currentPath = tempPath;
  }
  for (const plan of renamePlans) {
    if (!plan.currentPath || !plan.desiredPath) {
      continue;
    }
    const finalStat = await statOrNull(plan.currentPath);
    if (!finalStat?.isFile()) {
      modelSlotMap.delete(plan.slot);
      continue;
    }
    if (plan.currentPath.toLowerCase() !== plan.desiredPath.toLowerCase()) {
      try {
        await renamePathSafely(plan.currentPath, plan.desiredPath);
      } catch (error) {
        if (isMissingPathError(error)) {
          modelSlotMap.delete(plan.slot);
          continue;
        }
        throw error;
      }
    }
    modelSlotMap.set(plan.slot, plan.desiredPath);
  }
}

async function normalizeTextureFileNamesForAsset(textureSlotMap, assetDir, assetName, assetId) {
  const renamePlans = [...textureSlotMap.entries()].map(([slot, filePath]) => {
    const currentPath = path.resolve(String(filePath || ""));
    const ext = path.extname(currentPath);
    const desiredBase = makeCustomTextureBaseName(slot, assetName, assetId);
    const desiredPath = path.resolve(path.join(assetDir, `${desiredBase}${ext}`));
    return { slot, currentPath, desiredPath };
  });
  for (const plan of renamePlans) {
    if (!plan.currentPath || !plan.desiredPath) {
      continue;
    }
    const currentStat = await statOrNull(plan.currentPath);
    if (!currentStat?.isFile()) {
      textureSlotMap.delete(plan.slot);
      continue;
    }
    if (plan.currentPath.toLowerCase() !== plan.desiredPath.toLowerCase()) {
      try {
        await renamePathSafely(plan.currentPath, plan.desiredPath);
      } catch (error) {
        if (isMissingPathError(error)) {
          textureSlotMap.delete(plan.slot);
          continue;
        }
        throw error;
      }
    }
    textureSlotMap.set(plan.slot, plan.desiredPath);
  }
}

function makeCustomTextureBaseName(suffix, assetName, assetId, materialRole = "") {
  const assetNameToken = sanitizeToken(assetName) || "asset";
  // Remove any UUID-like suffix (e.g. _import-default-displacement-2) before creating the filename
  const cleanSuffix = String(suffix || "").replace(/_import-.*|_edit-.*/i, "");
  const rolePrefix = normalizeTextureMaterialRole(materialRole) === "billboard" ? "Billboard_" : "";
  const lower = cleanSuffix.trim().toLowerCase();
  if (lower === "hdr") {
    return `T_${assetNameToken}_${assetId}`;
  }
  return `T_${assetNameToken}_${assetId}_${rolePrefix}${cleanSuffix}`;
}

function makeUniqueId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 7; i += 1) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return result;
}

function isSidecarAssetMetaPath(metaPath) {
  return isSidecarAssetMetaFileName(path.basename(String(metaPath || "")));
}

function isFlatLibraryAsset(assetType, metaPath) {
  return isFlatCustomAssetType(assetType) || isSidecarAssetMetaPath(metaPath) || isAnimationModelMetaPath(metaPath);
}

async function cleanupAnimationArchiveDirectory(destinationDir) {
  const root = String(destinationDir || "").trim();
  if (!root) {
    return;
  }
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory() && /^(preview|previews)$/i.test(entry.name)) {
      await fs.rm(fullPath, { recursive: true, force: true });
      continue;
    }
    if (entry.isFile() && (/\.asset_info(?:\.json)?$/i.test(entry.name) || /^asset_info\.json$/i.test(entry.name))) {
      await fs.rm(fullPath, { force: true });
    }
  }
}

async function cleanupAnimationArchiveExtras(destinationDir, stem) {
  for (const extraPath of listAnimationArchiveExtras(destinationDir, stem)) {
    await fs.rm(extraPath, { recursive: true, force: true });
  }
  await cleanupAnimationArchiveDirectory(destinationDir);
}

async function makeAssetIdentity(assetType, assetName, destinationRoot) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const uniqueId = makeUniqueId();
    const layout = resolveCustomAssetLayout({ assetType, assetName, destinationRoot, uniqueId });
    if (!layout.wrapFolder) {
      return layout;
    }
    const existing = await statOrNull(layout.destinationDir);
    if (!existing) {
      return layout;
    }
  }
  throw new Error("生成资产唯一ID失败，请重试");
}

async function statOrNull(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

// 将任务栏图标进度条设置为 0..1 的值；传 -1（或非有限值）清除进度条。
function setMainWindowTaskbarProgress(value) {
  const progress = Number(value);
  const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
  if (!win || typeof win.setProgressBar !== "function") {
    return;
  }
  try {
    win.setProgressBar(Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : -1);
  } catch {
    void 0;
  }
}

function getPreviewEditTempPath() {
  const fileName = `assethive_preview_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
  return path.join(os.tmpdir(), fileName);
}

// 智能去背景模型路径：打包后 onnx 需解包到 app.asar.unpacked 供 onnxruntime 原生读取。
function getCutoutModelPath() {
  const appPath = app.getAppPath();
  return path.join(app.isPackaged ? appPath + ".unpacked" : appPath, "electron", "models", "silueta.onnx");
}

function getBitmapFromImagePath(sourcePath) {
  const image = nativeImage.createFromPath(path.resolve(sourcePath));
  if (image.isEmpty()) {
    return null;
  }
  const size = image.getSize();
  const width = Number(size.width) || 0;
  const height = Number(size.height) || 0;
  if (width <= 0 || height <= 0) {
    return null;
  }
  const bitmap = image.toBitmap();
  return { image, bitmap, width, height };
}

function colorDistanceSq(bitmap, pixelIndex, target) {
  const offset = pixelIndex * 4;
  const b = bitmap[offset];
  const g = bitmap[offset + 1];
  const r = bitmap[offset + 2];
  const dr = r - target.r;
  const dg = g - target.g;
  const db = b - target.b;
  return dr * dr + dg * dg + db * db;
}

async function cutoutPreviewMagic(sourcePath, x, y, tolerance = 20) {
  const imageData = getBitmapFromImagePath(sourcePath);
  if (!imageData) {
    return { ok: false, message: "预览图读取失败" };
  }
  const { bitmap, width, height } = imageData;
  const cx = Math.max(0, Math.min(width - 1, Math.round(Number(x) || 0)));
  const cy = Math.max(0, Math.min(height - 1, Math.round(Number(y) || 0)));
  const startIndex = cy * width + cx;
  const startOffset = startIndex * 4;
  const target = {
    b: bitmap[startOffset],
    g: bitmap[startOffset + 1],
    r: bitmap[startOffset + 2]
  };
  const visited = new Uint8Array(width * height);
  const stack = [startIndex];
  const threshold = Math.max(0, Math.min(255, Number(tolerance) || 0));
  const thresholdSq = threshold * threshold * 3;

  while (stack.length > 0) {
    const index = stack.pop();
    if (index === undefined || visited[index]) {
      continue;
    }
    visited[index] = 1;
    const offset = index * 4;
    if (bitmap[offset + 3] === 0) {
      continue;
    }
    if (colorDistanceSq(bitmap, index, target) > thresholdSq) {
      continue;
    }
    bitmap[offset + 3] = 0;
    const px = index % width;
    const py = Math.floor(index / width);
    if (px > 0) stack.push(index - 1);
    if (px < width - 1) stack.push(index + 1);
    if (py > 0) stack.push(index - width);
    if (py < height - 1) stack.push(index + width);
  }

  const nextPath = getPreviewEditTempPath();
  const output = nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 });
  await fs.writeFile(nextPath, output.toPNG());
  return { ok: true, message: "已执行连续抠像", path: nextPath };
}

async function finalizePreviewCutout(sourcePath, options = {}) {
  const imageData = getBitmapFromImagePath(sourcePath);
  if (!imageData) {
    return { ok: false, message: "预览图读取失败" };
  }
  const { bitmap, width, height } = imageData;
  const region = options.preserveCanvas ? { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1 } : opaqueBounds(bitmap, width, height);
  if (!region) {
    return { ok: false, message: "未检测到可保留的不透明区域" };
  }
  const padding = Math.max(0, Math.min(64, Number(options?.padding) || 8));
  const minX = Math.max(0, region.minX - padding);
  const maxX = Math.min(width - 1, region.maxX + padding);
  const minY = Math.max(0, region.minY - padding);
  const maxY = Math.min(height - 1, region.maxY + padding);
  const cropWidth = maxX - minX + 1;
  const cropHeight = maxY - minY + 1;
  const croppedBitmap = Buffer.alloc(cropWidth * cropHeight * 4);
  for (let row = 0; row < cropHeight; row += 1) {
    const srcStart = ((minY + row) * width + minX) * 4;
    const srcEnd = srcStart + cropWidth * 4;
    const dstStart = row * cropWidth * 4;
    bitmap.copy(croppedBitmap, dstStart, srcStart, srcEnd);
  }

  const maxSize = Math.max(256, Math.min(2048, Number(options?.maxSize) || 1024));
  let outImage = nativeImage.createFromBitmap(croppedBitmap, { width: cropWidth, height: cropHeight, scaleFactor: 1 });
  if (cropWidth > maxSize || cropHeight > maxSize) {
    const ratio = Math.min(maxSize / cropWidth, maxSize / cropHeight, 1);
    outImage = outImage.resize({
      width: Math.max(1, Math.round(cropWidth * ratio)),
      height: Math.max(1, Math.round(cropHeight * ratio)),
      quality: "good"
    });
  }
  const outputPath = getPreviewEditTempPath();
  await fs.writeFile(outputPath, outImage.toPNG());
  return { ok: true, message: "抠像完成", path: outputPath };
}

async function renamePathSafely(sourcePath, destinationPath) {
  const resolvedSource = path.resolve(sourcePath);
  const resolvedDestination = path.resolve(destinationPath);
  if (resolvedSource.toLowerCase() === resolvedDestination.toLowerCase()) {
    return resolvedDestination;
  }
  const sourceStats = await statOrNull(resolvedSource);
  if (!sourceStats) {
    throw new Error(`源路径不存在：${resolvedSource}`);
  }
  const destinationStats = await statOrNull(resolvedDestination);
  if (destinationStats) {
    await fs.rm(resolvedDestination, { recursive: true, force: true });
  }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.rename(resolvedSource, resolvedDestination);
      return resolvedDestination;
    } catch (error) {
      writeLog("WARN", "renamePathSafely failed, retrying...", { source: resolvedSource, dest: resolvedDestination, attempt, error: error?.message });
      const code = String(error?.code || "").toUpperCase();
      if (!["EPERM", "EACCES", "EXDEV"].includes(code)) {
        throw error;
      }
      if (attempt === 5) {
        if (sourceStats.isDirectory()) {
          await fs.cp(resolvedSource, resolvedDestination, { recursive: true, force: true });
          await fs.rm(resolvedSource, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
          return resolvedDestination;
        }
        await fs.copyFile(resolvedSource, resolvedDestination);
        await fs.rm(resolvedSource, { force: true, maxRetries: 8, retryDelay: 300 });
        return resolvedDestination;
      }
      await sleep(250 * (attempt + 1));
    }
  }
  return resolvedDestination;
}

async function collectImages(rootPath) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectImages(fullPath);
      results.push(...nested);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      results.push(fullPath);
    }
  }
  return results;
}

function hasPreviewTokenInName(filePath) {
  const base = path.basename(String(filePath || ""), path.extname(String(filePath || ""))).toLowerCase();
  if (!base) {
    return false;
  }
  return /(?:^|[_.-])(preview|thumb|thumbnail)(?:$|[_.-])/.test(base) || base.includes("render") || base.includes("beauty");
}

function looksLikeTextureTypeName(filePath) {
  const base = path.basename(String(filePath || ""), path.extname(String(filePath || "")));
  if (!base) return false;
  return Boolean(detectTextureTypeFromFileName(base) || normalizeTextureType(base));
}

async function resolvePreviewFile(sourcePath, previewImagePath, isExcludedPath = null) {
  if (previewImagePath) {
    const target = path.resolve(previewImagePath);
    const stats = await statOrNull(target);
    if (stats?.isFile()) {
      return target;
    }
  }
  const images = await collectImages(sourcePath);
  if (images.length === 0) {
    return null;
  }
  const scored = images.map((filePath) => {
    const normalized = normalizePath(filePath).toLowerCase();
    const name = path.basename(filePath).toLowerCase();
    const hasPreviewToken = hasPreviewTokenInName(filePath);
    const isTextureLike = looksLikeTextureTypeName(filePath);
    let score = 0;
    if (normalized.includes("/preview/") || normalized.includes("/previews/")) score += 140;
    if (name.includes("popup")) score += 60;
    if (hasPreviewToken) score += 120;
    if (name.endsWith("_sp.jpg") || name.endsWith("_sp.jpeg") || name.includes("sidepanel")) score += 20;
    if (isTextureLike && !hasPreviewToken) score -= 80;
    return { filePath, score, hasPreviewToken, isTextureLike };
  });
  const withoutTextureSuffix = scored.filter((item) => !item.isTextureLike
    && !(typeof isExcludedPath === "function" && isExcludedPath(item.filePath)));
  if (withoutTextureSuffix.length === 0) {
    return null;
  }
  const withExplicitPreview = withoutTextureSuffix.filter((item) => item.hasPreviewToken);
  if (withExplicitPreview.length > 0) {
    return [...withExplicitPreview].sort((a, b) => b.score - a.score)[0]?.filePath || null;
  }
  return [...withoutTextureSuffix].sort((a, b) => b.score - a.score)[0]?.filePath || null;
}

async function copyRenamedFile(sourcePath, destinationDir, baseName, characterCopy = false) {
  const resolved = path.resolve(sourcePath);
  const stats = await statOrNull(resolved);
  if (!stats?.isFile()) {
    return null;
  }
  const ext = path.extname(resolved).toLowerCase();
  const destinationPath = path.join(destinationDir, `${baseName}${ext}`);
  if (characterCopy) await require('./services/characterFileInspection').copyCharacterFile(resolved, destinationPath);
  else await fs.copyFile(resolved, destinationPath);
  return destinationPath;
}

async function hashFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fsSync.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function parseTextureResolutionPixelsFromName(filePath) {
  const name = path.basename(String(filePath || ""), path.extname(String(filePath || ""))).toLowerCase();
  const match = name.match(/(?:^|[_\-.])(1k|2k|4k|8k|16k)(?:$|[_\-.])/i);
  if (!match) return 0;
  const token = String(match[1] || "").toLowerCase();
  if (token === "1k") return 1024;
  if (token === "2k") return 2048;
  if (token === "4k") return 4096;
  if (token === "8k") return 8192;
  if (token === "16k") return 16384;
  return 0;
}

async function inspectTextureImportResolution(sourcePath) {
  const resolved = path.resolve(sourcePath);
  const declaredResolution = parseTextureResolutionPixelsFromName(resolved);
  let width = 0;
  let height = 0;
  try {
    const size = await imageDimensions(resolved);
    width = Math.max(0, Number(size?.width) || 0);
    height = Math.max(0, Number(size?.height) || 0);
  } catch {
    // Some legacy inputs cannot be decoded by the metadata probe. Filename
    // resolution remains the fallback and unsupported resizing will fail later.
  }
  const maxResolution = Math.max(width, height, declaredResolution);
  if (maxResolution > IMPORT_TEXTURE_MAX_RESOLUTION_PIXELS) {
    throw new Error(`贴图超过 8K 限制：${path.basename(resolved)}`);
  }
  return { width, height, declaredResolution, maxResolution };
}

function normalizeTexturePixelDimension(value) {
  const normalized = Math.max(0, Math.round(Number(value) || 0));
  return Number.isFinite(normalized) ? normalized : 0;
}

function parseTextureResolutionLabelPixels(value) {
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)K$/i);
  return match ? Math.round(Number(match[1]) * 1024) : 0;
}

function formatTextureResolutionLabel(pixels) {
  const normalized = normalizeTexturePixelDimension(pixels);
  if (normalized >= 8192) return `${Math.round(normalized / 1024)}K`;
  if (normalized >= 4096) return "4K";
  if (normalized >= 2048) return "2K";
  if (normalized >= 1024) return "1K";
  return normalized > 0 ? `${normalized}px` : "";
}

async function inspectStoredTextureDimensions(filePath, fallbackPixels = 0) {
  const resolved = path.resolve(filePath);
  const declaredResolution = parseTextureResolutionPixelsFromName(resolved);
  let width = 0;
  let height = 0;
  try {
    const size = await imageDimensions(resolved);
    width = normalizeTexturePixelDimension(size?.width);
    height = normalizeTexturePixelDimension(size?.height);
  } catch {
    // Keep metadata useful for legacy or temporarily unreadable files.
  }
  const fallback = normalizeTexturePixelDimension(fallbackPixels) || declaredResolution;
  if (!width && !height) {
    width = fallback;
    height = fallback;
  } else {
    if (!width) width = height;
    if (!height) height = width;
  }
  return { width, height };
}

function normalizeStoredFileSize(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function buildStoredTextureMetadata(stored, sourceHint = {}, fileStats = {}) {
  const width = normalizeTexturePixelDimension(stored?.width);
  const height = normalizeTexturePixelDimension(stored?.height);
  const storedMax = Math.max(width, height);
  const hintedSourcePixels =
    normalizeTexturePixelDimension(sourceHint.sourceResolutionPixels)
    || parseTextureResolutionLabelPixels(sourceHint.sourceResolution)
    || parseTextureResolutionLabelPixels(sourceHint.resolution);
  let sourceWidth =
    normalizeTexturePixelDimension(sourceHint.sourceWidth)
    || normalizeTexturePixelDimension(sourceHint.originalWidth)
    || normalizeTexturePixelDimension(sourceHint.width);
  let sourceHeight =
    normalizeTexturePixelDimension(sourceHint.sourceHeight)
    || normalizeTexturePixelDimension(sourceHint.originalHeight)
    || normalizeTexturePixelDimension(sourceHint.height);
  if (!sourceWidth && !sourceHeight && hintedSourcePixels) {
    sourceWidth = hintedSourcePixels;
    sourceHeight = hintedSourcePixels;
  }
  if (!sourceWidth) sourceWidth = width;
  if (!sourceHeight) sourceHeight = height;
  const sourceMax = Math.max(sourceWidth, sourceHeight, storedMax);
  const fileSize = normalizeStoredFileSize(fileStats.fileSize);
  const fileModifiedAt = normalizeStoredFileSize(fileStats.fileModifiedAt);
  return {
    width,
    height,
    resolution: formatTextureResolutionLabel(storedMax),
    sourceWidth,
    sourceHeight,
    sourceResolution: formatTextureResolutionLabel(sourceMax),
    compressed: sourceMax > storedMax && sourceMax > LIBRARY_TEXTURE_MAX_RESOLUTION_PIXELS,
    ...(fileSize > 0 ? { fileSize } : {}),
    ...(fileModifiedAt > 0 ? { fileModifiedAt } : {})
  };
}

async function inspectStoredTextureMetadata(filePath, sourceHint = {}, options = {}) {
  const stats = await statOrNull(filePath);
  const isFile = typeof stats?.isFile === "function" ? stats.isFile() : Boolean(stats);
  const fileSize = isFile ? normalizeStoredFileSize(stats?.size) : 0;
  const fileModifiedAt = isFile ? normalizeStoredFileSize(stats?.mtimeMs) : 0;
  const previousWidth = normalizeTexturePixelDimension(sourceHint.width);
  const previousHeight = normalizeTexturePixelDimension(sourceHint.height);
  const previousFileSize = normalizeStoredFileSize(sourceHint.fileSize);
  const previousFileModifiedAt = normalizeStoredFileSize(sourceHint.fileModifiedAt);
  const referenceTimestamp = Date.parse(String(options.referenceTimestamp || ""));
  const hasCompleteFileCache = previousFileSize > 0 && previousFileModifiedAt > 0;
  const fileCacheMatches = previousWidth > 0 && previousHeight > 0 && fileSize > 0 && fileModifiedAt > 0 && (
    hasCompleteFileCache
      ? previousFileSize === fileSize && previousFileModifiedAt === fileModifiedAt
      : Number.isFinite(referenceTimestamp) && fileModifiedAt <= referenceTimestamp + 2000
  );
  if (fileCacheMatches) {
    return buildStoredTextureMetadata(
      { width: previousWidth, height: previousHeight },
      sourceHint,
      { fileSize, fileModifiedAt }
    );
  }
  const stored = await inspectStoredTextureDimensions(
    filePath,
    sourceHint.storedFallbackPixels || sourceHint.width || sourceHint.sourceWidth
  );
  return buildStoredTextureMetadata(stored, sourceHint, { fileSize, fileModifiedAt });
}

function textureResolutionMetadataFields(textureMetadata) {
  const fields = {};
  if (!textureMetadata || typeof textureMetadata !== "object") return fields;
  const width = normalizeTexturePixelDimension(textureMetadata.width);
  const height = normalizeTexturePixelDimension(textureMetadata.height);
  const sourceWidth = normalizeTexturePixelDimension(textureMetadata.sourceWidth);
  const sourceHeight = normalizeTexturePixelDimension(textureMetadata.sourceHeight);
  const fileSize = normalizeStoredFileSize(textureMetadata.fileSize);
  const fileModifiedAt = normalizeStoredFileSize(textureMetadata.fileModifiedAt);
  if (width > 0) fields.width = width;
  if (height > 0) fields.height = height;
  if (typeof textureMetadata.resolution === "string" && textureMetadata.resolution.trim()) fields.resolution = textureMetadata.resolution.trim();
  if (sourceWidth > 0) fields.sourceWidth = sourceWidth;
  if (sourceHeight > 0) fields.sourceHeight = sourceHeight;
  if (typeof textureMetadata.sourceResolution === "string" && textureMetadata.sourceResolution.trim()) fields.sourceResolution = textureMetadata.sourceResolution.trim();
  if (typeof textureMetadata.compressed === "boolean") fields.compressed = textureMetadata.compressed;
  if (fileSize > 0) fields.fileSize = fileSize;
  if (fileModifiedAt > 0) fields.fileModifiedAt = fileModifiedAt;
  return fields;
}

function findPreviousTextureMetadata(meta, slot, filePath, materialRole = "") {
  const parsedSlot = parseTextureSlotToken(slot);
  const textureType = String(parsedSlot?.textureType || slot || "").trim().toLowerCase();
  const areaIndex = parsedSlot?.areaIndex || 1;
  const normalizedRole = normalizeTextureMaterialRole(materialRole, filePath);
  const uri = path.basename(String(filePath || "")).toLowerCase();
  const candidates = [
    ...(Array.isArray(meta?.textureEntries) ? meta.textureEntries : []),
    ...(Array.isArray(meta?.components) ? meta.components.filter((item) => item && item.type === "texture") : [])
  ].filter((item) => item && typeof item === "object");
  const matchesRole = (item) => {
    if (!normalizedRole) return true;
    return normalizeTextureMaterialRole(item?.materialRole, item?.uri || item?.path || "") === normalizedRole;
  };
  return candidates.find((item) => String(item.uri || item.path || "").trim().toLowerCase() === uri && matchesRole(item))
    || candidates.find((item) => String(item.textureType || item.slot || "").trim().toLowerCase() === textureType
      && (Number(item.areaIndex) || 1) === areaIndex
      && matchesRole(item))
    || null;
}

// 入库后的纹理既需要元数据（尺寸/来源分辨率），也需要真实落盘路径：
// 调用方依赖 path 更新纹理槽位、生成预览与写入元数据，缺一不可。
async function inspectCopiedTextureMetadata(filePath, sourceHint) {
  const metadata = await inspectStoredTextureMetadata(filePath, sourceHint);
  return { ...metadata, path: path.resolve(filePath) };
}

async function copyTextureIntoLibrary(sourcePath, destinationDir, baseName, options = {}) {
  const resolved = path.resolve(sourcePath);
  const stats = await statOrNull(resolved);
  if (!stats?.isFile()) return null;
  const ext = path.extname(resolved).toLowerCase();
  const info = await inspectTextureImportResolution(resolved);
  const sourceHint = {
    sourceWidth: info.width || info.declaredResolution,
    sourceHeight: info.height || info.declaredResolution
  };
  const isHdri = options.isHdri === true;
  if (options.preserveOriginal === true) {
    const copiedPath = await copyRenamedFile(resolved, destinationDir, baseName, options.characterCopy === true);
    if (!copiedPath) return null;
    const copiedStat = await fs.stat(copiedPath);
    // Character textures are byte-for-byte copies, so their decoded dimensions
    // are already known. Do not decode every TGA a second time over the share.
    return { ...buildStoredTextureMetadata({ width: sourceHint.sourceWidth, height: sourceHint.sourceHeight }, sourceHint,
      { fileSize: copiedStat.size, fileModifiedAt: copiedStat.mtimeMs }), path: path.resolve(copiedPath) };
  }
  if (ext === ".exr" && !isHdri) {
    const convertedPath = path.join(destinationDir, `${baseName}.png`);
    await protectFile(convertedPath);
    await runImageTask("exrToPng", [resolved, convertedPath, { normalize: true, maxSize: LIBRARY_TEXTURE_MAX_RESOLUTION_PIXELS }]);
    return inspectCopiedTextureMetadata(convertedPath, sourceHint);
  }
  if (info.maxResolution <= LIBRARY_TEXTURE_MAX_RESOLUTION_PIXELS) {
    const copiedPath = await copyRenamedFile(resolved, destinationDir, baseName);
    return copiedPath ? inspectCopiedTextureMetadata(copiedPath, sourceHint) : null;
  }
  const targetExt = ext === ".hdr"
    ? ".hdr"
    : (ext === ".exr" ? ".exr" : ([".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"].includes(ext) ? ext : ".png"));
  const targetPath = path.join(destinationDir, `${baseName}${targetExt}`);
  await protectFile(targetPath);
  if (ext === ".hdr") await runImageTask("resizeHdr", [resolved, targetPath, LIBRARY_TEXTURE_MAX_RESOLUTION_PIXELS]);
  else if (ext === ".exr") await runImageTask("resizeExr", [resolved, targetPath, LIBRARY_TEXTURE_MAX_RESOLUTION_PIXELS]);
  else await runImageTask("resizeTexture", [resolved, targetPath, LIBRARY_TEXTURE_MAX_RESOLUTION_PIXELS]);
  return inspectCopiedTextureMetadata(targetPath, sourceHint);
}

function toPreviewRelativeUri(assetDir, previewFilePath) {
  const relative = normalizePath(path.relative(assetDir, previewFilePath));
  return relative;
}

function normalizeAssetPreviewPath(asset, previewPath) {
  const raw = String(previewPath || "").trim();
  if (!raw) {
    return "";
  }
  if (path.isAbsolute(raw)) {
    return normalizePath(raw);
  }
  const assetDir = String(asset?.path || "").trim();
  if (!assetDir) {
    return normalizePath(raw);
  }
  return normalizePath(path.join(assetDir, raw));
}

function normalizeAssetPreviewFields(asset) {
  if (!asset || typeof asset !== "object") {
    return asset;
  }
  if (String(asset.source || "").trim().toLowerCase() !== "custom") {
    return asset;
  }
  const nextPreview = normalizeAssetPreviewPath(asset, asset.preview);
  const nextPreviewImage = normalizeAssetPreviewPath(asset, asset.previewImage || asset.preview);
  const nextDetailImage = normalizeAssetPreviewPath(asset, asset.detailImage || asset.previewImage || asset.preview);
  if (nextPreview === String(asset.preview || "") && nextPreviewImage === String(asset.previewImage || "") && nextDetailImage === String(asset.detailImage || "")) {
    return asset;
  }
  return { ...asset, preview: nextPreview, previewImage: nextPreviewImage, detailImage: nextDetailImage };
}

function normalizeIndexPreviewFields(list) {
  return (Array.isArray(list) ? list : []).map((asset) => normalizeAssetPreviewFields(asset));
}

function resolveCustomAssetFilePath(assetDir, rawPath) {
  const normalizedRaw = String(rawPath || "").trim();
  if (!normalizedRaw) {
    return "";
  }
  return normalizePath(path.isAbsolute(normalizedRaw) ? normalizedRaw : path.join(assetDir, normalizedRaw));
}

function pickHdriSourceFileFromAsset(asset) {
  const assetDir = String(asset?.path || "").trim();
  const meta = asset?.meta && typeof asset.meta === "object" ? asset.meta : null;
  const candidates = [];
  const pushCandidate = (value) => {
    const resolved = resolveCustomAssetFilePath(assetDir, value);
    if (!resolved) {
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    if (ext === ".hdr" || ext === ".exr") {
      candidates.push(resolved);
    }
  };
  if (meta?.textureSlots && typeof meta.textureSlots === "object" && !Array.isArray(meta.textureSlots)) {
    pushCandidate(meta.textureSlots.HDR || meta.textureSlots.hdr);
  }
  if (Array.isArray(meta?.textureEntries)) {
    for (const entry of meta.textureEntries) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const textureType = String(entry.textureType || entry.slot || "").trim().toLowerCase();
      if (textureType !== "hdr") {
        continue;
      }
      pushCandidate(entry.uri || entry.path);
    }
  }
  if (Array.isArray(meta?.components)) {
    for (const component of meta.components) {
      if (!component || typeof component !== "object") {
        continue;
      }
      const componentType = String(component.type || "").trim().toLowerCase();
      const slot = String(component.slot || component.textureType || "").trim().toLowerCase();
      if (componentType !== "texture" || slot !== "hdr") {
        continue;
      }
      pushCandidate(component.uri || component.path);
    }
  }
  if (Array.isArray(meta?.textureFiles)) {
    for (const filePath of meta.textureFiles) {
      pushCandidate(filePath);
    }
  }
  if (Array.isArray(asset?.textureFiles)) {
    for (const filePath of asset.textureFiles) {
      pushCandidate(filePath);
    }
  }
  return candidates[0] || "";
}

async function computeRelativeSizeFromPreview(previewDest, fallbackAssetType) {
  if (previewDest) {
    try {
      const previewImage = nativeImage.createFromPath(previewDest);
      if (!previewImage.isEmpty()) {
        const size = previewImage.getSize();
        if (size.width > 0 && size.height > 0) {
          return `${size.width}x${size.height}`;
        }
      }
    } catch { }
    if (sharp) {
      try {
        const meta = await sharp(previewDest, { failOn: "none" }).metadata();
        if (meta?.width > 0 && meta?.height > 0) {
          return `${meta.width}x${meta.height}`;
        }
      } catch { }
    }
  }
  return (String(fallbackAssetType || "").toLowerCase() === "hdri") ? "2x1" : "1x1";
}

async function ensureCustomHdriPreview(asset) {
  if (!asset || typeof asset !== "object") {
    return asset;
  }
  if (String(asset.source || "").trim().toLowerCase() !== "custom") {
    return asset;
  }
  if (String(asset.assetType || asset?.meta?.assetType || asset?.meta?.semanticTags?.asset_type || "").trim().toLowerCase() !== "hdri") {
    return normalizeAssetPreviewFields(asset);
  }
  const normalizedAsset = normalizeAssetPreviewFields(asset);
  const currentPreviewPath = String(normalizedAsset.previewImage || normalizedAsset.preview || normalizedAsset.detailImage || "").trim();
  const currentPreviewStats = currentPreviewPath ? await statOrNull(currentPreviewPath) : null;
  if (currentPreviewStats?.isFile() && currentPreviewStats.size > 0
    && ![".hdr", ".exr"].includes(path.extname(currentPreviewPath).toLowerCase())) {
    return normalizedAsset;
  }
  const assetDir = String(normalizedAsset.path || "").trim();
  const assetId = String(normalizedAsset.id || normalizedAsset?.meta?.assetID || path.basename(assetDir || "hdri")).trim() || "hdri";
  if (!assetDir) {
    return normalizedAsset;
  }
  const hdrSourcePath = pickHdriSourceFileFromAsset(normalizedAsset);
  if (!hdrSourcePath) {
    return normalizedAsset;
  }
  const hdrSourceStats = await statOrNull(hdrSourcePath);
  if (!hdrSourceStats?.isFile()) {
    return normalizedAsset;
  }
  try {
    const previewDest = await resolvePreviewThumbnailPath(hdrSourcePath);
    if (!previewDest || previewDest === hdrSourcePath) {
      return normalizedAsset;
    }
    const previewAbsolutePath = normalizePath(previewDest);
    return {
      ...normalizedAsset,
      // Keep a shareable source while showing the local derived PNG. Browsing
      // must not create files inside an asset or rewrite its metadata.
      preview: normalizePath(hdrSourcePath),
      previewImage: previewAbsolutePath,
      detailImage: previewAbsolutePath
    };
  } catch (error) {
    writeLog("WARN", "ensureCustomHdriPreview failed", {
      assetId,
      message: error?.message || String(error)
    });
    return normalizedAsset;
  }
}

async function hydrateAssetPreviewFields(asset) {
  if (!asset || typeof asset !== "object") {
    return null;
  }
  const assetDir = String(asset.path || "").trim();
  if (!assetDir) {
    return null;
  }
  const dirStat = await statOrNull(assetDir);
  if (!dirStat?.isDirectory()) {
    return null;
  }
  const metaPath = String(asset.metaPath || "").trim();
  if (metaPath) {
    const metaStat = await statOrNull(metaPath);
    if (!metaStat?.isFile()) {
      return null;
    }
  }
  const normalized = normalizeAssetPreviewFields(asset);
  if (isAnimationAssetType(normalized.assetType) || isAnimationModelMetaPath(metaPath)) {
    const previewPath = String(normalized.previewImage || normalized.preview || normalized.detailImage || "").trim();
    if (previewPath && !(await statOrNull(previewPath))?.isFile()) {
      normalized.preview = "";
      normalized.previewImage = "";
      normalized.detailImage = "";
    }
  }
  return ensureCustomHdriPreview(normalized);
}

async function hydrateIndexPreviewFields(list) {
  const items = Array.isArray(list) ? list : [];
  const result = [];
  const deleteIds = [];
  for (const asset of items) {
    const hydrated = await hydrateAssetPreviewFields(asset);
    if (!hydrated) {
      const assetId = String(asset?.id || "").trim();
      if (assetId) {
        deleteIds.push(assetId);
      }
      continue;
    }
    result.push(hydrated);
  }
  if (deleteIds.length > 0) {
    const deleteIdSet = new Set(deleteIds);
    const beforeCount = index.length;
    index = index.filter((item) => !deleteIdSet.has(String(item?.id || "").trim()));
    const removedCount = beforeCount - index.length;
    if (removedCount > 0) {
      scheduleIndexSnapshotSave("purge_missing_assets");
      applyLibrarySqlCacheChanges({ upsertAssets: [], deleteIds: [...deleteIdSet] }).catch((error) => {
        writeLog("WARN", "applyLibrarySqlCacheChanges failed during purge_missing_assets", { message: error?.message || String(error) });
      });
    }
  }
  return result;
}

async function collectFilesByExtensions(rootPath, extensions) {
  const resolvedRoot = path.resolve(rootPath);
  if (isThumbsFolderPath(resolvedRoot)) {
    return [];
  }
  const rootStat = await statOrNull(resolvedRoot);
  if (!rootStat?.isDirectory()) {
    return [];
  }
  const stack = [resolvedRoot];
  const files = [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!isThumbsFolderPath(fullPath)) {
          stack.push(fullPath);
        }
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.has(ext)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function detectTextureSuffix(filePath) {
  return detectTextureTypeFromFileName(filePath) || normalizeTextureType(path.basename(String(filePath || "")));
}

function isDisplacementTextureSlotName(value) {
  const parsed = parseTextureSlotToken(value);
  const textureType = normalizeTextureSlotName(parsed?.textureType || value || "");
  return textureType === "Displacement" || textureType === "Height";
}

function selectImportTextureSlots(candidates, assetType) {
  const isHdri = String(assetType || "").trim().toLowerCase() === "hdri";
  const grouped = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const source = String(candidate?.source || "").trim();
    const suffix = String(candidate?.suffix || "").trim();
    if (!source || !suffix) continue;
    const parsed = parseTextureSlotToken(suffix);
    const token = String(parsed?.token || suffix).trim();
    const textureType = String(parsed?.textureType || suffix).trim();
    const materialRole = normalizeTextureMaterialRole(candidate?.materialRole, source);
    const ext = path.extname(source).toLowerCase();
    const displacement = isDisplacementTextureSlotName(textureType);
    if (ext === ".exr" && !isHdri && !displacement) continue;
    const key = `${token}|${materialRole}`.toLowerCase();
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ suffix: token, source, textureType, areaIndex: parsed?.areaIndex || 1, materialRole, displacement });
  }
  const rank = (item) => {
    const ext = path.extname(item.source).toLowerCase();
    if (ext === ".png") return 400;
    if (ext === ".exr") return item.displacement ? 300 : 0;
    return 200;
  };
  return [...grouped.values()].map((items) => items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(b.item) - rank(a.item) || a.index - b.index)
    .map((entry) => entry.item)[0]);
}

function hasLodToken(filePath) {
  const base = path.basename(String(filePath || ""), path.extname(String(filePath || ""))).toLowerCase();
  if (!base) {
    return false;
  }
  return /(?:^|[_.-])lod(?:[_-]?\d+)?(?:$|[_.-])/.test(base);
}

function getLodOrder(filePath) {
  const base = path.basename(String(filePath || ""), path.extname(String(filePath || ""))).toLowerCase();
  const match = base.match(/(?:^|[_.-])lod[_-]?(\d+)(?=$|[_.-])/i);
  return match ? Math.max(0, Number(match[1]) || 0) : Number.MAX_SAFE_INTEGER;
}

function normalizeMegascansImportAssetType(value) {
  const token = String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!token) return "";
  if (["3d", "3dasset", "3dassets", "asset3d"].includes(token)) return "3d";
  if (["3dplant", "3dplants", "plant3d"].includes(token)) return "3dplant";
  if (["surface", "surfaces", "material", "materials", "tile", "tiles", "tiling"].includes(token)) return "surface";
  if (["atlas", "atlases"].includes(token)) return "atlas";
  if (["decal", "decals"].includes(token)) return "decal";
  if (["imperfection", "imperfections", "surfaceimperfection"].includes(token)) return "imperfection";
  if (["displacement", "displacements"].includes(token)) return "displacement";
  if (["brush", "brushes"].includes(token)) return "brush";
  if (["hdri", "hdr", "environment", "sky"].includes(token)) return "hdri";
  return "";
}

function collectMegascansStringValues(value, result, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) result.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMegascansStringValues(item, result, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) collectMegascansStringValues(item, result, depth + 1);
  }
}

function resolveMegascansReferencedPath(assetDir, rawPath) {
  const raw = String(rawPath || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return "";
  const cleaned = raw.replace(/^file:\/+/i, "").replace(/^["']|["']$/g, "").replace(/[?#].*$/, "");
  if (!cleaned) return "";
  return path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(assetDir, cleaned.replace(/^[/\\]+/, ""));
}

function inferMegascansAreaId(filePath) {
  const base = path.basename(String(filePath || ""));
  const udimMatch = base.match(/(?:^|[_.-])(1\d{3})(?=[_.-]|$)/);
  if (udimMatch) {
    const udim = Number(udimMatch[1]) || 0;
    if (udim >= 1001 && udim <= 1999) return Math.max(1, udim - 1000);
  }
  const groupMatch = base.match(/(?:^|[_.-])(\d{3})(?=[_.-]|$)/);
  return groupMatch ? Math.max(1, Number(groupMatch[1]) || 1) : 1;
}

function collectMegascansTags(meta) {
  return require("./services/megascansTags").collectMegascansTags(meta);
}

const MEGASCANS_VARIANT_METADATA_KEYS = new Set([
  "variant", "variantkey", "variantname", "variation", "variationkey", "variationname", "variantid", "variationid"
]);

function collectMegascansPathEntries(meta, assetDir) {
  const entries = [];
  const visit = (value, hints = [], variantHints = [], depth = 0) => {
    if (depth > 64 || value === null || value === undefined) return;
    if (typeof value === "string") {
      const resolved = resolveMegascansReferencedPath(assetDir, value);
      const ext = path.extname(resolved).toLowerCase();
      if (MODEL_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext)) {
        entries.push({ filePath: resolved, hints: [...hints, value], variantKey: variantHints.at(-1) || "" });
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, hints, variantHints, depth + 1);
      return;
    }
    if (typeof value === "object") {
      const nextHints = [...hints, ...collectMegascansTextureHints(value)];
      const nextVariantHints = [...variantHints];
      for (const [key, item] of Object.entries(value)) {
        if (!MEGASCANS_VARIANT_METADATA_KEYS.has(key.toLowerCase())) continue;
        if (typeof item !== "string" && typeof item !== "number") continue;
        const variantKey = normalizeModelVariantKey(item);
        if (variantKey) nextVariantHints.push(variantKey);
      }
      for (const [key, item] of Object.entries(value)) {
        visit(item, [...nextHints, key], nextVariantHints, depth + 1);
      }
    }
  };
  visit(meta);
  return entries;
}

// Keep Bridge's typed values, including the nested location tree. The editable
// name/category/tags remain AssetHive-owned and are not accepted through here.
function bridgeSemanticDetails(tags) {
  const keys = ["latin_name", "minSize", "maxSize", "country", "region", "locations", "industry", "resolution", "interior_exterior"];
  return Object.fromEntries(keys.filter(key => tags?.[key] != null && tags[key] !== "").map(key => [key, tags[key]]));
}

async function readMegascansDropMetadata(jsonFiles) {
  const candidates = [];
  for (const jsonPath of jsonFiles) {
    if (/_wind\.json$/i.test(jsonPath) || path.basename(jsonPath).toLowerCase() === "_layer.json" ||
        path.basename(path.dirname(jsonPath)).toLowerCase() === "_layer_data") continue;
    const stats = await statOrNull(jsonPath);
    if (!stats?.isFile() || stats.size > 8 * 1024 * 1024) continue;
    const meta = await loadJson(jsonPath, null);
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
    const assetDir = path.dirname(jsonPath);
    const lowerName = path.basename(jsonPath).toLowerCase();
    const jsonText = JSON.stringify(meta).toLowerCase();
    const score = (lowerName === ASSET_METADATA_FILE_NAME || lowerName === "asset_info.jason" ? 100 : 0)
      + (jsonText.includes("megascans") || jsonText.includes("quixel") || jsonText.includes("bridge") ? 80 : 0)
      + (meta.name || meta.title || meta.displayName ? 10 : 0)
      + (meta.components || meta.maps || meta.meshes ? 10 : 0);
    if (score <= 0) continue;
    candidates.push({ meta, assetDir, metadataFilePath: jsonPath, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const picked = candidates[0];
  if (!picked) return null;
  const meta = picked.meta;
  const assetDir = picked.assetDir;
  // Source identification must come from the metadata payload itself. The
  // dropped folder name is only used to resolve file paths and must not be
  // allowed to stamp a Megascans / PBRMAX source tag.
  const sourceStandardAssetTags = detectSourceStandardAssetTags(meta);
  const name = resolveMegascansName(meta);
  const typeValues = [];
  for (const key of ["asset_type", "assetType", "type", "category", "categories", "assetCategories"]) {
    collectMegascansStringValues(meta?.[key], typeValues);
  }
  collectMegascansStringValues(meta?.semanticTags?.asset_type, typeValues);
  let assetType = isDisplacementMetadata(meta, { legacy: true }) ? "displacement"
    : isImperfectionMetadata(meta) ? "imperfection" : typeValues.map(normalizeMegascansImportAssetType).find(Boolean) || "";
  const pathEntries = collectMegascansPathEntries(meta, assetDir);
  const explicitPreviewUris = [
    materialPreview(meta, assetType)?.uri,
    meta.previews?.preview?.uri,
    ...(Array.isArray(meta.previews?.images) ? meta.previews.images
      .filter((item) => (Array.isArray(item?.tags) && item.tags.some((tag) => String(tag).toLowerCase() === "preview"))
        || hasPreviewTokenInName(item?.uri))
      .map((item) => item?.uri) : []),
    meta.previewImage,
    meta.detailImage
  ];
  let explicitPreview = "";
  for (const uri of explicitPreviewUris) {
    const candidate = resolveMegascansReferencedPath(assetDir, uri);
    if (!IMAGE_EXTENSIONS.has(path.extname(candidate).toLowerCase())
      || looksLikeTextureTypeName(candidate) || isThumbsFolderPath(candidate)) continue;
    if ((await statOrNull(candidate))?.isFile()) {
      explicitPreview = candidate;
      break;
    }
  }
  if (!explicitPreview) {
    const jsonStem = path.basename(picked.metadataFilePath, path.extname(picked.metadataFilePath)).toLowerCase();
    const rootPreviews = (await fs.readdir(assetDir, { withFileTypes: true }).catch(() => []))
      .filter((item) => item.isFile() && IMAGE_EXTENSIONS.has(path.extname(item.name).toLowerCase()))
      .map((item) => path.join(assetDir, item.name))
      .filter((filePath) => /(?:^|[_.-])preview$/i.test(path.basename(filePath, path.extname(filePath)))
        && !looksLikeTextureTypeName(filePath));
    explicitPreview = rootPreviews.find((filePath) =>
      path.basename(filePath, path.extname(filePath)).toLowerCase() === `${jsonStem}_preview`)
      || rootPreviews[0] || "";
  }
  const modelCandidates = [];
  const textureSlots = [];
  const lodTextureCandidates = new Map();
  const previewCandidates = [];
  const seen = new Set();
  for (const entry of pathEntries) {
    const ext = path.extname(entry.filePath).toLowerCase();
    const key = entry.filePath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const exists = await statOrNull(entry.filePath);
    if (!exists?.isFile()) continue;
    if (isThumbsFolderPath(entry.filePath)) continue;
    const isLod = hasLodToken(entry.filePath);
    if (MODEL_EXTENSIONS.has(ext)) {
      modelCandidates.push({ filePath: entry.filePath, variantKey: entry.variantKey });
      continue;
    }
    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    if ((entry.hints || []).some((hint) => ["previews", "previewimage", "detailimage"].includes(String(hint).toLowerCase()))) {
      previewCandidates.push(entry.filePath);
      continue;
    }
    const textureType = (Array.isArray(entry.hints) ? entry.hints : [])
      .map((hint) => normalizeMegascansTextureType(hint, assetType, { opacityAsMasked: true }))
      .find(Boolean) || inferTextureSlotFromFileName(entry.filePath);
    const materialRole = normalizeTextureMaterialRole(
      "",
      [entry.filePath, ...(Array.isArray(entry.hints) ? entry.hints : [])].join("/"),
      "atlas"
    );
    const fileName = path.basename(entry.filePath).toLowerCase();
    const isPreview = /(?:^|[_.-])(preview|thumb|thumbnail)(?:$|[_.-])/.test(fileName) || fileName.includes("render") || fileName.includes("beauty");
    if (isPreview && !looksLikeTextureTypeName(entry.filePath)) previewCandidates.push(entry.filePath);
    if (!textureType) continue;
    const candidate = {
      filePath: entry.filePath,
      textureType,
      areaId: inferMegascansAreaId(entry.filePath),
      materialRole
    };
    if (!isLod) {
      textureSlots.push(candidate);
      continue;
    }
    const slotKey = `${candidate.textureType.toLowerCase()}|${candidate.areaId}|${candidate.materialRole}`;
    const current = lodTextureCandidates.get(slotKey);
    const currentOrder = current ? getLodOrder(current.filePath) : Number.MAX_SAFE_INTEGER;
    const candidateOrder = getLodOrder(candidate.filePath);
    if (!current || candidateOrder < currentOrder) {
      lodTextureCandidates.set(slotKey, candidate);
    }
  }
  const modelLodPlan = buildModelLodPlan(modelCandidates);
  const modelFiles = modelLodPlan.primaryFiles;
  const modelVariants = modelLodPlan.modelVariants.length > 0
    ? modelLodPlan.modelVariants
    : modelFiles.map((filePath) => ({
      file: normalizePath(filePath),
      ...modelVariantMetadataFields(parseModelVariantKey(filePath) || "01")
    }));
  const availableTextureSlots = new Set(textureSlots.map((item) => `${item.textureType.toLowerCase()}|${item.areaId}|${item.materialRole}`));
  for (const [slotKey, candidate] of lodTextureCandidates) {
    if (!availableTextureSlots.has(slotKey)) {
      textureSlots.push(candidate);
    }
  }
  if (!assetType) {
    assetType = modelFiles.length > 0 ? "3d" : (textureSlots.some((item) => item.textureType === "HDR") ? "hdri" : "surface");
  }
  if (assetType === "3dplant" && sourceStandardAssetTags.includes("Megascans") && isBridgeMicroPlant(meta, { name })) {
    sourceStandardAssetTags.push("Micro");
  }
  const sourceTags = [...new Set([...collectMegascansTags(meta),
    ...sourceStandardAssetTags.filter(tag => /^(megascans|pbrmax)$/i.test(tag))])];
  const sourceIdentity = resolveMegascansSourceIdentity({
    metadata: meta,
    metadataFilePath: picked.metadataFilePath,
    assetName: name || path.basename(assetDir),
    assetType,
    standardAssetTags: sourceStandardAssetTags,
    tags: sourceTags
  });
  return {
    name,
    assetType,
    category: resolveMegascansCategory(meta, assetType),
    tags: sourceTags,
    standardAssetTags: sourceStandardAssetTags,
    modelFiles,
    modelVariants,
    modelLods: modelLodPlan.modelLods.map((item) => ({ ...item, file: normalizePath(item.file) })),
    materialNames: meta.materialNames,
    textureSlots: textureSlots.map((entry) => {
      const stored = (Array.isArray(meta.textureEntries) ? meta.textureEntries : []).find((item) =>
        path.basename(item.uri || item.path || "").toLowerCase() === path.basename(entry.filePath).toLowerCase());
      return stored ? { ...entry, areaId: Math.max(1, Number(stored.areaIndex) || 1) } : entry;
    }),
    previewImagePath: explicitPreview || previewCandidates[0] || "",
    nativePlantWind: normalizeNativePlantWind(meta.nativePlantWind),
    sourceSemanticTags: sourceIdentity?.sourceKind === "megascans" ? bridgeSemanticDetails(meta.semanticTags) : undefined,
    sourceClassification: ["imperfection", "displacement"].includes(assetType) ? (meta.sourceClassification || {
      source: "quixel", sourceAssetId: sourceIdentity?.sourceAssetId, assetType,
      assetCategories: meta.assetCategories || {}, categories: meta.categories || [], semanticTags: meta.semanticTags || {}
    }) : undefined,
    sourceIdentity
  };
}

function normalizeDedupeAction(value) {
  const action = String(value || "").trim().toLowerCase();
  return ["inspect", "skip", "update", "new"].includes(action) ? action : "";
}

function normalizeContentIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fingerprintVersion = String(value.fingerprintVersion || "").trim();
  const contentFingerprint = String(value.contentFingerprint || "").trim();
  if (fingerprintVersion !== FINGERPRINT_VERSION || !contentFingerprint) return null;
  return {
    fingerprintVersion,
    contentFingerprint,
    modelFingerprints: value.modelFingerprints && typeof value.modelFingerprints === "object" && !Array.isArray(value.modelFingerprints)
      ? value.modelFingerprints
      : {},
    textureFingerprint: String(value.textureFingerprint || "").trim()
  };
}

function resolveStoredAssetFilePath(assetDir, rawPath) {
  const raw = String(rawPath || "").trim();
  if (!raw) return "";
  return path.resolve(assetDir, path.basename(raw));
}

function getStoredSourceIdentity(target) {
  const meta = target?.meta && typeof target.meta === "object" ? target.meta : {};
  return deriveSourceIdentity({
    assetName: meta.name || target?.name || "",
    assetType: meta.assetType || meta.asset_type || target?.assetType || "3d",
    standardAssetTags: Array.isArray(meta.standardAssetTags) ? meta.standardAssetTags : target?.standardAssetTags,
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    sourceIdentity: meta.identity && typeof meta.identity === "object" ? meta.identity : null
  });
}

function getStoredContentIdentity(target) {
  const identity = target?.meta?.identity;
  if (identity && typeof identity === "object" && String(identity.contentFingerprint || "").trim()) {
    return {
      fingerprintVersion: String(identity.fingerprintVersion || "sha256-v1"),
      contentFingerprint: String(identity.contentFingerprint),
      modelFingerprints: identity.modelFingerprints && typeof identity.modelFingerprints === "object" ? identity.modelFingerprints : {},
      textureFingerprint: String(identity.textureFingerprint || "")
    };
  }
  return null;
}

async function computeStoredContentIdentity(target) {
  const cached = getStoredContentIdentity(target);
  if (cached) return cached;
  const meta = target?.meta && typeof target.meta === "object" ? target.meta : {};
  const assetDir = String(target?.path || (target?.metaPath ? path.dirname(target.metaPath) : "")).trim();
  if (!assetDir) return null;
  const modelSlots = {};
  const modelLodFiles = {};
  const textureSlots = [];
  const modelSource = meta.modelSlots && typeof meta.modelSlots === "object" && !Array.isArray(meta.modelSlots)
    ? meta.modelSlots
    : {};
  for (const [slot, rawPath] of Object.entries(modelSource)) {
    const resolved = resolveStoredAssetFilePath(assetDir, rawPath);
    if (resolved && await statOrNull(resolved)) modelSlots[slot] = resolved;
  }
  if (Array.isArray(meta.modelFiles)) {
    for (const rawPath of meta.modelFiles) {
      const resolved = resolveStoredAssetFilePath(assetDir, rawPath);
      if (!resolved || !(await statOrNull(resolved))) continue;
      const inferred = normalizeIdentityModelSlot(inferModelSlotFromFileName(resolved));
      if (inferred && !modelSlots[inferred]) modelSlots[inferred] = resolved;
    }
  }
  for (const item of Array.isArray(meta.modelLods) ? meta.modelLods : []) {
    const slot = normalizeIdentityModelSlot(item?.slot || inferModelSlotFromFileName(item?.file || item?.path || item?.uri));
    const resolved = resolveStoredAssetFilePath(assetDir, item?.file || item?.path || item?.uri);
    if (!slot || !resolved || !(await statOrNull(resolved))) continue;
    if (!modelLodFiles[slot]) modelLodFiles[slot] = [];
    modelLodFiles[slot].push({ source: resolved, lod: Math.max(0, Math.floor(Number(item?.lod) || 0)) });
  }
  const textureEntries = Array.isArray(meta.textureEntries) ? meta.textureEntries : [];
  for (const item of textureEntries) {
    const rawPath = item?.uri || item?.path || item?.filePath;
    const resolved = resolveStoredAssetFilePath(assetDir, rawPath);
    if (!resolved || !(await statOrNull(resolved))) continue;
    const textureType = normalizeTextureSlotName(item?.textureType || item?.slot || inferTextureSlotFromFileName(resolved));
    if (!textureType) continue;
    const areaIndex = Math.max(1, Number(item?.areaIndex ?? item?.areaId) || 1);
    const suffix = areaIndex <= 1 ? textureType : `${String(areaIndex).padStart(3, "0")}_${textureType}`;
    textureSlots.push({ suffix, source: resolved, areaIndex, materialRole: item?.materialRole || "" });
  }
  if (textureSlots.length === 0 && Array.isArray(target?.textureFiles)) {
    for (const rawPath of target.textureFiles) {
      const resolved = resolveStoredAssetFilePath(assetDir, rawPath);
      if (!resolved || !(await statOrNull(resolved))) continue;
      const textureType = normalizeTextureSlotName(inferTextureSlotFromFileName(resolved));
      if (textureType) textureSlots.push({ suffix: textureType, source: resolved, areaIndex: 1, materialRole: "" });
    }
  }
  if (Object.keys(modelSlots).length === 0 && textureSlots.length === 0) return null;
  try {
    return await computeContentIdentity({ modelSlots, modelLodFiles, textureSlots });
  } catch (error) {
    writeLog("WARN", "failed to compute stored asset content identity", {
      assetId: target?.id || "",
      message: error?.message || String(error)
    });
    return null;
  }
}

function normalizeIdentityModelSlot(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  const legacy = MODEL_SLOT_SUFFIXES.find((item) => item.toLowerCase() === normalized.toLowerCase());
  if (legacy) return legacy;
  if (isMeshSlotName(normalized)) return formatMeshSlotName(getMeshSlotOrder(normalized));
  return normalized;
}

// SQL 快照缓存（库根目录 HiveIndex.sqlite）不持久化 identity。若直接使用缓存
// 加载的索引，重复导入检测会退化成「仅同名同类型」。这里对候选按需回读磁盘
// asset_info.json 的身份信息，命中同源判定后再按同源 / 内容指纹匹配。
async function resolveStoredSourceIdentityWithDiskFallback(target, cache) {
  const meta = target?.meta && typeof target.meta === "object" && !Array.isArray(target.meta) ? target.meta : {};
  const memoryIdentity = meta.identity && typeof meta.identity === "object" && !Array.isArray(meta.identity)
    ? meta.identity
    : null;
  if (memoryIdentity && String(memoryIdentity.sourceKey || "").trim()) {
    return getStoredSourceIdentity(target);
  }
  const metaPath = String(target?.metaPath || "").trim();
  if (!metaPath) {
    return getStoredSourceIdentity(target);
  }
  const cacheKey = normalizeComparePath(metaPath);
  if (cache && cache.has(cacheKey)) {
    return cache.get(cacheKey) || getStoredSourceIdentity(target);
  }
  const diskMeta = await loadJson(metaPath, null).catch(() => null);
  const derived = deriveStoredSourceIdentityFromMetadata(diskMeta, {
    name: String(meta.name || target?.name || "").trim(),
    assetType: meta.assetType || target?.assetType,
    standardAssetTags: Array.isArray(meta.standardAssetTags) ? meta.standardAssetTags : target?.standardAssetTags
  });
  if (!derived) {
    if (cache) cache.set(cacheKey, null);
    return getStoredSourceIdentity(target);
  }
  if (cache) cache.set(cacheKey, derived);
  return derived;
}

async function inspectImportDuplicate({ sourceIdentity, contentIdentity, assetName, assetType }) {
  const incomingName = normalizeSourceToken(assetName);
  const incomingType = String(assetType || "").trim().toLowerCase();
  const diskIdentityCache = new Map();
  let exactSource = null;
  let sameNameType = null;
  for (const target of index) {
    if (!target || target.source !== "custom") continue;
    let storedSource = getStoredSourceIdentity(target);
    let match = evaluateSourceMatch({
      incomingSource: sourceIdentity,
      incomingName,
      incomingType,
      storedSource,
      targetName: target.name,
      targetType: target.assetType
    });
    if (!match.isExactSource && match.nameMatches && match.typeMatches) {
      storedSource = await resolveStoredSourceIdentityWithDiskFallback(target, diskIdentityCache);
      match = evaluateSourceMatch({
        incomingSource: sourceIdentity,
        incomingName,
        incomingType,
        storedSource,
        targetName: target.name,
        targetType: target.assetType
      });
    }
    if (!exactSource && match.isExactSource) {
      exactSource = target;
      continue;
    }
    if (!sameNameType && match.nameMatches && match.typeMatches) {
      sameNameType = target;
    }
  }
  const candidate = exactSource || sameNameType;
  if (!candidate) return null;
  const candidateContent = await computeStoredContentIdentity(candidate);
  const sameContent = Boolean(
    candidateContent?.contentFingerprint
    && contentIdentity?.contentFingerprint
    && candidateContent.contentFingerprint === contentIdentity.contentFingerprint
  );
  let matchKind = "name";
  if (exactSource && sameContent) matchKind = "identical";
  else if (exactSource) matchKind = "source";
  else if (sameContent) matchKind = "content";
  const defaultAction = matchKind === "source" ? "update" : (matchKind === "identical" ? "skip" : "new");
  return {
    candidate: {
      id: candidate.id,
      name: candidate.name,
      assetType: candidate.assetType,
      path: candidate.path,
      source: candidate.source
    },
    matchKind,
    defaultAction,
    sameContent,
    existingContentFingerprint: candidateContent?.contentFingerprint || "",
    message: matchKind === "identical"
      ? "库中已有同源且内容一致的资产"
      : matchKind === "source"
      ? "检测到同源资产，内容或变体已发生变化"
      : matchKind === "content"
      ? "检测到不同来源但内容一致的资产"
      : "检测到同名同类型的资产"
  };
}

async function inspectCharacterIdentity(payload) {
  if (!isCharacterAssetType(payload?.assetType)) return { ok: true };
  const fields = { ...normalizeCharacterFields(payload.assetType, payload.character), category: payload.category, formIds: payload.character?.formIds };
  const identity = characterIdentity(payload.assetType, fields, payload.assetName);
  if (!identity) return { ok: true };
  const candidates = index.filter(asset => asset.source === "custom" && asset.assetType === payload.assetType && characterIdentity(asset.assetType, { ...asset.meta?.character, category: asset.meta?.category }, asset.name) === identity);
  if (candidates.length > 1) return { ok: false, message: "此编号存在多条资产记录，请先核对库内记录，不能自动选择覆盖目标" };
  if (!candidates.length) return { ok: true };
  const { parent } = await require("./services/characterComponents").loadParent(settings.customLibraryPath, candidates[0], ["suit", "monster", "npc", "weapon", "item"]);
  return { ok: true, asset: parent };
}

async function importCustomAsset(payload, sender) {
  const characterImportStartedAt = Date.now();
  if (payload?.__action === "deleteCustom") {
    return deleteCustomAsset({ assetId: payload?.assetId }, sender);
  }
  if (!settings.customLibraryPath) {
    return { ok: false, message: "请先在设置中配置 Standard Library 路径" };
  }
  let assetName = convertChineseToPinyin(String(payload?.assetName || "").trim());
  const assetType = sanitizeToken(payload?.assetType || "");
  const topCategory = getTopCategoryForAssetType(assetType);
  const rawCategory = String(payload?.category || assetType || "custom").trim() || "custom";
  const category = assetType === 'item' ? require('../shared/gameplayCategories.mjs').normalizeCategory(rawCategory) : rawCategory;
  const inputStandardAssetTags = Array.isArray(payload?.standardAssetTags)
    ? payload.standardAssetTags.map((tag) => String(tag || "").trim()).filter(Boolean)
    : (payload?.subType ? [String(payload.subType).trim()] : []);
  const standardAssetTags = [...new Set(inputStandardAssetTags.map(normalizeStandardAssetTag).filter(Boolean))];
  const zionTags = Array.isArray(payload?.zionTags)
    ? payload.zionTags.filter((tag) => typeof tag === "string").map(normalizeAssetTag).filter(Boolean).slice(0, 1)
    : [];
  const inputTags = Array.isArray(payload?.tags)
    ? payload.tags.filter((tag) => typeof tag === "string").map(normalizeAssetTag).filter(Boolean)
    : [];
  const tags = [...new Set([...inputTags, ...inputStandardAssetTags.filter((tag) => /^(megascans|pbrmax)$/i.test(tag))])];
  const isCharacterImport = isCharacterAssetType(assetType);
  if (isCharacterImport) writeLog('INFO', 'character import started', { name: assetName, fileCount: payload?.characterPackageFiles?.length || 0 });
  const characterFields = isCharacterImport ? normalizeCharacterFields(assetType, payload?.character) : null;
  if (assetType === 'item') {
    const identity = require('../shared/gameplayNaming.mjs').gameplayIdentity(category, characterFields.displayNameEn);
    characterFields.name = identity.name;
    characterFields.displayNameEn = identity.name;
  }
  let characterPackageFiles = isCharacterImport && Array.isArray(payload?.characterPackageFiles)
    ? partitionCharacterPackageFiles(payload.characterPackageFiles).accepted
    : [];
  if (isCharacterImport) {
    characterPackageFiles = (await require('./services/characterTextureDuplicates').deduplicateCharacterTextures(characterPackageFiles)).files;
  }
  if (assetType === 'suit') {
    characterPackageFiles = require('../shared/heroPackageRules.mjs').partitionHeroSuitFiles(characterPackageFiles, characterFields, { includeWeapons: false }).accepted;
  }
  const isFamilyImport = isCharacterImport && assetType !== "suit";
  const weaponModelAnalyses = new Map();
  if (assetType === 'weapon' || assetType === 'suit' || assetType === 'monster' || assetType === 'npc' || assetType === 'item') {
    for (const file of characterPackageFiles.filter(file => /\.(fbx|obj|gltf|glb)$/i.test(file))) {
      const analysis = /\.fbx$/i.test(file) ? await require('./services/characterFileInspection').inspectCharacterModel(file) : { meshKind: 'staticMesh' };
      if (analysis.error || !analysis.meshKind) return { ok: false, message: `无法检查模型：${path.basename(file)}` };
      weaponModelAnalyses.set(path.resolve(file).toLowerCase(), analysis);
    }
  }
  const familyPlan = isFamilyImport
    ? buildFamilyPackagePlan(assetType, characterPackageFiles[0] || "", characterPackageFiles, { assetName, category, name: characterFields.name, formIds: characterFields.formIds, modelAnalyses: weaponModelAnalyses })
    : null;
  let monsterAssociation = null;
  const characterPreviewPaths = isCharacterImport && payload?.characterPreviewPaths && typeof payload.characterPreviewPaths === "object"
    ? Object.fromEntries(["front", "left", "right", "back"].map((view) => [view, String(payload.characterPreviewPaths[view] || "").trim()]))
    : {};
  if (isCharacterImport) {
    const collision = await inspectCharacterIdentity(payload);
    if (!collision.ok) return collision;
    if (collision.asset) return { ok: false, message: "相同角色身份／编号已存在。请确认更新此资产，或修改编号后重新导入。", collisionAssetId: collision.asset.id };
    const characterErrors = validateCharacterImport({
      materialNames: payload.materialNames || {},
      modelAnalyses: Object.fromEntries(characterPackageFiles.map(file => [file, weaponModelAnalyses.get(path.resolve(file).toLowerCase()) || {}])),
      assetType,
      assetName,
      category,
      characterFields,
      packageFiles: characterPackageFiles,
      previewPaths: characterPreviewPaths
    });
    if (characterErrors.length > 0) return { ok: false, message: characterErrors[0] };
    if (familyPlan && !familyPlan.ok) return { ok: false, message: familyPlan.errors[0], validationIssues: familyPlan.validationIssues };
    if (familyPlan && assetType === "weapon" && characterFields.serial !== familyPlan.fields.serial) {
      return { ok: false, message: "编号与资产目录不一致，请核对并重新确认结构化字段" };
    }
    if (familyPlan && String(characterFields.name || "").toLowerCase() !== familyPlan.fields.name.toLowerCase()) {
      return { ok: false, message: "资产名称字段与资产目录不一致，请核对并重新确认结构化字段" };
    }
    if (familyPlan?.family === "monster") {
      monsterAssociation = resolveMonsterAssociation(familyPlan, characterFields.relatedAssetId, index);
      if (!monsterAssociation.ok) return monsterAssociation;
      characterFields.formIds = familyPlan.forms.map((form) => form.id);
      assetName = buildMonsterAssetName(characterFields.name, characterFields.formIds);
      familyPlan.assetName = assetName;
    }
    if (familyPlan?.family === 'npc') {
      if (JSON.stringify(characterFields.formIds || []) !== JSON.stringify(familyPlan.fields.formIds || [])) {
        return { ok: false, message: 'NPC 形态与资产名称不一致，请核对两位形态编号' };
      }
      characterFields.serial = '';
      characterFields.formIds = [...(familyPlan.fields.formIds || [])];
    }
    if (assetType === 'weapon' && characterFields.relatedAssetId) {
      const arrow = index.find(asset => asset.id === characterFields.relatedAssetId && asset.assetType === 'weapon');
      if (characterFields.weaponType !== 'Bow' || !arrow || !/^Arrow\d{3}_/.test(arrow.meta?.name || arrow.name)) return { ok: false, message: '配套箭已不存在，请重新选择；弓与箭始终独立管理' };
    }
    for (const filePath of characterPackageFiles) {
      if (!(await statOrNull(filePath))?.isFile()) return { ok: false, message: `角色资产包文件不存在：${filePath}` };
    }
  }
  const pbrMaxDecalTextureOptions = { assetType, standardAssetTags, tags };
  const animationAffiliation = isAnimationAssetType(assetType)
    ? String(payload?.animationAffiliation || "").trim()
    : "";
  if (!assetName) {
    return { ok: false, message: "请填写资产名称" };
  }
  if (!assetType) {
    return { ok: false, message: "请选择资产分类" };
  }
  markInternalLibraryMutation(25000);

  const destination = resolveImportDestinationRoot(assetType, payload?.destinationPath, category);
  if (!destination.ok) {
    return { ok: false, message: destination.message };
  }
  const destinationRoot = destination.destinationRoot;
  await fs.mkdir(destinationRoot, { recursive: true });
  const isAnimationImport = isAnimationAssetType(assetType);

  const sourcePath = String(payload?.sourcePath || "").trim();
  const modelPath = String(payload?.modelPath || "").trim();
  const normalizedNormalMapFormat = normalizeNormalMapFormatValue(payload?.normalMapFormat, "dx");
  const normalizedBaseTiling = normalizeBaseTilingValue(payload?.baseTiling);
  const payloadNormalMapFormats = payload?.normalMapFormats && typeof payload.normalMapFormats === "object" ? payload.normalMapFormats : {};
  const modelSlots = payload?.modelSlots && typeof payload.modelSlots === "object" ? payload.modelSlots : {};
  const textureSlots = payload?.textureSlots && typeof payload.textureSlots === "object" ? payload.textureSlots : {};
  const payloadTextureEntries = Array.isArray(payload?.textureEntries) ? payload.textureEntries : [];
  const isModelAsset = isModelAssetType(assetType);
  const isCustomMeshAssetType = isModelAsset;
  const normalizedModelSlots = Object.entries(modelSlots)
    .filter(([, value]) => typeof value === "string" && value.trim())
    .map(([key, value]) => {
      const normalizedLegacy = MODEL_SLOT_SUFFIXES.find((name) => name.toLowerCase() === String(key).toLowerCase());
      const normalizedMesh = isCustomMeshAssetType && isMeshSlotName(key)
        ? formatMeshSlotName(getMeshSlotOrder(key))
        : "";
      const suffix = normalizedMesh || normalizedLegacy || "";
      if (!suffix) {
        return null;
      }
      return { suffix, source: String(value).trim() };
    })
    .filter(Boolean);
  const payloadModelLodFiles = payload?.modelLodFiles && typeof payload.modelLodFiles === "object" ? payload.modelLodFiles : {};
  const normalizedModelLodFiles = new Map();
  for (const [key, entries] of Object.entries(payloadModelLodFiles)) {
    const normalizedLegacy = MODEL_SLOT_SUFFIXES.find((name) => name.toLowerCase() === String(key).toLowerCase());
    const normalizedMesh = isCustomMeshAssetType && isMeshSlotName(key)
      ? formatMeshSlotName(getMeshSlotOrder(key))
      : "";
    const suffix = normalizedMesh || normalizedLegacy || "";
    if (!suffix) continue;
    const normalizedEntries = (Array.isArray(entries) ? entries : [])
      .map((entry) => {
        const source = String(entry?.filePath || entry?.file || entry?.path || "").trim();
        if (!source || path.extname(source).toLowerCase() !== ".fbx") return null;
        const lod = Number.isFinite(Number(entry?.lod)) ? Math.max(0, Math.floor(Number(entry.lod))) : getLodOrder(source);
        if (!Number.isFinite(lod) || lod === Number.MAX_SAFE_INTEGER) return null;
        return { source, lod };
      })
      .filter(Boolean)
      .sort((left, right) => left.lod - right.lod || left.source.localeCompare(right.source, undefined, { numeric: true, sensitivity: "base" }));
    normalizedModelLodFiles.set(suffix.toLowerCase(), normalizedEntries);
  }
  const normalizedTextureSlots = [];
  const textureSlotSignatures = new Set();
  const addNormalizedTextureSlot = (textureType, areaIndex, source, materialRole = "") => {
    const normalizedType = normalizePbrMaxDecalTextureType(textureType, pbrMaxDecalTextureOptions);
    const normalizedSource = String(source || "").trim();
    if (!normalizedType || !normalizedSource) {
      return;
    }
    const normalizedArea = Math.max(1, Number(areaIndex) || 1);
    const suffix = normalizedArea <= 1
      ? normalizedType
      : `${String(normalizedArea).padStart(3, "0")}_${normalizedType}`;
    const normalizedRole = normalizeTextureMaterialRole(materialRole, normalizedSource);
    const signature = `${suffix}|${normalizedSource.toLowerCase()}|${normalizedRole}`;
    if (textureSlotSignatures.has(signature)) {
      return;
    }
    textureSlotSignatures.add(signature);
    normalizedTextureSlots.push({ suffix, source: normalizedSource, materialRole: normalizedRole });
  };
  for (const entry of payloadTextureEntries) {
    if (!entry || typeof entry !== "object") continue;
    addNormalizedTextureSlot(
      entry.textureType || entry.slot,
      entry.areaId ?? entry.areaIndex,
      entry.filePath || entry.file || entry.path,
      entry.materialRole
    );
  }
  for (const [key, value] of Object.entries(textureSlots)) {
    if (typeof value !== "string" || !value.trim()) continue;
    const separator = key.lastIndexOf("|");
    const baseKey = separator >= 0 ? key.slice(0, separator) : key;
    const roleToken = separator >= 0 ? key.slice(separator + 1) : "";
    const parsed = parseTextureSlotToken(baseKey);
    if (parsed) {
      addNormalizedTextureSlot(parsed.textureType, parsed.areaIndex, value, roleToken);
    }
  }

  const sourceModelCandidates = sourcePath
    ? (await collectFilesByExtensions(sourcePath, MODEL_EXTENSIONS)).filter((filePath) => !hasLodToken(filePath))
    : [];
  const sourceTextureCandidates = sourcePath
    ? (await collectFilesByExtensions(sourcePath, IMAGE_EXTENSIONS))
      .filter((filePath) => !hasLodToken(filePath))
      .map((filePath) => ({ source: filePath, materialRole: normalizeTextureMaterialRole("", filePath) }))
    : [];

  const modelSlotMap = new Map(normalizedModelSlots.map((item) => [item.suffix.toLowerCase(), item]));
  if (modelPath && !modelSlotMap.has("mesh") && !modelSlotMap.has("highpoly")) {
    const fallbackSlot = isCustomMeshAssetType ? "Mesh" : "HighPoly";
    modelSlotMap.set(fallbackSlot.toLowerCase(), { suffix: fallbackSlot, source: modelPath });
  }
  let meshAutoIndex = Math.max(
    1,
    ...[...modelSlotMap.values()]
      .filter((item) => isMeshSlotName(item.suffix))
      .map((item) => getMeshSlotOrder(item.suffix))
      .filter((value) => Number.isFinite(value))
  ) + 1;
  for (const sourceModel of sourceModelCandidates) {
    if (isCustomMeshAssetType) {
      const meshSlot = formatMeshSlotName(meshAutoIndex);
      const meshKey = meshSlot.toLowerCase();
      if (!modelSlotMap.has(meshKey)) {
        modelSlotMap.set(meshKey, { suffix: meshSlot, source: sourceModel });
        meshAutoIndex += 1;
      }
      continue;
    }
    const fileToken = path.basename(sourceModel).toLowerCase();
    const matchedSlot =
      ((fileToken.includes("ztool") || fileToken.endsWith(".ztl")) && "Ztool") ||
      (fileToken.includes("high") && "HighPoly") ||
      (fileToken.includes("lod0") && "Lod0") ||
      (fileToken.includes("lod1") && "Lod1") ||
      (fileToken.includes("lod2") && "Lod2") ||
      (fileToken.includes("lod3") && "Lod3") ||
      "";
    if (!matchedSlot) {
      continue;
    }
    const key = matchedSlot.toLowerCase();
    if (!modelSlotMap.has(key)) {
      modelSlotMap.set(key, { suffix: matchedSlot, source: sourceModel });
    }
  }
  if (isModelAsset && modelSlotMap.size === 0 && sourceModelCandidates.length > 0) {
    if (isCustomMeshAssetType) {
      modelSlotMap.set("mesh", { suffix: "Mesh", source: sourceModelCandidates[0] });
    } else {
      const prioritized = [...sourceModelCandidates].sort((a, b) => {
        const score = (filePath) => {
          const lower = path.basename(filePath).toLowerCase();
          let value = 0;
          if (lower.includes("high")) value += 20;
          if (lower.includes("lod0")) value += 12;
          if (lower.includes("lod")) value -= 6;
          if (lower.includes("low")) value -= 8;
          return value;
        };
        return score(b) - score(a);
      });
      modelSlotMap.set("highpoly", { suffix: "HighPoly", source: prioritized[0] });
    }
  }
  const resolvedModelSlots = sortModelSlotEntries([...modelSlotMap.values()].map((item) => [item.suffix, item])).map(([, item]) => item)
    .filter(item => assetType !== 'suit' || require('../shared/heroPackageRules.mjs').partitionHeroSuitFiles([item.source], characterFields, { includeWeapons: false }).accepted.length > 0);

  const textureCandidates = [...normalizedTextureSlots];
  for (const sourceTexture of sourceTextureCandidates) {
    const detectedSuffix = normalizePbrMaxDecalTextureType(detectTextureSuffix(sourceTexture.source), pbrMaxDecalTextureOptions);
    if (!detectedSuffix) {
      continue;
    }
    textureCandidates.push({ suffix: detectedSuffix, source: sourceTexture.source, materialRole: sourceTexture.materialRole });
  }
  const resolvedTextureSlots = selectImportTextureSlots(textureCandidates, assetType);
  if (isAnimationImport && resolvedModelSlots.length === 0) {
    return { ok: false, message: "请至少选择一个动画文件（FBX）" };
  }
  if (isModelAssetType(assetType) && !isAnimationAssetType(assetType) && !isFamilyImport && resolvedModelSlots.length === 0 && resolvedTextureSlots.length === 0) {
    return { ok: false, message: "请至少导入模型或贴图" };
  }
  if (!isModelAssetType(assetType) && resolvedTextureSlots.length === 0) {
    return { ok: false, message: "请至少导入一张贴图" };
  }

  const sourceIdentityInput = payload?.sourceIdentity && typeof payload.sourceIdentity === "object" && !Array.isArray(payload.sourceIdentity)
    ? { ...payload.sourceIdentity }
    : {};
  const inferredPbrMaxSourceAssetId = resolvePbrMaxSourceAssetId({
    filePaths: [
      ...resolvedModelSlots.map((item) => item.source),
      ...[...normalizedModelLodFiles.values()].flatMap((entries) => entries.map((entry) => entry.source)),
      ...resolvedTextureSlots.map((item) => item.source),
      ...sourceModelCandidates,
      ...sourceTextureCandidates.map((item) => item.source)
    ],
    folderNames: [
      sourcePath ? path.basename(sourcePath) : "",
      ...[...resolvedModelSlots, ...resolvedTextureSlots].map((item) => path.basename(path.dirname(item.source)))
    ],
    standardAssetTags,
    tags: [...tags, ...zionTags]
  });
  if (!sourceIdentityInput.sourceAssetId && inferredPbrMaxSourceAssetId) {
    sourceIdentityInput.sourceAssetId = inferredPbrMaxSourceAssetId;
    if (!sourceIdentityInput.sourceKey || /^pbrmax:/i.test(String(sourceIdentityInput.sourceKey))) {
      sourceIdentityInput.sourceKey = `pbrmax:${normalizeSourceToken(inferredPbrMaxSourceAssetId)}`;
    }
  }
  const sourceIdentity = deriveSourceIdentity({
    assetName,
    assetType,
    standardAssetTags,
    tags: [...tags, ...zionTags],
    sourceIdentity: sourceIdentityInput
  });
  const contentIdentity = normalizeContentIdentity(payload?.contentIdentity) || await computeContentIdentity({
    ...(isCharacterImport ? { hashFile: async source => (await require('./services/characterFileInspection').inspectCharacterFile(source)).sourceHash } : {}),
    modelSlots: resolvedModelSlots.map((item) => ({ suffix: item.suffix, source: item.source })),
    modelLodFiles: normalizedModelLodFiles,
    textureSlots: resolvedTextureSlots.map((item) => ({
      suffix: item.suffix,
      source: item.source,
      materialRole: item.materialRole,
      areaIndex: parseTextureSlotToken(item.suffix)?.areaIndex || 1
    }))
  });
  // 导入重复检测暂时停用；原有检查和处理策略保留，供重新启用。
  // Monster forms always create separate records; association validation above handles same-form conflicts.
  const inspection = assetType === "monster" || payload?.skipDuplicateCheck === true ? null : await inspectImportDuplicate({
    sourceIdentity,
    contentIdentity,
    assetName,
    assetType
  });
  const requestedDedupeAction = normalizeDedupeAction(payload?.dedupeAction);
  if (!requestedDedupeAction || requestedDedupeAction === "inspect") {
    if (inspection) {
      return {
        ok: true,
        duplicate: true,
        action: "inspect",
        candidate: inspection.candidate,
        matchKind: inspection.matchKind,
        defaultAction: inspection.defaultAction,
        sameContent: inspection.sameContent,
        contentFingerprint: contentIdentity.contentFingerprint,
        contentIdentity,
        message: inspection.message
      };
    }
    if (requestedDedupeAction === "inspect") {
      return {
        ok: true,
        duplicate: false,
        contentFingerprint: contentIdentity.contentFingerprint,
        contentIdentity,
        message: ""
      };
    }
  }
  const selectedDedupeAction = requestedDedupeAction || inspection?.defaultAction || "new";
  if (selectedDedupeAction === "skip" && inspection) {
    return {
      ok: true,
      duplicate: true,
      skipped: true,
      action: "skip",
      candidate: inspection.candidate,
      matchKind: inspection.matchKind,
      contentFingerprint: contentIdentity.contentFingerprint,
      message: "检测到重复资产，已跳过写入"
    };
  }
  if (selectedDedupeAction === "update" && inspection?.candidate) {
    const updateResult = await updateCustomAsset({
      ...payload,
      assetId: inspection.candidate.id,
      sourceIdentity,
      contentIdentity,
      dedupeAction: "update"
    }, sender);
    return {
      ...updateResult,
      duplicate: true,
      action: "update",
      candidate: inspection.candidate,
      matchKind: inspection.matchKind,
      contentFingerprint: contentIdentity.contentFingerprint
    };
  }

  let assetIdentity = await makeAssetIdentity(assetType, assetName, destinationRoot);
  let resumedReservation = false;
  if (payload?.queueId) {
    const modelSource = resolvedModelSlots[0]?.source || "";
    const proofPath = isAnimationImport
      ? getAnimationIdentitySidecarPath(path.join(assetIdentity.destinationDir, `${makeCustomAnimationBaseName(modelSource)}${path.extname(modelSource)}`))
      : path.join(assetIdentity.destinationDir, ASSET_METADATA_FILE_NAME);
    const reservation = await getImportQueueStore().reserve(settings.customLibraryPath, payload.queueId, {
      assetIdentity, assetId: assetIdentity.uniqueId, assetPath: assetIdentity.destinationDir, proofPath, assetType, destinationRoot
    });
    resumedReservation = reservation.assetIdentity?.uniqueId !== assetIdentity.uniqueId;
    assetIdentity = reservation.assetIdentity || assetIdentity;
  }
  const uniqueId = assetIdentity.uniqueId;
  let reportedCharacterProgress = 0;
  const characterProgress = (value, message) => {
    if (!isCharacterImport) return;
    value = reportedCharacterProgress = Math.max(reportedCharacterProgress, Math.min(100, value));
    emitCustomSaveProgress(sender, uniqueId, value, `character:${message}`);
    writeLog('INFO', 'character import progress', { assetId: uniqueId, progress: Math.round(value), message, elapsedMs: Date.now() - characterImportStartedAt });
  };
  characterProgress(5, '正在保存模型');
  if (monsterAssociation) {
    // A new monster receives an independent identity even when another monster has the same name.
    characterFields.entityKey = monsterAssociation.entityKey || `monster:asset:${uniqueId}`;
    familyPlan.entityKey = characterFields.entityKey;
  }
  let assetFolderName = assetIdentity.assetFolderName;
  const destinationDir = assetIdentity.destinationDir;
  let metadataFileName = ASSET_METADATA_FILE_NAME;
  const characterDestinationNameCounts = new Map();
  const reserveCharacterDestinationBaseName = (sourcePath, fallback = "Asset") => {
    const stem = path.basename(String(sourcePath || ""), path.extname(String(sourcePath || ""))).trim() || fallback;
    const safeStem = stem.replace(/[<>:"/\\|?*]+/g, "_");
    const key = safeStem.toLowerCase();
    const count = (characterDestinationNameCounts.get(key) || 0) + 1;
    characterDestinationNameCounts.set(key, count);
    return count === 1 ? safeStem : `${safeStem}_${String(count).padStart(2, "0")}`;
  };
  const characterMaterialGroups = isCharacterImport && payload?.materialNames && typeof payload.materialNames === "object"
    ? Object.fromEntries(Object.entries(payload.materialNames).map(([areaIndex, name]) => [String(areaIndex), String(name || "").trim()]).filter(([, name]) => name))
    : {};
  const normalizedCharacterMaterialNames = isFamilyImport
    ? Object.fromEntries([...new Set((familyPlan?.files || [])
      .filter((item) => item.role === "material" || item.role === "texture")
      .map((item) => {
        const stem = path.basename(item.normalizedName, path.extname(item.normalizedName)).replace(/^T_/i, "MI_");
        return item.role === "texture" && getFamilyTextureMapCode(stem) ? stem.slice(0, stem.lastIndexOf("_")) : stem;
      }))]
      .map((name, index) => [index + 1, name]))
    : (isCharacterImport
      ? Object.fromEntries(Object.entries(characterMaterialGroups).map(([areaIndex, groupName]) => [
          areaIndex,
          buildCharacterMaterialBaseName(assetName, groupName, characterFields)
        ]))
      : null);
  const familyMaterialAreas = new Map(isFamilyImport
    ? Object.entries(normalizedCharacterMaterialNames || {}).map(([area, name]) => [String(name).toLowerCase(), Number(area)])
    : []);
  if (assetIdentity.wrapFolder !== false) {
    await fs.mkdir(destinationDir, { recursive: true });
  }
  if (isAnimationImport) {
    for (const model of resolvedModelSlots) {
      const stem = makeCustomAnimationBaseName(model.source);
      const destPath = path.join(destinationDir, `${stem}${path.extname(model.source)}`);
      if (!resumedReservation && await statOrNull(destPath)) {
        return { ok: false, message: `归档目录已存在同名动画：${stem}` };
      }
    }
  }

  const copiedModelEntries = [];
  const copiedModelLodEntries = [];
  const copiedPlantLayerLods = [];
  const copiedTextureFiles = [];
  const characterModelAnalyses = new Map();
  if (isCharacterImport) {
    for (const model of familyPlan ? familyPlan.files.filter(item => ["staticMesh", "skeletalMesh"].includes(item.role)).map(item => ({ source: item.sourcePath })) : resolvedModelSlots) {
      const ext = path.extname(model.source).toLowerCase();
      if (![".fbx", ".obj", ".abc", ".gltf", ".glb"].includes(ext)) continue;
      if (ext !== ".fbx") {
        characterModelAnalyses.set(path.resolve(model.source).toLowerCase(), { meshKind: "staticMesh", hasSkeleton: false, hasSkin: false, boneCount: 0, skinnedMeshCount: 0 });
        continue;
      }
      const analysis = weaponModelAnalyses.get(path.resolve(model.source).toLowerCase()) || await require('./services/characterFileInspection').inspectCharacterModel(model.source);
      if (analysis.error || !["staticMesh", "skeletalMesh"].includes(analysis.meshKind)) {
        return { ok: false, message: `无法检查模型是否包含骨骼：${path.basename(model.source)}${analysis.error ? `\n${analysis.error}` : ""}` };
      }
      characterModelAnalyses.set(path.resolve(model.source).toLowerCase(), analysis);
    }
  }
  if (familyPlan) require("./services/characterFamilyRules").applyFamilyModelAnalyses(familyPlan, characterModelAnalyses);
  const familyArchivedBySource = new Map();
  if (familyPlan) {
    let copied = 0;
    const familyCopies = await boundedMap(familyPlan.files, 3, async item => {
      const folder = path.join(destinationDir, ...item.relativePath.split("/").slice(0, -1));
      await fs.mkdir(folder, { recursive: true });
      const copiedPath = await copyRenamedFile(item.sourcePath, folder, path.basename(item.normalizedName, path.extname(item.normalizedName)), true);
      if (!copiedPath) throw new Error(`角色资产文件入库失败：${item.sourceName}`);
      characterProgress(5 + ++copied / familyPlan.files.length * 45, `正在保存文件 ${copied}/${familyPlan.files.length}`);
      return copiedPath;
    });
    for (const [fileIndex, item] of familyPlan.files.entries()) {
      const copiedPath = familyCopies[fileIndex];
      const key = path.resolve(item.sourcePath).toLowerCase();
      const analysis = characterModelAnalyses.get(key);
      const archived = { ...(analysis || {}), role: item.role, destination: copiedPath, ...(item.formId ? { formId: item.formId } : {}),
        ...(item.unresolvedFormToken ? { unresolvedFormToken: item.unresolvedFormToken } : {}),
        ...(item.sharedAcrossForms ? { sharedAcrossForms: true, sourceFormId: item.sourceFormId } : {}),
        ...(item.componentRole ? { componentRole: item.componentRole, componentName: item.componentName } : {}) };
      familyArchivedBySource.set(key, archived);
      const ext = path.extname(copiedPath).toLowerCase();
      if (["skeletalMesh", "staticMesh"].includes(item.role) && MODEL_EXTENSIONS.has(ext)) {
        copiedModelEntries.push({ ...(analysis || {}), role: item.role, suffix: formatMeshSlotName(copiedModelEntries.length + 1), path: copiedPath, source: item.sourcePath, variantKey: "" });
      }
      if (item.role === "texture" && IMAGE_EXTENSIONS.has(ext)) {
        const textureStem = path.basename(copiedPath, ext);
        const materialName = textureStem.slice(0, textureStem.lastIndexOf("_")).replace(/^T_/i, "MI_");
        archived.materialName = materialName;
        archived.textureType = ({ D: "Diffuse", N: "Normal", ORM: "ORM", A: "Opacity", Emissive: "Emissive" })[item.textureMapCode] || "MAP";
        copiedTextureFiles.push({
          suffix: archived.textureType, textureType: archived.textureType, areaIndex: familyMaterialAreas.get(materialName.toLowerCase()) || 1,
          materialRole: "", source: item.sourcePath, materialName, textureGroup: materialName,
          path: copiedPath
        });
      }
    }
  }
  const meshVariantKeys = buildModelVariantKeyMap(
    resolvedModelSlots
      .filter((model) => isMeshSlotName(model.suffix))
      .map((model) => [model.suffix, model.source]),
    payload?.modelVariantKeys
  );
  for (const model of isFamilyImport ? [] : resolvedModelSlots) {
    const modelExt = path.extname(model.source).toLowerCase();
    if (!MODEL_EXTENSIONS.has(modelExt)) {
      return { ok: false, message: "模型格式无效，请选择 fbx/obj/abc/gltf/glb" };
    }
    const slotKey = String(model.suffix || "").toLowerCase();
    const characterModelAnalysis = characterModelAnalyses.get(path.resolve(model.source).toLowerCase());
    const characterMeshKind = characterModelAnalysis?.meshKind || "staticMesh";
    const modelDestinationDir = isCharacterImport ? path.join(destinationDir, "Mesh", characterMeshKind === "skeletalMesh" ? "SkeletalMesh" : "StaticMesh") : destinationDir;
    if (isCharacterImport) await fs.mkdir(modelDestinationDir, { recursive: true });
    const copiedModel = await copyRenamedFile(
      model.source,
      modelDestinationDir,
      isAnimationAssetType(assetType)
        ? makeCustomAnimationBaseName(model.source)
        : (isCharacterImport
          ? buildCharacterModelBaseName(assetName, model.source, characterFields, characterMeshKind)
          : makeCustomModelBaseName(model.suffix, assetName, uniqueId, {
          variantKey: meshVariantKeys.get(slotKey) || parseModelVariantKey(model.source)
        })),
      isCharacterImport
    );
    if (!copiedModel) {
      return { ok: false, message: `模型文件不存在：${model.suffix}` };
    }
    const variantKey = isMeshSlotName(model.suffix)
      ? (meshVariantKeys.get(slotKey) || parseModelVariantKey(model.source) || "01")
      : "";
    copiedModelEntries.push({
      suffix: model.suffix,
      path: copiedModel,
      source: model.source,
      ...(isCharacterImport ? { role: characterMeshKind,
        hasSkeleton: characterModelAnalysis?.hasSkeleton === true,
        hasSkin: characterModelAnalysis?.hasSkin === true,
        boneCount: Number(characterModelAnalysis?.boneCount) || 0,
        skinnedMeshCount: Number(characterModelAnalysis?.skinnedMeshCount) || 0 } : {}),
      variantKey,
      ...(variantKey ? modelVariantMetadataFields(variantKey) : {})
    });

    const lodCandidates = normalizedModelLodFiles.get(slotKey) || [];
    const copiedLodOrders = new Set();
    for (const lodCandidate of lodCandidates) {
      if (copiedLodOrders.has(lodCandidate.lod)) continue;
      copiedLodOrders.add(lodCandidate.lod);
      let copiedLodPath = "";
      if (path.resolve(lodCandidate.source).toLowerCase() === path.resolve(model.source).toLowerCase()) {
        copiedLodPath = copiedModel;
      } else {
        copiedLodPath = await copyRenamedFile(
          lodCandidate.source,
          modelDestinationDir,
          isCharacterImport
            ? `${buildCharacterModelBaseName(assetName, lodCandidate.source, characterFields, characterMeshKind)}_LOD${lodCandidate.lod}`
            : makeCustomModelLodBaseName(assetName, uniqueId, variantKey, lodCandidate.lod)
        );
      }
      if (!copiedLodPath) {
        return { ok: false, message: `LOD 文件不存在：${path.basename(lodCandidate.source)}` };
      }
      copiedModelLodEntries.push({
        slot: model.suffix,
        path: copiedLodPath,
        source: lodCandidate.source,
        variantKey,
        ...(isCharacterImport ? { role: characterMeshKind } : {}),
        lod: lodCandidate.lod,
        ...(variantKey ? modelVariantMetadataFields(variantKey) : {})
      });
      copiedPlantLayerLods.push({ path: copiedLodPath, source: lodCandidate.source,
        variantKey, lod: lodCandidate.lod });
    }
  }
  if (assetType === "3dplant" && sourceIdentity.sourceAssetId) {
    const models = copiedModelEntries.flatMap((entry, index) => entry.variantKey
      ? [{ ...entry, source: resolvedModelSlots[index].source }] : []);
    await importPlantLayers(sourceIdentity.sourceAssetId, models, destinationDir, copiedPlantLayerLods);
  }
  if (isAnimationImport && copiedModelEntries[0]?.path) {
    const stem = path.basename(copiedModelEntries[0].path, path.extname(copiedModelEntries[0].path));
    assetFolderName = stem;
    await cleanupAnimationArchiveExtras(destinationDir, stem);
  }

  const saveImportTexture = async texture => {
    characterProgress(15 + copiedTextureFiles.length / Math.max(1, resolvedTextureSlots.length) * 35, `正在保存贴图 ${copiedTextureFiles.length}/${resolvedTextureSlots.length}`);
    const parsedTextureSlot = parseTextureSlotToken(texture.suffix);
    const textureSlotToken = parsedTextureSlot?.token || String(texture.suffix || "").trim();
    const textureExt = path.extname(texture.source).toLowerCase();
    const isHdriTexture = assetType.toLowerCase() === "hdri";
    const isDisplacementTexture = isDisplacementTextureSlotName(parsedTextureSlot?.textureType || texture.suffix);
    if (isHdriTexture) {
      if (textureExt !== ".hdr" && textureExt !== ".exr") {
        return { ok: false, message: "HDRI 仅支持导入 .hdr 或 .exr" };
      }
    } else if (!isCharacterImport && textureExt === ".exr" && !isDisplacementTexture) {
      return null;
    }

    const characterTextureGroup = isCharacterImport
      ? (characterMaterialGroups[String(parsedTextureSlot?.areaIndex || 1)] || inferCharacterTextureGroup(texture.source))
      : "";
    const textureBaseName = isCharacterImport
      ? buildCharacterTextureBaseName(
          assetName,
          characterTextureGroup,
          parsedTextureSlot?.textureType || textureSlotToken,
          texture.source,
          characterFields
        )
      : makeCustomTextureBaseName(texture.suffix, assetName, uniqueId, texture.materialRole);
    let copiedTexture = null;
    try {
      const textureDestinationDir = isCharacterImport ? path.join(destinationDir, "Texture") : destinationDir;
      if (isCharacterImport) await fs.mkdir(textureDestinationDir, { recursive: true });
      copiedTexture = await copyTextureIntoLibrary(texture.source, textureDestinationDir, textureBaseName, {
        isHdri: isHdriTexture,
        isDisplacement: isDisplacementTexture,
        preserveOriginal: isCharacterImport,
        characterCopy: isCharacterImport
      });
    } catch (error) {
      return { ok: false, message: `贴图入库失败：${path.basename(texture.source)}（${error?.message || String(error)}）` };
    }
    if (!copiedTexture?.path || !(await statOrNull(copiedTexture.path))?.isFile()) {
      return { ok: false, message: `贴图不存在：${texture.suffix}` };
    }
    copiedTextureFiles.push({
      suffix: textureSlotToken,
      textureType: parsedTextureSlot?.textureType || textureSlotToken,
      areaIndex: parsedTextureSlot?.areaIndex || 1,
      materialRole: normalizeTextureMaterialRole(texture.materialRole, texture.source),
      source: texture.source,
      ...(isCharacterImport ? {
        materialName: buildCharacterMaterialBaseName(assetName, characterTextureGroup, characterFields),
        textureGroup: characterTextureGroup
      } : {}),
      ...copiedTexture
    });
    characterProgress(15 + copiedTextureFiles.length / Math.max(1, resolvedTextureSlots.length) * 35, `正在保存贴图 ${copiedTextureFiles.length}/${resolvedTextureSlots.length}`);
    return null;
  };
  const texturesToCopy = isFamilyImport ? [] : resolvedTextureSlots;
  const textureCopyConcurrency = isCharacterImport ? 3 : 1;
  const textureCopyResults = await boundedMap(texturesToCopy, textureCopyConcurrency, saveImportTexture);
  const textureCopyFailure = textureCopyResults.find(result => result?.ok === false);
  if (textureCopyFailure) return textureCopyFailure;

  let characterManifest = null;
  let characterMetrics = null;
  if (isCharacterImport) {
    const normalizedSourceKey = (filePath) => path.resolve(String(filePath || "")).toLowerCase();
    const archivedBySource = new Map(familyArchivedBySource);
    for (const item of copiedModelEntries) {
      if (!archivedBySource.has(normalizedSourceKey(item.source))) {
        archivedBySource.set(normalizedSourceKey(item.source), { role: item.role || "staticMesh", destination: item.path,
          ...(item.hasSkeleton !== undefined ? { hasSkeleton: item.hasSkeleton, hasSkin: item.hasSkin, boneCount: item.boneCount, skinnedMeshCount: item.skinnedMeshCount } : {}) });
      }
    }
    for (const item of copiedModelLodEntries) {
      archivedBySource.set(normalizedSourceKey(item.source), { role: item.role || "staticMesh", destination: item.path });
    }
    for (const item of copiedTextureFiles) {
      if (archivedBySource.has(normalizedSourceKey(item.source))) continue;
      archivedBySource.set(normalizedSourceKey(item.source), {
        role: "texture",
        destination: item.path,
        materialName: item.materialName,
        textureGroup: item.textureGroup,
        textureType: item.textureType
      });
    }

    const supportCandidates = characterPackageFiles.filter((filePath) => isAllowedCharacterPackageFile(filePath)
      && !archivedBySource.has(normalizedSourceKey(filePath)));
    let supportTextureIndex = 0;
    for (const [supportIndex, sourceFile] of supportCandidates.entries()) {
      characterProgress(50 + supportIndex / Math.max(1, supportCandidates.length) * 8, `正在保存配套文件 ${supportIndex + 1}/${supportCandidates.length}`);
      const role = classifyCharacterPackageFile(sourceFile);
      const isTexture = role === "texture";
      const textureGroup = isTexture ? (inferCharacterTextureGroup(sourceFile) || `Texture${String(++supportTextureIndex).padStart(2, "0")}`) : "";
      const targetDir = path.join(destinationDir, isTexture ? "Texture" : "SourceFiles");
      await fs.mkdir(targetDir, { recursive: true });
      const baseName = isTexture
        ? buildCharacterTextureBaseName(assetName, textureGroup, inferCharacterTextureType(sourceFile), sourceFile, characterFields)
        : `SRC_${assetName}_${reserveCharacterDestinationBaseName(sourceFile, "SourceFile")}`;
      const copiedPath = await copyRenamedFile(
        sourceFile,
        targetDir,
        baseName,
        true
      );
      if (!copiedPath) return { ok: false, message: `角色配套文件入库失败：${path.basename(sourceFile)}` };
      archivedBySource.set(normalizedSourceKey(sourceFile), {
        role,
        destination: copiedPath,
        ...(isTexture ? {
          materialName: buildCharacterMaterialBaseName(assetName, textureGroup, characterFields),
          textureGroup,
          textureType: inferCharacterTextureType(sourceFile) || "MAP"
        } : {})
      });
    }

    const files = [];
    for (const sourceFile of characterPackageFiles.filter(isAllowedCharacterPackageFile)) {
      const archived = archivedBySource.get(normalizedSourceKey(sourceFile));
      if (!archived?.destination) return { ok: false, message: `角色资产包文件未被收录：${path.basename(sourceFile)}` };
      const stat = await statOrNull(archived.destination);
      files.push({
        originalPath: normalizePath(sourceFile),
        originalName: path.basename(sourceFile),
        normalizedName: path.basename(archived.destination),
        storedPath: normalizePath(path.relative(destinationDir, archived.destination)),
        role: archived.role,
        ...(archived.formId ? { formId: archived.formId } : {}),
        ...(archived.unresolvedFormToken ? { unresolvedFormToken: archived.unresolvedFormToken } : {}),
        ...(archived.componentRole ? { componentRole: archived.componentRole, componentName: archived.componentName } : {}),
        ...(archived.sharedAcrossForms ? { sharedAcrossForms: true, sourceFormId: archived.sourceFormId } : {}),
        ...(archived.materialName ? { materialName: archived.materialName } : {}),
        ...(archived.textureGroup ? { textureGroup: archived.textureGroup } : {}),
        ...(archived.textureType ? { textureType: archived.textureType } : {}),
        ...(archived.hasSkeleton !== undefined ? { hasSkeleton: archived.hasSkeleton, hasSkin: archived.hasSkin, boneCount: archived.boneCount, skinnedMeshCount: archived.skinnedMeshCount } : {}),
        size: stat?.size || 0,
        sha256: (await require('./services/characterFileInspection').inspectCharacterFile(archived.destination)).sourceHash
      });
    }
    characterProgress(60, '正在整理文件信息');
    const analysisSources = [...new Set([...(payload?.characterAnalysisSourcePaths || []), ...(payload?.characterPackageFiles || [])])]
      .filter(file => typeof file === 'string' && /\.(ma|mb)$/i.test(file))
      .map(sourcePath => ({ role: 'source', sourcePath, normalizedName: path.basename(sourcePath) }));
    characterMetrics = await refreshCharacterTriangleMetrics([...files, ...analysisSources], destinationDir);
    characterManifest = {
      schemaVersion: "1.0",
      family: assetType,
      fields: characterFields,
      completeness: "complete",
      maturity: characterFields.maturity,
      confirmed: true,
      confirmedAt: new Date().toISOString(),
      fileCount: files.length,
      metrics: characterMetrics,
      files,
      ...(familyPlan ? {
        ruleCategory: familyPlan.category,
        ruleAssetName: familyPlan.assetName,
        ruleWarnings: familyPlan.warnings,
        ...(familyPlan.entityKey ? { entityKey: familyPlan.entityKey, forms: familyPlan.forms, sharedFiles: familyPlan.sharedFiles, unassignedFiles: familyPlan.unassignedFiles } : {})
      } : {})
    };
  }


  const importWarnings = [...(familyPlan?.warnings || [])];
  let nativePlantWind = null;
  if (isZionPlantAsset({ assetType, standardAssetTags, tags, zionTags })) {
    nativePlantWind = normalizeNativePlantWind(payload?.nativePlantWind);
    if (!nativePlantWind) {
      const detectedWind = await detectNativePlantWind({
        modelFiles: [...normalizedModelSlots.map((item) => item.source), modelPath].filter(Boolean),
        rootDir: sourcePath
      });
      nativePlantWind = detectedWind.profile;
      importWarnings.push(...detectedWind.warnings);
    }
  }
  const foliageOpaqueRequested = !isZionPlantAsset({ assetType, standardAssetTags, tags, zionTags })
    && (payload?.foliageOpaque === true || payload?.foliageOpaque?.enabled === true);
  // 裁切面数预设（0 = 插件按自己的档位表；> 0 = 操作者覆盖）：在下面的裁切块里算出，
  // 但写资产元数据的地方在块外，块内 const 读不到 —— 所以先在这里占位。
  let opaqueFaceBudgetForMeta = 0;
  if (foliageOpaqueRequested && isCustomMeshAssetType && !isAnimationImport) {
    const opaqueOptions = payload?.foliageOpaque || {};
    // 面数设置为 0（或不填）时按植被子类档位推导面数预设，填了数值则用该值覆盖。
    // 预设含义 = 这批 _OPAQUE 变体的**面数上限**：插件侧以上限设 Nanite 保留百分比，
    // 界面用它做超限提示。
    // 注意：导出不再自动减面（生成多少面导出多少，收敛交给 UE 侧 Nanite），
    // 因此这里解析出的只是"预设/闸门"，不再当 QEM 目标。
    const opaqueBudgetRange = opaqueOptions.faceBudgetAuto === true
      ? resolvePlantOpaqueBudgetRange({
          tags: [...standardAssetTags, ...tags],
          category: payload?.category
        })
      : null;
    // 自动档取档位**上限**（= 插件侧的裁切档上限，Grass 15 万 / Bush 30 万）。
    const opaqueFaceBudget = opaqueBudgetRange ? opaqueBudgetRange.ceiling
      : (Number(opaqueOptions.faceBudget) || 0);
    // 供块外的元数据写入使用（见 opaqueFaceBudgetForMeta 的声明）。
    opaqueFaceBudgetForMeta = opaqueFaceBudget;
    const opaqueSimplifyTarget = 0;
    // 裁切是入库里最长的阶段（12 变体约 6 分钟），此前这里完全静默：
    // importCustomAsset 不发进度事件，界面进度环一动不动，用户只能认为
    // 导入已经结束，关闭应用时却提示"还有资产在导入"。裁切约占入库墙钟的
    // 九成，映射到 10..60；其余阶段（贴图/预览/元数据）在收尾统一跳到 100。
    emitCustomSaveProgress(sender, uniqueId, 10, "foliage-opaque");
    const opaqueResult = await buildFoliageOpaqueVariants({
      destinationDir,
      modelEntries: copiedModelEntries,
      lodEntries: copiedModelLodEntries,
      textureEntries: copiedTextureFiles,
      // 裁切参数来自导入界面：轮廓精度（纹素）、面数预设（0 = 按植被档位自动，填值覆盖）、
      // 裁切后的细碎面片清理的区域大小比率阈值（百分比，0 = 关闭清理），
      // 以及细分目标（纹素）。导出不再自动减面：生成多少面导出多少面，收敛交给 UE 侧 Nanite。
      contourPrecisionTexels: opaqueOptions.contourPrecisionTexels,
      maskErodeTexels: opaqueOptions.maskErodeTexels,
      // 孔洞填充（含面积上限）：把白色区域内含的黑色孔洞填成白色，边界只留外轮廓。
      // 关闭时保留原遮罩（孔洞会切出额外内环与碎面）。见 worker 的 fillMaskHoles。
      fillHoles: opaqueOptions.fillHoles,
      holeMaxAreaTexels: opaqueOptions.holeMaxAreaTexels,
      faceBudget: opaqueFaceBudget,
      // 自动档的浮动区间：处理器在生成后按复杂度把目标定在 下限..上限 之间。
      faceBudgetFloor: opaqueBudgetRange ? opaqueBudgetRange.floor : 0,
      faceBudgetCeiling: opaqueBudgetRange ? opaqueBudgetRange.ceiling : 0,
      cleanupPercent: opaqueOptions.cleanupPercent,
      subdivideTexels: opaqueOptions.subdivideTexels,
      simplifyTarget: opaqueSimplifyTarget,
      traceStepTexels: opaqueOptions.traceStepTexels,
      // Trace 生成阶段的面数上限（0/缺省 = 处理器默认 100 万面）：见 foliageOpaque.js
      // 的 DEFAULT_TRACE_MAX_FACES —— 它是该阶段唯一的内存闸门。
      traceMaxFaces: opaqueOptions.traceMaxFaces,
      isMeshSlot: isMeshSlotName,
      meshSlotNameForOrder: formatMeshSlotName,
      nameForModel: (variantKey) => makeCustomModelBaseName("Mesh", assetName, uniqueId, { variantKey }),
      variantFields: (variantKey) => modelVariantMetadataFields(variantKey),
      // 逐变体进度：12 个变体并行分片跑，进度按输出路径去重后聚合（见 foliageOpaque.js）。
      onProgress: (progress) => {
        const done = Math.max(0, Math.floor(Number(progress?.done) || 0));
        const total = Math.max(1, Math.floor(Number(progress?.total) || 1));
        emitCustomSaveProgress(sender, uniqueId,
          10 + Math.round(50 * (done / total)),
          `foliage-opaque ${done}/${total}`);
      },
      onLog: (message) => writeLog("INFO", "foliage opaque " + message)
    });
    copiedModelEntries.push(...opaqueResult.added);
    copiedModelLodEntries.push(...opaqueResult.lodAdded);
    for (const warning of opaqueResult.warnings) {
      importWarnings.push(warning);
      writeLog("WARN", "foliage opaque warning", { message: warning });
    }
    if (!opaqueResult.ok && opaqueResult.warnings.length === 0 && opaqueResult.message) {
      importWarnings.push(opaqueResult.message);
      writeLog("WARN", "foliage opaque unavailable", { message: opaqueResult.message });
    }
  }

  const areaNormalMapFormats = buildAreaNormalMapFormats(copiedTextureFiles, payloadNormalMapFormats, normalizedNormalMapFormat);

  let previewDest = null;
  let previewImagePath = String(payload?.previewImagePath || "").trim();
  const previewDir = path.join(destinationDir, "Preview");
  const shouldWritePreviewDir = !isAnimationImport;
  if (shouldWritePreviewDir) {
    await fs.mkdir(previewDir, { recursive: true });
  }
  // 任何已进入纹理槽的贴图都不能再作为预览图，即使调用方显式传了
  // previewImagePath 也一样。相对 uri 用文件名兜底匹配，避免不同根路径漏判。
  const textureSlotPathKeys = new Set();
  const textureSlotBaseKeys = new Set();
  const registerTextureSlotPath = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return;
    textureSlotPathKeys.add(normalizeComparePath(raw));
    const base = path.basename(raw).toLowerCase();
    if (base) textureSlotBaseKeys.add(base);
  };
  for (const slot of resolvedTextureSlots) registerTextureSlotPath(slot?.source);
  for (const item of familyPlan?.files || []) {
    if (item.role === "texture") registerTextureSlotPath(item.sourcePath);
  }
  for (const entry of payloadTextureEntries) {
    registerTextureSlotPath(entry?.filePath);
    registerTextureSlotPath(entry?.uri);
  }
  for (const value of Object.values(textureSlots)) {
    if (typeof value === "string") registerTextureSlotPath(value);
    else if (value && typeof value === "object") {
      registerTextureSlotPath(value.filePath);
      registerTextureSlotPath(value.uri);
    }
  }
  const isTextureSlotPath = (filePath) => {
    const raw = String(filePath || "").trim();
    if (!raw) return false;
    if (textureSlotPathKeys.has(normalizeComparePath(raw))) return true;
    const base = path.basename(raw).toLowerCase();
    return Boolean(base && textureSlotBaseKeys.has(base));
  };
  if (previewImagePath && isTextureSlotPath(previewImagePath)) {
    writeLog("WARN", "import preview ignored because it is a texture slot", { previewImagePath });
    previewImagePath = "";
  }
  if (previewImagePath && isAnimationImport) {
    previewDest = await persistLocalAnimationPreview(uniqueId, previewImagePath);
  } else if (previewImagePath && shouldWritePreviewDir) {
    previewDest = await compressPreviewImage(previewImagePath, previewDir, `${uniqueId}_preview`);
    if (!previewDest && assetType.toLowerCase() !== "hdri") {
      return { ok: false, message: "无法读取或解码预览图" };
    }
  }
  if (!previewDest && shouldWritePreviewDir) {
    if (assetType.toLowerCase() === "hdri") {
      const hdrLike = copiedTextureFiles.find((item) => item.textureType && item.textureType.toLowerCase() === "hdr") || copiedTextureFiles[0];
      const originalHdr = resolvedTextureSlots.find((item) => String(item.suffix).toLowerCase() === "hdr") || resolvedTextureSlots[0];
      if (hdrLike && (!previewImagePath || path.resolve(originalHdr.source) !== path.resolve(previewImagePath))) {
        const copiedFromTexture = await compressPreviewImage(hdrLike.path, previewDir, `${uniqueId}_preview`);
        previewDest = copiedFromTexture || null;
      }
    } else {
      // 只接受非贴图的渲染图（如 Tree.jpg 这类裸名图片）；贴图槽里的
      // Albedo / Diffuse 不能拿来当预览图，否则用户没选缩略图时卡片会
      // 显示成一张贴图。
      let previewFile = null;
      if (sourcePath) {
        previewFile = await resolvePreviewFile(sourcePath, "", isTextureSlotPath);
      }
      if (previewFile) {
        const compressed = await compressPreviewImage(previewFile, previewDir, `${uniqueId}_preview`);
        previewDest = compressed || null;
      }
    }
  }

  let previewFileUri = null;
  let previewContentLength = 0;
  let previewWidth = 0;
  let previewHeight = 0;
  if (previewDest) {
    previewFileUri = isAnimationImport ? previewDest : toPreviewRelativeUri(destinationDir, previewDest);
    const previewStat = await statOrNull(previewDest);
    previewContentLength = previewStat?.size || 0;
    try {
      const previewImage = nativeImage.createFromPath(previewDest);
      if (!previewImage.isEmpty()) {
        const size = previewImage.getSize();
        previewWidth = size.width || 0;
        previewHeight = size.height || 0;
      }
    } catch { }
    if (!previewWidth || !previewHeight) {
      try {
        const meta = await sharp(previewDest, { failOn: "none" }).metadata();
        previewWidth = meta?.width || 0;
        previewHeight = meta?.height || 0;
      } catch { }
    }
  }
  const previewAbsolutePath = previewFileUri
    ? (isAnimationImport || path.isAbsolute(previewFileUri)
      ? normalizePath(previewFileUri)
      : normalizePath(path.join(destinationDir, previewFileUri)))
    : "";
  const computedRelativeSize = (previewWidth > 0 && previewHeight > 0)
    ? `${previewWidth}x${previewHeight}`
    : (assetType.toLowerCase() === "hdri" ? "2x1" : "1x1");

  const characterPreviewEntries = [];
  characterProgress(70, '正在保存预览');
  if (isCharacterImport && (Object.values(characterPreviewPaths).some(Boolean)
    || assetType === "suit" && !require("../shared/heroPackageRules.mjs").heroPartKind(characterFields))) {
    const previews = await boundedMap(["front", "left", "right", "back"], 3, async view => {
      const source = String(characterPreviewPaths[view] || "").trim();
      if (!(await statOrNull(source))?.isFile()) throw new Error(`角色${view}预览不存在`);
      const normalizedView = `${view.charAt(0).toUpperCase()}${view.slice(1)}`;
      const destination = await compressPreviewImage(source, previewDir, `${assetName}_Preview_${normalizedView}`);
      if (!destination) throw new Error(`无法读取或解码角色${view}预览`);
      return {
        contentLength: (await statOrNull(destination))?.size || 0,
        resolution: "unknown",
        uri: toPreviewRelativeUri(destinationDir, destination),
        tags: ["preview", `view:${view}`, "origin:auto"]
      };
    });
    characterPreviewEntries.push(...previews);
  }

  if (isCharacterImport) {
    for (const [index, source] of [...new Set(payload.characterExtraPreviewPaths || [])].entries()) {
      if (String(source) === String(payload.previewImagePath)) continue;
      const destination = await compressPreviewImage(source, previewDir, `${assetName}_Extra_${index + 1}`);
      if (!destination) return { ok: false, message: '无法保存新增的预览图片' };
      characterPreviewEntries.push({ uri: toPreviewRelativeUri(destinationDir, destination), tags: ['preview', 'origin:manual'] });
    }
  }

  let dimensions = null;
  let modelAnalysis = null;
  if (sender && isModelAssetType(assetType) && !isAnimationAssetType(assetType)) {
    const highPolySlot = resolvedModelSlots.find((s) => s.suffix.toLowerCase() === "highpoly") || resolvedModelSlots[0];
    if (highPolySlot && highPolySlot.source && !(isCharacterImport && /\.abc$/i.test(highPolySlot.source))) {
      try {
        modelAnalysis = isCharacterImport && /\.fbx$/i.test(highPolySlot.source)
          ? await require('./services/characterFileInspection').inspectCharacterModel(highPolySlot.source)
          : await requestModelAnalysis(sender, highPolySlot.source);
        dimensions = modelAnalysis?.bounds || null;
      } catch (err) {
        writeLog("WARN", "failed to calculate bounds", { message: err.message });
      }
    }
  }
  const hasCollision = isCollisionCheckRequired(assetType, standardAssetTags, category)
    && modelAnalysis?.collision?.checked === true
    ? Boolean(modelAnalysis.collision.hasCollision)
    : undefined;

  let textureAnalysis = null;
  if (isModelAssetType(assetType) && !isAnimationAssetType(assetType)) {
    try {
      textureAnalysis = await analyzeAssetTextureUsage({
        dimensions,
        dimensionsSource: dimensions ? "measured" : "",
        textureFiles: copiedTextureFiles.map((item) => item.path)
      });
    } catch (error) {
      writeLog("WARN", "failed to analyze 4K texture usage", { message: error?.message || String(error) });
    }
  }

  const now = new Date().toISOString();
  const normalizedTags = [...new Set([assetType, category, animationAffiliation, ...standardAssetTags, ...zionTags, ...tags].map((tag) => normalizeAssetTag(tag.toLowerCase())).filter(Boolean))];
  const meta = createAssetMetadata({
    pack: null,
    ...(["imperfection", "displacement"].includes(assetType) && payload?.sourceClassification?.assetType === assetType
      && payload.sourceClassification.sourceAssetId === sourceIdentity.sourceAssetId
      ? { sourceClassification: payload.sourceClassification } : {}),
    scanInformation: dimensions ? { dimensions, dimensionsSource: "measured" } : undefined,
    textureAnalysis: textureAnalysis || undefined,
    semanticTags: {
      ...(sourceIdentity.sourceKind === "megascans" ? bridgeSemanticDetails(payload?.sourceSemanticTags) : {}),
      name: assetName,
      asset_type: assetType,
      contains: normalizedTags,
      theme: [category, animationAffiliation].filter(Boolean),
      descriptive: [],
      state: [],
      subject_matter: category,
      environment: []
    },
    name: assetName,
    assetID: uniqueId,
    slug: assetFolderName,
    topCategory,
    previewSkeletonPath: String(payload?.previewSkeletonPath || "").trim(),
    previewSkeletalMeshPath: String(payload?.previewSkeletalMeshPath || "").trim(),
    assetType,
    ...(isCharacterImport ? {
      character: characterFields,
      characterManifest,
      characterMetrics,
      ...(String(payload?.characterRelationGroupId || "").trim() ? { characterImportGroupId: String(payload.characterRelationGroupId).trim().slice(0, 128) } : {}),
      characterUpdateHistory: [{ id: crypto.randomUUID(), at: new Date().toISOString(), label: "首次入库", ...(() => {
        const files = (characterManifest?.files || []).filter(file => file.originalPath);
        return { sourcePaths: files.map(file => file.originalPath), files: files.map((file, sourceIndex) => ({ name: file.normalizedName || file.originalName, status: "added", sourcePath: file.originalPath, sourceIndex, storedPath: file.storedPath })) };
      })() }],
      packageStatus: "stored"
    } : {}),
    standardAssetTags,
    zionTags,
    ...(nativePlantWind ? { nativePlantWind } : {}),
    ...(typeof hasCollision === "boolean" ? { hasCollision } : {}),
    category,
    animationAffiliation: animationAffiliation || undefined,
    baseTiling: assetType === "surface" ? normalizedBaseTiling : undefined,
    tags: normalizedTags,
    previews: {
      images: [
        ...(previewFileUri
          ? [
          {
            contentLength: previewContentLength,
            resolution: "unknown",
            uri: previewFileUri,
            tags: ["preview", "cover"]
          }
        ]
          : []),
        ...characterPreviewEntries
      ],
      relativeSize: computedRelativeSize
    },
    categories: [topCategory, assetType, category.toLowerCase(), animationAffiliation].filter(Boolean),
    meta: [],
    modelVariants: copiedModelEntries
      .filter((item) => isMeshSlotName(item.suffix) && item.variantKey)
      .map((item) => ({ file: normalizePath(item.path), ...modelVariantMetadataFields(item.variantKey) })),
    modelLods: copiedModelLodEntries
      .filter((item) => item.path && item.variantKey)
      .map((item) => ({
        file: normalizePath(item.path),
        slot: item.suffix,
        lod: item.lod,
        ...modelVariantMetadataFields(item.variantKey)
      })),
    components: [
      ...copiedModelEntries.map((item) => ({
        type: "model",
        slot: item.suffix,
        uri: isFamilyImport ? normalizePath(path.relative(destinationDir, item.path)) : path.basename(item.path),
        ...(item.variantKey ? modelVariantMetadataFields(item.variantKey) : {})
      })),
      ...copiedTextureFiles.map((item) => {
        const nextItem = {
          type: "texture",
          slot: item.textureType,
          areaIndex: item.areaIndex,
          uri: isFamilyImport ? normalizePath(path.relative(destinationDir, item.path)) : path.basename(item.path),
          ...(item.materialRole ? { materialRole: item.materialRole } : {}),
          ...textureResolutionMetadataFields(item)
        };
        if (String(item.textureType || "").toLowerCase() === "normal") {
          nextItem.normalMapFormat = areaNormalMapFormats[item.areaIndex] || normalizedNormalMapFormat;
        }
        return nextItem;
      })
    ],
    modelFiles: copiedModelEntries.map((item) => normalizePath(item.path)),
    modelSlots: Object.fromEntries(copiedModelEntries.map((item) => [item.suffix, normalizePath(item.path)])),
    textureFiles: copiedTextureFiles.map((item) => normalizePath(item.path)),
    textureSlots: Object.fromEntries(
      copiedTextureFiles
        .filter((item) => item.areaIndex === 1 && item.materialRole !== "billboard")
        .map((item) => [item.textureType, normalizePath(item.path)])
    ),
    textureEntries: copiedTextureFiles.map((item) => ({
      textureType: item.textureType,
      areaIndex: item.areaIndex,
      uri: isFamilyImport ? normalizePath(path.relative(destinationDir, item.path)) : path.basename(item.path),
      ...(item.materialRole ? { materialRole: item.materialRole } : {}),
      ...textureResolutionMetadataFields(item),
      ...(String(item.textureType || "").toLowerCase() === "normal"
        ? { normalMapFormat: areaNormalMapFormats[item.areaIndex] || normalizedNormalMapFormat }
        : {})
    })),
    normalMapFormat: normalizedNormalMapFormat,
    normalMapFormats: areaNormalMapFormats,
    materialNames: normalizedCharacterMaterialNames || payload?.materialNames,
    identity: {
      schemaVersion: IDENTITY_SCHEMA_VERSION,
      ...sourceIdentity,
      ...contentIdentity
    },
    metadataUpdate: buildMetadataUpdateMarker(now),
    ...(payload?.queueId ? { importQueueId: payload.queueId } : {}),
    revision: 1,
    importHistory: [
      {
        at: now,
        action: "import",
        sourcePath: sourcePath || String(payload?.sourcePath || "").trim(),
        previousFingerprint: "",
        nextFingerprint: contentIdentity.contentFingerprint
      }
    ],
    createdAt: now
  }, { now, fileName: metadataFileName });
  const colorTags = await inferColorTagsSafely(copiedTextureFiles.filter(item => !isCharacterImport || /^(diffuse|albedo|basecolor)$/i.test(item.textureType)).map((item) => isCharacterImport ? item.source : item.path));
  applyColorTagsToMeta(meta, colorTags);
  if (previewFileUri) {
    meta.previewImage = previewFileUri;
    meta.detailImage = previewFileUri;
  }
  // 裁切变体的面数预设（0 = 插件按自己的档位表，> 0 = 操作者覆盖）：
  // 写进资产元数据，导出时随导入 job 发给插件，由它设 _OPAQUE 网格的 Nanite 面数上限。
  // 不写这个字段，插件永远按档位表（Grass 15 万 / Bush 30 万）算 —— 界面上把面数改成
  // 20 万也不会有任何效果，UE 里仍然是 15 万。
  if (foliageOpaqueRequested) {
    meta.foliageOpaque = { ...(meta.foliageOpaque || {}), faceBudget: opaqueFaceBudgetForMeta };
  }
  await require('./services/characterImportPreviews').saveCharacterImportPreviews({ meta, assetType, destinationDir,
    previews: payload.characterPartPreviews,
    saveImage: (source, name) => compressPreviewImage(source, previewDir, name),
    onProgress: (done, total) => characterProgress(75 + done / total * 20, `正在保存部件预览 ${done}/${total}`) });
  characterProgress(96, '正在完成入库');
  const metadataWrite = isAnimationImport
    ? { meta, metaPath: copiedModelEntries[0]?.path || "" }
    : await writeAssetMetadata(destinationDir, meta, { now, fileName: metadataFileName });
  const savedMeta = metadataWrite.meta;
  const jsonPath = metadataWrite.metaPath;
  if (isAnimationImport && copiedModelEntries[0]?.path) {
    await writeAnimationIdentitySidecar(copiedModelEntries[0].path, savedMeta).catch((error) => {
      writeLog("WARN", "failed to write animation identity sidecar during import", {
        path: copiedModelEntries[0].path,
        message: error?.message || String(error)
      });
    });
    await cleanupAnimationArchiveDirectory(destinationDir);
  }

  const newAsset = {
    id: uniqueId,
    name: assetName,
    slug: assetFolderName,
    source: "custom",
    sourceRoot: settings.customLibraryPath,
    path: isAnimationImport && copiedModelEntries[0]?.path ? path.dirname(copiedModelEntries[0].path) : destinationDir,
    metaPath: jsonPath,
    topCategory,
    assetType,
    ...(typeof hasCollision === "boolean" ? { hasCollision } : {}),
    textureAnalysis: savedMeta.textureAnalysis,
    standardAssetTags,
    zionTags,
    animationAffiliation: animationAffiliation || undefined,
    baseTiling: savedMeta.baseTiling,
    tags: normalizedTags,
    themes: [category.toLowerCase(), animationAffiliation].filter(Boolean),
    categories: [topCategory, assetType, category.toLowerCase(), animationAffiliation].filter(Boolean),
    preview: previewAbsolutePath,
    previewImage: previewAbsolutePath,
    detailImage: previewAbsolutePath,
    previewImages: [
      ...(previewAbsolutePath ? [{ path: previewAbsolutePath, tags: ["preview", "cover"] }] : []),
      ...characterPreviewEntries.map((item) => ({
        path: normalizePath(path.join(destinationDir, item.uri)),
        tags: item.tags
      }))
    ],
    modelFiles: savedMeta.modelFiles,
    textureFiles: savedMeta.textureFiles,
    colorTags,
    meta: savedMeta
  };
  index.push(toAssetIndexRecord(newAsset));

  // 抑制文件监控引发的二次扫描，给它10秒的时间窗口
  markInternalLibraryMutation(10000);

  // The isolated download worker publishes a verified staging directory after
  // import. Its temporary paths must never enter the desktop library index.
  if (!process.env.ASSETHIVE_MEGASCANS_IMPORT_JOB && process.env.ASSETHIVE_MEGASCANS_IMPORT_WORKER !== "1") {
    getSharedDerivedCache().warmAssets?.([newAsset], { priority: true });
    scheduleIndexSnapshotSave("import_custom_asset");
    applyLibrarySqlCacheChanges({ upsertAssets: [newAsset], deleteIds: [] }).catch(err => {
      writeLog("ERROR", "applyLibrarySqlCacheChanges failed during importCustomAsset", { message: err.message });
    });
  }

  if (!isCharacterImport && sender && !sender.isDestroyed()) {
    sender.send("assets:change", { incremental: true, count: index.length });
  }

  // 入库收尾：进度环与任务栏走到 100。渲染层按 100 触发清理计时器，
  // 新资产入库后卡片不会停在中间进度；导入循环也用它把任务栏推到
  // "已完成资产数/总数" 的真实比例。
  characterProgress(100, '入库完成');
  emitCustomSaveProgress(sender, uniqueId, 100, "done");
  if (isCharacterImport) writeLog('INFO', 'character import completed', { assetId: uniqueId, durationMs: Date.now() - characterImportStartedAt, preparedParts: payload.characterPartPreviews?.length || 0 });

  return {
    ok: true,
    message: isCharacterImport
      ? "角色资产已完成结构确认并入库"
      : assetType.toLowerCase() === "hdri" && !previewDest
      ? "HDRI 已导入，预览暂未生成，可在编辑资产中指定预览图；原始贴图已保留"
      : "自定义资产已导入",
    previewWarning: assetType.toLowerCase() === "hdri" && !previewDest,
    warnings: importWarnings,
    assetId: uniqueId,
    assetPath: isAnimationImport && copiedModelEntries[0]?.path ? copiedModelEntries[0].path : destinationDir,
    metaPath: jsonPath
  };
}

async function updateCustomAsset(payload, sender) {
  const assetId = String(payload?.assetId || "").trim();
  if (!assetId || !settings.customLibraryPath) return { ok: false, message: "缺少资产 ID 或资源库路径" };
  await ensureLibraryEditsRecovered(assetId);
  const owner = crypto.createHash("sha256").update(`${os.hostname()}|${getPersistentCacheRoot()}`).digest("hex").slice(0, 24);
  return withFileTransaction({ root: settings.customLibraryPath, owner, key: `${settings.customLibraryPath}|${assetId}` },
    () => updateCustomAssetFiles(payload, sender));
}

async function updateCustomAssetFiles(payload, sender) {
  const assetId = String(payload?.assetId || "").trim();
  if (!assetId) {
    return { ok: false, message: "缺少资产ID" };
  }
  const target = index.find((asset) => asset.id === assetId && asset.source === "custom");
  if (!target) {
    return { ok: false, message: "未找到可编辑的自定义资产" };
  }
  markInternalLibraryMutation(25000);
  const metaPath = target.metaPath;
  let meta = await loadJson(metaPath, null);
  if ((!meta || typeof meta !== "object") && isFlatLibraryAsset(target.assetType, metaPath)) {
    meta = target.meta && typeof target.meta === "object"
      ? { ...target.meta }
      : buildAnimationMetaFromModel(metaPath, target);
  }
  if (!meta || typeof meta !== "object") {
    return { ok: false, message: "资产元数据读取失败" };
  }
  meta = normalizeAssetModelPaths(pruneEmptyAssetSlots(meta), target.path);
  const storedSlotPaths = new Set([
    ...Object.values(meta.modelSlots || {}), ...Object.values(meta.textureSlots || {}),
    ...(meta.modelFiles || []), ...(meta.textureFiles || []),
    ...[...(meta.components || []).filter(entry => ["model", "texture"].includes(entry?.type)),
      ...(meta.textureEntries || []), ...(meta.modelVariants || []), ...(meta.modelLods || [])]
      .map(entry => entry?.uri || entry?.filePath || entry?.path || entry?.file || entry?.source)
  ].filter(value => typeof value === "string" && value.trim())
    .map(value => path.resolve(resolveAssetModelPath(target.path, value)).toLowerCase()));
  const inputs = [...Object.values(payload?.modelSlots || {}), ...Object.values(payload?.textureSlots || {}),
    ...(payload?.textureEntries || []).map(entry => entry?.filePath),
    ...Object.values(payload?.modelLodFiles || {}).flatMap(entries => Array.isArray(entries) ? entries.map(entry => entry?.filePath || entry?.file || entry?.path) : [])]
    .filter(value => typeof value === "string" && value.trim());
  for (const input of inputs) {
    if (!(await statOrNull(input))?.isFile() && !storedSlotPaths.has(path.resolve(input).toLowerCase())) {
      return { ok: false, message: `文件不存在：${input}` };
    }
  }
  if (payload?.previewImagePath && !(await statOrNull(payload.previewImagePath))?.isFile()) {
    return { ok: false, message: `文件不存在：${payload.previewImagePath}` };
  }
  const previousIdentity = meta.identity && typeof meta.identity === "object" && !Array.isArray(meta.identity)
    ? { ...meta.identity }
    : {};
  const previousName = String(meta.name || target.name || "Custom Asset");
  const previousType = sanitizeToken(meta.assetType || meta?.semanticTags?.asset_type || target.assetType || "3d") || "3d";
  const previousCategory = String(meta.category || meta?.semanticTags?.subject_matter || "custom").trim() || "custom";
  const previousTags = Array.isArray(meta.tags) ? meta.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean) : [];
  const previousZionTags = Array.isArray(meta.zionTags) ? meta.zionTags.map((tag) => String(tag || "").trim()).filter(Boolean) : [];

  const nextName = convertChineseToPinyin(String(payload?.assetName ?? previousName).trim()) || previousName;
  const nextAssetType = sanitizeToken(payload?.assetType ?? previousType) || previousType;
  const nextCategory = String(payload?.category ?? previousCategory).trim() || previousCategory;
  const nextTopCategory = getTopCategoryForAssetType(nextAssetType);
  const previousStandardAssetTags = Array.isArray(meta.standardAssetTags) ? meta.standardAssetTags : [];
  const replacingStandardAssetTags = Array.isArray(payload?.standardAssetTags);
  const inputStandardAssetTags = Array.isArray(payload?.standardAssetTags)
    ? payload.standardAssetTags.map((tag) => String(tag || "").trim()).filter(Boolean)
    : previousStandardAssetTags;
  const nextStandardAssetTags = [...new Set(inputStandardAssetTags.map(normalizeStandardAssetTag).filter(Boolean))];
  const nextZionTags = Array.isArray(payload?.zionTags)
    ? payload.zionTags.filter((tag) => typeof tag === "string").map((tag) => normalizeAssetTag(String(tag || "").trim())).filter(Boolean).slice(0, 1)
    : previousZionTags.slice(0, 1);
  const nextSourceIdentity = deriveSourceIdentity({
    assetName: nextName,
    assetType: nextAssetType,
    standardAssetTags: nextStandardAssetTags,
    tags: [...previousTags, ...nextZionTags],
    sourceIdentity: payload?.sourceIdentity && typeof payload.sourceIdentity === "object"
      ? payload.sourceIdentity
      : previousIdentity
  });
  const inputTags = Array.isArray(payload?.tags)
    ? payload.tags.filter((tag) => typeof tag === "string").map((tag) => normalizeAssetTag(tag.toLowerCase())).filter(Boolean)
    : [...new Set([...previousTags, ...previousStandardAssetTags.filter((tag) => /^(megascans|pbrmax)$/i.test(tag))])];
  const previousZionTagKeys = new Set(previousZionTags.map((tag) => tag.toLowerCase()));
  const previousStandardTagKeys = replacingStandardAssetTags
    ? new Set(previousStandardAssetTags.map((tag) => String(tag || "").trim().toLowerCase()).filter((tag) => tag && !/^(megascans|pbrmax)$/.test(tag)))
    : new Set();
  const previousAffiliation = String(meta.animationAffiliation || target.animationAffiliation || "").trim();
  // 资产类型、分类、归属是系统托管的 tag，会被 nextAssetType / nextCategory / nextAffiliation
  // 用新值重新写入 mergedTags。这里从用户输入里剔除旧值，避免只改分类时旧分类 tag 残留，
  // 导致旧分类下仍能匹配到该资产。
  const previousManagedTagKeys = new Set([
    previousType.toLowerCase(),
    previousCategory.toLowerCase(),
    previousAffiliation.toLowerCase()
  ].filter(Boolean));
  const regularInputTags = inputTags.filter((tag) => {
    const key = tag.toLowerCase();
    return !previousZionTagKeys.has(key) && !previousManagedTagKeys.has(key) && !previousStandardTagKeys.has(key);
  });
  const nextAffiliation = isAnimationAssetType(nextAssetType)
    ? String(payload?.animationAffiliation !== undefined ? payload.animationAffiliation : previousAffiliation || "").trim()
    : "";
  const mergedTags = [...new Set([nextAssetType, nextCategory.toLowerCase(), nextAffiliation, ...nextStandardAssetTags, ...regularInputTags, ...nextZionTags.map((tag) => tag.toLowerCase())].filter(Boolean))];
  const pbrMaxDecalTextureOptions = { assetType: nextAssetType, standardAssetTags: nextStandardAssetTags, tags: mergedTags };
  let nextNativePlantWind = null;
  if (isZionPlantAsset({ assetType: nextAssetType, standardAssetTags: nextStandardAssetTags,
    tags: mergedTags, zionTags: nextZionTags })) {
    nextNativePlantWind = normalizeNativePlantWind(payload?.nativePlantWind);
    if (!nextNativePlantWind) {
      const detectedWind = await detectNativePlantWind({ modelFiles: Object.values(payload?.modelSlots || {}).filter((value) => typeof value === "string") });
      nextNativePlantWind = detectedWind.profile;
      if (!nextNativePlantWind && !Object.hasOwn(payload || {}, "nativePlantWind")) {
        nextNativePlantWind = normalizeNativePlantWind(meta.nativePlantWind);
      }
    }
  }
  const normalizedNormalMapFormat = normalizeNormalMapFormatValue(payload?.normalMapFormat, meta.normalMapFormat || "dx");
  const payloadNormalMapFormats = payload?.normalMapFormats && typeof payload.normalMapFormats === "object" ? payload.normalMapFormats : {};

  const isMeshAssetType = isModelAssetType(nextAssetType);
  const normalizeModelSlot = (value) => {
    const normalizedText = String(value || "").trim();
    const normalizedLegacy = MODEL_SLOT_SUFFIXES.find((item) => item.toLowerCase() === normalizedText.toLowerCase());
    if (normalizedLegacy) {
      return normalizedLegacy;
    }
    if (isMeshAssetType && isMeshSlotName(normalizedText)) {
      return formatMeshSlotName(getMeshSlotOrder(normalizedText));
    }
    return "";
  };
  const normalizeTextureSlot = (value) => normalizePbrMaxDecalTextureType(value, pbrMaxDecalTextureOptions);
  const makeTextureToken = (textureType, areaIndex, materialRole = "") => {
    const normalizedType = normalizeTextureSlot(textureType);
    if (!normalizedType) {
      return "";
    }
    const normalizedArea = Math.max(1, Number(areaIndex) || 1);
    const token = normalizedArea <= 1
      ? normalizedType
      : `${String(normalizedArea).padStart(3, "0")}_${normalizedType}`;
    const normalizedRole = normalizeTextureMaterialRole(materialRole);
    return normalizedRole ? `${token}|${normalizedRole}` : token;
  };
  const parseTextureToken = (value) => {
    const raw = String(value || "").trim();
    const separator = raw.lastIndexOf("|");
    const baseToken = separator >= 0 ? raw.slice(0, separator) : raw;
    const roleToken = separator >= 0 ? raw.slice(separator + 1) : "";
    const parsed = parseTextureSlotToken(baseToken);
    if (!parsed) {
      return null;
    }
    return { ...parsed, materialRole: normalizeTextureMaterialRole(roleToken) };
  };

  let assetDir = path.resolve(target.path);
  const metadataFileName = path.basename(String(metaPath || "")) || ASSET_METADATA_FILE_NAME;
  const isFlatAsset = isFlatLibraryAsset(nextAssetType, metaPath) || isFlatLibraryAsset(previousType, metaPath);
  const nextTypeDir = path.join(settings.customLibraryPath, getCustomAssetTypeFolder(nextAssetType));
  await fs.mkdir(nextTypeDir, { recursive: true });
  const previousNameToken = sanitizeToken(previousName);
  const nextNameToken = sanitizeToken(nextName);
  const keepOriginalFolderName = true; // DO NOT rename the folder to avoid EPERM on locked preview images
  const nextFolderName = keepOriginalFolderName
    ? path.basename(assetDir)
    : `${nextAssetType}_${sanitizeToken(nextName) || "asset"}_${assetId}`;
  const movedAssetDir = path.join(nextTypeDir, nextFolderName);
  if (!isFlatAsset && path.resolve(assetDir).toLowerCase() !== path.resolve(movedAssetDir).toLowerCase()) {
    emitCustomSaveProgress(sender, assetId, 8, "rename-folder");
    assetDir = await renamePathSafely(assetDir, movedAssetDir);
  }
  const normalizeFileIdentity = (filePath) => path.resolve(String(filePath || "")).toLowerCase();
  const toAssetFilePath = (rawPath) => resolveAssetModelPath(assetDir, rawPath);
  const toAssetModelFilePath = toAssetFilePath;
  const toStoredTextureUri = filePath => isUnderRoot(assetDir, filePath)
    ? normalizePath(path.relative(assetDir, filePath)) : normalizePath(filePath);
  const previousModelFiles = new Set();
  const previousTextureFiles = new Set();
  if (meta.modelSlots && typeof meta.modelSlots === "object" && !Array.isArray(meta.modelSlots)) {
    for (const filePath of Object.values(meta.modelSlots)) {
      const resolvedPath = toAssetModelFilePath(filePath);
      if (path.basename(resolvedPath)) {
        previousModelFiles.add(resolvedPath);
      }
    }
  }
  for (const filePath of Array.isArray(meta.modelFiles) ? meta.modelFiles : target.modelFiles || []) {
    const resolvedPath = toAssetModelFilePath(filePath);
    if (path.basename(resolvedPath)) {
      previousModelFiles.add(resolvedPath);
    }
  }
  if (Array.isArray(meta.components)) {
    for (const component of meta.components) {
      if (!component || component.type !== "model") {
        continue;
      }
      const resolvedPath = toAssetModelFilePath(component.uri || component.path);
      if (path.basename(resolvedPath)) {
        previousModelFiles.add(resolvedPath);
      }
    }
  }
  for (const filePath of Array.isArray(meta.textureFiles) ? meta.textureFiles : target.textureFiles || []) {
    const resolvedPath = toAssetFilePath(filePath);
    if (path.basename(resolvedPath)) {
      previousTextureFiles.add(resolvedPath);
    }
  }
  if (Array.isArray(meta.components)) {
    for (const component of meta.components) {
      if (!component || component.type !== "texture") {
        continue;
      }
      const resolvedPath = toAssetFilePath(component.uri || component.path);
      if (path.basename(resolvedPath)) {
        previousTextureFiles.add(resolvedPath);
      }
    }
  }

  const modelSlotMap = new Map();
  if (meta.modelSlots && typeof meta.modelSlots === "object" && !Array.isArray(meta.modelSlots)) {
    for (const [slotKey, filePath] of Object.entries(meta.modelSlots)) {
      const normalizedSlot = normalizeModelSlot(slotKey);
      const normalizedPath = String(filePath || "").trim();
      if (!normalizedSlot || !normalizedPath) {
        continue;
      }
      const resolvedPath = toAssetModelFilePath(normalizedPath);
      modelSlotMap.set(normalizedSlot, resolvedPath);
    }
  }
  const modelLodMap = new Map();
  for (const item of Array.isArray(meta.modelLods) ? meta.modelLods : []) {
    const slot = normalizeModelSlot(item?.slot || inferModelSlotFromFileName(item?.file || item?.path || item?.uri));
    const resolvedPath = toAssetModelFilePath(item?.file || item?.path || item?.uri);
    if (!slot || !path.basename(resolvedPath)) continue;
    if (!modelLodMap.has(slot)) modelLodMap.set(slot, []);
    modelLodMap.get(slot).push({
      filePath: resolvedPath,
      lod: Math.max(0, Math.floor(Number(item?.lod) || 0)),
      variantKey: normalizeModelVariantKey(item?.variantKey, parseModelVariantKey(resolvedPath) || "01")
    });
    previousModelFiles.add(resolvedPath);
  }
  const existingModelPathSet = new Set(
    [...modelSlotMap.values()]
      .map((filePath) => path.resolve(String(filePath || "")).toLowerCase())
      .filter(Boolean)
  );
  const existingMeshOrders = [...modelSlotMap.keys()]
    .filter((slot) => isMeshSlotName(slot))
    .map((slot) => getMeshSlotOrder(slot))
    .filter((order) => Number.isFinite(order));
  let nextMeshOrder = existingMeshOrders.length > 0 ? Math.max(...existingMeshOrders) + 1 : 1;
  for (const filePath of [
    ...(Array.isArray(meta.modelFiles) ? meta.modelFiles : target.modelFiles || []),
    ...(Array.isArray(meta.components) ? meta.components : []).filter(entry => entry?.type === "model").map(entry => entry.uri || entry.path)
  ]) {
    const resolvedPath = toAssetModelFilePath(filePath);
    const resolvedKey = path.resolve(resolvedPath).toLowerCase();
    if (!resolvedPath || existingModelPathSet.has(resolvedKey)) {
      continue;
    }
    const inferredSlot = normalizeModelSlot(inferModelSlotFromFileName(filePath));
    const slot = inferredSlot || (isMeshAssetType ? formatMeshSlotName(nextMeshOrder++) : "");
    if (!slot) {
      continue;
    }
    if (!modelSlotMap.has(slot)) {
      modelSlotMap.set(slot, resolvedPath);
      existingModelPathSet.add(resolvedKey);
    }
  }
  if (isMeshAssetType && modelSlotMap.size === 0 && !isFlatAsset) {
    const diskModelFiles = await collectFilesByExtensions(assetDir, MODEL_EXTENSIONS);
    for (const filePath of diskModelFiles) {
      const resolvedPath = path.resolve(filePath);
      const resolvedKey = resolvedPath.toLowerCase();
      if (!resolvedKey || existingModelPathSet.has(resolvedKey)) {
        continue;
      }
      const inferredSlot = normalizeModelSlot(inferModelSlotFromFileName(resolvedPath));
      const slot = inferredSlot || formatMeshSlotName(nextMeshOrder++);
      if (!slot || modelSlotMap.has(slot)) {
        continue;
      }
      modelSlotMap.set(slot, resolvedPath);
      existingModelPathSet.add(resolvedKey);
    }
  }
  const textureSlotMap = new Map();
  if (Array.isArray(meta.textureEntries)) {
    for (const textureEntry of meta.textureEntries) {
      if (!textureEntry || typeof textureEntry !== "object") {
        continue;
      }
      const textureToken = makeTextureToken(textureEntry.textureType, textureEntry.areaIndex, textureEntry.materialRole);
      if (!textureToken || textureSlotMap.has(textureToken)) {
        continue;
      }
      const resolvedPath = toAssetFilePath(textureEntry.uri || textureEntry.path);
      if (path.basename(resolvedPath)) {
        textureSlotMap.set(textureToken, resolvedPath);
      }
    }
  }
  if (Array.isArray(meta.components)) {
    for (const component of meta.components) {
      if (!component || component.type !== "texture") {
        continue;
      }
      const normalizedSlot = normalizeTextureSlot(component.slot) || normalizeTextureSlot(inferTextureSlotFromFileName(component.uri || component.path));
      const normalizedToken = makeTextureToken(normalizedSlot, component.areaIndex, component.materialRole);
      if (!normalizedToken || textureSlotMap.has(normalizedToken)) {
        continue;
      }
      const resolvedPath = toAssetFilePath(component.uri || component.path);
      if (path.basename(resolvedPath)) {
        textureSlotMap.set(normalizedToken, resolvedPath);
      }
    }
  }
  if (meta.textureSlots && typeof meta.textureSlots === "object" && !Array.isArray(meta.textureSlots)) {
    for (const [slotKey, filePath] of Object.entries(meta.textureSlots)) {
      const parsedSlot = parseTextureSlotToken(slotKey);
      const normalizedToken = parsedSlot ? makeTextureToken(parsedSlot.textureType, parsedSlot.areaIndex, parsedSlot.materialRole) : "";
      if (!normalizedToken || textureSlotMap.has(normalizedToken)) {
        continue;
      }
      const resolvedPath = toAssetFilePath(filePath);
      if (path.basename(resolvedPath)) {
        textureSlotMap.set(normalizedToken, resolvedPath);
      }
    }
  }
  for (const filePath of Array.isArray(meta.textureFiles) ? meta.textureFiles : target.textureFiles || []) {
    const slot = normalizeTextureSlot(inferTextureSlotFromFileName(filePath));
    const areaMatched = String(filePath || "").match(/_(\d{3})_[^_.]+(?:\.[^.]+)?$/i);
    const areaIndex = areaMatched ? Math.max(1, Number(areaMatched[1]) || 1) : 1;
    const token = makeTextureToken(slot, areaIndex, normalizeTextureMaterialRole("", filePath));
    if (token && !textureSlotMap.has(token)) {
      textureSlotMap.set(token, toAssetFilePath(filePath));
    }
  }

  if (nextName !== previousName) {
    emitCustomSaveProgress(sender, assetId, 18, "rename-existing");
    // SKIP renaming existing textures to avoid EPERM when files are locked by the frontend
    // await normalizeTextureFileNamesForAsset(textureSlotMap, assetDir, nextName, assetId);
  }

  const inputModelSlots = payload?.modelSlots && typeof payload.modelSlots === "object" ? payload.modelSlots : {};
  for (const [slotKey, sourcePath] of Object.entries(inputModelSlots)) {
    const normalizedSlot = normalizeModelSlot(slotKey);
    const source = String(sourcePath || "").trim();
    if (!normalizedSlot || !source) {
      continue;
    }
    const resolved = path.resolve(storedSlotPaths.has(path.resolve(source).toLowerCase())
      ? resolveAssetModelPath(assetDir, source) : source);
    // 如果传入的就是资产目录内的文件，说明只是名称重命名带来的更新，不需要再 copyRenamedFile，后续 normalizeModelFileNamesForAsset 会处理
    if (resolved.toLowerCase().startsWith(assetDir.toLowerCase())) {
      continue;
    }
    const stats = await statOrNull(resolved);
    if (!stats?.isFile()) {
      if (storedSlotPaths.has(resolved.toLowerCase())) {
        modelSlotMap.set(normalizedSlot, resolved);
        continue;
      }
      return { ok: false, message: `模型路径无效：${normalizedSlot}` };
    }
    const ext = path.extname(resolved).toLowerCase();
    if (!MODEL_EXTENSIONS.has(ext)) {
      return { ok: false, message: `模型格式无效：${normalizedSlot}` };
    }
    emitCustomSaveProgress(sender, assetId, 35, `model-${normalizedSlot}`);
    const copied = await copyRenamedFile(
      resolved,
      assetDir,
      isAnimationAssetType(nextAssetType)
        ? makeCustomAnimationBaseName(resolved)
        : makeCustomModelBaseName(normalizedSlot, nextName, assetId, {
          variantKey: payload?.modelVariantKeys?.[normalizedSlot]
            || payload?.modelVariantKeys?.[slotKey]
            || parseModelVariantKey(resolved)
        })
    );
    if (!copied) {
      return { ok: false, message: `模型复制失败：${normalizedSlot}` };
    }
    modelSlotMap.set(normalizedSlot, copied);

    const rawLodEntries = payload?.modelLodFiles?.[slotKey] || payload?.modelLodFiles?.[normalizedSlot];
    if (Array.isArray(rawLodEntries)) {
      const nextLods = [];
      for (const lodEntry of rawLodEntries) {
        const lodSource = String(lodEntry?.filePath || lodEntry?.file || lodEntry?.path || "").trim();
        if (!lodSource) continue;
        const lodResolved = path.resolve(lodSource);
        const lod = Math.max(0, Math.floor(Number(lodEntry?.lod) || 0));
        let lodPath = lodResolved;
        if (!lodResolved.toLowerCase().startsWith(assetDir.toLowerCase())) {
          lodPath = await copyRenamedFile(
            lodResolved,
            assetDir,
            makeCustomModelLodBaseName(
              nextName,
              assetId,
              payload?.modelVariantKeys?.[normalizedSlot] || payload?.modelVariantKeys?.[slotKey] || parseModelVariantKey(lodResolved) || "01",
              lod
            )
          );
        }
        if (!lodPath) continue;
        nextLods.push({
          filePath: lodPath,
          lod,
          variantKey: payload?.modelVariantKeys?.[normalizedSlot] || payload?.modelVariantKeys?.[slotKey] || parseModelVariantKey(lodResolved) || "01"
        });
      }
      modelLodMap.set(normalizedSlot, nextLods);
    }
  }

  const removeModelSlots = Array.isArray(payload?.removeModelSlots) ? payload.removeModelSlots : [];
  for (const slotKey of removeModelSlots) {
    const normalizedSlot = normalizeModelSlot(slotKey);
    const filePath = modelSlotMap.get(normalizedSlot);
    if (filePath) {
      if (isUnderRoot(assetDir, filePath)) await fs.rm(filePath, { force: true });
      modelSlotMap.delete(normalizedSlot);
      modelLodMap.delete(normalizedSlot);
    }
  }

  const payloadTextureEntries = Array.isArray(payload?.textureEntries) ? payload.textureEntries : [];
  const inputTextureSlots = payload?.textureSlots && typeof payload.textureSlots === "object" ? payload.textureSlots : {};
  const textureInputs = [];
  if (payloadTextureEntries.length > 0) {
    for (const entry of payloadTextureEntries) {
      if (!entry || typeof entry !== "object") continue;
      const textureType = normalizeTextureSlot(entry.textureType || entry.slot);
      const areaIndex = Math.max(1, Number(entry.areaId ?? entry.areaIndex) || 1);
      const source = String(entry.filePath || entry.file || entry.path || "").trim();
      const materialRole = normalizeTextureMaterialRole(entry.materialRole, source);
      const token = makeTextureToken(textureType, areaIndex, materialRole);
      if (token && source) {
        textureInputs.push({ token, source, parsedSlot: { textureType, areaIndex, token, materialRole } });
      }
    }
  } else {
    for (const [slotKey, sourcePath] of Object.entries(inputTextureSlots)) {
      const parsedSlot = parseTextureToken(slotKey);
      const token = parsedSlot?.token || "";
      const source = String(sourcePath || "").trim();
      if (token && source) {
        textureInputs.push({ token: parsedSlot.materialRole ? `${token}|${parsedSlot.materialRole}` : token, source, parsedSlot });
      }
    }
  }
  if (Array.isArray(payload?.textureEntries)) {
    textureSlotMap.clear();
  }
  // 编辑保存同样只处理同槽位的 PNG；跳过 EXR，避免无意义的转换。
  const pngTextureTokens = new Set(textureInputs
    .filter((item) => path.extname(item.source).toLowerCase() === ".png")
    .map((item) => item.token.toLowerCase()));
  const preferredTextureInputs = textureInputs.filter((item) =>
    path.extname(item.source).toLowerCase() !== ".exr" || !pngTextureTokens.has(item.token.toLowerCase()));
  const copiedTextureMetadata = new Map();
  for (const textureInput of preferredTextureInputs) {
    const normalizedSlot = textureInput.token;
    const source = textureInput.source;
    const parsedSlot = textureInput.parsedSlot;
    const resolved = path.resolve(storedSlotPaths.has(path.resolve(source).toLowerCase())
      ? resolveAssetModelPath(assetDir, source) : source);
    // 如果传入的就是资产目录内的文件，说明只是名称重命名带来的更新，不需要再 copyRenamedFile，后续 normalizeTextureFileNamesForAsset 会处理
    if (resolved.toLowerCase().startsWith(assetDir.toLowerCase())) {
      textureSlotMap.set(normalizedSlot, resolved);
      continue;
    }
    const stats = await statOrNull(resolved);
    if (!stats?.isFile()) {
      if (storedSlotPaths.has(resolved.toLowerCase())) {
        textureSlotMap.set(normalizedSlot, resolved);
        continue;
      }
      return { ok: false, message: `贴图路径无效：${normalizedSlot}` };
    }
    emitCustomSaveProgress(sender, assetId, 55, `texture-${normalizedSlot}`);
    const ext = path.extname(resolved).toLowerCase();
    const isHdri = String(nextAssetType || "").trim().toLowerCase() === "hdri";
    if (ext === ".exr" && !isHdri && !isDisplacementTextureSlotName(parsedSlot?.textureType)) {
      return { ok: false, message: `普通贴图不支持 EXR 格式：${normalizedSlot}` };
    }
    const baseToken = String(parsedSlot?.token || normalizedSlot).split("|")[0];
    const baseName = makeCustomTextureBaseName(baseToken, nextName, assetId, parsedSlot?.materialRole);
    let copied = null;
    try {
      copied = await copyTextureIntoLibrary(resolved, assetDir, baseName, {
        isHdri,
        isDisplacement: isDisplacementTextureSlotName(parsedSlot?.textureType)
      });
    } catch (error) {
      return { ok: false, message: `贴图入库失败：${path.basename(resolved)}（${error?.message || String(error)}）` };
    }
    if (!copied?.path || !(await statOrNull(copied.path))?.isFile()) {
      return { ok: false, message: `贴图复制失败：${normalizedSlot}` };
    }
    copiedTextureMetadata.set(normalizedSlot, copied);
    textureSlotMap.set(normalizedSlot, copied.path);
  }


  const removeTextureSlots = Array.isArray(payload?.removeTextureSlots) ? payload.removeTextureSlots : [];
  for (const slotKey of removeTextureSlots) {
    const parsedSlot = parseTextureToken(slotKey);
    if (!parsedSlot?.token) continue;
    const targetKeys = parsedSlot.materialRole
      ? [`${parsedSlot.token}|${parsedSlot.materialRole}`]
      : [...textureSlotMap.keys()].filter((key) => parseTextureToken(key)?.token === parsedSlot.token);
    for (const targetKey of targetKeys) {
      const filePath = textureSlotMap.get(targetKey);
      if (filePath) {
        if (isUnderRoot(assetDir, filePath)) await fs.rm(filePath, { force: true });
        textureSlotMap.delete(targetKey);
      }
    }
  }

  // SKIP renaming files to avoid slow copy fallbacks on EPERM
  // await normalizeModelFileNamesForAsset(modelSlotMap, assetDir, nextName, assetId);
  // await normalizeTextureFileNamesForAsset(textureSlotMap, assetDir, nextName, assetId);

  const previewImagePath = String(payload?.previewImagePath || "").trim();
  const previewDir = path.join(assetDir, "Preview");
  if (!isFlatCustomAssetType(nextAssetType) && payload?.clearPreview) {
    await clearPreviewDir(previewDir);
    meta.previews = typeof meta.previews === "object" && meta.previews ? meta.previews : {};
    meta.previews.images = [];
    delete meta.previewImage;
    delete meta.detailImage;
  } else if (previewImagePath && isFlatCustomAssetType(nextAssetType)) {
    emitCustomSaveProgress(sender, assetId, 72, "preview");
    const resolvedPreviewSource = path.resolve(previewImagePath);
    const previewSourceStat = await statOrNull(resolvedPreviewSource);
    if (!previewSourceStat?.isFile()) {
      return { ok: false, message: `预览图不存在：${previewImagePath}` };
    }
    const previewDest = await persistLocalAnimationPreview(assetId, resolvedPreviewSource);
    if (!previewDest) {
      return { ok: false, message: `无法保存动画预览：${path.extname(previewImagePath).toLowerCase() || "未知格式"}` };
    }
    const previewSize = (await statOrNull(previewDest))?.size || 0;
    meta.previews = typeof meta.previews === "object" && meta.previews ? meta.previews : {};
    meta.previews.images = [
      {
        contentLength: previewSize,
        resolution: "unknown",
        uri: previewDest,
        tags: ["preview"]
      }
    ];
    meta.previewImage = previewDest;
    meta.detailImage = previewDest;
  } else if (isFlatCustomAssetType(nextAssetType)) {
    const preserved = pickPreservedAnimationPreview(target, meta);
    if (preserved) {
      meta.previewImage = preserved;
      meta.detailImage = preserved;
    }
  } else if (previewImagePath && !isFlatCustomAssetType(nextAssetType)) {
    emitCustomSaveProgress(sender, assetId, 72, "preview");
    const resolvedPreviewSource = path.resolve(previewImagePath);
    const previewSourceStat = await statOrNull(resolvedPreviewSource);
    if (!previewSourceStat?.isFile()) {
      return { ok: false, message: `预览图不存在：${previewImagePath}` };
    }
    await fs.mkdir(previewDir, { recursive: true });
    const stagedPreviewBaseName = `${assetId}_preview_pending_${process.pid}_${Date.now()}`;
    const stagedPreviewDest = await compressPreviewImage(resolvedPreviewSource, previewDir, stagedPreviewBaseName);
    if (!stagedPreviewDest) {
      return { ok: false, message: `无法解码预览图：${path.extname(previewImagePath).toLowerCase() || "未知格式"}` };
    }

    // Keep the existing preview until the replacement has decoded successfully.
    // This also makes selecting the asset's current preview as the source safe.
    await clearPreviewDir(previewDir, stagedPreviewDest);
    // A new path invalidates both PreviewLoader's path cache and Chromium's
    // file-image cache, including when the replacement keeps the same format.
    const canonicalPreviewDest = path.join(previewDir, `${assetId}_preview_${crypto.randomUUID()}${path.extname(stagedPreviewDest).toLowerCase()}`);
    let previewDest = stagedPreviewDest;
    if (path.resolve(stagedPreviewDest).toLowerCase() !== path.resolve(canonicalPreviewDest).toLowerCase()) {
      try {
        await fs.rename(stagedPreviewDest, canonicalPreviewDest);
        previewDest = canonicalPreviewDest;
      } catch (error) {
        writeLog("WARN", "preview replacement rename failed; keeping staged preview", {
          assetId,
          stagedPreviewDest,
          canonicalPreviewDest,
          message: error?.message || String(error)
        });
      }
    }
    const previewSize = (await statOrNull(previewDest))?.size || 0;
    meta.previews = typeof meta.previews === "object" && meta.previews ? meta.previews : {};
    meta.previews.images = [
      {
        contentLength: previewSize,
        resolution: "unknown",
        uri: toPreviewRelativeUri(assetDir, previewDest),
        tags: ["preview"]
      }
    ];
    meta.previews.relativeSize = await computeRelativeSizeFromPreview(previewDest, nextAssetType);
    const previewUri = toPreviewRelativeUri(assetDir, previewDest);
    meta.previewImage = previewUri;
    meta.detailImage = previewUri;
  } else if (String(nextAssetType || "").toLowerCase() === "hdri") {
    emitCustomSaveProgress(sender, assetId, 72, "preview");
    await fs.mkdir(previewDir, { recursive: true });
    const hdrEntry = [...textureSlotMap.entries()].find(([slot]) => String(slot || "").trim().toLowerCase() === "hdr") || null;
    const hdrSourcePath = hdrEntry ? String(hdrEntry[1] || "").trim() : "";
    if (hdrSourcePath) {
      const previewDest = await compressPreviewImage(hdrSourcePath, previewDir, `${assetId}_preview`);
      if (previewDest) {
        // Optionally clean old previews except the new one (skip aggressive clear to avoid losing previews on failure)
        const previewSize = (await statOrNull(previewDest))?.size || 0;
        meta.previews = typeof meta.previews === "object" && meta.previews ? meta.previews : {};
        meta.previews.images = [
          {
            contentLength: previewSize,
            resolution: "unknown",
            uri: toPreviewRelativeUri(assetDir, previewDest),
            tags: ["preview"]
          }
        ];
        if (!meta.previews.relativeSize) {
          meta.previews.relativeSize = await computeRelativeSizeFromPreview(previewDest, "hdri");
        }
        const previewUri = toPreviewRelativeUri(assetDir, previewDest);
        meta.previewImage = previewUri;
        meta.detailImage = previewUri;
      }
    }
  }

  emitCustomSaveProgress(sender, assetId, 84, "metadata");
  const modelEntries = [...modelSlotMap.entries()];
  const modelVariantKeys = buildModelVariantKeyMap(
    modelEntries.filter(([slot]) => isMeshSlotName(slot)),
    payload?.modelVariantKeys
  );
  const textureEntries = [...textureSlotMap.entries()];
  const textureMetadataBySlot = new Map(await Promise.all(textureEntries.map(async ([slot, filePath]) => {
    const parsedSlot = parseTextureToken(slot);
    const normalizedSlot = parsedSlot ? `${parsedSlot.token}|${parsedSlot.materialRole}` : slot;
    const previousMetadata = findPreviousTextureMetadata(meta, parsedSlot?.token || slot, filePath, parsedSlot?.materialRole || "");
    const metadata = copiedTextureMetadata.get(normalizedSlot)
      || await inspectStoredTextureMetadata(filePath, previousMetadata || {});
    return [normalizedSlot, metadata];
  })));
  const existingNormalMapFormats = meta?.normalMapFormats && typeof meta.normalMapFormats === "object" ? meta.normalMapFormats : {};
  const areaNormalMapFormats = buildAreaNormalMapFormats(
    textureEntries.map(([slot]) => {
      const parsedSlot = parseTextureToken(slot);
      return { areaIndex: parsedSlot?.areaIndex || 1 };
    }),
    { ...existingNormalMapFormats, ...payloadNormalMapFormats },
    normalizedNormalMapFormat
  );
  const activeModelLodEntries = [];
  for (const [slot, lodEntries] of modelLodMap.entries()) {
    if (!modelSlotMap.has(slot)) continue;
    for (const lodEntry of lodEntries) {
      if (!lodEntry?.filePath) continue;
      activeModelLodEntries.push({ slot, ...lodEntry });
    }
  }
  const activeModelFiles = new Set([
    ...modelEntries.map(([, filePath]) => normalizeFileIdentity(filePath)),
    ...activeModelLodEntries.map((item) => normalizeFileIdentity(item.filePath))
  ].filter(Boolean));
  const activeTextureFiles = new Set(textureEntries.map(([, filePath]) => normalizeFileIdentity(filePath)).filter(Boolean));
  for (const filePath of previousModelFiles) {
    if (isUnderRoot(assetDir, filePath) && !activeModelFiles.has(normalizeFileIdentity(filePath))) {
      await fs.rm(filePath, { force: true });
    }
  }
  for (const filePath of previousTextureFiles) {
    if (isUnderRoot(assetDir, filePath) && !activeTextureFiles.has(normalizeFileIdentity(filePath))) {
      await fs.rm(filePath, { force: true });
    }
  }
  const baseComponents = Array.isArray(meta.components)
    ? meta.components.filter((item) => item && item.type !== "model" && item.type !== "texture")
    : [];

  meta.name = nextName;
  meta.assetID = assetId;
  delete meta.id;
  delete meta.uniqueId;
  meta.topCategory = nextTopCategory;
  meta.assetType = nextAssetType;
  meta.asset_type = nextAssetType;
  meta.standardAssetTags = nextStandardAssetTags;
  meta.zionTags = nextZionTags;
  if (nextNativePlantWind) meta.nativePlantWind = nextNativePlantWind;
  else delete meta.nativePlantWind;
  if (nextAssetType === "surface") {
    meta.baseTiling = normalizeBaseTilingValue(payload?.baseTiling, meta.baseTiling);
  } else {
    delete meta.baseTiling;
  }
  meta.slug = isFlatAsset
    ? (meta.slug || path.basename(String((meta.modelFiles || target.modelFiles || [])[0] || metadataFileName), path.extname(String((meta.modelFiles || target.modelFiles || [])[0] || metadataFileName))))
    : path.basename(assetDir);
  meta.category = nextCategory;
  meta.animationAffiliation = nextAffiliation || undefined;
  meta.tags = mergedTags;
  meta.normalMapFormat = normalizedNormalMapFormat;
  meta.normalMapFormats = areaNormalMapFormats;
  if (payload?.materialNames !== undefined) meta.materialNames = payload.materialNames;
  meta.categories = [nextTopCategory, nextAssetType, nextCategory.toLowerCase(), nextAffiliation].filter(Boolean);
  meta.semanticTags = typeof meta.semanticTags === "object" && meta.semanticTags ? meta.semanticTags : {};
  if (nextSourceIdentity.sourceKind === "megascans") Object.assign(meta.semanticTags, bridgeSemanticDetails(payload?.sourceSemanticTags));
  meta.semanticTags.name = nextName;
  meta.semanticTags.asset_type = nextAssetType;
  meta.semanticTags.contains = mergedTags;
  meta.semanticTags.theme = [nextCategory, nextAffiliation].filter(Boolean);
  meta.semanticTags.subject_matter = nextCategory;

  if (!meta.createdAt) {
    meta.createdAt = new Date().toISOString();
  }
  meta.components = [
    ...baseComponents,
    ...modelEntries.map(([slot, filePath]) => ({
      type: "model",
      slot,
      uri: normalizePath(path.relative(assetDir, filePath)),
      ...(isMeshSlotName(slot)
        ? modelVariantMetadataFields(modelVariantKeys.get(String(slot).toLowerCase()) || parseModelVariantKey(filePath))
        : {})
    })),
    ...textureEntries.map(([slot, filePath]) => {
      const parsedSlot = parseTextureToken(slot);
      const normalizedSlot = parsedSlot ? `${parsedSlot.token}|${parsedSlot.materialRole}` : slot;
      const nextItem = {
        type: "texture",
        slot: parsedSlot?.textureType || slot,
        areaIndex: parsedSlot?.areaIndex || 1,
        uri: toStoredTextureUri(filePath),
        ...(parsedSlot?.materialRole ? { materialRole: parsedSlot.materialRole } : {}),
        ...textureResolutionMetadataFields(textureMetadataBySlot.get(normalizedSlot))
      };
      if (String(parsedSlot?.textureType || slot).toLowerCase() === "normal") {
        nextItem.normalMapFormat = areaNormalMapFormats[parsedSlot?.areaIndex || 1] || normalizedNormalMapFormat;
      }
      return nextItem;
    })
  ];
  meta.modelFiles = modelEntries.map(([, filePath]) => normalizePath(filePath));
  meta.modelSlots = Object.fromEntries(modelEntries.map(([slot, filePath]) => [slot, normalizePath(filePath)]));
  meta.modelVariants = modelEntries
    .filter(([slot, filePath]) => isMeshSlotName(slot) && filePath)
    .map(([slot, filePath]) => ({
      file: normalizePath(filePath),
      ...modelVariantMetadataFields(modelVariantKeys.get(String(slot).toLowerCase()) || parseModelVariantKey(filePath))
    }));
  meta.modelLods = activeModelLodEntries.map((item) => ({
    file: normalizePath(item.filePath),
    slot: item.slot,
    lod: Math.max(0, Math.floor(Number(item.lod) || 0)),
    ...modelVariantMetadataFields(item.variantKey || parseModelVariantKey(item.filePath) || "01")
  }));
  meta.textureFiles = textureEntries.map(([, filePath]) => normalizePath(filePath));
  meta.textureSlots = Object.fromEntries(
    textureEntries
      .map(([slot, filePath]) => {
        const parsedSlot = parseTextureToken(slot);
        if (!parsedSlot || parsedSlot.areaIndex > 1 || parsedSlot.materialRole === "billboard") {
          return null;
        }
        return [parsedSlot.textureType, normalizePath(filePath)];
      })
      .filter(Boolean)
  );
  meta.textureEntries = textureEntries.map(([slot, filePath]) => {
    const parsedSlot = parseTextureToken(slot);
    const normalizedSlot = parsedSlot ? `${parsedSlot.token}|${parsedSlot.materialRole}` : slot;
    const nextItem = {
      textureType: parsedSlot?.textureType || slot,
      areaIndex: parsedSlot?.areaIndex || 1,
      uri: toStoredTextureUri(filePath),
      ...(parsedSlot?.materialRole ? { materialRole: parsedSlot.materialRole } : {}),
      ...textureResolutionMetadataFields(textureMetadataBySlot.get(normalizedSlot))
    };
    if (String(parsedSlot?.textureType || slot).toLowerCase() === "normal") {
      nextItem.normalMapFormat = areaNormalMapFormats[parsedSlot?.areaIndex || 1] || normalizedNormalMapFormat;
    }
    return nextItem;
  });

  if (isModelAssetType(nextAssetType)) {
    const scanInformation = meta.scanInformation && typeof meta.scanInformation === "object" && !Array.isArray(meta.scanInformation)
      ? meta.scanInformation
      : {};
    try {
      meta.textureAnalysis = await analyzeAssetTextureUsage({
        dimensions: scanInformation.dimensions,
        dimensionsSource: scanInformation.dimensionsSource,
        textureFiles: meta.textureFiles,
        previousAnalysis: meta.textureAnalysis || target.textureAnalysis
      });
    } catch (error) {
      delete meta.textureAnalysis;
      writeLog("WARN", "failed to refresh 4K texture analysis during custom asset update", {
        id: assetId,
        message: error?.message || String(error)
      });
    }
  } else {
    delete meta.textureAnalysis;
  }
  if (payload?.previewSkeletonPath !== undefined) {
    meta.previewSkeletonPath = String(payload.previewSkeletonPath || "").trim();
  }
  if (payload?.previewSkeletalMeshPath !== undefined) {
    meta.previewSkeletalMeshPath = String(payload.previewSkeletalMeshPath || "").trim();
  }

  const hasTextureChanges = Object.keys(inputTextureSlots).length > 0 || removeTextureSlots.length > 0 || Array.isArray(payload?.textureEntries);
  const updatedColorTags = hasTextureChanges ? await inferColorTagsSafely(textureEntries.map(([, filePath]) => filePath)) : (meta.colorTags || target.colorTags || collectColorTagsFromMeta(meta) || []);
  applyColorTagsToMeta(meta, updatedColorTags);

  const payloadContentIdentity = payload?.contentIdentity && typeof payload.contentIdentity === "object" && !Array.isArray(payload.contentIdentity)
    ? payload.contentIdentity
    : {};
  let resolvedContentIdentity = { ...payloadContentIdentity };
  const shouldRecomputeContentIdentity = Boolean(
    Object.keys(inputModelSlots).length > 0
    || Array.isArray(payload?.modelLodFiles)
    || (payload?.modelLodFiles && typeof payload.modelLodFiles === "object" && Object.keys(payload.modelLodFiles).length > 0)
    || payloadTextureEntries.length > 0
    || removeModelSlots.length > 0
    || removeTextureSlots.length > 0
  );
  if (shouldRecomputeContentIdentity && (modelEntries.length > 0 || textureEntries.length > 0)) {
    try {
      const mergedModelLodFiles = new Map();
      for (const item of activeModelLodEntries) {
        const slotKey = String(item.slot || "").toLowerCase();
        if (!mergedModelLodFiles.has(slotKey)) mergedModelLodFiles.set(slotKey, []);
        mergedModelLodFiles.get(slotKey).push({ source: item.filePath, lod: item.lod });
      }
      resolvedContentIdentity = await computeContentIdentity({
        modelSlots: modelEntries.map(([slot, filePath]) => ({ suffix: slot, source: filePath })),
        modelLodFiles: mergedModelLodFiles,
        textureSlots: textureEntries.map(([slot, filePath]) => {
          const parsedSlot = parseTextureToken(slot);
          return {
            suffix: parsedSlot?.token || slot,
            source: filePath,
            materialRole: parsedSlot?.materialRole || "",
            areaIndex: parsedSlot?.areaIndex || 1
          };
        })
      });
    } catch (error) {
      writeLog("WARN", "failed to recompute merged asset content identity", {
        assetId,
        message: error?.message || String(error)
      });
    }
  }
  const nextContentFingerprint = String(resolvedContentIdentity.contentFingerprint || previousIdentity.contentFingerprint || "").trim();
  const identityUpdatedAt = new Date().toISOString();
  meta.identity = {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    ...previousIdentity,
    ...nextSourceIdentity,
    ...(resolvedContentIdentity.fingerprintVersion ? { fingerprintVersion: resolvedContentIdentity.fingerprintVersion } : {}),
    ...(resolvedContentIdentity.modelFingerprints && typeof resolvedContentIdentity.modelFingerprints === "object"
      ? { modelFingerprints: resolvedContentIdentity.modelFingerprints }
      : {}),
    ...(resolvedContentIdentity.textureFingerprint ? { textureFingerprint: resolvedContentIdentity.textureFingerprint } : {}),
    ...(nextContentFingerprint ? { contentFingerprint: nextContentFingerprint } : {})
  };
  meta.revision = Math.max(1, Math.floor(Number(meta.revision) || 1)) + 1;
  meta.importHistory = [
    ...(Array.isArray(meta.importHistory) ? meta.importHistory : []).slice(-49),
    {
      at: identityUpdatedAt,
      action: payload?.dedupeAction === "update" ? "update" : "edit",
      sourcePath: String(payload?.sourcePath || "").trim(),
      previousFingerprint: String(previousIdentity.contentFingerprint || "").trim(),
      nextFingerprint: nextContentFingerprint
    }
  ];

  const previousAnimationModelPath = String(metaPath || (Array.isArray(target.modelFiles) && target.modelFiles[0]) || "").trim();
  const animationModelPath = String((modelEntries[0] && modelEntries[0][1]) || (Array.isArray(meta.modelFiles) && meta.modelFiles[0]) || (target.modelFiles || [])[0] || "").trim();
  let nextMetaPath = metaPath;
  if (isFlatCustomAssetType(nextAssetType)) {
    if (animationModelPath) {
      nextMetaPath = animationModelPath;
    }
    const stem = path.basename(nextMetaPath, path.extname(nextMetaPath));
    await cleanupAnimationArchiveExtras(assetDir, stem);
    if (animationModelPath) {
      await writeAnimationIdentitySidecar(animationModelPath, meta).catch((error) => {
        writeLog("WARN", "failed to write animation identity sidecar during update", {
          path: animationModelPath,
          message: error?.message || String(error)
        });
      });
      if (previousAnimationModelPath && path.resolve(previousAnimationModelPath).toLowerCase() !== path.resolve(animationModelPath).toLowerCase()) {
        await fs.rm(getAnimationIdentitySidecarPath(previousAnimationModelPath), { force: true }).catch(() => {});
      }
    }
  } else {
    const metadataWrite = await writeAssetMetadata(assetDir, meta, { updatedAt: identityUpdatedAt, fileName: metadataFileName });
    meta = metadataWrite.meta;
    nextMetaPath = metadataWrite.metaPath;
  }

  const previewRel = ((isFlatCustomAssetType(nextAssetType) && meta.previewImage)
    || meta?.previews?.images?.[0]?.uri || meta.previewImage || meta.detailImage || "").trim();
  const previewUri = previewRel
    ? (path.isAbsolute(previewRel) ? previewRel : path.join(assetDir, previewRel))
    : "";
  const updatedAsset = {
    ...target,
    id: assetId,
    name: nextName,
    slug: meta.slug || target.slug,
    source: "custom",
    sourceRoot: settings.customLibraryPath,
    path: assetDir,
    metaPath: nextMetaPath,
    topCategory: nextTopCategory,
    assetType: nextAssetType,
    standardAssetTags: nextStandardAssetTags,
    zionTags: nextZionTags,
    animationAffiliation: nextAffiliation || undefined,
    baseTiling: meta.baseTiling,
    tags: mergedTags,
    themes: [nextCategory.toLowerCase(), nextAffiliation].filter(Boolean),
    categories: [nextTopCategory, nextAssetType, nextCategory.toLowerCase(), nextAffiliation].filter(Boolean),
    preview: previewUri ? normalizePath(previewUri) : "",
    previewImage: previewUri ? normalizePath(previewUri) : "",
    detailImage: previewUri ? normalizePath(previewUri) : "",
    modelFiles: meta.modelFiles,
    textureFiles: meta.textureFiles,
    textureAnalysis: meta.textureAnalysis || undefined,
    colorTags: collectColorTagsFromMeta(meta),
    meta
  };
  await commitFileTransaction();
  const assetIndex = index.findIndex((asset) => asset.id === assetId && asset.source === "custom");
  if (assetIndex >= 0) {
    index[assetIndex] = toAssetIndexRecord(updatedAsset);
  } else {
    index.push(toAssetIndexRecord(updatedAsset));
  }
  getSharedDerivedCache().warmAssets?.([updatedAsset], { priority: true });

  // 抑制文件监控引发的二次扫描，给它10秒的时间窗口
  markInternalLibraryMutation(10000);

  scheduleIndexSnapshotSave("update_custom_asset");

  const refreshedAsset = updatedAsset;

  // 更新数据库缓存并发送增量更新给前端
  applyLibrarySqlCacheChanges({ upsertAssets: [updatedAsset], deleteIds: [], changedDirectories: [target.path] }).catch(err => {
    writeLog("ERROR", "applyLibrarySqlCacheChanges failed during updateCustomAsset", { message: err.message });
  });

  if (sender && !sender.isDestroyed()) {
    sender.send("assets:change", { incremental: true, count: index.length });
  }

  emitCustomSaveProgress(sender, assetId, 100, "done");
  return {
    ok: true,
    message: "资产信息已更新",
    assetId,
    asset: refreshedAsset,
    listAsset: toAssetListRecord(refreshedAsset)
  };
}

// 资产库内「重新 Opaque 裁切」：按透贴为 FBX 植被生成或替换 _OPAQUE 裁切变体。
// 裁切管线与导入侧完全一致（foliageOpaqueRegenerate → buildFoliageOpaqueVariants），
// 差别只是数据来源改为资产目录里的既有元数据，成功后回写元数据并刷新索引与 SQLite 缓存。
const foliageOpaqueRegenInFlight = new Set();
async function regenerateFoliageOpaqueCut(payload, sender) {
  const assetId = String(payload?.assetId || "").trim();
  if (!assetId) {
    return { ok: false, message: "缺少资产ID" };
  }
  const target = index.find((asset) => asset.id === assetId && asset.source === "custom");
  if (!target) {
    return { ok: false, message: "未找到库内的自定义资产" };
  }
  const assetType = String(target.assetType || "").trim().toLowerCase();
  if (assetType !== "3dplant") {
    return { ok: false, message: "重新裁切仅支持 FBX 植被（3D Plants）" };
  }
  const assetDir = String(target.path || "").trim();
  const metaPath = String(target.metaPath || "").trim();
  if (!assetDir || !metaPath) {
    return { ok: false, message: "资产目录或元数据缺失，无法重新裁切" };
  }
  const meta = await loadJson(metaPath, null);
  if (!meta || typeof meta !== "object") {
    return { ok: false, message: "资产元数据读取失败" };
  }
  if (isZionPlantAsset(target, meta)) {
    return { ok: false, message: "Zion 植被保留原始模型，不支持 OPAQUE 几何裁切；导入 UE 时按透贴自动启用 Masked" };
  }
  if (foliageOpaqueRegenInFlight.has(assetId)) {
    return { ok: false, message: "该资产正在重新裁切，请稍候" };
  }
  const runtime = foliageOpaqueStatus();
  if (!runtime.available) {
    return { ok: false, message: runtime.message || "不透明裁切处理器不可用" };
  }

  foliageOpaqueRegenInFlight.add(assetId);
  try {
    const assetName = String(meta.name || target.name || assetId).trim() || assetId;
    const requestedOptions = payload?.options && typeof payload.options === "object" ? payload.options : payload;
    // 重新裁切走的是界面上的「裁切参数」面板：面数设置为 0（或不填）时按植被子类
    // 档位推导面数预设，填了数值则覆盖（与导入路径同一套，见 plantOpaqueBudget）。
    // 与导入一致：预设只作闸门/提示，导出不减面，收敛交给 UE 侧 Nanite。
    const regenBudgetRange = requestedOptions?.faceBudgetAuto === true
      ? resolvePlantOpaqueBudgetRange({
          tags: [
            ...(Array.isArray(meta.standardAssetTags) ? meta.standardAssetTags : []),
            ...(Array.isArray(meta.tags) ? meta.tags : [])
          ],
          category: meta.category
        })
      : null;
    const cutOptions = regenBudgetRange
      ? {
          ...requestedOptions,
          faceBudget: regenBudgetRange.ceiling,
          faceBudgetFloor: regenBudgetRange.floor,
          faceBudgetCeiling: regenBudgetRange.ceiling,
          simplifyTarget: 0
        }
      : requestedOptions;
    const outcome = await regenerateFoliageOpaqueVariants({
      assetDir,
      assetId,
      assetName,
      meta,
      cutOptions,
      isMeshSlot: isMeshSlotName,
      meshSlotNameForOrder: formatMeshSlotName,
      nameForModel: (variantKey) => makeCustomModelBaseName("Mesh", assetName, assetId, { variantKey }),
      // 重新裁切是整个操作的主体（12 变体约 6 分钟）：逐变体推进进度环，
      // 否则期间完全静默，与入库路径是同一个"看着像完成了"的问题。
      onProgress: (progress) => {
        const done = Math.max(0, Math.floor(Number(progress?.done) || 0));
        const total = Math.max(1, Math.floor(Number(progress?.total) || 1));
        emitCustomSaveProgress(sender, assetId,
          5 + Math.round(90 * (done / total)),
          `foliage-opaque ${done}/${total}`);
      },
      onLog: (message) => writeLog("INFO", "foliage opaque regenerate " + message)
    });
    if (!outcome.ok || !outcome.meta) {
      writeLog("WARN", "foliage opaque regenerate failed", { assetId, message: outcome.message });
      // 进度环必须闭环：上面 5..95 的梯级把 owner 设为该资产；失败时若不发终态，
      // 卡片会永远停在"正在保存 95%"（重切是少数会失败的路径，表现为"有概率卡住"）。
      emitCustomSaveFailure(sender, outcome.message || "重新裁切失败");
      return { ok: false, message: outcome.message || "重新裁切失败", warnings: outcome.warnings };
    }
    const updatedAt = new Date().toISOString();
    outcome.meta.metadataUpdate = buildMetadataUpdateMarker(updatedAt);
    outcome.meta.revision = Math.max(1, Math.floor(Number(outcome.meta.revision) || 1)) + 1;
    // 同上：把本次重切用的面数预设写回元数据，导出时随导入 job 下发给插件，
    // 由它设 _OPAQUE 的 Nanite 面数上限（0 = 仍按插件档位表）。
    outcome.meta.foliageOpaque = {
      ...(outcome.meta.foliageOpaque || {}),
      faceBudget: Math.max(0, Math.floor(Number(cutOptions?.faceBudget) || 0)),
      faceBudgetAuto: cutOptions?.faceBudgetAuto === true
    };
    const metadataWrite = await writeAssetMetadata(assetDir, outcome.meta, { updatedAt, fileName: path.basename(metaPath) });
    markInternalLibraryMutation(10000);
    scheduleIndexSnapshotSave("regenerate_foliage_opaque");
    const refreshed = await refreshAssetById(assetId);
    if (refreshed) {
      applyLibrarySqlCacheChanges({ upsertAssets: [refreshed], deleteIds: [] }).catch((error) => {
        writeLog("ERROR", "applyLibrarySqlCacheChanges failed during regenerateFoliageOpaqueCut", { message: error?.message });
      });
    }
    if (sender && !sender.isDestroyed()) {
      sender.send("assets:change", { incremental: true, count: index.length });
    }
    writeLog("INFO", "foliage opaque regenerate finished", {
      assetId,
      generated: outcome.generated,
      replaced: outcome.removedFiles,
      restored: outcome.restoredVariants,
      warnings: outcome.warnings.length,
      options: {
        contourPrecisionTexels: cutOptions?.contourPrecisionTexels,
        maskErodeTexels: cutOptions?.maskErodeTexels,
        fillHoles: cutOptions?.fillHoles,
        holeMaxAreaTexels: cutOptions?.holeMaxAreaTexels,
        faceBudget: cutOptions?.faceBudget,
        cleanupPercent: cutOptions?.cleanupPercent
      }
    });
    // 进度闭环：重切的进度梯级上限是 95（5 + 90×done/total），终态必须在这里补发，
    // 否则卡片会永远停在"正在保存 95%"，看起来像卡死（实际任务已经完成）。
    emitCustomSaveProgress(sender, assetId, 100, "done");
    return {
      ok: true,
      message: outcome.message,
      assetId,
      asset: refreshed || null,
      generated: outcome.generated,
      removed: outcome.removedFiles,
      restored: outcome.restoredVariants,
      metaPath: metadataWrite.metaPath,
      warnings: outcome.warnings
    };
  } catch (error) {
    // 异常路径同样要闭环，否则失败后卡片一直停在中间进度。
    emitCustomSaveFailure(sender, error?.message || String(error));
    throw error;
  } finally {
    foliageOpaqueRegenInFlight.delete(assetId);
  }
}

async function deleteLegacyCustomAsset(payload) {
  const assetId = String(payload?.assetId || "").trim();
  if (!assetId) {
    return { ok: false, message: "缺少资产ID" };
  }
  const target = index.find((asset) => asset.id === assetId && asset.source === "custom");
  if (!target) {
    return { ok: false, message: "未找到可删除的自定义资产" };
  }
  const customRoot = String(settings.customLibraryPath || "").trim();
  if (!customRoot) {
    return { ok: false, message: "未配置 Standard Library 路径" };
  }
  const resolvedRoot = path.resolve(customRoot);
  const resolvedTarget = path.resolve(target.path || "");
  const normalizedRoot = resolvedRoot.toLowerCase();
  const normalizedTarget = resolvedTarget.toLowerCase();
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep.toLowerCase()}`)) {
    return { ok: false, message: "删除路径不在标准库目录中" };
  }
  const targetStat = await statOrNull(resolvedTarget);
  if (!targetStat?.isDirectory()) {
    return { ok: false, message: "资产目录不存在或无效" };
  }
  markInternalLibraryMutation(25000);
  const failedRemovals = [];
  if (isFlatLibraryAsset(target.assetType, target.metaPath)) {
    const filesToRemove = new Set();
    const addFile = (filePath) => {
      const rawPath = String(filePath || "").trim();
      if (!rawPath) return;
      const resolved = path.resolve(rawPath);
      if (!resolved || resolved.toLowerCase() === normalizedRoot) return;
      if (resolved.toLowerCase() !== normalizedRoot && !resolved.toLowerCase().startsWith(`${normalizedRoot}${path.sep.toLowerCase()}`)) return;
      filesToRemove.add(resolved);
    };
    addFile(target.metaPath);
    for (const filePath of [...(target.modelFiles || []), ...(target.textureFiles || [])]) {
      addFile(filePath);
    }
    addFile(target.previewImage || target.preview || target.detailImage);
    const animationModelPath = String(target.metaPath || (target.modelFiles || [])[0] || "").trim();
    const stem = path.basename(animationModelPath, path.extname(animationModelPath));
    for (const extraPath of listAnimationArchiveExtras(resolvedTarget, stem)) {
      addFile(extraPath);
    }
    addFile(getAnimationIdentitySidecarPath(animationModelPath));
    for (const filePath of filesToRemove) {
      const stat = await statOrNull(filePath);
      if (stat?.isDirectory() && path.basename(filePath).toLowerCase() !== "preview" && path.basename(filePath).toLowerCase() !== "previews") {
        continue;
      }
      const removal = await removeLibraryPathWithRetries(filePath, {
        trashRoot: resolvedRoot,
        label: path.basename(filePath)
      });
      if (removal.ok) {
        if (removal.mode === "trashed") {
          void purgeTrashEntry(removal.staged);
        }
      } else {
        failedRemovals.push({ path: filePath, error: removal.error });
      }
    }
  } else {
    const removal = await removeLibraryPathWithRetries(resolvedTarget, {
      trashRoot: resolvedRoot,
      label: path.basename(resolvedTarget)
    });
    if (removal.ok) {
      if (removal.mode === "trashed") {
        void purgeTrashEntry(removal.staged);
      }
    } else {
      failedRemovals.push({ path: resolvedTarget, error: removal.error });
    }
  }
  if (failedRemovals.length > 0) {
    const failure = failedRemovals[0];
    const failureCode = String(failure.error?.code || "").trim();
    writeLog("ERROR", "deleteCustomAsset failed to remove path", {
      assetId,
      path: failure.path,
      code: failureCode,
      message: failure.error?.message || ""
    });
    return {
      ok: false,
      assetId,
      message: failureCode
        ? "删除失败：文件被占用或无权限（" + failureCode + "），请关闭预览、资源管理器或占用该文件的程序后重试"
        : "删除失败：文件被占用或无权限，请关闭预览、资源管理器或占用该文件的程序后重试"
    };
  }
  index = index.filter((asset) => !(asset.id === assetId && asset.source === "custom"));

  // 抑制文件监控引发的二次扫描，给它10秒的时间窗口
  markInternalLibraryMutation(10000);

  scheduleIndexSnapshotSave("delete_custom_asset");

  applyLibrarySqlCacheChanges({ upsertAssets: [], deleteIds: [assetId], changedDirectories: [resolvedTarget] }).catch(err => {
    writeLog("ERROR", "applyLibrarySqlCacheChanges failed during deleteCustomAsset", { message: err.message });
  });

  const window = BrowserWindow.getAllWindows()[0];
  if (window && !window.isDestroyed()) {
    window.webContents.send("assets:change", { incremental: true, count: index.length });
  }

  return {
    ok: true,
    message: "资产已删除",
    assetId
  };
}

// The recycle journal is authoritative even when a local/shared cache is stale.
let recycleInProgress = false;
async function filterRecycledIndex(concurrency = 8) {
  const root = String(settings.customLibraryPath || "").trim();
  if (!root) return;
  const generation = librarySelectionGeneration;
  const [recycled, permanentlyDeleted] = await Promise.all([
    listRecycledAssets(root, { concurrency }),
    listPermanentlyDeletedAssets(root, { concurrency })
  ]);
  if (generation !== librarySelectionGeneration) return;
  const deleted = new Set([...recycled, ...permanentlyDeleted].map(item => item.assetId));
  if (deleted.size) index = index.filter(asset => !deleted.has(asset.id));
}

async function syncRecycleIndex(action, asset, root) {
  if (normalizeComparePath(settings.customLibraryPath) !== normalizeComparePath(root)) {
    throw new Error("标准库已切换，请在原库刷新索引");
  }
  index = index.filter(item => item.id !== asset.id);
  if (action === "restore") index.push(asset);
  await applyLibrarySqlCacheChanges({ upsertAssets: action === "restore" ? [asset] : [], deleteIds: action === "delete" ? [asset.id] : [], changedDirectories: [asset.path] });
  if (!getLibraryDb() && !await saveIndexSnapshot(index)) throw new Error("本机索引未能持久化");
  sharedSnapshotVersion++;
  if (sharedIndexComplete && !scanInProgress) publishSharedIndexSnapshot();
}

async function waitForCharacterDeletion(report) {
  const started = Date.now();
  while (scanInProgress || hasActiveBackgroundImport() || activeExportCalls > 0 || foliageOpaqueRegenInFlight.size) {
    report(0, scanInProgress ? '正在等待当前扫描结束，随后删除…' : '正在等待当前资源操作结束，随后删除…');
    if (Date.now() - started > 120000) throw new Error('当前资源操作仍未结束，本次未删除任何文件，请稍后重试');
    await new Promise(resolve => globalThis.setTimeout(resolve, 250));
  }
}

async function waitForCharacterOperation(readOnly, previewOnly = false) {
  if (recycleInProgress) throw new Error('正在删除角色资产，请稍后重试');
  // Inspection only reads the current metadata. Background library polling
  // must not reject a user's file/folder selection.
  if (readOnly) return;
  const started = Date.now();
  while ((!previewOnly && scanInProgress) || hasActiveBackgroundImport() || activeExportCalls > 0) {
    if (Date.now() - started > 30000) throw new Error('其他资源操作尚未完成，请稍后确认更新');
    await new Promise(resolve => globalThis.setTimeout(resolve, 120));
    if (recycleInProgress) throw new Error('正在删除角色资产，请稍后重试');
  }
}

async function previewCustomAssetDeletion(payload) {
  if (String(payload?.assetId || "").includes("::part::")) throw new Error("部件不能单独删除，请从主体删除整套及所属部件");
  // Read-only confirmation can run during polling or export. The confirmed
  // token and live files are checked again after acquiring the deletion lock.
  if (recycleInProgress) throw new Error('正在删除角色资产，请稍后重试');
  const target = index.find(asset => asset.id === payload?.assetId && asset.source === "custom");
  if (!target || !["monster", "suit", "npc", "weapon", "item"].includes(target.assetType)) throw new Error("请选择角色资产进行删除");
  return { ok: true, plan: await preparePermanentCharacterDeletion({ root: settings.customLibraryPath, asset: target, records: index }) };
}

async function deleteCustomAsset(payload, sender) {
  if (String(payload?.assetId || "").includes("::part::")) throw new Error("部件不能单独删除，请从主体删除整套及所属部件");
  const selected = index.find(asset => asset.id === payload?.assetId && asset.source === "custom");
  if (selected && !["monster", "suit", "npc", "weapon", "item"].includes(selected.assetType)) return deleteLegacyCustomAsset(payload);
  if (recycleInProgress) throw new Error('正在删除角色资产，请稍后重试');
  recycleInProgress = true;
  const root = settings.customLibraryPath;
  const startedAt = Date.now();
  const report = (progress, message) => emitCustomSaveProgress(sender, payload.assetId, progress, `character-update:${message}`);
  let blockedPaths = [];
  try {
    // Reserve the operation first: no new background scans/exports may race
    // ahead while we drain an already running operation.
    await waitForCharacterDeletion(report);
    if (normalizeComparePath(settings.customLibraryPath) !== normalizeComparePath(root)) throw new Error('标准库已切换，本次未删除任何文件');
    report(0, '正在检查关联缓存…');
    const target = index.find(asset => asset.id === payload?.assetId && asset.source === "custom");
    const { prepareCharacterCacheCleanup, clearCharacterCacheFiles } = require('./services/characterCacheCleanup');
    const cleanup = await prepareCharacterCacheCleanup(target, root, getPersistentCacheRoot());
    blockedPaths = cleanup.paths.map(file => path.resolve(file).toLowerCase());
    blockedPaths.forEach(file => deletingCharacterCachePaths.add(file));
    await Promise.allSettled([...previewThumbnailTasks].filter(([file]) => deletingCharacterCachePaths.has(file)).flatMap(([, tasks]) => [...tasks]));
    // Finish old thumbnail publishers before deleting. Index publication below
    // uses a fresh cache worker and must not be cancelled by cache cleanup.
    sharedDerivedCache?.dispose(); sharedDerivedCache = null;
    markInternalLibraryMutation(25000);
    const result = await deleteCharacterPermanently({ root, asset: target, records: index, token: payload?.token, confirmPermanent: payload?.confirmPermanent,
      onProgress: (progress, message) => report(10 + progress * 0.7, message),
      onIndexChange: (action, asset) => syncRecycleIndex(action, asset, root) });
    if (result.ok) {
      try {
        report(82, '正在清理草稿和缓存…');
        const clearedDraftIds = await getImportQueueStore().discardCharacter(root, cleanup);
        for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('assets:characterDeleted', {
          assetId: target.id, assetPath: target.path, paths: cleanup.paths, clearedDraftIds
        });
        await clearCharacterCacheFiles(cleanup);
        report(92, '正在清理扫描记录…');
        const { clearCharacterScanMemos } = require('./services/characterCacheCleanup');
        await clearCharacterScanMemos(cleanup, root, [getLibrarySqlCachePath().replace(/\.sqlite$/, '.memo.json.gz'), getLibrarySqlCachePath().replace(/\.sqlite$/, '.memo.resident.json.gz')]);
        require('./services/characterSuitExport').clearCharacterExportInspection();
        result.cachesCleared = true;
      } catch (error) {
        result.cleanupPending = true;
        result.message = `资产已删除，相关缓存清理未完成：${error.message}`;
        writeLog('ERROR', 'character deletion cache cleanup failed', { assetId: target.id, message: error.message });
      }
    }
    // characterDeleted already removes the owner/parts in every window. A full
    // index reload here re-read the journals and 30k unrelated records again.
    if (!result.ok || result.indexPending) {
      await filterRecycledIndex();
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('assets:change');
    }
    if (result.ok) report(100, '删除完成');
    writeLog(result.ok ? "INFO" : "ERROR", "character permanent deletion", { assetId: result.assetId, durationMs: Date.now() - startedAt, indexPending: result.indexPending, message: result.message });
    return result;
  } finally {
    blockedPaths.forEach(file => deletingCharacterCachePaths.delete(file));
    recycleInProgress = false;
  }
}

async function rewriteCustomJsonFiles(options = {}) {
  const syncCurrentRules = options?.syncCurrentRules === true;
  const sender = options?.sender || null;
  markInternalLibraryMutation(syncCurrentRules ? 180000 : 60000);
  const customAssets = index.filter((asset) => asset.source === "custom");
  let updatedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let animationSkippedCount = 0;
  let fingerprintCreatedCount = 0;
  let opaqueRenamedCount = 0;
  for (const asset of customAssets) {
    let appliedOpaqueRenames = [];
    let appliedOpaqueAssetDir = "";
    try {
      if (syncCurrentRules && isAnimationLibraryAsset(asset, asset.meta || {})) {
        animationSkippedCount += 1;
        continue;
      }
      const metaPath = String(asset.metaPath || "").trim();
      if (!metaPath || (syncCurrentRules
        ? (isFlatCustomAssetType(asset.assetType) || isAnimationModelMetaPath(metaPath))
        : isFlatLibraryAsset(asset.assetType, metaPath))) {
        skippedCount += 1;
        continue;
      }
      const loadedMeta = await loadJson(metaPath, null);
      if (!loadedMeta || typeof loadedMeta !== "object") {
        skippedCount += 1;
        continue;
      }
      if (syncCurrentRules && isAnimationLibraryAsset(asset, loadedMeta)) {
        animationSkippedCount += 1;
        continue;
      }
      let meta = loadedMeta;
      let opaqueMigrationChanged = false;
      const assetDir = path.resolve(asset.path || path.dirname(metaPath));
      const migrationAssetType = normalizeAssetType(asset.assetType || meta.assetType || meta.asset_type);
      if (syncCurrentRules && (migrationAssetType === "3d" || migrationAssetType === "3dplant")) {
        const opaqueMigration = prepareOpaqueFilenameMigration(assetDir, meta);
        if (opaqueMigration.changed) {
          opaqueMigrationChanged = true;
          if (opaqueMigration.renames.length > 0) {
            applyOpaqueRenamePlan(assetDir, opaqueMigration.renames);
            appliedOpaqueRenames = opaqueMigration.renames;
            appliedOpaqueAssetDir = assetDir;
            opaqueRenamedCount += opaqueMigration.renames.length;
          }
          meta = opaqueMigration.metadata;
          writeLog("INFO", "opaque filename migration", {
            id: asset.id,
            renames: opaqueMigration.renames.map((item) => `${item.from} -> ${item.to}`),
            metadataRepairOnly: opaqueMigration.renames.length === 0
          });
        }
      }
      if (syncCurrentRules && hasCurrentMetadataUpdateMarker(meta) && normalizeContentIdentity(meta.identity)) {
        if (opaqueMigrationChanged) {
          const migrationUpdatedAt = new Date().toISOString();
          const migrationWrite = await writeAssetMetadata(assetDir, {
            ...meta,
            updatedAt: migrationUpdatedAt,
            metadataUpdate: buildMetadataUpdateMarker(migrationUpdatedAt)
          }, {
            updatedAt: migrationUpdatedAt,
            fileName: path.basename(metaPath) || ASSET_METADATA_FILE_NAME
          });
          meta = migrationWrite.meta;
          if (migrationWrite.metaPath
            && path.resolve(metaPath).toLowerCase() !== path.resolve(migrationWrite.metaPath).toLowerCase()) {
            await fs.rm(metaPath, { force: true }).catch(() => {});
          }
          appliedOpaqueRenames = [];
          updatedCount += 1;
          continue;
        }
        skippedCount += 1;
        continue;
      }
      const normalizeAssetFilePath = (value) => {
        const raw = String(value || "").trim();
        if (!raw) {
          return "";
        }
        const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(assetDir, raw);
        return normalizePath(resolved);
      };
      const modelSlotMap = new Map();
      const modelPathSet = new Set();
      let meshSlotCounter = 1;
      const authoritativeAssetType = syncCurrentRules
        ? sanitizeToken(asset.assetType || meta.assetType || meta.asset_type)
        : sanitizeToken(meta.assetType || meta.asset_type || asset.assetType);
      const isMeshAssetType = isModelAssetType(authoritativeAssetType);
      const tryAddModel = (slotCandidate, filePath) => {
        const normalizedPath = normalizeAssetFilePath(filePath);
        if (!normalizedPath) {
          return;
        }
        if (modelPathSet.has(normalizedPath)) {
          return;
        }
        const normalizedSlotText = String(slotCandidate || "").trim();
        const slotFromLegacy = normalizeModelSlotName(normalizedSlotText);
        const slotFromMesh = isMeshAssetType && isMeshSlotName(normalizedSlotText)
          ? formatMeshSlotName(getMeshSlotOrder(normalizedSlotText))
          : "";
        const slotFromInput = slotFromLegacy || slotFromMesh;
        const inferredSlot = inferModelSlotFromFileName(normalizedPath);
        const slot = slotFromInput || inferredSlot || (isMeshAssetType ? formatMeshSlotName(meshSlotCounter++) : (modelSlotMap.has("HighPoly") ? "" : "HighPoly"));
        if (!slot) {
          return;
        }
        if (!modelSlotMap.has(slot)) {
          modelSlotMap.set(slot, normalizedPath);
          modelPathSet.add(normalizedPath);
        }
      };
      if (meta.modelSlots && typeof meta.modelSlots === "object" && !Array.isArray(meta.modelSlots)) {
        for (const [slotKey, filePath] of Object.entries(meta.modelSlots)) {
          tryAddModel(slotKey, filePath);
        }
      }
      const modelComponents = Array.isArray(meta.components) ? meta.components.filter((item) => item && item.type === "model") : [];
      for (const item of modelComponents) {
        const slotCandidate = String(item.slot || item.modelType || "").trim();
        const uriCandidate = String(item.uri || item.path || "").trim();
        tryAddModel(slotCandidate, uriCandidate);
      }
      const fallbackModelFiles = Array.isArray(meta.modelFiles) ? meta.modelFiles : [];
      for (const filePath of fallbackModelFiles) {
        tryAddModel("", filePath);
      }
      if (modelSlotMap.size === 0 && (syncCurrentRules || !isSidecarAssetMetaPath(metaPath))) {
        const diskModelFiles = await collectFilesByExtensions(assetDir, MODEL_EXTENSIONS);
        for (const filePath of diskModelFiles) {
          tryAddModel("", filePath);
        }
      }

      const textureSlotMap = new Map();
      const texturePathSet = new Set();
      const textureNormalMapFormatsByArea = {};
      const fallbackNormalFormat = normalizeNormalMapFormatValue(meta?.normalMapFormat, "dx");
      const persistedNormalFormats = meta?.normalMapFormats && typeof meta.normalMapFormats === "object" ? meta.normalMapFormats : {};
      const metaStandardAssetTags = Array.isArray(meta.standardAssetTags) ? meta.standardAssetTags : [];
      const isMegascansSource = String(meta.identity?.sourceKind || "").trim().toLowerCase() === "megascans"
        || [...metaStandardAssetTags, ...(Array.isArray(meta.tags) ? meta.tags : [])]
          .some((tag) => String(tag || "").trim().toLowerCase() === "megascans");
      const parseTextureEntryToken = (value) => {
        const { token, materialRole } = splitSyncedTextureToken(value);
        const parsed = parseTextureSlotToken(token);
        return parsed ? { ...parsed, materialRole: materialRole || "" } : null;
      };
      const buildTextureMetadataKey = (normalizedSlot, materialRole = "") => (materialRole ? `${normalizedSlot}|${materialRole}` : normalizedSlot);
      const tryAddTexture = (slotCandidate, filePath, areaCandidate = 1, normalMapFormatCandidate = "", materialRoleCandidate = "") => {
        const normalizedPath = normalizeAssetFilePath(filePath);
        if (!normalizedPath) {
          return;
        }
        const storedSlot = normalizeTextureSlotName(slotCandidate);
        const inferredSlot = normalizeTextureSlotName(inferTextureSlotFromFileName(normalizedPath));
        const normalizedSlot = syncCurrentRules && storedSlot === "Subsurface" && inferredSlot === "Translucency"
          ? inferredSlot
          : (storedSlot || inferredSlot);
        if (!normalizedSlot) {
          return;
        }
        const materialRole = resolveSyncedTextureMaterialRole(materialRoleCandidate, normalizedPath, { megascansSource: isMegascansSource });
        const areaIndex = Math.max(1, Number(areaCandidate) || 1);
        const token = buildSyncedTextureToken(normalizedSlot, areaIndex, materialRole);
        if (!token) {
          return;
        }
        if (!textureSlotMap.has(token)) {
          textureSlotMap.set(token, normalizedPath);
        }
        texturePathSet.add(normalizedPath.toLowerCase());
        if (normalizedSlot === "Normal") {
          textureNormalMapFormatsByArea[areaIndex] = normalizeNormalMapFormatValue(
            normalMapFormatCandidate || textureNormalMapFormatsByArea[areaIndex] || persistedNormalFormats[areaIndex] || persistedNormalFormats[String(areaIndex)],
            fallbackNormalFormat
          );
        }
      };
      const textureComponents = Array.isArray(meta.components) ? meta.components.filter((item) => item && item.type === "texture") : [];
      for (const item of textureComponents) {
        const slotCandidate = String(item.slot || item.textureType || "").trim();
        const uriCandidate = String(item.uri || item.path || "").trim();
        tryAddTexture(slotCandidate, uriCandidate, item.areaIndex, item.normalMapFormat, item.materialRole);
      }
      if (Array.isArray(meta.textureEntries)) {
        for (const item of meta.textureEntries) {
          if (!item || typeof item !== "object") {
            continue;
          }
          const slotCandidate = String(item.slot || item.textureType || "").trim();
          const uriCandidate = String(item.uri || item.path || "").trim();
          tryAddTexture(slotCandidate, uriCandidate, item.areaIndex, item.normalMapFormat, item.materialRole);
        }
      }
      const fallbackTextureFiles = Array.isArray(meta.textureFiles) ? meta.textureFiles : [];
      for (const filePath of fallbackTextureFiles) {
        tryAddTexture("", filePath, 1, "");
      }
      if (syncCurrentRules && authoritativeAssetType === "3dplant") {
        // 3D Plant 在库内同时保留 Atlas 与 Billboard 两套贴图：历史元数据可能缺少
        // materialRole 或整条 Atlas 记录，这里按资产根目录的贴图文件补全条目，避免
        // “更新元数据”把磁盘上仍存在的贴图从元数据里抹掉。
        const diskEntries = await fs.readdir(assetDir, { withFileTypes: true }).catch(() => []);
        for (const entry of diskEntries) {
          if (!entry.isFile()) {
            continue;
          }
          if (!IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            continue;
          }
          const diskPath = normalizeAssetFilePath(path.join(assetDir, entry.name));
          if (!diskPath || texturePathSet.has(diskPath.toLowerCase())) {
            continue;
          }
          tryAddTexture("", diskPath, 1, "");
        }
      }

      const modelEntries = [...modelSlotMap.entries()];
      const modelVariantKeys = buildModelVariantKeyMap(
        modelEntries.filter(([slot]) => isMeshSlotName(slot))
      );
      const textureEntries = [...textureSlotMap.entries()];
      const textureMetadataBySlot = new Map(await Promise.all(textureEntries.map(async ([slot, filePath]) => {
        const parsedSlot = parseTextureEntryToken(slot);
        const normalizedSlot = parsedSlot?.token || slot;
        const materialRole = parsedSlot?.materialRole || "";
        const previousMetadata = findPreviousTextureMetadata(meta, normalizedSlot, filePath, materialRole);
        const metadata = await inspectStoredTextureMetadata(filePath, previousMetadata || {}, {
          referenceTimestamp: meta.updatedAt
        });
        return [buildTextureMetadataKey(normalizedSlot, materialRole), metadata];
      })));
      const baseComponents = Array.isArray(meta.components)
        ? meta.components.filter((item) => item && item.type !== "model" && item.type !== "texture")
        : [];

      if (syncCurrentRules) {
        meta = {
          ...meta,
          ...buildSyncedAssetMetadataFields({ asset, meta, assetType: authoritativeAssetType })
        };
        delete meta.subType;
      } else {
        meta.assetID = String(asset.id || meta.assetID || "").trim();
        if ("id" in meta) {
          delete meta.id;
        }
        if ("uniqueId" in meta) {
          delete meta.uniqueId;
        }
        meta.name = String(meta.name || asset.name || "");
        meta.assetType = String(meta.assetType || asset.assetType || "").trim();
        meta.asset_type = meta.assetType;
        meta.slug = String(meta.slug || asset.slug || path.basename(assetDir) || "");
        meta.tags = Array.isArray(meta.tags) ? meta.tags : Array.isArray(asset.tags) ? asset.tags : [];
        meta.categories = Array.isArray(meta.categories) && meta.categories.length > 0
          ? meta.categories
          : [String(asset.assetType || "").trim().toLowerCase(), String(meta.category || "").trim().toLowerCase()].filter(Boolean);
      }
      const areaNormalMapFormats = buildAreaNormalMapFormats(
        textureEntries.map(([slot]) => {
          const parsedSlot = parseTextureEntryToken(slot);
          return { areaIndex: parsedSlot?.areaIndex || 1 };
        }),
        { ...persistedNormalFormats, ...textureNormalMapFormatsByArea },
        fallbackNormalFormat
      );
      meta.components = [
        ...baseComponents,
        ...modelEntries.map(([slot, filePath]) => ({
          type: "model",
          slot,
          uri: path.basename(filePath),
          ...(isMeshSlotName(slot)
            ? modelVariantMetadataFields(modelVariantKeys.get(String(slot).toLowerCase()) || parseModelVariantKey(filePath))
            : {})
        })),
        ...textureEntries.map(([slot, filePath]) => {
          const parsedSlot = parseTextureEntryToken(slot);
          const normalizedSlot = parsedSlot?.token || slot;
          const materialRole = parsedSlot?.materialRole || "";
          const areaIndex = parsedSlot?.areaIndex || 1;
          const textureType = parsedSlot?.textureType || slot;
          const nextItem = {
            type: "texture",
            slot: textureType,
            areaIndex,
            uri: path.basename(filePath),
            ...(materialRole ? { materialRole } : {}),
            ...textureResolutionMetadataFields(textureMetadataBySlot.get(buildTextureMetadataKey(normalizedSlot, materialRole)))
          };
          if (String(textureType || "").toLowerCase() === "normal") {
            nextItem.normalMapFormat = areaNormalMapFormats[areaIndex] || fallbackNormalFormat;
          }
          return nextItem;
        })
      ];
      meta.modelFiles = modelEntries.map(([, filePath]) => filePath);
      meta.modelSlots = Object.fromEntries(modelEntries.map(([slot, filePath]) => [slot, filePath]));
      meta.modelVariants = modelEntries
        .filter(([slot, filePath]) => isMeshSlotName(slot) && filePath)
        .map(([slot, filePath]) => ({
          file: filePath,
          ...modelVariantMetadataFields(modelVariantKeys.get(String(slot).toLowerCase()) || parseModelVariantKey(filePath))
        }));
      meta.textureFiles = textureEntries.map(([, filePath]) => filePath);
      meta.textureSlots = Object.fromEntries(
        textureEntries
          .map(([slot, filePath]) => {
            const parsedSlot = parseTextureEntryToken(slot);
            if (!parsedSlot || parsedSlot.areaIndex > 1 || parsedSlot.materialRole === "billboard") {
              return null;
            }
            return [parsedSlot.textureType, filePath];
          })
          .filter(Boolean)
      );
      meta.textureEntries = textureEntries.map(([slot, filePath]) => {
        const parsedSlot = parseTextureEntryToken(slot);
        const normalizedSlot = parsedSlot?.token || slot;
        const materialRole = parsedSlot?.materialRole || "";
        const areaIndex = parsedSlot?.areaIndex || 1;
        const textureType = parsedSlot?.textureType || slot;
        const nextItem = {
          textureType,
          areaIndex,
          uri: path.basename(filePath),
          ...(materialRole ? { materialRole } : {}),
          ...textureResolutionMetadataFields(textureMetadataBySlot.get(buildTextureMetadataKey(normalizedSlot, materialRole)))
        };
        if (String(textureType || "").toLowerCase() === "normal") {
          nextItem.normalMapFormat = areaNormalMapFormats[areaIndex] || fallbackNormalFormat;
        }
        return nextItem;
      });
      meta.normalMapFormat = areaNormalMapFormats[1] || fallbackNormalFormat;
      meta.normalMapFormats = areaNormalMapFormats;

      const metadataUpdatedAt = new Date().toISOString();
      if (syncCurrentRules) {
        const previousIdentity = meta.identity && typeof meta.identity === "object" && !Array.isArray(meta.identity)
          ? meta.identity
          : {};
        let contentIdentity = normalizeContentIdentity(previousIdentity);
        let contentIdentityCreated = false;
        if (!contentIdentity) {
          try {
            contentIdentity = normalizeContentIdentity(await computeStoredContentIdentity({
              ...asset,
              path: assetDir,
              metaPath,
              meta: { ...meta, identity: null }
            }));
          } catch (error) {
            writeLog("WARN", "metadata update fingerprint failed", {
              id: asset.id,
              message: error?.message || String(error)
            });
          }
          contentIdentityCreated = Boolean(contentIdentity);
        }
        const nextSourceIdentity = deriveSourceIdentity({
          assetName: meta.name || asset.name,
          assetType: authoritativeAssetType,
          standardAssetTags: meta.standardAssetTags,
          tags: meta.tags,
          sourceIdentity: previousIdentity
        });
        meta.identity = {
          schemaVersion: IDENTITY_SCHEMA_VERSION,
          ...previousIdentity,
          ...nextSourceIdentity,
          ...(contentIdentity ? {
            fingerprintVersion: contentIdentity.fingerprintVersion,
            contentFingerprint: contentIdentity.contentFingerprint,
            modelFingerprints: contentIdentity.modelFingerprints,
            textureFingerprint: contentIdentity.textureFingerprint
          } : {})
        };
        if (!contentIdentity) {
          delete meta.identity.fingerprintVersion;
          delete meta.identity.contentFingerprint;
          delete meta.identity.modelFingerprints;
          delete meta.identity.textureFingerprint;
        }
        if (contentIdentityCreated) {
          fingerprintCreatedCount += 1;
        }
        meta.metadataUpdate = buildMetadataUpdateMarker(metadataUpdatedAt);

        const shouldCheckCollision = isCollisionCheckRequired(
          authoritativeAssetType,
          meta.standardAssetTags,
          meta.category
        );
        const needsCollisionAnalysis = typeof meta.hasCollision !== "boolean"
          || !meta.scanInformation?.dimensions;
        if (!shouldCheckCollision) {
          delete meta.hasCollision;
        } else if (sender && modelEntries.length > 0 && needsCollisionAnalysis) {
          const collisionModelEntry = modelEntries.find(([slot]) => normalizeModelSlotName(slot) === "HighPoly") || modelEntries[0];
          try {
            const analysis = await requestModelAnalysis(sender, collisionModelEntry[1]);
            if (analysis?.bounds) {
              meta.scanInformation = meta.scanInformation && typeof meta.scanInformation === "object"
                ? meta.scanInformation
                : {};
              meta.scanInformation.dimensions = analysis.bounds;
              meta.scanInformation.dimensionsSource = "measured";
            }
            if (analysis?.collision?.checked === true) {
              meta.hasCollision = Boolean(analysis.collision.hasCollision);
            }
          } catch (error) {
            writeLog("WARN", "metadata sync collision analysis failed", {
              id: asset.id,
              message: error?.message || String(error)
            });
          }
        }

        if (isModelAssetType(authoritativeAssetType)) {
          try {
            const scanInformation = meta.scanInformation && typeof meta.scanInformation === "object"
              ? meta.scanInformation
              : {};
            meta.textureAnalysis = await analyzeAssetTextureUsage({
              dimensions: scanInformation.dimensions,
              dimensionsSource: scanInformation.dimensionsSource,
              textureFiles: meta.textureFiles,
              previousAnalysis: meta.textureAnalysis || asset.textureAnalysis
            });
          } catch (error) {
            delete meta.textureAnalysis;
            writeLog("WARN", "metadata sync texture analysis failed", {
              id: asset.id,
              message: error?.message || String(error)
            });
          }
        } else {
          delete meta.textureAnalysis;
        }
      }

      const metadataFileName = syncCurrentRules
        ? ASSET_METADATA_FILE_NAME
        : (path.basename(metaPath) || ASSET_METADATA_FILE_NAME);
      const metadataWrite = await writeAssetMetadata(assetDir, meta, {
        updatedAt: metadataUpdatedAt,
        fileName: metadataFileName
      });
      meta = metadataWrite.meta;
      appliedOpaqueRenames = [];
      if (syncCurrentRules
        && metadataWrite.metaPath
        && path.resolve(metaPath).toLowerCase() !== path.resolve(metadataWrite.metaPath).toLowerCase()) {
        await fs.rm(metaPath, { force: true }).catch(() => {});
      }
      updatedCount += 1;
    } catch (error) {
      if (appliedOpaqueRenames.length > 0 && appliedOpaqueAssetDir) {
        try {
          rollbackOpaqueRenamePlan(appliedOpaqueAssetDir, appliedOpaqueRenames);
        } catch (rollbackError) {
          writeLog("ERROR", "opaque filename migration rollback failed", {
            id: asset.id,
            message: rollbackError?.message || String(rollbackError)
          });
        }
      }
      failedCount += 1;
      writeLog("WARN", "rewrite custom json failed", { id: asset.id, message: error?.message });
    }
  }

  index = await scanLibraryInWorker(settings.customLibraryPath, {
    residentIndex: true, residentBase: index, forceFullScan: true, refreshMetadata: true, maintenance: true,
    writeSharedMemo: failedCount === 0,
    scanMemoPath: getLibrarySqlCachePath().replace(/\.sqlite$/, ".memo.json.gz"), concurrency: 4
  });
  await applyUserFavorites(index);
  await saveIndexSnapshot(index);
  return {
    ok: true,
    updatedCount,
    skippedCount,
    failedCount,
    animationSkippedCount,
    fingerprintCreatedCount,
    opaqueRenamedCount
  };
}

async function syncLibraryMetadata(sender) {
  await ensureLibraryEditsRecovered();
  return rewriteCustomJsonFiles({ syncCurrentRules: true, sender });
}

async function reconcileCustomAssetFolders() {
  const customRootRaw = String(settings.customLibraryPath || "").trim();
  if (!customRootRaw) {
    return { ok: false, message: "未配置 Standard Library 路径", renamedCount: 0, skippedCount: 0, failedCount: 0 };
  }
  const customRoot = path.resolve(customRootRaw);
  const customAssets = index.filter((asset) => asset && asset.source === "custom");
  let renamedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  markInternalLibraryMutation(90000);

  for (const asset of customAssets) {
    try {
      const assetId = String(asset.id || "").trim();
      if (!assetId) {
        skippedCount += 1;
        continue;
      }
      const currentDir = path.resolve(String(asset.path || ""));
      if (!currentDir) {
        skippedCount += 1;
        continue;
      }
      const normalizedRoot = customRoot.toLowerCase();
      const normalizedCurrent = currentDir.toLowerCase();
      if (normalizedCurrent !== normalizedRoot && !normalizedCurrent.startsWith(`${normalizedRoot}${path.sep.toLowerCase()}`)) {
        skippedCount += 1;
        continue;
      }
      const metaPath = String(asset.metaPath || "").trim();
      const meta = metaPath ? await loadJson(metaPath, null) : null;
      const nextName = String(meta?.name || asset.name || "").trim();
      const nextAssetType = sanitizeToken(meta?.assetType || asset.assetType || "3d") || "3d";
      const nextTypeDir = path.join(customRoot, getCustomAssetTypeFolder(nextAssetType));
      await fs.mkdir(nextTypeDir, { recursive: true });
      const desiredFolder = `${nextAssetType}_${sanitizeToken(nextName) || "asset"}_${assetId}`;
      const desiredDir = path.join(nextTypeDir, desiredFolder);
      if (path.resolve(currentDir).toLowerCase() === path.resolve(desiredDir).toLowerCase()) {
        skippedCount += 1;
        continue;
      }
      await renamePathSafely(currentDir, desiredDir);
      renamedCount += 1;
    } catch (error) {
      failedCount += 1;
      writeLog("WARN", "reconcile custom folder failed", {
        assetId: asset?.id,
        message: error?.message
      });
    }
  }

  index = await scanLibraryInWorker(settings.customLibraryPath, {
    residentIndex: true, residentBase: index, forceFullScan: true, refreshMetadata: true,
    scanMemoPath: getLibrarySqlCachePath().replace(/\.sqlite$/, ".memo.json.gz"), concurrency: 4
  });
  await saveIndexSnapshot(index);
  return {
    ok: failedCount === 0,
    message: `目录对齐完成：重命名 ${renamedCount}，跳过 ${skippedCount}，失败 ${failedCount}`,
    renamedCount,
    skippedCount,
    failedCount
  };
}

async function purgeMissingAssetsFromIndex() {
  if (!Array.isArray(index) || index.length === 0) {
    return;
  }
  const customRoot = String(settings.customLibraryPath || "").trim();
  const rootAvailability = new Map();
  if (customRoot) {
    const rootStat = await statOrNull(customRoot);
    rootAvailability.set(customRoot, Boolean(rootStat?.isDirectory()));
  }
  const missing = [];
  const batchSize = 64;
  for (let offset = 0; offset < index.length; offset += batchSize) {
    const batch = index.slice(offset, offset + batchSize);
    const results = await Promise.all(batch.map(async (asset) => {
      const root = customRoot;
      if (!root || !rootAvailability.get(root)) {
        return { asset, ok: true };
      }
      const metaPath = String(asset?.metaPath || "").trim();
      const assetDir = String(asset?.path || "").trim();
      const targetPath = metaPath || assetDir;
      if (!targetPath) {
        return { asset, ok: true };
      }
      const targetStat = await statOrNull(targetPath);
      return { asset, ok: Boolean(targetStat) };
    }));
    for (const item of results) {
      if (!item.ok) {
        missing.push(item.asset);
      }
    }
  }
  if (missing.length === 0) {
    return;
  }
  const missingIds = missing
    .map((asset) => String(asset?.id || "").trim())
    .filter(Boolean);
  const missingIdSet = new Set(missingIds);
  const missingMetaTokens = new Set(
    missing
      .map((asset) => normalizeComparePath(String(asset?.metaPath || "").trim()))
      .filter(Boolean)
  );
  index = index.filter((asset) => {
    if (missingIdSet.has(String(asset?.id || "").trim())) {
      return false;
    }
    const token = normalizeComparePath(String(asset?.metaPath || "").trim());
    return !(token && missingMetaTokens.has(token));
  });
  if (missingIds.length > 0) {
    await applyLibrarySqlCacheChanges({ upsertAssets: [], deleteIds: missingIds }).catch((error) => {
      writeLog("WARN", "applyLibrarySqlCacheChanges failed during purge_missing_assets", { message: error?.message });
    });
  }
  writeLog("WARN", "purged missing assets from cache", { count: missing.length });
}

async function loadSettingsState() {
  const settingsPath = getSettingsFilePath();
  const timeoutMs = 3000;
  let timeoutId;
  const timedOut = Symbol("settings load timed out");
  writeLog("INFO", "settings load started", { settingsPath });
  // Roaming AppData can be redirected. Keep the read side-effect free so a late result cannot overwrite settings
  // after the window has started using the defaults.
  const loadPromise = (async () => {
    const loadedCurrent = await loadJson(settingsPath, null);
    if (loadedCurrent && typeof loadedCurrent === "object" && !Array.isArray(loadedCurrent)) {
      return { loaded: loadedCurrent, source: "current" };
    }
    return { loaded: null, source: "defaults" };
  })().catch((error) => ({ error }));
  const result = await Promise.race([
    loadPromise,
    new Promise((resolve) => { timeoutId = globalThis.setTimeout(() => resolve(timedOut), timeoutMs); })
  ]);
  globalThis.clearTimeout(timeoutId);
  if (result === timedOut) {
    writeLog("WARN", "settings load timed out; opening window with defaults", { settingsPath, timeoutMs });
  } else if (result.error) {
    writeLog("WARN", "settings load failed; opening window with defaults", { message: result.error?.message || String(result.error) });
  } else {
    if (result.loaded) settings = { ...settings, ...result.loaded };
    writeLog("INFO", "settings load finished", { source: result.source });
  }
  // Older settings persisted the previous default as an empty string.
  if (!settings.plantSyntheticWind) settings.plantSyntheticWind = "auto";
  // Ensure new fields exist
  if (typeof settings.customLibraryPath !== "string") settings.customLibraryPath = "";
  if (typeof settings.unrealEditorPath !== "string") settings.unrealEditorPath = "";
  if (typeof settings.unrealProjectPath !== "string") settings.unrealProjectPath = "";
  settings.exportTarget = ["unreal", "blender", "3dcoat"].includes(settings.exportTarget) ? settings.exportTarget : "unreal";
  if (typeof settings.blenderExecutablePath !== "string") settings.blenderExecutablePath = "";
  settings.blenderDecimationRatio = normalizeBlenderDecimationRatio(settings.blenderDecimationRatio);
  if (typeof settings.pluginRepo !== "string" || !settings.pluginRepo.trim() || settings.pluginRepo.trim() === "Biscuits47/AssetHive-UE-Plugin_Source" || settings.pluginRepo.trim() === "Biscuits47/AssetHive-UE-Plugin" || settings.pluginRepo.trim() === "Biscuits47/AssetHive_UE-Plugin_Release") {
    settings.pluginRepo = "Biscuits-Lab/AssetHivePlugin";
  }
  settings.uiLanguage = settings.uiLanguage === "en" ? "en" : "zh";
}

// SQLite cache is local to the user and selected library. Metadata probes may
// still reach the shared library, so restoration must not delay the window.
// A completed scan supersedes an older snapshot.
function restoreSelectedLibraryCache() {
  // Invalidate even A -> B -> A responses. A previous worker can still deliver
  // messages while terminate() is in flight, so scanning also checks this token.
  const generation = ++librarySelectionGeneration;
  pendingScanRequest = null;
  stopLibraryScans();
  void stopLibraryWatch();
  globalThis.clearTimeout(pendingIndexSaveTimer);
  pendingIndexSaveTimer = 0;
  closeLibraryDb();
  sharedDerivedCache?.dispose();
  sharedDerivedCache = null;
  scanIndexAuthoritative = false;
  sharedIndexComplete = false;
  sharedSnapshotVersion++;
  sharedPublishedVersion = -1;
  index = [];
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("assets:change", { reset: true });
  }
  libraryCacheRestorePromise = restoreLibraryIndexCache();
  return generation;
}

async function restoreLibraryIndexCache() {
  try {
    const restoreRoot = getLibraryRootPath();
    const restoreGeneration = librarySelectionGeneration;
    const current = () => restoreGeneration === librarySelectionGeneration && restoreRoot === getLibraryRootPath();
    const sqlPath = getLibrarySqlCachePath();
    const jsonPath = getLibraryJsonCachePath();
    const startedAt = Date.now();
    writeLog("INFO", "library cache restore started", {
      customLibraryPath: settings.customLibraryPath,
      cachePath: getLibrarySqlCachePath()
    });
    // null means missing/unreadable; [] is a successfully read empty library.
    // A corrupt local file must not disable a usable shared startup cache.
    let cached = await loadLibrarySqlCache(sqlPath);
    if (!current()) return;
    if (cached === null) cached = await loadLibraryJsonCache(jsonPath);
    let fromShared = false;
    if (cached === null && current()) {
      const shared = await getSharedDerivedCache().readSnapshot();
      if (shared !== null) { cached = shared; fromShared = true; }
    }
    cached ??= [];
    if (!current() || (scanInProgress && activeScanGeneration === restoreGeneration) || scanIndexAuthoritative) {
      writeLog("INFO", "library cache restore skipped: scan owns the index", { count: cached.length });
      return;
    }
    await applyUserFavorites(cached);
    if (!current() || (scanInProgress && activeScanGeneration === restoreGeneration) || scanIndexAuthoritative) {
      writeLog("INFO", "library cache restore aborted: scan owns the index");
      return;
    }
    index = cached;
    getSharedDerivedCache().warmAssets?.(index, { replace: true });
    writeLog("INFO", "library cache restored", { count: index.length, fromShared, durationMs: Date.now() - startedAt });
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("assets:change");
      }
    }
    // Both local and shared snapshots are first-card hints. The normal scan
    // validates them; startup must not repeat thousands of network probes.
  } catch (error) {
    writeLog("WARN", "library cache restore failed", { message: error?.message || String(error) });
  }
}

// 启动扫描等待索引缓存就绪（最多 timeoutMs），拿到缓存后再做增量 reconcile；
// 缓存恢复卡住时按超时继续扫描，UI 不受影响。
async function waitForLibraryCacheRestore(timeoutMs = 15000) {
  if (!libraryCacheRestorePromise) {
    return;
  }
  await Promise.race([libraryCacheRestorePromise, sleep(timeoutMs)]);
}

async function performScan(window, options = {}) {
  const reason = String(options?.reason || "manual");
  const force = Boolean(options?.force);
  const requestedGeneration = librarySelectionGeneration;
  await waitForLibraryCacheRestore();
  if (requestedGeneration !== librarySelectionGeneration) return index;
  // Automatic polls are retried on the next tick. Do not compete with a user
  // operation for SMB I/O or start a scan of its partially copied package.
  if ((reason === 'periodic' || reason.startsWith('watch')) &&
      (hasActiveBackgroundImport() || recycleInProgress || activeExportCalls > 0)) return index;
  if (scanInProgress) {
    if (reason !== "periodic" && (reason.startsWith("watch") || force)) {
      pendingScanRequest = { reason, force: true };
    }
    writeLog("INFO", "scan skipped: already in progress", { reason, queued: Boolean(pendingScanRequest) });
    return index;
  }
  if (reason.startsWith("watch") && !force) {
    const now = Date.now();
    const elapsedMs = now - lastWatcherScanAt;
    if (elapsedMs < WATCH_SCAN_COOLDOWN_MS) {
      writeLog("INFO", "scan skipped: watcher cooldown", { elapsedMs });
      return index;
    }
    lastWatcherScanAt = now;
  }
  const startedAt = Date.now();
  const scanGeneration = librarySelectionGeneration;
  const selectedRoot = getLibraryRootPath();
  const current = () => scanGeneration === librarySelectionGeneration && selectedRoot === getLibraryRootPath();
  const emitIntervalMs = 1400;
  let lastIncrementalEmitAt = 0;
  // 进度只允许前进：准备/巡检/遍历各阶段各有自己的进度口径，回退会让进度条
  // 看起来在倒退。
  let reportedProgress = 0;
  const reportScanProgress = (payload = {}) => {
    if (!current() || !window || window.isDestroyed()) {
      return;
    }
    const progress = Math.max(0, Math.min(100, Number(payload?.progress) || 0));
    reportedProgress = Math.max(reportedProgress, progress);
    const source = String(payload?.source || "all");
    const phase = String(payload?.phase || "scan");
    const processed = Math.max(0, Number(payload?.processed) || 0);
    const total = Math.max(0, Number(payload?.total) || 0);
    const message = String(payload?.message || "");
    window.webContents.send("assets:scanProgress", { active: true, progress: reportedProgress, source, phase, processed, total, message });
  };
  scanInProgress = true;
  const previousSharedIndexComplete = sharedIndexComplete;
  sharedIndexComplete = false;
  activeScanGeneration = scanGeneration;
  let scanSchedule, scanRoot;
  try {
    // Scans must not recover/modify asset files. Recovery belongs to explicitly
    // requested edits or Settings > Update Metadata.
    const previousIndex = Array.isArray(index) ? [...index] : [];
    const unavailableSourcesToPreserve = new Set();
    if (reason === "startup") {
      const configuredRoots = [
        { source: "custom", root: String(settings.customLibraryPath || "").trim() }
      ];
      for (const entry of configuredRoots) {
        if (!entry.root) continue;
        const rootStats = await statOrNull(entry.root);
        if (!rootStats?.isDirectory()) {
          unavailableSourcesToPreserve.add(entry.source);
        }
      }
    }
    scanRoot = normalizeComparePath(String(settings.customLibraryPath || ""));
    const schedulePath = getLibrarySqlCachePath().replace(/\.sqlite$/, ".scan.json");
    if (!libraryScanSchedules.has(schedulePath)) {
      libraryScanSchedules.set(schedulePath, createScanSchedule(schedulePath));
    }
    scanSchedule = libraryScanSchedules.get(schedulePath);
    const schedule = await scanSchedule.plan({
      root: scanRoot, libraryRoot: unavailableSourcesToPreserve.has("custom") ? "" : settings.customLibraryPath, reason, hasCache: previousIndex.length > 0,
      idle: !hasActiveBackgroundImport() && powerMonitor.getSystemIdleTime() >= 60
    });
    if (!current()) return index;
    if (schedule.skip && (schedule.throttled || unavailableSourcesToPreserve.size === 0)) {
      sharedIndexComplete = previousSharedIndexComplete;
      if (previousSharedIndexComplete) publishSharedIndexSnapshot();
      return index;
    }
    const incrementalPoll = schedule.incremental;
    writeLog("INFO", "performing library scan", { reason, memory: process.memoryUsage() });
    reportScanProgress({ progress: 0, source: "all", phase: "prepare", message: "准备扫描资产库…" });
    writeLog("INFO", "scan mode selected", {
      reason, mode: schedule.changedDirectories ? "change-index" : incrementalPoll ? "incremental-poll" : "reconcile",
      pollShard: schedule.pollShard, fullScanDeferred: schedule.deferred
    });
    const favoriteIds = await loadFavoriteIds();
    const favoriteMetaTokens = await loadFavoriteMetaTokens();
    if (!current()) return index;
    // Cache clearing and all scans leave asset files untouched.
    if (!current()) return index;
    reportScanProgress({ progress: 1, source: "all", phase: "start" });
    // Keep the cached snapshot visible while the background reconciliation is
    // running. Starting from an empty map made a startup scan temporarily
    // replace a populated library with only the first few scanned records.
    const incrementalMap = new Map(
      previousIndex
        .filter((asset) => asset && asset.id)
        .map((asset) => [asset.id, asset])
    );
    let publishedScanIndex = new Map(incrementalMap);
    const localIndexChanges = new Map();
    const publishScanIndex = (records) => {
      // Imports and edits mutate the live index while the worker reads an older
      // directory snapshot. Capture those changes before every scan publication
      // so neither a partial batch nor the final snapshot can undo a saved asset.
      const liveIndex = new Map(index.filter(asset => asset?.id).map(asset => [asset.id, asset]));
      for (const [id, asset] of liveIndex) {
        if (publishedScanIndex.get(id) !== asset) localIndexChanges.set(id, asset);
      }
      for (const id of publishedScanIndex.keys()) {
        if (!liveIndex.has(id)) localIndexChanges.set(id, null);
      }
      for (const [id, asset] of localIndexChanges) {
        if (asset) records.set(id, asset);
        else records.delete(id);
      }
      if (localIndexChanges.size > 0) scanRecordsChanged = true;
      index = [...records.values()];
      publishedScanIndex = new Map(records);
    };
    // 扫描过程中只把新增记录推给界面，界面不再为了一个增量事件回传整份索引；
    // 上千资产的库上整份索引序列化会明显拖慢双方。
    const pendingIncrementalRecords = [];
    const emitIncrementalAssets = (force = false) => {
      if (!current() || !window || window.isDestroyed()) {
        return;
      }
      const now = Date.now();
      if (!force && now - lastIncrementalEmitAt < emitIntervalMs) {
        return;
      }
      if (pendingIncrementalRecords.length === 0) return;
      publishScanIndex(incrementalMap);
      const records = pendingIncrementalRecords.splice(0, pendingIncrementalRecords.length)
        .map(record => incrementalMap.get(record.id)).filter(Boolean).map(toAssetListRecord).filter(Boolean);
      window.webContents.send("assets:change", { incremental: true, count: index.length, records });
      lastIncrementalEmitAt = now;
    };
    const failedScanPaths = new Set();
    let scanRecordsChanged = false;
    const scannedIndex = await scanLibraryInWorker(settings.customLibraryPath, {
      residentIndex: true,
      residentBase: previousIndex,
      forceFullScan: true,
      refreshMetadata: reason === "manual-rescan" || reason === "clear-cache",
      maintenance: false,
      writeSharedMemo: false,
      scanMemoPath: getLibrarySqlCachePath().replace(/\.sqlite$/, ".memo.json.gz"),
      concurrency: reason === "manual-rescan" || reason === "clear-cache" ? 8 : 4,
      incrementalScan: incrementalPoll,
      changedDirectories: schedule.changedDirectories,
      pollShard: schedule.pollShard,
      onProgress: reportScanProgress,
      // 扫描各阶段耗时写进日志，方便在共享盘上定位下一处瓶颈。
      onTiming: (timing) => writeLog("INFO", "scan timing", timing || {}),
      onWarning: (warning) => {
        if (warning.operation === "metadata-write") {
          writeLog("WARN", "scan metadata backfill failed; previous metadata retained", warning);
          return;
        }
        failedScanPaths.add(normalizeComparePath(warning.path));
        writeLog("WARN", "scan path unreadable; preserving previous assets", warning);
      },
      onRecord: (record) => {
        if (!current() || !record || !record.id) {
          return;
        }
        record.favorite = favoriteIds.has(record.id) || favoriteMetaTokens.has(normalizeComparePath(String(record.metaPath || "").trim()));
        const previousRecord = incrementalMap.get(record.id);
        if (!previousRecord || JSON.stringify(previousRecord) !== JSON.stringify(record)) {
          getSharedDerivedCache().warmAssets?.([record], { priority: true });
        }
        if (incrementalPoll && previousRecord && JSON.stringify(previousRecord) === JSON.stringify(record)) return;
        scanRecordsChanged = true;
        incrementalMap.set(record.id, record);
        pendingIncrementalRecords.push(record);
        // 让 UI 侧的资产计数随扫描进度平滑增长（emitIncrementalAssets 内部按 1.4s 节流）
        emitIncrementalAssets(false);
      }
    });
    if (!current()) return index;
    if (failedScanPaths.size > 0 || unavailableSourcesToPreserve.size > 0) {
      const merged = new Map(scannedIndex.map((asset) => [String(asset?.id || ""), asset]));
      for (const asset of previousIndex) {
        const id = String(asset?.id || "");
        const source = String(asset?.source || "").trim().toLowerCase();
        let failedParent = normalizeComparePath(String(asset.metaPath || asset.path || ""));
        while (failedParent && !failedScanPaths.has(failedParent)) {
          const parent = normalizeComparePath(path.dirname(failedParent));
          if (parent === failedParent) { failedParent = ""; break; }
          failedParent = parent;
        }
        if (id && (failedParent || unavailableSourcesToPreserve.has(source)) && !merged.has(id)) {
          merged.set(id, asset);
          pendingIncrementalRecords.push(asset);
        }
      }
      publishScanIndex(merged);
      writeLog("WARN", "startup scan preserved cached assets for unavailable libraries", {
        sources: [...unavailableSourcesToPreserve],
        count: index.length - scannedIndex.length
      });
    } else {
      publishScanIndex(new Map(scannedIndex.map(asset => [asset.id, asset])));
    }
    if (localIndexChanges.size > 0) {
      writeLog("INFO", "scan preserved concurrent asset changes", {
        upserted: [...localIndexChanges.values()].filter(Boolean).length,
        deleted: [...localIndexChanges.values()].filter(asset => !asset).length
      });
    }
    scanIndexAuthoritative = true;
    // 最终索引已是全量扫描结果；把增量 map 对齐到它，避免切换库路径后把
    // previousIndex 种子里上一个库的过期卡片重新混入最终索引。
    incrementalMap.clear();
    for (const asset of index) {
      if (asset && asset.id) {
        incrementalMap.set(asset.id, asset);
      }
    }
    pendingIncrementalRecords.push(...[...localIndexChanges.values()].filter(Boolean));
    emitIncrementalAssets(true);
    applyFavoriteIds(index, favoriteIds, favoriteMetaTokens);
    reportScanProgress({ progress: 96, source: "all", phase: "save", processed: index.length, total: index.length });
    const unchangedPoll = incrementalPoll && !scanRecordsChanged
      && index.length === previousIndex.length && lastScanSnapshotRoot === scanRoot;
    const snapshotSaved = unchangedPoll || await saveIndexSnapshot(index, {
      publishShared: failedScanPaths.size === 0 && unavailableSourcesToPreserve.size === 0,
      onProgress: (fraction) => {
        const safeFraction = Math.max(0, Math.min(1, Number(fraction) || 0));
        reportScanProgress({ progress: 96 + safeFraction * 3, source: "all", phase: "save", processed: index.length, total: index.length });
      }
    });
    if (!current()) return index;
    if (snapshotSaved) lastScanSnapshotRoot = scanRoot;
    sharedIndexComplete = failedScanPaths.size === 0 && unavailableSourcesToPreserve.size === 0 && Boolean(snapshotSaved);
    if (unchangedPoll && sharedIndexComplete) publishSharedIndexSnapshot();
    getSharedDerivedCache().warmAssets?.(index, { replace: true });
    // Advance the daily deadline only after a complete scan and durable snapshot.
    await scanSchedule.complete(scanRoot, incrementalPoll, failedScanPaths.size === 0 && unavailableSourcesToPreserve.size === 0 && Boolean(snapshotSaved), schedule.changeCursor, Array.isArray(schedule.changedDirectories))
      .catch((error) => writeLog("WARN", "scan schedule save failed", { message: error?.message || String(error) }));
    if (!current()) return index;
    if (unchangedPoll) writeLog("INFO", "incremental poll unchanged; snapshot write skipped", { count: index.length });
    reportScanProgress({ progress: 99, source: "all", phase: "finalize", processed: index.length, total: index.length });
    if (window && !window.isDestroyed()) {
      window.webContents.send("assets:scanProgress", { active: false, progress: 100, source: "all", phase: failedScanPaths.size ? "partial" : "done", processed: index.length, total: index.length, message: failedScanPaths.size ? `${failedScanPaths.size} 处读取失败，已保留原有资产；详情见日志` : "" });
      // 扫描过程已经按批把记录推给界面了。收尾只补一份 ID / 收藏清单
      // （2 万资产约 1MB），避免再把整份索引序列化一次；界面据此剔除已删除的
      // 资产并校正收藏标记。
      window.webContents.send("assets:change", {
        incremental: true,
        complete: true,
        count: index.length,
        ids: index.map((asset) => String(asset?.id || "")).filter(Boolean),
        favoriteIds: index.filter((asset) => asset?.favorite).map((asset) => String(asset.id || "")).filter(Boolean)
      });
    }
    writeLog("INFO", "scan complete", { count: index.length, durationMs: Date.now() - startedAt,
      memory: process.memoryUsage() });
  } catch (error) {
    if (!current()) return index;
    await scanSchedule?.complete(scanRoot, false, false).catch(() => {});
    writeLog("ERROR", "scan failed", { message: error?.message });
    if (window && !window.isDestroyed()) {
      window.webContents.send("assets:scanProgress", { active: false, progress: 0, source: "all", phase: "failed" });
    }
  } finally {
    scanInProgress = false;
    const queued = pendingScanRequest;
    pendingScanRequest = null;
    if (queued) {
      writeLog("INFO", "queued scan request starts", { reason: queued.reason });
      void performScan(window, { reason: queued.reason, force: true });
    }
  }
  return index;
}

async function clearAssetCaches() {
  librarySelectionGeneration++;
  sharedIndexComplete = false;
  libraryCacheRestorePromise = null;
  sharedDerivedCache?.dispose();
  sharedDerivedCache = null;
  // 先释放 SQLite 句柄：句柄未关闭时 Windows 会拒绝删除缓存文件，于是“清理
  // 缓存”看起来成功，重启后旧索引又原样回来。
  closeLibraryDb();
  const cacheFiles = new Set([
    getDataFilePath(LIBRARY_JSON_CACHE_FILE_NAME),
    getLibraryJsonCachePath(),
    getLibrarySqlCachePath(),
    getLibrarySqlCachePath().replace(/\.sqlite$/, ".memo.json.gz"),
    getLibrarySqlCachePath().replace(/\.sqlite$/, ".memo.resident.json.gz"),
    getFallbackLibrarySqlCachePath()
  ].filter(Boolean));
  const removed = [];
  const failed = [];
  const criticalFailed = [];
  for (const filePath of cacheFiles) {
    try {
      const target = path.resolve(filePath);
      const exists = await fs.stat(target).then(() => true).catch(() => false);
      await fs.rm(target, { force: true });
      if (exists) {
        removed.push(target);
      }
    } catch (error) {
      const item = { path: filePath, message: error?.message || String(error) };
      failed.push(item);
      criticalFailed.push(item);
    }
  }
  const runtimeCacheResult = await clearRuntimeCaches("clear-cache-action");
  removed.push(...runtimeCacheResult.removed);
  failed.push(...runtimeCacheResult.failed);
  // Keep the visible snapshot while the forced scan rebuilds disk caches.
  writeLog("INFO", "asset caches cleared", {
    removedCount: removed.length,
    failedCount: failed.length
  });
  return {
    ok: criticalFailed.length === 0,
    removed,
    failed,
    message: failed.length === 0 ? `已清理 ${removed.length} 个缓存文件` : `已清理 ${removed.length} 个缓存文件，${failed.length} 个失败`,
    warningOnly: criticalFailed.length === 0 && failed.length > 0
  };
}

async function waitForScanIdle(timeoutMs = 6000) {
  const start = Date.now();
  while (scanInProgress) {
    if (Date.now() - start >= timeoutMs) {
      return false;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 120));
  }
  return true;
}

async function ensureCharacterTriangleMetrics(asset, metaPath) {
  if (!asset || asset.source !== "custom" || !isCharacterAssetType(asset.assetType)
    || !metaPath || asset.meta?.characterMetrics?.analyzedAt) return asset;
  const expectedId = String(asset.id || asset.assetID || "");
  let backfilled = false;
  markInternalLibraryMutation(25000);
  await updateAssetMetadataFile(metaPath, async meta => {
    if (String(meta.assetID || meta.id || "") !== expectedId) throw new Error("角色资产 ID 已变化，无法回填三角面数");
    if (meta.characterMetrics?.analyzedAt) return meta;
    const files = activeCharacterFiles({ ...asset, meta });
    const metrics = await refreshCharacterTriangleMetrics(files, asset.path);
    meta.characterMetrics = metrics;
    if (meta.characterManifest) meta.characterManifest.metrics = metrics;
    backfilled = true;
    return meta;
  });
  if (backfilled) writeLog("INFO", "character triangle metrics backfilled", { assetId: expectedId });
  return await getAssetDetailsByMetaPath(metaPath, asset.source) || asset;
}

async function refreshAssetById(assetId) {
  const normalizedId = String(assetId || "").trim();
  if (!normalizedId) {
    return null;
  }
  const assetIndex = index.findIndex((asset) => String(asset?.id || "").trim() === normalizedId);
  if (assetIndex < 0) {
    return null;
  }
  const target = index[assetIndex];
  const assetDir = String(target?.path || "").trim();
  const metaPath = String(target?.metaPath || "").trim();
  const generation = librarySelectionGeneration;
  if (!assetDir && !metaPath) {
    return target;
  }
  let fullDetails = metaPath
    ? await getAssetDetailsByMetaPath(metaPath, target.source)
    : await getAssetDetails(assetDir, target.source);
  if (fullDetails) fullDetails = await ensureCharacterTriangleMetrics(fullDetails, metaPath);
  if (fullDetails && isAnimationModelMetaPath(metaPath)) {
    fullDetails.id = target.id;
    fullDetails.assetID = target.id;
    fullDetails.name = target.name || fullDetails.name;
    fullDetails.tags = Array.isArray(target.tags) && target.tags.length ? target.tags : fullDetails.tags;
    fullDetails.themes = Array.isArray(target.themes) && target.themes.length ? target.themes : fullDetails.themes;
    fullDetails.zionTags = Array.isArray(target.zionTags) && target.zionTags.length ? target.zionTags : fullDetails.zionTags;
    fullDetails.animationAffiliation = target.animationAffiliation || fullDetails.animationAffiliation;
    fullDetails.meta = {
      ...(fullDetails.meta && typeof fullDetails.meta === "object" ? fullDetails.meta : {}),
      ...(target.meta && typeof target.meta === "object" ? target.meta : {}),
      assetID: target.id,
      id: target.id
    };
    applyPreservedAnimationPreview(fullDetails, target);
  }
  if (!fullDetails) {
    const hydrated = await hydrateAssetPreviewFields(target);
    if (!hydrated) {
      const deleteId = String(target?.id || "").trim();
      if (deleteId) {
        const beforeCount = index.length;
        index = index.filter((item) => String(item?.id || "").trim() !== deleteId);
        const removedCount = beforeCount - index.length;
        if (removedCount > 0) {
          scheduleIndexSnapshotSave("purge_missing_asset_refresh");
          applyLibrarySqlCacheChanges({ upsertAssets: [], deleteIds: [deleteId] }).catch((error) => {
            writeLog("WARN", "applyLibrarySqlCacheChanges failed during purge_missing_asset_refresh", { message: error?.message || String(error) });
          });
        }
      }
      return null;
    }
    return hydrated;
  }
  const refreshed = await hydrateAssetPreviewFields({
    ...target,
    ...fullDetails,
    favorite: target.favorite // Preserve favorite state from index
  });
  const livePosition = index.findIndex(asset => asset?.id === normalizedId);
  if (generation !== librarySelectionGeneration || livePosition < 0) return null;
  // A detail read can finish after the animation's new local cover is published.
  if (isAnimationModelMetaPath(metaPath) && index[livePosition] !== target) return index[livePosition];
  if (!refreshed) {
    const deleteId = String(target?.id || "").trim();
    if (deleteId) {
      const beforeCount = index.length;
      index = index.filter((item) => String(item?.id || "").trim() !== deleteId);
      const removedCount = beforeCount - index.length;
      if (removedCount > 0) {
        scheduleIndexSnapshotSave("purge_missing_asset_refresh");
        applyLibrarySqlCacheChanges({ upsertAssets: [], deleteIds: [deleteId] }).catch((error) => {
          writeLog("WARN", "applyLibrarySqlCacheChanges failed during purge_missing_asset_refresh", { message: error?.message || String(error) });
        });
      }
    }
    return null;
  }
  index[livePosition] = toAssetIndexRecord(refreshed);
  return refreshed;
}

// 定期增量扫描：网络共享库的 fs.watch 收不到远程同事上传的变更，
// 靠这个定时器周期性 reconcile，把别人新增的资产补进本地缓存。
function startPeriodicScan(window) {
  if (!ENABLE_PERIODIC_SCAN) {
    return;
  }
  if (periodicScanTimer) {
    globalThis.clearTimeout(periodicScanTimer);
  }
  const scheduleNext = () => {
    periodicScanTimer = globalThis.setTimeout(() => {
      periodicScanTimer = null;
      const win = (window && !window.isDestroyed())
        ? window
        : BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      if (!win) return;
      scheduleNext();
      void performScan(win, { reason: "periodic", force: true });
    }, periodicScanDelay(getScanClientId(), PERIODIC_SCAN_INTERVAL_MS));
    periodicScanTimer.unref?.();
  };
  scheduleNext();
}
function startWatching(window) {
  const customRoot = String(settings.customLibraryPath || "").trim();
  if (!customRoot || !ENABLE_WATCH_AUTO_SCAN) {
    void stopLibraryWatch();
    return;
  }
  // The watch service verifies the Windows drive type before creating a worker.
  // Both UNC and mapped NAS drives use the existing periodic scan instead.
  const watchTargets = [customRoot]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (watchTargets.length > 0) {
    watchLibrary(watchTargets, async (payload) => {
      writeLog("INFO", "library change detected via watcher");
      if (Date.now() < suppressWatcherScanUntil) {
        writeLog("INFO", "watch change ignored: internal mutation", { remainingMs: suppressWatcherScanUntil - Date.now() });
        return;
      }
      if (!ENABLE_WATCH_AUTO_SCAN) {
        writeLog("INFO", "watch change ignored: auto scan disabled");
        return;
      }
      const changes = Array.isArray(payload?.changes) ? payload.changes : [];
      const normalizedChanges = changes
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          event: String(item.event || ""),
          path: String(item.path || "")
        }))
        .filter((item) => item.path);
      if (normalizedChanges.length === 0) {
        return;
      }
      let changed = false;
      const upserts = [];
      const deletes = [];
      for (const entry of normalizedChanges) {
        const rawPath = String(entry.path || "").trim();
        if (!rawPath) continue;
        const ext = path.extname(rawPath).toLowerCase();
        if (ext === ".json" || ext === ".jason") {
          const resolvedMetaPath = path.resolve(rawPath);
          if (entry.event === "unlink") {
            const metaToken = normalizeComparePath(resolvedMetaPath);
            const removed = index.filter((asset) => normalizeComparePath(asset?.metaPath || "") === metaToken);
            if (removed.length > 0) {
              for (const asset of removed) {
                const id = String(asset?.id || "").trim();
                if (id) {
                  deletes.push(id);
                }
              }
              index = index.filter((asset) => normalizeComparePath(asset?.metaPath || "") !== metaToken);
              changed = true;
            }
            continue;
          }

          const source =
            isUnderRoot(settings.customLibraryPath, resolvedMetaPath) ? "custom"
              : (index.find((asset) => normalizeComparePath(asset?.metaPath || "") === normalizeComparePath(resolvedMetaPath))?.source || "custom");

          const record = await getAssetDetailsByMetaPath(resolvedMetaPath, source);
          if (!record) {
            continue;
          }

          const metaToken = normalizeComparePath(resolvedMetaPath);
          const existingByMeta = index.find((asset) => normalizeComparePath(asset?.metaPath || "") === metaToken);
          const existingId = String(existingByMeta?.id || "").trim();
          const nextId = String(record.id || "").trim();
          const existingFavorite = Boolean(existingByMeta?.favorite);
          if (existingId && nextId && existingId !== nextId) {
            deletes.push(existingId);
            index = index.filter((asset) => String(asset?.id || "").trim() !== existingId);
          }

          const existingIndex = index.findIndex((asset) => String(asset?.id || "").trim() === nextId);
          if (existingIndex >= 0) {
            const existing = index[existingIndex];
            if (isAnimationModelMetaPath(resolvedMetaPath)) {
              applyPreservedAnimationPreview(record, existing);
            }
            const merged = toAssetIndexRecord({ ...existing, ...record, favorite: existing.favorite });
            index[existingIndex] = merged;
            upserts.push(merged);
          } else {
            if (isAnimationModelMetaPath(resolvedMetaPath)) {
              applyPreservedAnimationPreview(record, existingByMeta || {});
            }
            record.favorite = existingFavorite;
            index.push(toAssetIndexRecord(record));
            upserts.push(record);
          }
          changed = true;
          continue;
        }

        if (entry.event === "unlinkDir") {
          const resolvedDir = path.resolve(rawPath);
          const dirToken = normalizeComparePath(resolvedDir);
          const removed = index.filter((asset) => {
            const assetDir = normalizeComparePath(String(asset?.path || "").trim());
            return assetDir === dirToken || assetDir.startsWith(`${dirToken}/`);
          });
          if (removed.length > 0) {
            for (const asset of removed) {
              const id = String(asset?.id || "").trim();
              if (id) {
                deletes.push(id);
              }
            }
            const removedMetaTokens = new Set(
              removed
                .map((asset) => normalizeComparePath(String(asset?.metaPath || "").trim()))
                .filter(Boolean)
            );
            index = index.filter((asset) => {
              const assetDir = normalizeComparePath(String(asset?.path || "").trim());
              if (assetDir === dirToken || assetDir.startsWith(`${dirToken}/`)) {
                return false;
              }
              const token = normalizeComparePath(String(asset?.metaPath || "").trim());
              return !(token && removedMetaTokens.has(token));
            });
            changed = true;
          }
          continue;
        }

        const isImage = ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".bmp";
        const isModel = ext === ".fbx" || ext === ".st9" || ext === ".obj" || ext === ".abc" || ext === ".gltf" || ext === ".glb";
        if (isImage || isModel) {
          const resolvedFile = path.resolve(rawPath);
          const dirToken = normalizeComparePath(path.dirname(resolvedFile));
          const target = index.find((asset) => normalizeComparePath(asset?.path || "") === dirToken);
          if (!target) {
            continue;
          }
          const refreshed = await refreshAssetById(String(target.id || ""));
          if (refreshed) {
            upserts.push(refreshed);
            changed = true;
          }
        }
      }
      if (changed && window && !window.isDestroyed()) {
        getSharedDerivedCache().warmAssets?.(upserts, { priority: true });
        getSharedDerivedCache().warmAssets?.(index, { replace: true });
        scheduleIndexSnapshotSave("library_watcher");
        await applyLibrarySqlCacheChanges({ upsertAssets: upserts, deleteIds: deletes,
          changedDirectories: normalizedChanges.map(entry => entry.event === "unlinkDir" ? entry.path : path.dirname(entry.path))
            .filter(directory => normalizeComparePath(directory) !== normalizeComparePath(customRoot)) });
        window.webContents.send("assets:change", { incremental: true, count: index.length });
      }
    }, { debounceMs: 1400, depth: 6 });
  }
}

function shouldAutoScanOnStartup() {
  if (!ENABLE_STARTUP_AUTO_SCAN) {
    return false;
  }
  const hasLibraryPath = Boolean(String(settings.customLibraryPath || "").trim());
  if (!hasLibraryPath) {
    return false;
  }
  // Discover changes made while closed. A recent successful reconciliation and
  // restored cache allow incremental startup; missing state/cache requires full discovery.
  return true;
}

function createWindow() {
  if (quitting) return;
  const appIconPath = path.join(__dirname, "v2.ico");
  const windowOptions = {
    width: 1280,
    height: 800,
    title: "AssetHive",
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: false
    },
    autoHideMenuBar: true,
    backgroundColor: "#121212",
    show: false
  };
  if (fsSync.existsSync(appIconPath)) {
    windowOptions.icon = appIconPath;
  }
  const win = new BrowserWindow(windowOptions);
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (hasActiveBackgroundImport()) {
      if (!quitAfterImport) confirmQuitAfterImport(win);
      return;
    }
    writeLog("INFO", "window closed while idle, quitting app");
    app.quit();
  });

  const startupWindow = createStartupWindow({
    BrowserWindow, ipcMain, mainWindow: win, language: settings.uiLanguage,
    icon: windowOptions.icon,
    onCancel: () => win.close(),
    onError: error => {
      writeLog("ERROR", "startup animation load failed", { message: error?.message });
      startupWindows.delete(win.id);
    }
  });
  startupWindows.set(win.id, startupWindow);
  win.once("closed", () => startupWindows.delete(win.id));
  win.webContents.once("render-process-gone", () => startupWindows.delete(win.id));

  const rendererLoadStartedAt = Date.now();
  const reportStartupMilestone = (event, payload) => {
    if (event.sender !== win.webContents || !["preload-ready", "modules-ready", "ui-mounted"].includes(payload?.stage)) return;
    writeLog("INFO", "renderer startup milestone", { stage: payload.stage, durationMs: Date.now() - rendererLoadStartedAt, navigation: payload.navigation });
  };
  ipcMain.on("app:startupMilestone", reportStartupMilestone);
  win.once("closed", () => ipcMain.removeListener("app:startupMilestone", reportStartupMilestone));
  const devServerUrl = process.env.VITE_DEV_SERVER_URL || (!app.isPackaged ? "http://127.0.0.1:5173" : "");
  if (devServerUrl) {
    writeLog("INFO", "load renderer url", { url: devServerUrl });
    win.loadURL(devServerUrl).catch((error) => {
      writeLog("ERROR", "loadURL failed", { message: error?.message });
    });
  } else {
    const filePath = path.join(__dirname, "../dist/index.html");
    writeLog("INFO", "load renderer file", { filePath });
    win.loadFile(filePath).catch((error) => {
      writeLog("ERROR", "loadFile failed", { message: error?.message });
    });
  }

  const showWindow = () => {
    if (!win.isDestroyed() && !win.isVisible()) {
      win.show();
    }
    startupWindow.finish();
    startupWindows.delete(win.id);
  };

  // Cold renderer loading can take longer than three seconds. Keep the window
  // hidden until its first paint rather than exposing an empty black surface.
  const rendererWaitTimer = globalThis.setTimeout(() => {
    writeLog("WARN", "renderer still loading, waiting for first paint", { durationMs: Date.now() - rendererLoadStartedAt });
  }, 3000);
  rendererWaitTimer.unref?.();
  win.once("closed", () => globalThis.clearTimeout(rendererWaitTimer));

  win.once("ready-to-show", () => {
    globalThis.clearTimeout(rendererWaitTimer);
    writeLog("INFO", "window ready-to-show", { durationMs: Date.now() - rendererLoadStartedAt });
    showWindow();
    startWatching(win);
    startPeriodicScan(win);
    if (shouldAutoScanOnStartup()) {
      writeLog("INFO", "startup auto scan scheduled");
      globalThis.setTimeout(() => {
        if (win.isDestroyed()) {
          return;
        }
        // 等索引缓存恢复后再扫描，避免缓存未就绪时退化成全量扫描；
        // 缓存恢复卡住（网络共享不可用）时超时后照常扫描。
        void waitForLibraryCacheRestore().then(() => {
          if (!win.isDestroyed()) {
            void performScan(win, { reason: "startup", force: true });
          }
        });
      }, startupScanDelay(getScanClientId(), index.length > 0));
    }
  });

  win.webContents.on("did-finish-load", () => {
    writeLog("INFO", "did-finish-load", { durationMs: Date.now() - rendererLoadStartedAt });
  });

  win.webContents.on("did-fail-load", async (_, errorCode, errorDescription, validatedURL) => {
    globalThis.clearTimeout(rendererWaitTimer);
    showWindow();
    writeLog("ERROR", "did-fail-load", { errorCode, errorDescription, validatedURL });
    await dialog.showMessageBox(win, {
      type: "error",
      title: "页面加载失败",
      message: `${errorDescription} (${errorCode})`,
      detail: validatedURL || "unknown url"
    });
  });

  win.webContents.on("render-process-gone", async (_, details) => {
    writeLog("ERROR", "render-process-gone", {
      ...details, assetCount: index.length,
      processes: app.getAppMetrics().map(({ pid, type, memory }) => ({ pid, type, memory }))
    });
    if (quitting || win.isDestroyed() || rendererRecoveryPending) return;
    if (details.reason === "launch-failed") {
      rendererRecoveryPending = true;
      try {
        const busy = hasActiveBackgroundImport() || activeExportCalls > 0;
        const { response } = await dialog.showMessageBox(win, {
          type: "error",
          title: "AssetHive 界面启动失败",
          message: "界面进程未能启动，需要重新启动 AssetHive。",
          detail: busy
            ? `后台任务仍在进行，请等待任务完成后重新打开软件。\n错误代码：${details.exitCode}`
            : `点击“重新启动”关闭当前进程并重新打开软件。若仍然失败，请将日志提供给维护人员。\n错误代码：${details.exitCode}`,
          buttons: busy ? ["知道了"] : ["重新启动", "关闭软件"],
          defaultId: 0,
          cancelId: busy ? 0 : 1,
          noLink: true
        });
        // Recheck after the dialog: a background task may have started meanwhile.
        if (busy || quitting || hasActiveBackgroundImport() || activeExportCalls > 0) return;
        if (response === 0) app.relaunch();
        app.quit();
      } finally {
        rendererRecoveryPending = false;
      }
      return;
    }
    await dialog.showMessageBox(win, {
      type: "error",
      title: "渲染进程崩溃",
      message: details.reason,
      detail: `exitCode: ${details.exitCode}`
    });
  });

  win.on("unresponsive", () => {
    writeLog("ERROR", "window unresponsive");
  });

  win.webContents.on("preload-error", (_, preloadPath, error) => {
    writeLog("ERROR", "preload-error", { preloadPath, message: error?.message, stack: error?.stack });
  });

  win.webContents.on("console-message", (event, legacyLevel, legacyMessage, legacyLine, legacySourceId) => {
    const level = typeof event?.level === "string" ? event.level : legacyLevel;
    if (level === "warning" || level === "error" || level >= 2) {
      writeLog("RENDERER", "console-message", {
        level,
        sourceId: event?.sourceId || legacySourceId,
        line: event?.lineNumber ?? legacyLine,
        message: event?.message || legacyMessage
      });
    }
  });

  writeLog("INFO", "window created", { id: win.id });
  return win;
}

app.whenReady().then(async () => {
  // app.quit() after a failed single-instance lock is asynchronous. Do not let
  // a queued ready callback start another hidden copy of the application.
  if (!gotTheLock) return;
  logManager.init({ app });
  setupLogger();
  writeLog("INFO", "app ready");
  if (process.env.ASSETHIVE_MEGASCANS_IMPORT_WORKER === "1") {
    if (!process.send) { app.exit(1); return; }
    if (sharp && typeof sharp.cache === "function") sharp.cache(false);
    const { runImportJob, inspectImportSource } = require("./services/megascansBatchImport");
    const { serveImportWorker } = require("../scripts/lib/megascans-import-worker.cjs");
    serveImportWorker({
      run: async job => {
        if (job?.kind === "inspect-source") {
          return inspectImportSource(job, { readMetadata: readMegascansDropMetadata });
        }
        if (!job?.library) throw new Error("下载入库任务配置无效");
        settings.customLibraryPath = path.resolve(job.library);
        try {
          return await runImportJob(job, { readMetadata: readMegascansDropMetadata, importAsset: payload => importCustomAsset(payload, null) });
        } finally {
          // Published folders have moved out of staging. Do not retain their
          // temporary records between jobs or grow a full-library RAM index.
          index = [];
        }
      },
      shutdown: code => app.exit(code)
    });
    return;
  }
  if (process.env.ASSETHIVE_MEGASCANS_IMPORT_JOB) {
    // libvips may retain image file handles in its cache. Batch publication
    // renames the completed directory, so release those handles on Windows/SMB.
    if (sharp && typeof sharp.cache === "function") sharp.cache(false);
    const job = await loadJson(process.env.ASSETHIVE_MEGASCANS_IMPORT_JOB, null);
    try {
      if (!job?.library || !job?.resultPath) throw new Error("下载入库任务配置无效");
      settings.customLibraryPath = path.resolve(job.library);
      const { runImportJob } = require("./services/megascansBatchImport");
      const result = await runImportJob(job, {
        readMetadata: readMegascansDropMetadata,
        importAsset: payload => importCustomAsset(payload, null)
      });
      await saveJson(job.resultPath, result);
      app.exit(0);
    } catch (error) {
      if (job?.resultPath) await saveJson(job.resultPath, { ok: false, message: error.message });
      app.exit(1);
    }
    return;
  }
  app.on("child-process-gone", (_, details) => {
    writeLog("ERROR", "child-process-gone", details);
  });
  // Only the bounded user settings read precedes window creation. The SQLite
  // cache is local; library metadata access remains asynchronous after startup.
  await loadSettingsState();
  startRuntimeCacheMonitor();
  tcpClient.setTarget(settings);
  const connectionDiagnostics = new Map();
  tcpClient.on("diagnostic", diagnostic => {
    const signature = JSON.stringify(diagnostic);
    if (connectionDiagnostics.get(diagnostic.port) === signature) return;
    connectionDiagnostics.set(diagnostic.port, signature);
    if (diagnostic.state !== "socket-error" || diagnostic.code !== "ECONNREFUSED") {
      writeLog("INFO", "unreal connection", diagnostic);
    }
  });
  tcpClient.connect();
  libraryCacheRestorePromise = restoreLibraryIndexCache();
  // Metadata maintenance requires Settings > Update Metadata.
  if (
    process.env.ASSETHIVE_CLEAR_CACHE_ON_START === "1"
    || process.env.ASSETHIVE_RECONCILE_FOLDERS_ON_START === "1"
  ) {
    await libraryCacheRestorePromise;
  }
  if (process.env.ASSETHIVE_CLEAR_CACHE_ON_START === "1") {
    await clearAssetCaches();
    writeLog("INFO", "startup cache clear executed");
  }
  createWindow();

  registerThreeDCoatIpc({
    app, ipcMain, dialog, getAsset: refreshAssetById,
    getLanguage: () => settings.uiLanguage, writeLog
  });

  ipcMain.handle("settings:get", () => settings);
  ipcMain.handle("window:minimize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) {
      return { ok: false };
    }
    win.minimize();
    return { ok: true };
  });
  ipcMain.handle("window:toggleMaximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) {
      return { ok: false };
    }
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    return { ok: true, maximized: win.isMaximized() };
  });
  ipcMain.handle("window:close", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) {
      return { ok: false };
    }
    win.close();
    return { ok: true };
  });

  ipcMain.handle("window:setImportQueueActive", (event, active) => {
    if (active && appUpdates?.isInstalling()) return { ok: false, message: "正在安装更新，请稍后重试" };
    const ownerId = event.sender.id;
    if (active) {
      backgroundImportOwners.add(ownerId);
      if (!observedImportOwners.has(ownerId)) {
        observedImportOwners.add(ownerId);
        event.sender.once("destroyed", () => {
          backgroundImportOwners.delete(ownerId);
          observedImportOwners.delete(ownerId);
          finishImportBeforeQuit();
        });
      }
    } else {
      backgroundImportOwners.delete(ownerId);
      finishImportBeforeQuit();
    }
    return { ok: true };
  });

  ipcMain.handle("window:shouldCloseAfterCurrentImport", () => quitAfterImport);

  ipcMain.handle("window:setTaskbarProgress", (_, value) => {
    setMainWindowTaskbarProgress(value);
    return { ok: true };
  });

  ipcMain.handle("settings:update", async (_, patch) => {
    const prev = settings;
    const libraryPathsChanged =
      patch.customLibraryPath !== undefined && patch.customLibraryPath !== prev.customLibraryPath;
    settings = { ...settings, ...patch };
    const selection = libraryPathsChanged ? restoreSelectedLibraryCache() : librarySelectionGeneration;
    tcpClient.setTarget(settings);
    await saveJson(getSettingsFilePath(), settings);

    // Update watcher + scan ONLY when the Custom library path actually changed.
    // Previously we compared against a never-defined `oldSettings`, which made
    // `libraryPathsChanged` always evaluate truthy on any call (e.g. switching
    // language) → every switchUiLanguage triggered a full library scan and the
    // UI appeared frozen for many seconds.
    if (libraryPathsChanged && selection === librarySelectionGeneration) {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        startWatching(windows[0]);
        void performScan(windows[0], { reason: "settings-change", force: true });
      }
    }

    return settings;
  });
  ipcMain.handle("settings:clearCaches", async (event) => {
    // 清理缓存会让进行中的扫描结果失效。之前的做法是先等 6 秒再扫描，而
    // 那次重扫会被“scan already in progress”直接丢掉，界面上就只剩下空库。
    if (scanInProgress) {
      writeLog("INFO", "clear cache aborts running scan");
      stopLibraryScans();
      await waitForScanIdle(15000);
    }
    const result = await clearAssetCaches();
    await waitForScanIdle(2000);
    const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getAllWindows()[0] || null;
    if (win && !win.isDestroyed()) {
      // 不要 await 整次重扫：大库要扫很久，界面会一直卡在“正在清理缓存”。
      void performScan(win, { reason: "clear-cache", force: true });
      event.sender.send("assets:change");
    }
    return result;
  });

  ipcMain.handle("settings:dropPlugin", async (_, droppedPath) => {
    try {
      if (!droppedPath) return { ok: false, message: "No path provided" };

      const pluginsDir = path.join(app.getPath("userData"), "Plugins");
      await fs.mkdir(pluginsDir, { recursive: true });

      const destName = path.basename(droppedPath);
      const destPath = path.join(pluginsDir, destName);

      // Copy to storage (works for file or dir)
      await fs.cp(droppedPath, destPath, { recursive: true, force: true });

      return { ok: true, installed: false, message: "Plugin stored. It will only be installed when you click Install AssetHive Plugin." };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  // 「输出日志」窗口：只读历史尾部、实时行由 logManager 订阅后推送。
  // 只读文件尾部而不是全量读取 —— 日志上限 4MB，全量读再切会白占内存与主线程时间。
  ipcMain.handle("logs:read", async (_, payload) => {
    const filePath = logManager.getActiveLogFilePath();
    if (!filePath) {
      return { ok: false, path: "", lines: [], message: "日志文件尚未初始化" };
    }
    try {
      const stats = await fs.stat(filePath);
      const limit = Math.max(1, Math.min(20000, Math.floor(Number(payload?.maxLines) || 2000)));
      const maxBytes = 1.5 * 1024 * 1024;
      const start = Math.max(0, stats.size - maxBytes);
      const length = stats.size - start;
      const buffer = Buffer.alloc(length);
      const handle = await fs.open(filePath, "r");
      try {
        await handle.read(buffer, 0, length, start);
      } finally {
        await handle.close();
      }
      let lines = buffer.toString("utf8").split(/\r?\n/).filter((line) => line.length > 0);
      // 从中间截取时首行可能是半行，丢弃它（标准 tail 行为）。
      if (start > 0 && lines.length) {
        lines = lines.slice(1);
      }
      return { ok: true, path: filePath, lines: lines.slice(-limit), truncated: start > 0 };
    } catch (error) {
      return { ok: false, path: filePath, lines: [], message: error?.message || String(error) };
    }
  });

  ipcMain.handle("logs:openFolder", async () => {
    const filePath = logManager.getActiveLogFilePath();
    if (!filePath) {
      return { ok: false, message: "日志文件尚未初始化" };
    }
    try {
      shell.showItemInFolder(filePath);
      return { ok: true, path: filePath };
    } catch (error) {
      return { ok: false, path: filePath, message: error?.message || String(error) };
    }
  });

  ipcMain.handle("logs:clear", async () => {
    // 截断已打开的写句柄：不删文件、不换路径，追加写入不中断。
    const ok = logManager.clearLogFile();
    if (ok) {
      writeLog("INFO", "log cleared from UI");
    }
    return { ok, message: ok ? "" : "日志文件尚未初始化或不可写" };
  });

  ipcMain.handle("plugins:getStatus", async (_, { projectPath, editorPath }) => {
    try {
      const resolvedProjectPath = await resolveProjectFilePath(projectPath);
      const info = await tcpClient.getEditorInfo(2500, { projectPath: resolvedProjectPath || projectPath, editorPath });
      const connectedInfo = matchesUnrealConnection(info, resolvedProjectPath || projectPath, editorPath) ? info : null;
      // An engine target follows its live project; a project target must never
      // borrow a different project's connection when its path cannot be resolved.
      const effectiveProjectPath = (editorPath && connectedInfo?.projectPath)
        || resolvedProjectPath || connectedInfo?.projectPath || "";
      const effectiveEditorPath = editorPath || connectedInfo?.editorPath || "";
      // A compatible handshake proves the plugin is loaded, including plugins
      // installed in the engine or in a nonstandard project plugin directory.
      const installed = Boolean(connectedInfo)
        || Boolean(effectiveProjectPath && await hasProjectAssetHivePlugin(effectiveProjectPath))
        || Boolean(effectiveEditorPath && await hasEngineAssetHivePlugin(effectiveEditorPath));
      const enabled = installed && (effectiveProjectPath ? await isProjectAssetHiveEnabled(effectiveProjectPath) : true);
      const message = installed && !enabled ? "AssetHive plugin is installed but disabled in this project" : "";
      return {
        installed,
        enabled,
        canInstall: true,
        message,
        resolvedProjectPath: effectiveProjectPath
      };
    } catch (e) {
      return { installed: false, error: e.message };
    }
  });

  ipcMain.handle("plugins:install", async (event, { repo, targetPath }) => {
    try {
      if (!targetPath) return { ok: false, message: "No target path provided" };

      const isEngine = targetPath.toLowerCase().includes("engine");
      // Simple heuristic: if path ends with .uproject, it's a project path.
      // But user might provide directory.
      // Let's check if it's a file or directory first.
      let isProject = false;
      if (targetPath.endsWith(".uproject")) {
        isProject = true;
      } else {
        // Check if it's engine root
        const engineCheck = path.join(targetPath, "Engine", "Binaries");
        if (await fs.stat(engineCheck).catch(() => false)) {
          // It is likely engine root
        } else {
          // Maybe it is a project directory?
          // For now, let's rely on what the UI passes.
          // Actually, let's just use the helper functions we already have or just try both?
          // Wait, if it's installToEngine, we need editor executable path usually for our helper.
          // If it's installToProject, we need .uproject path.
        }
      }

      // Re-using existing logic requires specific paths.
      // Let's assume the UI sends the correct stored setting value.
      // settings.unrealEditorPath is .../UnrealEditor.exe
      // settings.unrealProjectPath is .../HiveTest.uproject

      const win = BrowserWindow.fromWebContents(event.sender);
      const onProgress = (stage, progress) => {
        const ratio = Number(progress);
        const safeRatio = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
        let percent = 0;
        if (stage === "fetching_info") percent = 5;
        else if (stage === "downloading") percent = 10 + Math.round(safeRatio * 45);
        else if (stage === "extracting") percent = 60 + Math.round(safeRatio * 20);
        else if (stage === "installing") percent = 82 + Math.round(safeRatio * 16);
        else if (stage === "completed") percent = 100;
        if (win) win.webContents.send("plugins:installProgress", { stage, progress: percent });
      };

      const effectiveRepo = repo || settings.pluginRepo || "Biscuits-Lab/AssetHivePlugin";

      if (targetPath.toLowerCase().endsWith(".exe")) {
        // Engine Executable
        const result = await installPluginToEngine(effectiveRepo, targetPath, onProgress);
        if (settings.unrealProjectPath) {
          await ensureProjectAssetHiveEnabled(settings.unrealProjectPath);
        }
        return { ok: true, version: result.version, path: result.installedPath };
      } else if (targetPath.toLowerCase().endsWith(".uproject")) {
        // Project File
        const result = await installPluginFromGithub(effectiveRepo, targetPath, onProgress);
        await ensureProjectAssetHiveEnabled(targetPath);
        return { ok: true, version: result.version, path: result.installedPath };
      } else {
        // It is a directory. Check if it is Engine or Project.

        // 1. Check for Engine
        const engineExe = path.join(targetPath, "Engine", "Binaries", "Win64", "UnrealEditor.exe");
        if (await fs.stat(engineExe).catch(() => false)) {
          const result = await installPluginToEngine(effectiveRepo, targetPath, onProgress); // Pass dir, helper handles it
          if (settings.unrealProjectPath) {
            await ensureProjectAssetHiveEnabled(settings.unrealProjectPath);
          }
          return { ok: true, version: result.version, path: result.installedPath };
        }

        // 2. Check for Project
        try {
          const entries = await fs.readdir(targetPath);
          const hasUproject = entries.some(f => f.endsWith(".uproject"));
          if (hasUproject) {
            // Pass dir directly, updated installPluginFromGithub handles it
            const result = await installPluginFromGithub(effectiveRepo, targetPath, onProgress);
            await ensureProjectAssetHiveEnabled(targetPath);
            return { ok: true, version: result.version, path: result.installedPath };
          }
        } catch (err) {
          // Ignore readdir error if not a dir
        }

        return { ok: false, message: "Unknown target path type. Please select valid Engine root or Project directory." };
      }
    } catch (e) {
      console.error("Plugin install error:", e);
      return { ok: false, message: `Install Error: ${e.message}` };
    }
  });

  ipcMain.handle("plugins:checkUpdate", async () => {
    try {
      const repo = settings.pluginRepo || "Biscuits-Lab/AssetHivePlugin";
      const release = await fetchLatestRelease(repo);
      return { ok: true, version: release.version, name: release.name, publishedAt: release.publishedAt };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  async function checkAppUpdateRelease() {
    try {
      const currentVersion = app.getVersion();
      const release = await fetchLatestAppRelease(APP_UPDATE_REPO_CANDIDATES);
      const latestVersion = normalizeVersionTag(release.version);
      const normalizedCurrent = normalizeVersionTag(currentVersion);
      const hasUpdate = compareVersions(latestVersion, normalizedCurrent) > 0;
      const { updateDir } = getUpdateStorageContext();
      const installation = await getAppInstallation();
      const localPackagePath = hasUpdate ? await findLocalUpdatePackage(updateDir, latestVersion, installation.type) : "";
      const pickedAsset = hasUpdate ? pickWindowsUpdateAsset(release.assets, installation.type) : null;
      return {
        ok: true,
        repo: release.repo || "",
        currentVersion: normalizedCurrent,
        latestVersion,
        hasUpdate,
        localPackagePath,
        updateReady: Boolean(localPackagePath),
        name: release.name,
        publishedAt: release.publishedAt,
        releaseNotes: release.releaseNotes,
        releaseUrl: release.htmlUrl,
        downloadUrl: String(pickedAsset?.browser_download_url || ""),
        packageSize: Number(pickedAsset?.size) || 0
      };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  ipcMain.handle("app:getVersion", async () => {
    try {
      return { ok: true, version: String(app.getVersion() || "") };
    } catch (e) {
      return { ok: false, version: "", message: String(e?.message || e || "") };
    }
  });

  ipcMain.handle("app:openExternal", async (_event, url) => {
    try {
      const validUrl = String(url || "").trim();
      const isFeishuContactLink = /^(?:lark|feishu):\/\/client\/contact\/add_friend\?token=[A-Za-z0-9-]+$/.test(validUrl);
      if (validUrl && (validUrl.startsWith("http://") || validUrl.startsWith("https://") || isFeishuContactLink)) {
        await shell.openExternal(validUrl);
        return { ok: true };
      }
      return { ok: false, message: "Invalid URL" };
    } catch (e) {
      return { ok: false, message: String(e?.message || e || "") };
    }
  });

  async function downloadAppUpdateRelease() {
    const sendDownloadProgress = (payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send("app:updateDownloadProgress", payload);
      }
    };
    try {
      sendDownloadProgress({ phase: "prepare", progress: 0 });
      const currentVersion = normalizeVersionTag(app.getVersion());
      const release = await fetchLatestAppRelease(APP_UPDATE_REPO_CANDIDATES);
      const latestVersion = normalizeVersionTag(release.version);
      const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
      if (!hasUpdate) {
        sendDownloadProgress({ phase: "done", progress: 100 });
        return { ok: true, hasUpdate: false, message: "已经是最新版本", currentVersion, latestVersion, repo: release.repo || "" };
      }

      const { updateDir } = getUpdateStorageContext();
      const installation = await getAppInstallation();
      await fs.mkdir(updateDir, { recursive: true }).catch(() => { });
      const existingPackagePath = await findLocalUpdatePackage(updateDir, latestVersion, installation.type);
      if (existingPackagePath) {
        sendDownloadProgress({ phase: "done", progress: 100, source: "local" });
        return {
          ok: true,
          hasUpdate: true,
          message: "检测到已下载的更新包，可直接点击安装",
          currentVersion,
          latestVersion,
          filePath: existingPackagePath,
          updateReady: true,
          releaseUrl: release.htmlUrl,
          repo: release.repo || ""
        };
      }

      const pickedAsset = pickWindowsUpdateAsset(release.assets, installation.type);
      if (pickedAsset?.browser_download_url) {
        const targetFilePath = path.join(updateDir, path.basename(String(pickedAsset.name)));

        sendDownloadProgress({ phase: "downloading", progress: 0, source: "release" });
        await downloadReleaseAsset(String(pickedAsset.browser_download_url), targetFilePath, ({ progress, loaded, total }) => {
          sendDownloadProgress({ phase: "downloading", progress, loaded, total, source: "release" });
        }, { version: latestVersion, size: Number(pickedAsset.size) || 0, digest: pickedAsset.digest });
        sendDownloadProgress({ phase: "done", progress: 100, source: "release" });

        return {
          ok: true,
          hasUpdate: true,
          message: "更新包下载完成，请点击安装",
          currentVersion,
          latestVersion,
          filePath: targetFilePath,
          updateReady: true,
          releaseUrl: release.htmlUrl,
          repo: release.repo || ""
        };
      }
      sendDownloadProgress({ phase: "error", progress: 0 });
      return {
        ok: false,
        hasUpdate: true,
        message: `该版本未发布对应当前安装类型（${installation.type.toUpperCase() || "开发预览"}）的更新包，请稍后重试`,
        releaseUrl: release.htmlUrl,
        repo: release.repo || ""
      };
    } catch (e) {
      sendDownloadProgress({ phase: "error", progress: 0 });
      return { ok: false, message: e.message };
    }
  }

  appUpdates = createAppUpdateController({
    autoDownload: app.isPackaged,
    checkRelease: checkAppUpdateRelease,
    downloadRelease: downloadAppUpdateRelease,
    launch: launchDownloadedUpdatePackage,
    isBusy: () => hasActiveBackgroundImport() || activeExportCalls > 0 || quitAfterImport || quitting,
    prompt: async (state) => {
      const win = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.isVisible()
        && !window.webContents.isLoadingMainFrame());
      if (!win) return null;
      win.webContents.send("app:updateState", { ...state, showPrompt: true });
      // The shared update page owns installation. Closing it defers this version for this run.
      return false;
    },
    onState: (state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send("app:updateState", state);
      }
    },
    onError: error => writeLog("WARN", "app background update failed", { message: error.message })
  });
  // Preview instances never download release binaries or offer to replace the source checkout.
  if (app.isPackaged) appUpdates.start();
  ipcMain.handle("app:checkUpdate", () => appUpdates.check());
  ipcMain.handle("app:downloadUpdate", () => appUpdates.download());

  ipcMain.handle("app:installDownloadedUpdate", async (_event, payload) => {
    const filePath = String(payload?.filePath || "").trim();
    if (!filePath) {
      return { ok: false, message: "缺少安装包路径" };
    }
    return await appUpdates.install(filePath);
  });

  ipcMain.handle("plugins:installFromGithub", async () => {
    try {
      if (!settings.unrealProjectPath) {
        return { ok: false, message: "Please set Unreal Project path first." };
      }
      const repo = settings.pluginRepo || "Biscuits-Lab/AssetHivePlugin";
      const result = await installPluginFromGithub(repo, settings.unrealProjectPath);
      await ensureProjectAssetHiveEnabled(settings.unrealProjectPath);
      return { ok: true, version: result.version, path: result.installedPath };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle("library:pickPath", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle("blender:pickExecutable", async event => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(owner, { title: "选择 Blender / Select Blender", properties: ["openFile"],
      defaultPath: settings.blenderExecutablePath || undefined,
      filters: [{ name: "Blender", extensions: ["exe"] }] });
    if (result.canceled || !result.filePaths.length) return null;
    const executable = result.filePaths[0];
    if (path.basename(executable).toLowerCase() !== "blender.exe") throw new Error("请选择 blender.exe");
    return executable;
  });
  ipcMain.handle("blender:getStatus", () => getBlenderStatus(settings.blenderExecutablePath));
  ipcMain.handle("blender:installPlugin", async () => {
    try {
      const root = app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, "..");
      return await installBlenderPlugin(settings.blenderExecutablePath, path.join(root, "BlenderPlugin", "assethive"));
    } catch (error) { return { ok: false, message: error.message }; }
  });

  ipcMain.handle("settings:pickTarget", async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", "openDirectory"],
        // Remove restrictive filter to ensure directories can be picked freely on all OS versions
        // filters: [{ name: "Unreal Project", extensions: ["uproject"] }], 
        title: "Select Unreal Engine Root or Project File (.uproject)"
      });

      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }

      const pickedPath = result.filePaths[0];
      const stats = await fs.stat(pickedPath).catch(() => null);

      if (stats?.isDirectory()) {
        // 1. Check if it is Engine root
        const enginePossiblePaths = [
          path.join(pickedPath, "Engine", "Binaries", "Win64", "UnrealEditor.exe"),
          path.join(pickedPath, "Engine", "Binaries", "Win64", "UE4Editor.exe"),
          path.join(pickedPath, "Binaries", "Win64", "UnrealEditor.exe")
        ];
        for (const p of enginePossiblePaths) {
          if (await fs.stat(p).catch(() => false)) {
            return { type: "engine", path: p };
          }
        }

        // 2. Check if it is a Project directory (contains .uproject)
        try {
          const dirEntries = await fs.readdir(pickedPath, { withFileTypes: true });
          const uprojectEntry = dirEntries.find(e => e.isFile() && e.name.toLowerCase().endsWith(".uproject"));
          if (uprojectEntry) {
            return { type: "project", path: path.join(pickedPath, uprojectEntry.name) };
          }
        } catch (e) {
          console.error("Failed to read directory for .uproject check:", e);
        }

        // 3. Fallback: If "Engine" folder exists, assume it is engine root even if exe not found
        if (await fs.stat(path.join(pickedPath, "Engine")).catch(() => false)) {
          return { type: "engine", path: path.join(pickedPath, "Engine", "Binaries", "Win64", "UnrealEditor.exe") };
        }
      } else if (pickedPath.toLowerCase().endsWith(".uproject")) {
        return { type: "project", path: pickedPath };
      }

      return null;
    } catch (err) {
      console.error("pickTarget error:", err);
      return null;
    }
  });

  ipcMain.handle("settings:pickEngine", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Select Unreal Engine Root Directory (e.g. C:\\Program Files\\Epic Games\\UE_5.3)"
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    // Try to find the executable within the selected directory
    const rootDir = result.filePaths[0];
    const possiblePaths = [
      path.join(rootDir, "Engine", "Binaries", "Win64", "UnrealEditor.exe"),
      path.join(rootDir, "Engine", "Binaries", "Win64", "UE4Editor.exe"),
      path.join(rootDir, "Binaries", "Win64", "UnrealEditor.exe") // In case they picked Engine dir directly
    ];

    for (const p of possiblePaths) {
      if (await fs.stat(p).catch(() => false)) {
        return p;
      }
    }

    // If we can't find it, just return the directory or null?
    // User expects to set the path. If we return null, nothing happens.
    // Let's try to return the standard expected path even if it doesn't exist, or just the root?
    // But the setting is "unrealEditorPath", which expects an EXE path usually for launching (though we don't launch it yet).
    // The previous logic stored the EXE path.
    // Let's assume standard structure.
    return path.join(rootDir, "Engine", "Binaries", "Win64", "UnrealEditor.exe");
  });

  ipcMain.handle("settings:pickProject", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Unreal Project", extensions: ["uproject"] }]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle("assets:getIndex", async () => {
    await filterRecycledIndex();
    return index.map(toAssetListRecord).filter(Boolean);
  });
  let detailDeletionCheck = null;
  ipcMain.handle("assets:getById", async (_, assetId) => {
    const generation = librarySelectionGeneration;
    // Rapid card selections can share the active journal read. A later request
    // starts a fresh check so other clients' deletes and restores stay visible.
    if (detailDeletionCheck?.generation !== generation) {
      const check = filterRecycledIndex(8).finally(() => {
        if (detailDeletionCheck?.promise === check) detailDeletionCheck = null;
      });
      detailDeletionCheck = { generation, promise: check };
    }
    await detailDeletionCheck.promise;
    const asset = generation === librarySelectionGeneration ? await refreshAssetById(assetId) : null;
    return {
      ok: Boolean(asset),
      asset: asset || null,
      listAsset: asset ? toAssetListRecord(asset) : null
    };
  });
  ipcMain.handle("character:suitUnrealStatus", async (_, assetId) => {
    if (activeExportCalls || recycleInProgress) return { ok: false };
    activeExportCalls++;
    try {
      const asset = await refreshAssetById(String(assetId || ''));
      const changed = asset && await refreshSuitStatus(asset, settings, tcpClient);
      return { ok: true, changed: Boolean(changed) };
    } catch (error) {
      return { ok: false, message: error.message };
    } finally { activeExportCalls--; }
  });
  ipcMain.handle('character:downloadRigFiles', async (event, assetId) => {
    if (recycleInProgress) return { ok: false, message: '删除/恢复处理中，请稍后下载' };
    try {
      const ownerId = componentParentId(String(assetId || ''));
      const asset = await refreshAssetById(ownerId);
      if (!asset || !['suit', 'weapon', 'monster', 'npc', 'item'].includes(asset.assetType)) throw new Error('请选择角色资产或部件');
      const part = ownerId !== assetId ? listCharacterComponents(asset).find(item => item.id === assetId) : null;
      if (ownerId !== assetId && !part) throw new Error('目标部件不存在，请刷新');
      const picked = await dialog.showOpenDialog({ title: part ? '保存这个部件的模型' : '保存此资产的模型', properties: ['openDirectory', 'createDirectory'] });
      if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
      const result = await require('./services/characterRigDownload').downloadCharacterRigFiles({ root: settings.customLibraryPath, asset, slot: part?.slot, destination: picked.filePaths[0],
        onProgress: percent => { if (!event.sender.isDestroyed()) event.sender.send('character:rigDownloadProgress', { assetId, percent }); } });
      await shell.openPath(result.path);
      return result;
    } catch (error) { return { ok: false, message: error.message }; }
  });
  let connectionStatusLogSignature = "";
  ipcMain.handle("unreal:getConnectionStatus", async () => {
    try {
      const status = await getUnrealConnectionStatus(settings.unrealProjectPath, settings.unrealEditorPath);
      const diagnostic = { ...status, projectPath: settings.unrealProjectPath, editorPath: settings.unrealEditorPath };
      const signature = JSON.stringify(diagnostic);
      if (signature !== connectionStatusLogSignature) {
        connectionStatusLogSignature = signature;
        writeLog(status.connected ? "INFO" : "WARN", "unreal target status", diagnostic);
      }
      return status;
    } catch (error) {
      writeLog("WARN", "unreal:getConnectionStatus failed", { message: error?.message });
      return { connected: false };
    }
  });

  ipcMain.handle("assets:rescan", async (event) => {
    if (recycleInProgress) throw new Error("删除/恢复处理中，请稍后刷新");
    const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getAllWindows()[0] || null;
    await performScan(win, { reason: "manual-rescan", force: true });
    await filterRecycledIndex();
    return (await hydrateIndexPreviewFields(index)).map(toAssetListRecord).filter(Boolean);
  });

  ipcMain.handle("assets:search", async (_, query) => {
    await filterRecycledIndex();
    return searchAssets(index, query).map(toAssetListRecord).filter(Boolean);
  });

  const handleAssetExport = async (event, payload, target) => {
    const exportStartedAt = Date.now();
    if (recycleInProgress) return { ok: false, message: "删除/恢复处理中，请稍后导出" };
    const characterRequest = target === 'unreal' && payload?.assetIds?.length > 0 && payload.assetIds.every(id => index.some(asset => asset.id === componentParentId(id) && isCharacterUEAsset(asset)));
    if (characterRequest) event.sender.send('assets:exportProgress', { percent: 0, message: '正在读取所选角色资源…' });
    if (appUpdates?.isInstalling()) return { ok: false, message: "正在安装更新，请稍后重试" };
    if (!Array.isArray(payload?.assetIds) || !payload.assetIds.length) return { ok: false, message: "未选择资产" };
    activeExportCalls++;
    try {
    await filterRecycledIndex();
    const byId = new Map(index.map(asset => [asset.id, asset]));
    const rawAssets = [...new Set(payload.assetIds)].map(id => {
      const parent = target === "unreal" && componentParentId(id) !== id ? byId.get(componentParentId(id)) : null;
      return parent && isCharacterUEAsset(parent) ? { ...parent, exportComponentId: id } : byId.get(id) || { id, name: id, exportUnavailable: true };
    });
    const selectedAssets = [];
    for (const asset of rawAssets) {
      try {
        const full = asset.exportUnavailable ? null : await refreshAssetById(asset.id);
        if (full) {
          const part = asset.exportComponentId ? listCharacterComponents(full).find(item => item.id === asset.exportComponentId) : null;
          if (asset.exportComponentId && !part) throw new Error("目标部件不存在，请刷新");
          selectedAssets.push(full);
        }
        else selectedAssets.push({ id: asset.id, name: asset.name, exportUnavailable: true });
      } catch (error) {
        selectedAssets.push({ id: asset.id, name: asset.name, exportUnavailable: true, exportError: error.message });
      }
    }

    if (selectedAssets.some(asset => /^(imperfection|imperfections|displacement|displacements)$/i.test(String(asset.assetType || "").trim()))) {
      return { ok: false, message: "Imperfections / Displacements 请打开文件夹使用" };
    }
    if (target !== "unreal" && selectedAssets.some(asset => /^(atlas|atlases)$/i.test(String(asset.assetType || "").trim()))) {
      return { ok: false, message: "Atlases 目前仅支持导出到 Unreal Engine" };
    }
    const payloadOptions = payload?.options && typeof payload.options === "object" ? payload.options : {};
    const mergedOptions = {
      ...settings,
      ...payloadOptions
    };
    const exportLogName = target === "blender" ? "assets:exportToBlender" : "assets:exportToUnreal";
    writeLog("INFO", `${exportLogName} start`, {
      count: selectedAssets.length,
      prepareMs: Date.now() - exportStartedAt,
      blenderExecutablePath: target === "blender" ? mergedOptions.blenderExecutablePath : undefined,
      unrealProjectPath: mergedOptions.unrealProjectPath,
      unrealEditorPath: mergedOptions.unrealEditorPath
    });
    const sendProgress = (progress) => {
      const percent = Number(progress?.percent);
      if (Number.isFinite(percent)) {
        setMainWindowTaskbarProgress(percent / 100);
      }
      event.sender.send("assets:exportProgress", progress);
    };
    const hasSuits = target === "unreal" && selectedAssets.some(isCharacterUEAsset);
    if (hasSuits && !selectedAssets.every(isCharacterUEAsset)) return { ok: false, message: "请将套装、武器与其他类型分批发送" };
    const exporter = hasSuits ? (assets, options, progress) => sendSuitJob(assets, options, progress, tcpClient)
      : target === "blender" ? exportToBlender : exportToUnreal;
    return await exporter(selectedAssets, mergedOptions, sendProgress)
      .then(async (result) => {
        setMainWindowTaskbarProgress(-1);
        writeLog(result?.ok ? "INFO" : "WARN", `${exportLogName} complete`, {
          ok: Boolean(result?.ok),
          totalMs: Date.now() - exportStartedAt,
          issues: result?.results?.filter(item => item.status !== "success"),
          requestId: result?.requestId || "",
          logFile: result?.logFile || ""
        });
        return result;
      })
      .catch((error) => {
        setMainWindowTaskbarProgress(-1);
        writeLog("ERROR", `${exportLogName} failed`, {
          message: error?.message || String(error),
          stack: error?.stack
        });
        throw error;
      });
    } finally {
      activeExportCalls--;
    }
  };
  ipcMain.handle("assets:exportToUnreal", (event, payload) => handleAssetExport(event, payload, "unreal"));
  ipcMain.handle("assets:exportToBlender", (event, payload) => handleAssetExport(event, payload, "blender"));

  ipcMain.handle("assets:openFolder", async (_, assetPath) => {
    if (!assetPath) return;
    try {
      await shell.openPath(assetPath);
    } catch {
      writeLog("ERROR", "openFolder failed", { assetPath });
      return;
    }
  });

  ipcMain.handle("assets:revealCharacterModel", async (_, payload) => {
    try {
      const asset = index.find(item => item.id === payload?.assetId && item.source === "custom");
      const location = await resolveCharacterModelFile({ root: settings.customLibraryPath, asset, storedPath: payload?.storedPath });
      shell.showItemInFolder(location);
      return { ok: true };
    } catch (error) { return { ok: false, message: String(error.message || error) }; }
  });

  ipcMain.handle("assets:revealCharacterTexture", async (_, payload) => {
    try {
      const asset = index.find(item => item.id === payload?.assetId && item.source === "custom");
      const location = await resolveCharacterTextureFile({ root: settings.customLibraryPath, asset, storedPath: payload?.storedPath });
      shell.showItemInFolder(location);
      return { ok: true };
    } catch (error) { return { ok: false, message: String(error.message || error) }; }
  });

  ipcMain.handle("assets:copyText", async (_, text) => {
    const value = String(text || "");
    clipboard.writeText(value);
    return { ok: true };
  });

  ipcMain.handle("assets:pickFolder", async (_, options) => {
    const defaultPath = String(options?.defaultPath || "").trim();
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      defaultPath: defaultPath || undefined
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle("assets:pickImage", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"] }]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle("character:pickUpdateFiles", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择更新资源（可多选；文件夹可直接拖入更新窗口）",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "模型与贴图", extensions: ["fbx", "obj", "abc", "gltf", "glb", "png", "jpg", "jpeg", "tif", "tiff", "exr", "tga", "webp", "bmp"] }]
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("assets:pickFile", async (_, kind) => {
    const normalizedKind = String(kind || "any").trim().toLowerCase();
    let filters = [];
    if (normalizedKind === "model") {
      filters = [{ name: "Model", extensions: ["fbx", "st9"] }];
    } else if (normalizedKind === "hairmodel") {
      filters = [{ name: "HairCard / Groom", extensions: ["fbx", "abc"] }];
    } else if (normalizedKind === "animation") {
      filters = [{ name: "Animation", extensions: ["fbx"] }];
    } else if (normalizedKind === "texture") {
      filters = [{ name: "Texture", extensions: ["png", "jpg", "jpeg", "tif", "tiff", "tga", "webp", "bmp"] }];
    } else if (normalizedKind === "displacement") {
      filters = [{ name: "Displacement", extensions: ["png", "jpg", "jpeg", "tif", "tiff", "tga", "webp", "bmp", "exr"] }];
    } else if (normalizedKind === "hdri") {
      filters = [{ name: "HDRI", extensions: ["hdr", "exr"] }];
    } else {
      filters = [
        { name: "Supported", extensions: ["fbx", "obj", "abc", "gltf", "glb", "png", "jpg", "jpeg", "tif", "tiff", "exr", "tga", "webp", "bmp"] }
      ];
    }
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle("assets:readClipboardImage", async () => {
    const imageExtensions = { "image/png": "png", "image/jpeg": "jpg", "image/tiff": "tif", "image/webp": "webp", "image/bmp": "bmp" };
    for (const item of await clipboard.read()) {
      for (const type of item.types) {
        if (imageExtensions[type]) {
          const blob = await item.getType(type);
          return { name: `clipboard-preview.${imageExtensions[type]}`, bytes: new Uint8Array(await blob.arrayBuffer()) };
        }
        // Explorer can copy a filename without providing a bitmap or DOM File.
        if (process.platform === "win32" && type.includes('format="FileNameW"')) {
          const blob = await item.getType(type);
          const filePath = Buffer.from(await blob.arrayBuffer()).toString("utf16le").split("\0")[0];
          if (path.isAbsolute(filePath) && /\.(png|jpe?g|tiff?|hdr|tga|webp|bmp)$/i.test(filePath)) {
            try {
              return { name: path.basename(filePath), bytes: await fs.readFile(filePath) };
            } catch {
              // The copied file may have moved; other image formats can remain.
            }
          }
        }
      }
    }
    return null;
  });

  ipcMain.handle("assets:materializeDroppedFile", async (_, payload) => {
    const fileName = path.basename(String(payload?.name || "").trim());
    const bytes = payload?.bytes;
    if (!fileName || !bytes) {
      return "";
    }
    const ext = path.extname(fileName).toLowerCase();
    const baseName = path.basename(fileName, ext).replace(/[\\/:*?"<>|]/g, "_") || "dropped";
    const safeExt = ext || ".bin";
    const dropDir = path.join(getImportSourceRoot(), "DroppedFiles");
    await fs.mkdir(dropDir, { recursive: true });
    const targetPath = path.join(dropDir, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${baseName}${safeExt}`);
    const buffer = Buffer.from(bytes);
    await fs.writeFile(targetPath, buffer);
    droppedMaterializedFiles.add(targetPath);
    return targetPath;
  });

  ipcMain.handle("assets:getAnimationPreview", (_, modelPath) => getSharedDerivedCache().animationPreview(String(modelPath || "")));
  ipcMain.handle("assets:cacheAnimationPreview", async (_, payload) => {
    if (recycleInProgress) return "";
    try {
      return await cacheAnimationPreview(payload);
    } catch (error) {
      writeLog("WARN", "animation preview cache failed", { message: error?.message || String(error) });
      return "";
    }
  });

  const dropResolveJobs = new Map();

  ipcMain.handle("assets:resolveDroppedItems", async (event, payload) => {
    const includeCharacterSourceFiles = payload?.includeCharacterSourceFiles === true;
    const requestId = String(payload?.requestId || "").trim() || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = { aborted: false, processes: new Set(), tempDirs: [] };
    dropResolveJobs.set(requestId, job);
    const rawPaths = Array.isArray(payload?.paths) ? payload.paths : [];
    const inputPaths = rawPaths
      .map((p) => String(p || "").trim())
      .filter(Boolean)
      .map((p) => path.resolve(p));
    const jsonExts = new Set([".json", ".jason"]);
    const archiveExts = new Set([".zip", ".7z"]);
    const archiveSources = [];
    const files = [];
    const jsonFiles = [];
    const failedArchives = [];
    const seen = new Set();
    const seenJson = new Set();
    let lastProgress = null;
    let lastProgressMessage = "";
    let lastProgressSentAt = 0;
    let extractProgressCeiling = 0;

    const sendProgress = (percent, message = "") => {
      let normalized = percent == null || !Number.isFinite(Number(percent))
        ? null
        : Math.max(0, Math.min(100, Number(percent)));
      // 并发解压时多个 7z 子进程各自按槽位回报进度，报告顺序交错会让进度条
      // 来回跳。把“解压中”阶段的数值进度做成单调递增（只进不退）。
      if (normalized != null && String(message || "") === "Extracting") {
        if (normalized < extractProgressCeiling) {
          normalized = extractProgressCeiling;
        } else {
          extractProgressCeiling = normalized;
        }
      }
      const now = Date.now();
      if (normalized === lastProgress && message === lastProgressMessage && now - lastProgressSentAt < 200) {
        return;
      }
      lastProgress = normalized;
      lastProgressMessage = message;
      lastProgressSentAt = now;
      setMainWindowTaskbarProgress(normalized == null ? -1 : normalized / 100);
      try {
        event.sender.send("assets:resolveDroppedItemsProgress", {
          requestId,
          active: message !== "Done",
          percent: normalized,
          message: String(message || "").trim()
        });
      } catch {
        void 0;
      }
    };

    const addFile = (filePath) => {
      if (job.aborted) return;
      const resolved = path.resolve(filePath);
      const key = resolved.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      files.push(resolved);
    };

    const addJsonFile = (filePath) => {
      if (job.aborted) return;
      const resolved = path.resolve(filePath);
      const key = resolved.toLowerCase();
      if (seenJson.has(key)) return;
      seenJson.add(key);
      jsonFiles.push(resolved);
    };

    const pickPreferredName = async () => {
      if (inputPaths.length === 0) {
        return "";
      }
      const trimmed = inputPaths.map((p) => String(p || "").trim()).filter(Boolean);
      if (trimmed.length === 0) {
        return "";
      }

      if (trimmed.length === 1) {
        const only = trimmed[0];
        const stat = await statOrNull(only);
        if (stat?.isDirectory()) {
          return path.basename(only);
        }
        const ext = path.extname(only).toLowerCase();
        if (ext === ".zip") {
          return path.basename(only, ext);
        }
        return path.basename(path.dirname(only));
      }

      const parentDirs = new Set(trimmed.map((p) => path.dirname(p).toLowerCase()));
      if (parentDirs.size === 1) {
        return path.basename(path.dirname(trimmed[0]));
      }
      return "";
    };

    const resolve7zExecutable = async () => {
      const materializeBundled7za = async () => {
        try {
          const sevenBin = require("7zip-bin");
          const bundled = String(sevenBin?.path7za || "").trim();
          if (!bundled) {
            return "";
          }
          const sourceStats = await statOrNull(bundled);
          if (!sourceStats?.isFile()) {
            return "";
          }
          const binDir = path.join(os.tmpdir(), "AssetHive", "Bin");
          await fs.mkdir(binDir, { recursive: true });
          const targetPath = path.join(binDir, `7za${path.extname(bundled) || ".exe"}`);
          const targetStats = await statOrNull(targetPath);
          if (!targetStats?.isFile()) {
            await fs.copyFile(bundled, targetPath);
          }
          return targetPath;
        } catch {
          return "";
        }
      };

      const bundled = await materializeBundled7za();
      if (bundled) {
        return bundled;
      }
      const candidates = [
        "C:\\Program Files\\7-Zip\\7z.exe",
        "C:\\Program Files (x86)\\7-Zip\\7z.exe",
        "7z.exe",
        "7za.exe"
      ];
      for (const candidate of candidates) {
        if (candidate.includes(":\\") || candidate.startsWith("\\\\")) {
          const stats = await statOrNull(candidate);
          if (stats?.isFile()) {
            return candidate;
          }
          continue;
        }
        return candidate;
      }
      return "";
    };

    const listZipEntries = async (sevenZip, archivePath) => {
      const { spawn } = require("child_process");
      const ps = spawn(sevenZip, ["l", "-slt", "-sccUTF-8", archivePath], { windowsHide: true });
      job.processes.add(ps);
      return await new Promise((resolve, reject) => {
        const chunks = [];
        let byteCount = 0;
        let stderr = "";
        ps.stdout.on("data", (chunk) => {
          byteCount += chunk.length;
          if (byteCount > 16 * 1024 * 1024) {
            ps.kill();
            return;
          }
          chunks.push(chunk);
        });
        ps.stderr.on("data", (chunk) => { stderr += String(chunk || ""); });
        ps.on("error", (error) => { job.processes.delete(ps); reject(error); });
        ps.on("close", (code) => {
          job.processes.delete(ps);
          if (code !== 0 || byteCount > 16 * 1024 * 1024) {
            reject(new Error(stderr || `7z listing failed (${code})`));
            return;
          }
          const entries = parse7zTechnicalListing(Buffer.concat(chunks).toString("utf8"));
          if (!entries?.length) {
            reject(new Error("7z listing contained no usable entries"));
            return;
          }
          resolve(entries);
        });
      });
    };

    const extractArchiveToTemp = async (archivePath) => {
      if (job.aborted) return null;
      const startedAt = Date.now();
      const slotIndex = archiveProcessed;
      archiveProcessed += 1;
      const hasTotal = archiveTotal > 0;
      const slotStart = hasTotal ? (slotIndex / archiveTotal) * 100 : 0;
      const slotEnd = hasTotal ? ((slotIndex + 1) / archiveTotal) * 100 : 100;
      const mapArchiveProgress = (value) => {
        const ratio = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
        return hasTotal ? slotStart + ratio * (slotEnd - slotStart) : Math.max(0, Math.min(100, Number(value) || 0));
      };
      const base = path.basename(archivePath, path.extname(archivePath)).replace(/[\\/:*?"<>|]/g, "_") || "archive";
      const outDir = path.join(getImportSourceRoot(), "DroppedArchives", `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${base}`);
      await fs.mkdir(outDir, { recursive: true });
      job.tempDirs.push(outDir);
      droppedArchiveDirs.add(outDir);
      const { spawn } = require("child_process");
      // 每个压缩包开始时不要清空百分比，否则多压缩包时进度会在
      // “解压中”与“解压中 X%”之间来回跳。有总数时从当前槽位起点继续推进。
      sendProgress(hasTotal ? slotStart : null, "Extracting");

      const ext = path.extname(String(archivePath || "")).toLowerCase();
      const sevenZip = await resolve7zExecutable();
      if (sevenZip) {
        let includeListPath = "";
        let extractArgs = ["x", "-y", `-o${outDir}`, archivePath, "-bsp1", "-bb0"];
        if (ext === ".zip") {
          try {
            const entries = await listZipEntries(sevenZip, archivePath);
            if (job.aborted) return null;
            const selection = selectDropArchiveEntries(entries);
            if (selection.skippedCount > 0) {
              writeLog("INFO", "drop archive selective extraction", {
                archive: path.basename(archivePath),
                selected: selection.selected.length,
                skipped: selection.skippedCount,
                skippedPackedBytes: selection.skippedPackedBytes
              });
              if (selection.selected.length === 0) {
                sendProgress(slotEnd, "Extracting");
                return outDir;
              }
              includeListPath = path.join(outDir, ".assethive-include-list.txt");
              await fs.writeFile(includeListPath, `${selection.selected.map((entry) => entry.path).join("\n")}\n`, "utf8");
              extractArgs = [...extractArgs, "-scsUTF-8", `-i@${includeListPath}`];
            }
          } catch (error) {
            if (job.aborted) return null;
            includeListPath = "";
            writeLog("WARN", "drop archive selective extraction unavailable", {
              archive: path.basename(archivePath), message: error?.message || String(error)
            });
          }
        }
        if (job.aborted) return null;
        let extracted = false;
        const runSevenZipExtract = async (args) => {
          const ps = spawn(sevenZip, args, { windowsHide: true });
          job.processes.add(ps);
          try {
            await new Promise((resolve, reject) => {
              let stderr = "";
              let stdout = "";
              const flushOutput = (chunk) => {
                stdout += String(chunk || "");
                const lines = stdout.split(/[\r\n]+/);
                stdout = lines.pop() || "";
                for (const line of lines) {
                  const match = String(line || "").match(/(\d{1,3})%/);
                  if (match) sendProgress(mapArchiveProgress(match[1]), "Extracting");
                }
              };
              ps.stdout.on("data", flushOutput);
              ps.stderr.on("data", (chunk) => {
                stderr += String(chunk || "");
                flushOutput(chunk);
              });
              ps.on("error", reject);
              ps.on("close", (code) => {
                if (code === 0) resolve();
                else reject(new Error(stderr || `7z extract failed (${code})`));
              });
            });
          } finally {
            job.processes.delete(ps);
          }
        };
        try {
          await runSevenZipExtract(extractArgs);
          extracted = true;
        } catch (error) {
          if (includeListPath && !job.aborted) {
            writeLog("WARN", "drop archive selective extraction failed; retrying full archive", {
              archive: path.basename(archivePath), message: error?.message || String(error)
            });
            await runSevenZipExtract(["x", "-y", `-o${outDir}`, archivePath, "-bsp1", "-bb0"])
              .then(() => { extracted = true; })
              .catch((retryError) => writeLog("WARN", "drop archive extraction failed", {
                archive: path.basename(archivePath), message: retryError?.message || String(retryError)
              }));
          } else {
            writeLog("WARN", "drop archive extraction failed", {
              archive: path.basename(archivePath), message: error?.message || String(error)
            });
          }
        }
        if (includeListPath) await fs.rm(includeListPath, { force: true }).catch(() => null);
        sendProgress(slotEnd, "Extracting");
        if (!extracted || job.aborted) return null;
        writeLog("INFO", "drop archive extracted", {
          archive: path.basename(archivePath), durationMs: Date.now() - startedAt
        });
      } else if (ext === ".zip") {
        const ps = spawn("powershell", [
          "-NoProfile",
          "-Command",
          `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force`
        ], { windowsHide: true });
        job.processes.add(ps);
        await new Promise((resolve, reject) => {
          let err = "";
          ps.stderr.on("data", (d) => {
            err += String(d || "");
          });
          ps.on("error", reject);
          ps.on("close", (code) => {
            job.processes.delete(ps);
            if (code === 0) resolve();
            else reject(new Error(err || `Expand-Archive failed (${code})`));
          });
        }).catch(() => null);
        sendProgress(slotEnd, "Extracting");
      } else {
        return null;
      }

      // Keep sources available while the user reviews a multi-asset queue.
      // Session-owned extraction directories are cleaned up on exit.
      return outDir;
    };

    // 批量拖入的 zip 此前被串行解压，是导入的主要瓶颈。并发解压让多个 7z
    // 子进程同时跑，能更好地掩盖网络共享盘的 I/O 延迟（见 extractArchiveToTemp）。
    // 实测 1Gbps 网络共享盘：单流约 66 MB/s，3 并发约 88 MB/s，6 并发约 105 MB/s（接近链路极限）。
    // 4 并发在解压 CPU 开销与网络利用率之间取平衡，约 90% 链路利用率。
    const ARCHIVE_CONCURRENCY = (() => {
      const configured = Number(process.env.ASSETHIVE_EXTRACT_CONCURRENCY);
      if (Number.isFinite(configured) && configured > 0) return Math.max(1, Math.floor(configured));
      return 4;
    })();

    const mapWithConcurrency = async (items, limit, worker) => {
      const tasks = Array.isArray(items) ? items.slice() : [];
      if (tasks.length === 0) return;
      const safeLimit = Math.max(1, Math.min(Number(limit) || 1, tasks.length));
      let index = 0;
      await Promise.all(Array.from({ length: safeLimit }, async () => {
        while (index < tasks.length) {
          const current = index;
          index += 1;
          await worker(tasks[current]);
        }
      }));
    };

    const extractOneArchive = async (archivePath, depth) => {
      if (job.aborted) return;
      const ext = path.extname(archivePath).toLowerCase();
      const extractedDir = await extractArchiveToTemp(archivePath);
      if (extractedDir) {
        archiveSources.push({ root: extractedDir, name: path.basename(archivePath, ext), archivePath });
        await walk(extractedDir, depth + 1);
      } else {
        failedArchives.push({ name: path.basename(archivePath) });
      }
    };

    const walk = async (targetPath, depth = 0) => {
      if (job.aborted) return;
      if (depth > 8) return;
      const stats = await statOrNull(targetPath);
      if (!stats) return;
      if (isThumbsFolderPath(targetPath)) return;
      if (stats.isDirectory()) {
        if (isThumbsFolderPath(targetPath)) return;
        const entries = await fs.readdir(targetPath, { withFileTypes: true }).catch(() => []);
        const archives = [];
        const others = [];
        for (const entry of entries) {
          const full = path.join(targetPath, entry.name);
          const ext = path.extname(entry.name).toLowerCase();
          if (entry.isFile() && archiveExts.has(ext)) archives.push(full);
          else others.push(full);
        }
        await mapWithConcurrency(archives, ARCHIVE_CONCURRENCY, (archivePath) => extractOneArchive(archivePath, depth));
        for (const full of others) {
          await walk(full, depth + 1);
        }
        return;
      }
      if (!stats.isFile()) return;
      const ext = path.extname(targetPath).toLowerCase();
      if (archiveExts.has(ext)) {
        await extractOneArchive(targetPath, depth);
        return;
      }
      if (includeCharacterSourceFiles || (isDropCandidateFile(targetPath) && !jsonExts.has(ext))) {
        addFile(targetPath);
      } else if (jsonExts.has(ext)) {
        addJsonFile(targetPath);
      }
    };

    // Pre-scan the dropped tree once so archive extraction can report progress
    // against the whole batch instead of resetting to 0-100% per archive.
    const countArchives = async (targetPath, depth = 0) => {
      if (depth > 8) return 0;
      const stats = await statOrNull(targetPath);
      if (!stats) return 0;
      if (isThumbsFolderPath(targetPath)) return 0;
      if (stats.isDirectory()) {
        if (isThumbsFolderPath(targetPath)) return 0;
        const entries = await fs.readdir(targetPath, { withFileTypes: true }).catch(() => []);
        let count = 0;
        for (const entry of entries) {
          count += await countArchives(path.join(targetPath, entry.name), depth + 1);
        }
        return count;
      }
      if (!stats.isFile()) return 0;
      return archiveExts.has(path.extname(targetPath).toLowerCase()) ? 1 : 0;
    };

    sendProgress(null, "Scanning");
    let archiveTotal = 0;
    for (const p of inputPaths) {
      archiveTotal += await countArchives(p);
    }
    let archiveProcessed = 0;

    try {
      await mapWithConcurrency(inputPaths, ARCHIVE_CONCURRENCY, (p) => walk(p, 0));
      if (job.aborted) {
        return { files: [], preferredName: "" };
      }
      sendProgress(null, "Grouping");
      const preferredName = await pickPreferredName();
      if (includeCharacterSourceFiles && inputPaths.length === 1) {
        sendProgress(null, "Done");
        return {
          files, preferredName, failedArchives,
          assets: [{ files, preferredName, folderName: preferredName, metadata: null,
            ...(archiveSources[0]?.archivePath ? { sourceArchivePath: archiveSources[0].archivePath } : {}) }]
        };
      }
      const metadataGroups = [];
      const jsonByDirectory = new Map();
      for (const file of jsonFiles) {
        const root = path.dirname(file);
        if (!jsonByDirectory.has(root)) jsonByDirectory.set(root, []);
        jsonByDirectory.get(root).push(file);
      }
      for (const [root, candidates] of jsonByDirectory) {
        if (job.aborted) return { files: [], assets: [] };
        const metadata = await readMegascansDropMetadata(candidates).catch((error) => {
          writeLog("WARN", "read dropped Megascans metadata failed", { message: error?.message || String(error) });
          return null;
        });
        if (metadata) metadataGroups.push({ root, metadata, preferredName: metadata.name || path.basename(root) });
      }
      const { groupDroppedAssets } = require("./services/dropAssetGroups");
      const assets = await resolveNativePlantGroups(groupDroppedAssets(files, metadataGroups, archiveSources),
        { jsonFiles, metadataGroups, shouldAbort: () => job.aborted });
      if (job.aborted) return { files: [], assets: [] };
      sendProgress(null, "Done");
      return { files, preferredName, metadata: assets.length === 1 ? assets[0].metadata : null, assets, failedArchives };
    } finally {
      setMainWindowTaskbarProgress(-1);
      dropResolveJobs.delete(requestId);
    }
  });

  ipcMain.handle("assets:cancelResolveDroppedItems", async (_, payload) => {
    const requestId = String(payload?.requestId || "").trim();
    if (!requestId) {
      return { ok: false };
    }
    const job = dropResolveJobs.get(requestId);
    if (!job) {
      return { ok: true };
    }
    job.aborted = true;
    for (const ps of Array.from(job.processes)) {
      try {
        ps.kill();
      } catch {
        void 0;
      }
    }
    for (const dir of Array.from(job.tempDirs)) {
      fs.rm(dir, { recursive: true, force: true }).catch(() => null);
    }
    return { ok: true };
  });

  // 批量导入完成（全部成功）后由渲染进程调用，清理本会话解压的临时源文件。
  async function clearDroppedArchiveDirs() {
    const archiveRoot = path.resolve(getImportSourceRoot(), "DroppedArchives");
    for (const directory of [...droppedArchiveDirs]) {
      try {
        if (path.dirname(path.resolve(directory)) === archiveRoot && !getImportQueueStore().protects(directory)) {
          await fs.rm(directory, { recursive: true, force: true });
        }
      } catch {
        void 0;
      }
      droppedArchiveDirs.delete(directory);
    }
    const droppedFiles = path.resolve(getImportSourceRoot(), "DroppedFiles");
    for (const file of droppedMaterializedFiles) {
      if (path.dirname(file) !== droppedFiles || getImportQueueStore().protects(file)) continue;
      await fs.rm(file, { force: true }).catch(() => null);
      droppedMaterializedFiles.delete(file);
    }
  }

  ipcMain.handle("assets:clearDroppedArchives", async () => {
    await clearDroppedArchiveDirs();
    return { ok: true };
  });

  ipcMain.handle("assets:pathExists", async (_, rawPath) => {
    const targetPath = String(rawPath || "").trim();
    if (!targetPath) {
      return false;
    }
    const stats = await statOrNull(path.resolve(targetPath));
    return Boolean(stats?.isFile());
  });
  ipcMain.handle("assets:deduplicateCharacterTextures", async (_, rawPaths) => {
    const files = partitionCharacterPackageFiles(Array.isArray(rawPaths) ? rawPaths : []).accepted;
    return require('./services/characterTextureDuplicates').deduplicateCharacterTextures(files);
  });
  ipcMain.handle("assets:renderGroomPreview", async (_, sourcePath) => {
    return require('./services/groomPreview').renderGroomPreview(String(sourcePath || ''), {
      cacheRoot: path.join(app.getPath('temp'), 'AssetHive'), blenderExecutablePath: settings.blenderExecutablePath
    });
  });
  ipcMain.handle("assets:analyzeCharacterModels", async (_, rawPaths) => {
    try {
      const paths = [...new Set((Array.isArray(rawPaths) ? rawPaths : []).map(value => String(value || "").trim()).filter(value => /\.fbx$/i.test(value)))].slice(0, 32);
      const analyses = {};
      for (const filePath of paths) {
        const info = await statOrNull(filePath);
        if (!info?.isFile()) { analyses[filePath] = { ok: false, message: "文件不存在" }; continue; }
        const result = await require('./services/characterFileInspection').inspectCharacterModel(filePath);
        analyses[filePath] = result.error ? { ok: false, message: result.error } : { ok: true,
          sourceHash: (await require('./services/characterFileInspection').inspectCharacterFile(filePath)).sourceHash,
          meshKind: result.meshKind === "skeletalMesh" ? "skeletalMesh" : "staticMesh",
          materialNames: Array.isArray(result.materialNames) ? result.materialNames : [],
          hasSkeleton: result.hasSkeleton === true, hasSkin: result.hasSkin === true,
          boneCount: Number(result.boneCount) || 0, skinnedMeshCount: Number(result.skinnedMeshCount) || 0,
          triangleCount: Number.isFinite(result.triangleCount) ? result.triangleCount : null };
      }
      return { ok: true, analyses };
    } catch (error) { return { ok: false, message: String(error?.message || error), analyses: {} }; }
  });

  // Zion 资产导出目标二级目录的持久化：写在资产自身的 asset_info.json 里，
  // 与资产一起走库同步/备份，而不是只存在应用设置里。
  // 不透明裁切的"透明度来源"体检：界面在开启 OPAQUE 选项 / 点重新裁切之前先问一次，
  // 不可用就直接禁用入口并说明原因（不再等到跑完才报"未找到透贴"）。
  // 判定与真正裁切时用的是同一个 resolveFoliageMaskSource，避免两处口径不一致。
  ipcMain.handle("assets:foliageOpaqueMaskStatus", async (_, payload) => {
    const textureEntries = Array.isArray(payload?.textureEntries) ? payload.textureEntries : [];
    try {
      const source = await resolveFoliageMaskSource(textureEntries);
      return {
        ok: true,
        available: Boolean(source),
        message: describeFoliageMaskSource(source),
        filePath: source ? source.filePath : "",
        textureType: source ? source.textureType : "",
        channel: source ? source.channel : "",
        width: source ? source.width : 0,
        height: source ? source.height : 0
      };
    } catch (error) {
      return { ok: false, available: false, message: `透明度来源检测失败：${error?.message || String(error)}` };
    }
  });

  // 只改这一个字段：先读回原文件再合并写回，避免整文件覆写抹掉分析/语义等其它字段。
  ipcMain.handle("assets:setZionExportSubfolder", async (event, payload) => {
    const assetId = String(payload?.assetId || "").trim();
    if (!assetId) {
      return { ok: false, message: "缺少资产 ID" };
    }
    const target = index.find((item) => String(item?.id || "").trim() === assetId);
    if (!target) {
      return { ok: false, message: "未找到资产" };
    }
    const assetDir = String(target.path || "").trim();
    if (!assetDir) {
      return { ok: false, message: "资产目录为空" };
    }
    const subfolder = normalizeZionExportSubfolder(payload?.subfolder);
    try {
      const metaFileName = path.basename(String(target.metaPath || "").trim()) || ASSET_METADATA_FILE_NAME;
      const metaPath = path.join(assetDir, metaFileName);
      let existing = {};
      try {
        existing = JSON.parse(await fs.readFile(metaPath, "utf8"));
      } catch {
        existing = {};
      }
      if (!existing || typeof existing !== "object" || !existing.assetID) {
        return { ok: false, message: "资产元数据不可写" };
      }
      const now = new Date().toISOString();
      const merged = { ...existing };
      // 始终保留该键：空串代表"用户明确清空"，与"从未设置"（无键）区分开，
      // 否则导出侧无法判断该不该回退到应用设置里的上次输入。
      merged.zionExportSubfolder = subfolder;
      merged.updatedAt = now;
      const metadataWrite = await writeAssetMetadata(assetDir, merged, { now, fileName: metaFileName });
      // 同步内存索引，界面无需等下一次扫描即可读到新值。
      target.zionExportSubfolder = subfolder;
      if (Array.isArray(index)) {
        const detail = index.find((item) => String(item?.id || "").trim() === assetId);
        if (detail) detail.zionExportSubfolder = subfolder;
      }
      writeLog("INFO", "assets:setZionExportSubfolder saved", { assetId, subfolder, metaPath: metadataWrite.metaPath });
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed()) win.webContents.send("assets:change");
      return { ok: true, assetId, subfolder };
    } catch (error) {
      writeLog("ERROR", "assets:setZionExportSubfolder failed", { assetId, message: error?.message });
      return { ok: false, message: `保存失败：${String(error?.message || error || "未知错误")}` };
    }
  });

  const resolveRequestedPreviewThumbnail = async (rawPath, options) => {
    const targetPath = String(rawPath || "").trim();
    if (!targetPath) {
      return "";
    }
    const resolvedPath = path.resolve(targetPath);
    if (/\.fbx$/i.test(resolvedPath)) {
      const preview = await getSharedDerivedCache().animationPreview(resolvedPath);
      return preview?.path || targetPath;
    }
    // Character TGA previews have a dedicated decoder. Avoid first sending them
    // through the general image decoder, which cannot read this format.
    let thumbPath = options?.character && path.extname(resolvedPath).toLowerCase() === '.tga'
      ? resolvedPath : await resolvePreviewThumbnailPath(resolvedPath).catch(() => resolvedPath);
    if (path.resolve(String(thumbPath || resolvedPath)) === resolvedPath && path.extname(resolvedPath).toLowerCase() === ".tga") {
      try {
        const stat = await fs.stat(resolvedPath);
        const key = crypto.createHash("sha256")
          .update(`${resolvedPath.toLowerCase()}|${stat.size}|${stat.mtimeMs}`)
          .digest("hex");
        const outputDir = path.join(getImportSourceRoot(), "CharacterPreviewTextures");
        const outputPath = path.join(outputDir, `${key}.png`);
        const existing = await fs.stat(outputPath).catch(() => null);
        if (!existing?.isFile()) {
          await fs.mkdir(outputDir, { recursive: true });
          await runImageTask("resizeTexture", [resolvedPath, outputPath, 512]);
        }
        thumbPath = outputPath;
      } catch (error) {
        writeLog("WARN", "character preview TGA thumbnail failed", {
          sourcePath: resolvedPath,
          message: error?.message || String(error)
        });
      }
    }
    return String(thumbPath || resolvedPath);
  };
  ipcMain.handle('assets:getPreviewThumbnail', async (_, rawPath, options) => {
    const file = path.resolve(String(rawPath || '')).toLowerCase();
    if (deletingCharacterCachePaths.has(file)) return '';
    const task = resolveRequestedPreviewThumbnail(rawPath, options);
    if (!previewThumbnailTasks.has(file)) previewThumbnailTasks.set(file, new Set());
    const pending = previewThumbnailTasks.get(file); pending.add(task);
    try { return await task; }
    finally { pending.delete(task); if (!pending.size) previewThumbnailTasks.delete(file); }
  });

  // md 3.15: optional foliage opaque-variant generation in an application worker.
  ipcMain.handle("assets:foliageOpaqueStatus", async () => foliageOpaqueStatus());

  // 资产库内「重新 Opaque 裁切」：第三方 FBX 植被可用，Zion 使用材质 Masked。
  ipcMain.handle("assets:regenerateFoliageOpaque", async (event, payload) => {
    try {
      return await regenerateFoliageOpaqueCut(payload, event.sender);
    } catch (error) {
      writeLog("ERROR", "assets:regenerateFoliageOpaque exception", {
        assetId: String(payload?.assetId || ""),
        message: error?.message,
        stack: error?.stack
      });
      return { ok: false, message: `重新裁切失败：${String(error?.message || error || "未知错误")}` };
    }
  });

  ipcMain.handle("importQueue:load", (_, libraryPath) => getImportQueueStore().load(libraryPath || settings.customLibraryPath).then(rememberQueueSources));
  ipcMain.handle("importQueue:save", (_, snapshot) => getImportQueueStore().save(snapshot.libraryPath || settings.customLibraryPath, snapshot).then(rememberQueueSources));

  ipcMain.handle("assets:importCustom", async (event, payload) => {
    if (recycleInProgress) return { ok: false, message: "删除/恢复处理中，请稍后导入" };
    const isSave = payload?.dedupeAction !== "inspect";
    if (isSave && quitAfterImport) {
      writeLog("INFO", "new import skipped after close request");
      return { ok: false, message: "窗口将在当前资产处理完成后关闭，未开始后续资产导入。" };
    }
    if (isSave && appUpdates?.isInstalling()) return { ok: false, message: "正在安装更新，请稍后重试" };
    if (isSave) activeImportCalls++;
    try {
      let result = null;
      try {
        result = isSave && payload?.queueId
          ? await getImportQueueStore().run(settings.customLibraryPath, payload.queueId, () => importCustomAsset(payload, event.sender))
          : await importCustomAsset(payload, event.sender);
      } catch (error) {
        emitCustomSaveFailure(event.sender, error?.message || String(error));
        throw error;
      }
      if (result?.ok) {
        const windows = BrowserWindow.getAllWindows();
        const changed = index.find(asset => asset.id === result.assetId);
        const update = changed && isCharacterUEAsset(changed) ? { incremental: true, records: [toAssetListRecord(changed)] } : undefined;
        for (const win of windows) if (!win.isDestroyed()) win.webContents.send('assets:change', update);
      } else {
        // 失败时通知界面清理进度环，避免卡片一直停在中间进度。
        emitCustomSaveFailure(event.sender, result?.message || "");
      }
      return result;
    } finally {
      if (isSave) {
        activeImportCalls--;
        finishImportBeforeQuit();
      }
    }
  });

  ipcMain.handle("assets:updateCustom", async (event, payload) => {
    if (recycleInProgress) return { ok: false, message: "删除/恢复处理中，请稍后编辑" };
    if (appUpdates?.isInstalling()) return { ok: false, message: "正在安装更新，请稍后重试" };
    const payloadSummary = {
      assetId: String(payload?.assetId || ""),
      assetName: String(payload?.assetName || ""),
      assetType: String(payload?.assetType || ""),
      category: String(payload?.category || ""),
      modelSlots: Object.keys(payload?.modelSlots && typeof payload.modelSlots === "object" ? payload.modelSlots : {}),
      textureSlots: Object.keys(payload?.textureSlots && typeof payload.textureSlots === "object" ? payload.textureSlots : {}),
      removeModelSlots: Array.isArray(payload?.removeModelSlots) ? payload.removeModelSlots : [],
      removeTextureSlots: Array.isArray(payload?.removeTextureSlots) ? payload.removeTextureSlots : [],
      clearPreview: Boolean(payload?.clearPreview)
    };
    writeLog("INFO", "assets:updateCustom request", payloadSummary);
    activeImportCalls++;
    try {
      const result = await updateCustomAsset(payload, event.sender);
      if (result.ok) {
        writeLog("INFO", "assets:updateCustom success", {
          assetId: result.assetId,
          path: result.asset?.path || ""
        });
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
          windows[0].webContents.send("assets:change");
        }
      } else {
        writeLog("WARN", "assets:updateCustom failed", {
          assetId: payloadSummary.assetId,
          message: result.message
        });
      }
      return result;
    } catch (error) {
      writeLog("ERROR", "assets:updateCustom exception", {
        assetId: payloadSummary.assetId,
        message: error?.message,
        stack: error?.stack
      });
      return {
        ok: false,
        message: `更新失败：${String(error?.message || error || "未知错误")}`
      };
    } finally {
      activeImportCalls--;
      finishImportBeforeQuit();
    }
  });

  ipcMain.handle("assets:toggleFavorite", async (event, { assetId, isFavorite }) => {
    const target = index.find(asset => asset.id === String(assetId || "").trim());
    if (!target) return false;
    try {
      await getUserFavorites().update(getLibraryRootPath(), target, Boolean(isFavorite));
    } catch (error) {
      writeLog("ERROR", "user favorites save failed", { message: error.message });
      return false;
    }
    target.favorite = Boolean(isFavorite);
    const changed = true;
    if (changed) {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed()) {
        win.webContents.send("assets:change");
      }
    }
    return changed;
  });

  ipcMain.handle("assets:cropPreviewSelection", async (_, payload) => {
    const sourcePath = String(payload?.sourcePath || "").trim();
    if (!sourcePath) return { ok: false, message: "缺少预览图路径" };
    return runImageTask("cropPreviewSelection", [sourcePath, getPreviewEditTempPath(), payload?.selection]);
  });

  ipcMain.handle("assets:autoPreviewCutout", async (_, payload) => {
    const sourcePath = String(payload?.sourcePath || "").trim();
    if (!sourcePath) return { ok: false, message: "缺少预览图路径" };
    return runImageTask("smartCutout", [sourcePath, getPreviewEditTempPath(), { modelPath: getCutoutModelPath() }]);
  });

  ipcMain.handle("assets:cutoutPreviewMagic", async (_, payload) => {
    const sourcePath = String(payload?.sourcePath || "").trim();
    if (!sourcePath) {
      return { ok: false, message: "缺少预览图路径" };
    }
    return cutoutPreviewMagic(
      sourcePath,
      Number(payload?.x),
      Number(payload?.y),
      Number(payload?.tolerance)
    );
  });

  ipcMain.handle("assets:finalizePreviewCutout", async (_, payload) => {
    const sourcePath = String(payload?.sourcePath || "").trim();
    if (!sourcePath) {
      return { ok: false, message: "缺少预览图路径" };
    }
    return finalizePreviewCutout(sourcePath, {
      preserveCanvas: payload?.preserveCanvas === true,
      padding: Number(payload?.padding),
      maxSize: Number(payload?.maxSize)
    });
  });

  ipcMain.handle("assets:deleteCustom", async (event, payload) => {
    try {
      return await deleteCustomAsset(payload, event.sender);
    } catch (error) {
      writeLog("ERROR", "assets:deleteCustom failed", {
        message: error?.message,
        code: error?.code,
        path: error?.path
      });
      return {
        ok: false,
        message: "删除失败：" + String(error?.message || error)
      };
    }
  });

  ipcMain.handle("assets:previewDeletion", async (_, payload) => {
    try { return await previewCustomAssetDeletion(payload); }
    catch (error) { return { ok: false, message: String(error.message || error) }; }
  });
  ipcMain.handle("assets:inspectCharacterIdentity", async (_, payload) => {
    try { return await inspectCharacterIdentity(payload); }
    catch (error) { return { ok: false, message: String(error.message || error) }; }
  });
  ipcMain.handle("assets:revealCharacterHistorySource", async (_, payload) => {
    try {
      const asset = index.find(item => item.source === "custom" && item.id === payload?.assetId);
      const { parent, root } = await require("./services/characterComponents").loadParent(settings.customLibraryPath, asset, ["suit", "monster", "npc", "weapon", "item"]);
      const source = await resolveHistorySource(parent, root, payload.historyId, payload.sourceIndex);
      shell.showItemInFolder(source);
      return { ok: true };
    } catch (error) { return { ok: false, message: String(error.message || error) }; }
  });
  for (const [action, operation, readOnly] of [
    ["previewPartUpdate", prepareComponentReplacement, true],
    ["updatePart", replaceCharacterComponent, false],
    ["updateCharacterPreview", updateCharacterComponentPreview, false],
    ["updateCharacterPreviewBatch", require('./services/characterComponents').updateCharacterPreviewBatch, false],
    ["updateCharacterGallery", updateCharacterPreviewGallery, false],
    ["updateCharacterAutoPreviews", updateCharacterAutomaticPreviews, false],
    ["updateCharacterStatus", updateCharacterStatus, false],
    ['reviewCharacterRig', require('./services/characterRigReview').reviewCharacterRig, false],
    ["updateCharacterNames", updateCharacterNames, false],
    ["relinkCharacterHistory", relinkHistorySource, false],
    ["selectPartRevision", selectCharacterComponentRevision, false],
    ["matchCharacterUpdateTextures", matchCharacterTextureReplacements, true],
    ["inspectCharacterUpdateInput", inspectCharacterUpdateInput, true],
    ["previewPackageUpdate", prepareCharacterPackageUpdate, true],
    ["updatePackage", updateCharacterPackage, false],
    ["selectPackageRevision", restoreCharacterPackageVersion, false]
  ]) {
    ipcMain.handle(`assets:${action}`, async (event, payload) => {
      let ownsMutation = false;
      const report = (progress, message) => {
        if (!readOnly) emitCustomSaveProgress(event.sender, payload?.assetId, progress, `character-update:${message}`);
      };
      try {
        report(0, '正在准备更新…');
        // Preview writes use metadata transactions and revision checks; an
        // incremental library scan preserves these concurrent asset changes.
        await waitForCharacterOperation(readOnly, action === 'updateCharacterPreviewBatch' || action === 'updateCharacterAutoPreviews');
        const root = settings.customLibraryPath;
        const asset = index.find(item => item.id === payload?.assetId && item.source === "custom");
        if (!asset) throw new Error("主体记录不存在，请刷新");
        if (readOnly) return { ok: true, plan: await operation({ ...payload, root, asset }) };
        activeImportCalls++; ownsMutation = true;
        markInternalLibraryMutation(60000);
        report(5, '正在检查并保存更新…');
        const result = await operation({ ...payload, root, asset, onProgress: report });
        if (!result.ok) { emitCustomSaveFailure(event.sender, result.message); return result; }
        report(85, '正在同步资产列表…');
        const refreshed = await refreshAssetById(asset.id);
        let indexPending = false;
        try {
          if (!refreshed || normalizeComparePath(settings.customLibraryPath) !== normalizeComparePath(root)) throw new Error("资源库已切换或索引刷新失败");
          await applyLibrarySqlCacheChanges({ upsertAssets: [refreshed], deleteIds: [] });
          // The single changed character is already durable in SQLite. Avoid
          // serializing every environment/animation record twice per preview/status edit.
          if (!getLibraryDb() && !await saveIndexSnapshot(index)) throw new Error("索引保存失败");
          sharedSnapshotVersion++;
          if (sharedIndexComplete && !scanInProgress) publishSharedIndexSnapshot();
        } catch (error) { indexPending = true; writeLog("ERROR", "character update index pending", { assetId: asset.id, message: error.message }); }
        const changedRecord = refreshed && toAssetListRecord(refreshed);
        for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send("assets:change",
          changedRecord ? { incremental: true, records: [changedRecord] } : undefined);
        report(100, '更新完成');
        return { ...result, indexPending, asset: refreshed || null };
      } catch (error) {
        if (!readOnly) emitCustomSaveFailure(event.sender, String(error.message || error));
        return { ok: false, message: String(error.message || error) };
      }
      finally { if (ownsMutation) activeImportCalls--; }
    });
  }

  ipcMain.handle("assets:rewriteCustomJson", async () => ({
    ok: false, message: "请使用设置中的 Update Metadata / Use Settings > Update Metadata"
  }));

  ipcMain.handle("assets:syncMetadata", async (event) => {
    const result = await syncLibraryMetadata(event.sender);
    if (result.ok) {
      event.sender.send("assets:change");
    }
    return result;
  });

  ipcMain.handle("assets:reconcileCustomFolders", async (event) => {
    const result = await reconcileCustomAssetFolders();
    if (result.ok) {
      event.sender.send("assets:change");
    }
    return result;
  });

  ipcMain.handle("assets:recalculateSizes", async () => ({
    ok: false, count: 0, message: "请使用设置中的 Update Metadata / Use Settings > Update Metadata"
  }));

  ipcMain.handle("assets:respondBounds", (_, payload) => {
    const { requestId, bounds, collision } = payload || {};
    const request = pendingBoundsRequests.get(requestId);
    if (request) {
      globalThis.clearTimeout(request.timeout);
      request.resolve({ bounds: bounds || null, collision: collision || null });
      pendingBoundsRequests.delete(requestId);
    }
    return { ok: true };
  });
});

app.on("will-quit", () => {
  appUpdates?.stop();
  stopLibraryScans();
  void stopLibraryWatch();
  const archiveRoot = path.resolve(getImportSourceRoot(), "DroppedArchives");
  for (const directory of droppedArchiveDirs) {
    if (path.dirname(path.resolve(directory)) !== archiveRoot) continue;
    if (importQueueStore?.protects(directory)) continue;
    try { fsSync.rmSync(directory, { recursive: true, force: true }); } catch { /* Retry next exit if quitting is cancelled. */ }
  }
  tcpClient.disconnect();
  if (runtimeCacheMonitorTimer) {
    globalThis.clearInterval(runtimeCacheMonitorTimer);
    runtimeCacheMonitorTimer = null;
  }
  closeLibraryDb();
});

app.on("window-all-closed", () => {
  if (quitting) return;
  if (hasActiveBackgroundImport()) {
    quitAfterImport = true;
  } else {
    app.quit();
  }
});
