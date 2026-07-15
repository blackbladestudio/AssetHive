const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage } = require("electron");
let sharp = null;
try {
  sharp = require("sharp");
} catch {
  sharp = null;
}
let pinyinLib = null;
try {
  pinyinLib = require("pinyin");
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
  searchAssets,
  getAssetDetails,
  getAssetDetailsByMetaPath,
  watchLibrary,
  updateAssetFavorite,
  updateAssetMetadata,
  inferColorTagsFromTextureFiles,
  collectColorTagsFromMeta
} = require("./services/assetScanner");
const { exportToUnreal } = require("./services/unrealExporter");
const { fetchLatestRelease, installPluginFromGithub, installPluginToEngine } = require("./services/githubInstaller");
const logManager = require("./logManager");
const { writeLog, setupLogger, refreshLoggerPath } = logManager;

const DISABLE_GPU_ACCELERATION = process.env.ASSETHIVE_DISABLE_GPU === "1";
if (DISABLE_GPU_ACCELERATION) {
  app.disableHardwareAcceleration();
}
app.setName("AssetHive");
if (process.platform === "win32") {
  app.setAppUserModelId("com.blackblade.assethive");
}
app.commandLine.appendSwitch("disk-cache-dir", path.join(os.tmpdir(), "AssetHive", "chromium-cache"));
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");

let index = [];
let bridgeHeartbeatTimer = null;
let settings = {
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
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".exr", ".hdr", ".tga"]);
const MODEL_EXTENSIONS = new Set([".fbx", ".obj", ".abc", ".gltf", ".glb", ".ztl"]);
const TEXTURE_SUFFIXES = [
  "Albedo",
  "AO",
  "Brush",
  "Bump",
  "Cavity",
  "Diffuse",
  "Displacement",
  "Fuzz",
  "Gloss",
  "Mask",
  "Metalness",
  "Normal",
  "Opacity",
  "Roughness",
  "Specular",
  "Translucency",
  "HDR"
];
const TEXTURE_SUFFIX_SET = new Set(TEXTURE_SUFFIXES.map((name) => name.toLowerCase()));
const MODEL_SLOT_SUFFIXES = ["Ztool", "HighPoly", "Lod0", "Lod1", "Lod2", "Lod3"];
const APP_UPDATE_REPO_CANDIDATES = ["blackbladestudio/AssetHive"];
const APP_UPDATE_LATEST_CHANNEL_EXE = "release/latest/AssetHive.exe";
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
const RUNTIME_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
const RUNTIME_CACHE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const COLOR_TAG_INFER_TIMEOUT_MS = 3500;
const ENABLE_STARTUP_AUTO_SCAN = process.env.ASSETHIVE_AUTO_SCAN_ON_STARTUP !== "0";
const ENABLE_WATCH_AUTO_SCAN = process.env.ASSETHIVE_WATCH_AUTO_SCAN !== "0";
let scanInProgress = false;
let pendingWatcherScan = false;
let lastWatcherScanAt = 0;
let suppressWatcherScanUntil = 0;
let startupScanRequired = false;
let runtimeCacheMonitorTimer = null;
let pendingIndexSaveTimer = 0;

function normalizeVersionTag(value) {
  const normalized = String(value || "").trim().replace(/^v/i, "");
  if (!normalized) {
    return "0.0.0";
  }
  const parts = normalized.split(".").map((item) => Number.parseInt(item, 10)).filter((item) => Number.isFinite(item));
  while (parts.length < 3) {
    parts.push(0);
  }
  return parts.slice(0, 3).join(".");
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

function pickWindowsUpdateAsset(assets) {
  const candidates = Array.isArray(assets) ? assets.filter((item) => item && typeof item === "object") : [];
  const windowsAssets = candidates.filter((item) => {
    const name = String(item?.name || "").trim().toLowerCase();
    return name.endsWith(".exe") || name.endsWith(".msi") || name.endsWith(".zip");
  });
  if (windowsAssets.length === 0) {
    return null;
  }
  const scoreAsset = (asset) => {
    const name = String(asset?.name || "").trim().toLowerCase();
    let score = 0;
    if (name.endsWith(".exe")) score += 50;
    if (name.endsWith(".msi")) score += 40;
    if (name.includes("setup")) score += 20;
    if (name.includes("x64") || name.includes("win64")) score += 15;
    if (name.includes("portable")) score += 8;
    // We now support zip if it's the only one, or if it's explicitly preferred
    if (name.endsWith(".zip")) score += 10;
    return score;
  };
  return [...windowsAssets].sort((a, b) => scoreAsset(b) - scoreAsset(a))[0];
}

function getUpdateStorageContext() {
  const appRootPath = app.isPackaged ? path.dirname(app.getPath("exe")) : app.getAppPath();
  const updateDir = path.join(app.getPath("userData"), ".update");
  return { appRootPath, updateDir };
}

async function findLocalUpdatePackage(updateDir, latestVersion) {
  const normalizedVersion = String(latestVersion || "").trim();
  const entries = await fs.readdir(updateDir, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => {
      const lower = name.toLowerCase();
      if (!(lower.endsWith(".exe") || lower.endsWith(".msi") || lower.endsWith(".zip"))) {
        return false;
      }
      if (!normalizedVersion) {
        return lower.includes("assethive");
      }
      return lower.includes(`assethive-${normalizedVersion}`) || lower.includes(`assethive_latest_${normalizedVersion}`) || lower.includes(`latest-${normalizedVersion}`);
    });
  if (candidates.length === 0) {
    return "";
  }
  let picked = "";
  let pickedMtime = 0;
  for (const fileName of candidates) {
    const fullPath = path.join(updateDir, fileName);
    const stat = await fs.stat(fullPath).catch(() => null);
    const mtime = stat ? Number(stat.mtimeMs) || 0 : 0;
    if (!picked || mtime > pickedMtime) {
      picked = fullPath;
      pickedMtime = mtime;
    }
  }
  return picked;
}

async function extractZipForUpdate(zipPath, extractDir) {
  await fs.rm(extractDir, { recursive: true, force: true }).catch(() => { });
  await fs.mkdir(extractDir, { recursive: true });
  const { spawn } = require("child_process");
  await new Promise((resolve, reject) => {
    const psCommand = `Expand-Archive -Path "${zipPath}" -DestinationPath "${extractDir}" -Force`;
    const child = spawn("powershell", ["-NoProfile", "-Command", psCommand]);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Unzip failed with code ${code}`));
    });
    child.on("error", reject);
  });
}

async function findExeInDirForUpdate(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  let bestExe = "";
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findExeInDirForUpdate(fullPath);
      if (found && (!bestExe || found.toLowerCase().includes("assethive"))) {
        bestExe = found;
      }
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".exe")) {
      continue;
    }
    if (entry.name.toLowerCase().includes("assethive")) {
      return fullPath;
    }
    if (!bestExe) {
      bestExe = fullPath;
    }
  }
  return bestExe;
}

async function launchDownloadedUpdatePackage(packagePath) {
  const normalizedPath = String(packagePath || "").trim();
  if (!normalizedPath) {
    return { ok: false, message: "未找到可安装的更新包路径" };
  }
  const stat = await fs.stat(normalizedPath).catch(() => null);
  if (!stat || !stat.isFile()) {
    return { ok: false, message: "更新包不存在，请先下载" };
  }
  const { appRootPath, updateDir } = getUpdateStorageContext();
  const lowerPath = normalizedPath.toLowerCase();
  if (lowerPath.endsWith(".zip")) {
    const extractDir = path.join(updateDir, `${path.basename(normalizedPath, path.extname(normalizedPath))}-extracted`);
    try {
      await extractZipForUpdate(normalizedPath, extractDir);
      const extractedExe = await findExeInDirForUpdate(extractDir);
      if (!extractedExe) {
        return { ok: false, message: "压缩包中未找到可执行安装文件" };
      }
      const installDir = appRootPath;
      const restartExePath = path.join(installDir, path.basename(process.execPath));
      const updaterInInstall = path.join(installDir, "AssetHiveUpdater.exe");
      const updaterInUpdateDir = path.join(updateDir, "AssetHiveUpdater.exe");
      let updaterReady = false;
      try {
        if (await fs.stat(updaterInInstall).catch(() => null)) {
          await fs.copyFile(updaterInInstall, updaterInUpdateDir);
          updaterReady = true;
        }
      } catch {
        updaterReady = false;
      }
      const { spawn } = require("child_process");
      if (updaterReady) {
        const subprocess = spawn(updaterInUpdateDir, [
          "--source", path.dirname(extractedExe),
          "--target", installDir,
          "--restart", restartExePath,
          "--cleanup", path.dirname(extractedExe),
          "--cleanup", normalizedPath
        ], {
          detached: true,
          stdio: "ignore"
        });
        subprocess.unref();
      } else {
        const updateScriptPath = path.join(updateDir, "update_script.ps1");
        const psContent = `
Start-Sleep -Seconds 3
Copy-Item -Path "${path.dirname(extractedExe)}\\*" -Destination "${installDir}" -Recurse -Force
Start-Process -FilePath "${restartExePath}"
Remove-Item -Path "${path.dirname(extractedExe)}" -Recurse -Force
Remove-Item -Path "${normalizedPath}" -Force
        `;
        await fs.writeFile(updateScriptPath, psContent.trim());
        const subprocess = spawn("powershell.exe", [
          "-NoProfile",
          "-ExecutionPolicy", "Bypass",
          "-WindowStyle", "Hidden",
          "-Command", `& '${updateScriptPath}'; Remove-Item -Path '${updateScriptPath}' -Force`
        ], {
          detached: true,
          stdio: "ignore"
        });
        subprocess.unref();
      }
      global.setTimeout(() => {
        app.exit(0);
      }, 1000);
      return { ok: true, message: "已启动更新安装程序" };
    } catch (error) {
      writeLog("ERROR", "Failed to launch zip update package", error);
      return { ok: false, message: `安装失败：${String(error?.message || error || "")}` };
    }
  }
  const launchError = await shell.openPath(normalizedPath);
  if (launchError) {
    return { ok: false, message: launchError };
  }
  global.setTimeout(() => {
    app.quit();
  }, 1500);
  return { ok: true, message: "已启动安装程序" };
}

async function downloadReleaseAsset(url, targetFilePath, onProgress) {
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
      await fs.rm(targetFilePath, { force: true }).catch(() => { });
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
  const contentLength = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  await fs.mkdir(path.dirname(targetFilePath), { recursive: true });
  const handle = await fs.open(targetFilePath, "w");
  let loaded = 0;
  try {
    for (; ;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const value = chunk.value;
      if (!value) {
        continue;
      }
      await handle.write(value);
      loaded += value.length;
      if (typeof onProgress === "function") {
        const progress = contentLength > 0 ? Math.round((loaded / contentLength) * 100) : null;
        onProgress({ progress, loaded, total: contentLength });
      }
    }
  } finally {
    await handle.close();
  }
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

async function isValidWindowsExecutable(filePath) {
  const handle = await fs.open(filePath, "r").catch(() => null);
  if (!handle) {
    return false;
  }
  try {
    const buffer = Buffer.alloc(2);
    const { bytesRead } = await handle.read(buffer, 0, 2, 0);
    if (bytesRead < 2) {
      return false;
    }
    return buffer[0] === 0x4d && buffer[1] === 0x5a;
  } finally {
    await handle.close();
  }
}

function requestBoundsFromRenderer(sender, filePath) {
  return new Promise((resolve) => {
    const requestId = Math.random().toString(36).slice(2);
    const timeout = globalThis.setTimeout(() => {
      pendingBoundsRequests.delete(requestId);
      resolve(null);
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

function getLegacyUserDataRoots() {
  try {
    const appData = app.getPath("appData");
    const candidates = ["ArkHive", "ArkHive-App", "ArkHivePortable", "ArkHive-Portable"];
    return candidates.map((name) => path.join(appData, name));
  } catch {
    return [];
  }
}

async function loadLegacySettings() {
  const roots = getLegacyUserDataRoots();
  for (const root of roots) {
    const candidate = path.join(root, "settings.json");
    const stat = await statOrNull(candidate);
    if (!stat?.isFile()) {
      continue;
    }
    const loaded = await loadJson(candidate, null);
    if (loaded && typeof loaded === "object") {
      return { settings: loaded, from: candidate };
    }
  }
  return null;
}

async function loadLibraryJsonCache(extraCandidates = []) {
  const candidates = [
    getDataFilePath(LIBRARY_JSON_CACHE_FILE_NAME),
    ...(Array.isArray(extraCandidates) ? extraCandidates : [])
  ]
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
    if (!Array.isArray(list) || list.length === 0) {
      continue;
    }
    const normalized = list
      .map((item) => (item && typeof item === "object" ? item : null))
      .filter(Boolean)
      .map((asset) => ({
        id: String(asset?.id || "").trim(),
        name: String(asset?.name || "").trim() || String(asset?.id || "").trim(),
        source: String(asset?.source || "").trim() || "custom",
        path: String(asset?.path || "").trim(),
        metaPath: String(asset?.metaPath || "").trim(),
        previewImage: String(asset?.previewImage || asset?.preview || "").trim() || null,
        detailImage: String(asset?.detailImage || "").trim() || null,
        favorite: Boolean(asset?.favorite),
        assetType: String(asset?.assetType || "").trim(),
        tags: Array.isArray(asset?.tags) ? asset.tags : [],
        themes: Array.isArray(asset?.themes) ? asset.themes : [],
        colorTags: Array.isArray(asset?.colorTags) ? asset.colorTags : [],
        createdAt: asset?.createdAt || null
      }))
      .filter((asset) => asset.id);
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return [];
}

async function saveLibraryJsonCache(nextIndex) {
  const normalizedIndex = Array.isArray(nextIndex) ? nextIndex : [];
  await saveJson(getDataFilePath(LIBRARY_JSON_CACHE_FILE_NAME), normalizedIndex);
}

function getLibraryRootPath() {
  const preferredRoot = String(settings.customLibraryPath || settings.megascanLibraryPath || "").trim();
  if (!preferredRoot) {
    return "";
  }
  return path.resolve(preferredRoot);
}

function getRuntimeCacheTargets() {
  const userData = app.getPath("userData");
  const targets = [
    path.join(os.tmpdir(), "assethive"),
    path.join(os.tmpdir(), "AssetHive"),
    path.join(userData, "Cache"),
    path.join(userData, "Code Cache"),
    path.join(userData, "GPUCache"),
    path.join(userData, "DawnGraphiteCache"),
    path.join(userData, "DawnWebGPUCache"),
    path.join(userData, "Network"),
    path.join(userData, "blob_storage"),
    path.join(userData, "Session Storage"),
    path.join(userData, "Shared Dictionary")
  ];
  return [...new Set(targets.map((entry) => path.resolve(entry)))];
}

async function measureDirectorySize(targetPath) {
  let totalBytes = 0;
  const stack = [targetPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      try {
        const stats = await fs.stat(fullPath);
        totalBytes += Number(stats.size) || 0;
      } catch {
        void 0;
      }
    }
  }
  return totalBytes;
}

async function getRuntimeCacheUsage() {
  const targets = getRuntimeCacheTargets();
  let totalBytes = 0;
  for (const targetPath of targets) {
    const stats = await statOrNull(targetPath);
    if (!stats?.isDirectory()) {
      continue;
    }
    totalBytes += await measureDirectorySize(targetPath);
  }
  return totalBytes;
}

async function clearRuntimeCaches(reason = "manual") {
  const targets = getRuntimeCacheTargets();
  const removed = [];
  const failed = [];
  for (const targetPath of targets) {
    try {
      const stats = await statOrNull(targetPath);
      if (!stats?.isDirectory()) {
        continue;
      }
      await fs.rm(targetPath, { recursive: true, force: true });
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
      const totalBytes = await getRuntimeCacheUsage();
      if (totalBytes > RUNTIME_CACHE_MAX_BYTES) {
        await clearRuntimeCaches(reason);
      }
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
  const root = getLibraryRootPath();
  if (!root) {
    return "";
  }
  return path.join(root, LIBRARY_SQLITE_CACHE_FILE_NAME);
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
}

function getLibraryDb() {
  if (!DatabaseSync) {
    throw new Error("node:sqlite is not available in this runtime");
  }
  const preferredPath = getLibrarySqlCachePath();
  const fallbackPath = getFallbackLibrarySqlCachePath();
  const candidates = [preferredPath, fallbackPath]
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
  if (libraryDb) {
    try {
      libraryDb.close();
    } catch {
    }
    libraryDb = null;
    libraryDbPath = "";
  }

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
        tagsJson TEXT,
        themesJson TEXT,
        colorTagsJson TEXT,
        createdAt TEXT,
        favorite INTEGER DEFAULT 0,
        lastSeenScan INTEGER DEFAULT 0
      );
    `);
    ensureLibraryDbSchema(db);
    db.exec("CREATE INDEX IF NOT EXISTS idx_assets_source ON assets(source);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_assets_path ON assets(path);");
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
  if (!sourcePath) {
    return "";
  }
  const sourceExt = path.extname(sourcePath).toLowerCase();
  if (sourceExt === ".hdr" || sourceExt === ".exr") {
    return "";
  }
  const sourceStats = await statOrNull(sourcePath);
  if (!sourceStats || !sourceStats.isFile()) {
    return "";
  }
  if (!sharp) {
    return sourcePath;
  }
  try {
    const metadata = await sharp(sourcePath).metadata();
    const hasAlpha = Boolean(metadata?.hasAlpha);
    const targetExt = hasAlpha ? ".png" : ".jpg";
    const isMegascanPreview = isUnderRoot(settings.megascanLibraryPath, sourcePath);
    const dir = path.dirname(sourcePath);
    const parsed = path.parse(sourcePath);
    const nameNoExt = parsed.name;
    const thumbBaseName = `${nameNoExt}_thumb`;
    const persistentThumbPath = path.join(dir, `${thumbBaseName}${targetExt}`);

    const writeThumb = async (outputPath) => {
      const MAX_SIZE = 512;
      const pipeline = sharp(sourcePath).rotate().resize(MAX_SIZE, MAX_SIZE, { fit: "inside", withoutEnlargement: true });
      if (hasAlpha) {
        await pipeline.png({ compressionLevel: 9 }).toFile(outputPath);
      } else {
        await pipeline.jpeg({ quality: 72, mozjpeg: true }).toFile(outputPath);
      }
      return outputPath;
    };

    const persistentStats = await statOrNull(persistentThumbPath);
    if (persistentStats && Number(persistentStats.mtimeMs) >= Number(sourceStats.mtimeMs)) {
      return persistentThumbPath;
    }

    try {
      await writeThumb(persistentThumbPath);
      return persistentThumbPath;
    } catch {
      if (!isMegascanPreview) {
        return sourcePath;
      }
    }

    const cacheDir = path.join(os.tmpdir(), "AssetHive", "Thumbs");
    const key = crypto
      .createHash("sha1")
      .update(`${normalizeComparePath(sourcePath)}|${Number(sourceStats.mtimeMs) || 0}`)
      .digest("hex")
      .slice(0, 20);
    const tempThumbPath = path.join(cacheDir, `${key}${targetExt}`);
    const tempStats = await statOrNull(tempThumbPath);
    if (tempStats?.isFile()) {
      return tempThumbPath;
    }
    await fs.mkdir(path.dirname(tempThumbPath), { recursive: true });
    await writeThumb(tempThumbPath);
    return tempThumbPath;
  } catch {
    return sourcePath;
  }
}

async function loadFavoriteIds() {
  const db = getLibraryDb();
  if (!db) {
    return new Set();
  }
  try {
    const rows = db.prepare("SELECT id FROM assets WHERE favorite = 1").all();
    return new Set(
      (Array.isArray(rows) ? rows : [])
        .map((row) => String(row?.id || "").trim())
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

async function loadFavoriteMetaTokens() {
  const db = getLibraryDb();
  if (!db) {
    return new Set();
  }
  try {
    const rows = db.prepare("SELECT metaPath FROM assets WHERE favorite = 1").all();
    return new Set(
      (Array.isArray(rows) ? rows : [])
        .map((row) => normalizeComparePath(String(row?.metaPath || "").trim()))
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
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
    asset.favorite = (id && idSet.has(id)) || (metaToken && metaSet.has(metaToken));
  }
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
    tagsJson: JSON.stringify(Array.isArray(asset.tags) ? asset.tags : []),
    themesJson: JSON.stringify(Array.isArray(asset.themes) ? asset.themes : []),
    colorTagsJson: JSON.stringify(Array.isArray(asset.colorTags) ? asset.colorTags : []),
    createdAt: asset.createdAt || null,
    favorite: asset.favorite ? 1 : 0,
    lastSeenScan
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
        tagsJson, themesJson, colorTagsJson, createdAt, favorite, lastSeenScan
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
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
          item.tagsJson,
          item.themesJson,
          item.colorTagsJson,
          item.createdAt,
          item.favorite,
          item.lastSeenScan
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
  const db = getLibraryDb();
  if (!db) {
    return;
  }
  ensureLibraryDbSchema(db);
  const upsertAssets = Array.isArray(payload?.upsertAssets) ? payload.upsertAssets : [];
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
          tagsJson, themesJson, colorTagsJson, createdAt, favorite, lastSeenScan
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?
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
          item.tagsJson,
          item.themesJson,
          item.colorTagsJson,
          item.createdAt,
          item.favorite,
          item.lastSeenScan
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

async function loadLibrarySqlCache(options = {}) {
  const safeJson = (value, fallback) => {
    try {
      const parsed = JSON.parse(String(value || ""));
      return Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  };
  const readFromPath = (resolvedPath) => {
    try {
      const db = new DatabaseSync(resolvedPath);
      ensureLibraryDbSchema(db);
      const rows = db.prepare("SELECT id, name, source, path, metaPath, previewImage, detailImage, assetType, tagsJson, themesJson, colorTagsJson, createdAt, favorite FROM assets").all();
      try {
        db.close();
      } catch {
      }
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  };
  const preferredPath = getLibrarySqlCachePath();
  const fallbackPath = getFallbackLibrarySqlCachePath();
  const extraCandidates = Array.isArray(options?.extraCandidates) ? options.extraCandidates : [];
  const candidates = [preferredPath, fallbackPath, ...extraCandidates]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));
  const mergedRows = [];
  for (const candidate of candidates) {
    const rows = readFromPath(candidate);
    for (const row of rows) {
      mergedRows.push(row);
    }
    if (mergedRows.length > 0) {
      break;
    }
  }
  return mergedRows
    .map((row) => ({
      id: String(row?.id || "").trim(),
      name: String(row?.name || "").trim() || String(row?.id || "").trim(),
      source: String(row?.source || "").trim() || "custom",
      path: String(row?.path || "").trim(),
      metaPath: String(row?.metaPath || "").trim(),
      previewImage: String(row?.previewImage || "").trim() || null,
      detailImage: String(row?.detailImage || "").trim() || null,
      favorite: Boolean(Number(row?.favorite) || 0),
      assetType: String(row?.assetType || "").trim(),
      tags: safeJson(row?.tagsJson, []),
      themes: safeJson(row?.themesJson, []),
      colorTags: safeJson(row?.colorTagsJson, []),
      createdAt: row?.createdAt || null
    }))
    .filter((asset) => asset.id);
}

function hasCustomAssetsInIndex(currentIndex, customLibraryPath) {
  const customRoot = String(customLibraryPath || "").trim();
  if (!customRoot || !Array.isArray(currentIndex) || currentIndex.length === 0) {
    return false;
  }
  const normalizedCustomRoot = path.resolve(customRoot).replace(/\\/g, "/").toLowerCase();
  return currentIndex.some((asset) => {
    const source = String(asset?.source || "").trim().toLowerCase();
    if (source === "custom") {
      const assetPath = String(asset?.path || "").trim();
      if (assetPath) {
        const normalizedAssetPath = path.resolve(assetPath).replace(/\\/g, "/").toLowerCase();
        if (normalizedAssetPath === normalizedCustomRoot || normalizedAssetPath.startsWith(`${normalizedCustomRoot}/`)) {
          return true;
        }
      }
    }
    const sourceRoot = String(asset?.sourceRoot || "").trim();
    if (!sourceRoot) {
      return false;
    }
    const normalizedSourceRoot = path.resolve(sourceRoot).replace(/\\/g, "/").toLowerCase();
    return normalizedSourceRoot === normalizedCustomRoot;
  });
}

function getBridgeHeartbeatFilePath() {
  return path.join(os.homedir(), "Documents", "AssetHive", "bridge-heartbeat.json");
}

async function writeBridgeHeartbeat() {
  const filePath = getBridgeHeartbeatFilePath();
  const payload = {
    appName: "AssetHive",
    pid: process.pid,
    timestamp: Date.now()
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
}

function startBridgeHeartbeat() {
  const tick = async () => {
    try {
      await writeBridgeHeartbeat();
    } catch (error) {
      writeLog("WARN", "bridge heartbeat write failed", { message: error?.message });
    }
  };
  tick();
  bridgeHeartbeatTimer = globalThis.setInterval(tick, 2000);
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
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

async function saveIndexSnapshot(nextIndex, options = {}) {
  const normalizedIndex = Array.isArray(nextIndex) ? nextIndex : [];
  let sqliteSaved = false;
  if (DatabaseSync) {
    sqliteSaved = await saveLibrarySqlCache(normalizedIndex, options)
      .then(() => true)
      .catch((error) => {
        writeLog("WARN", "library sql cache save failed", { message: error?.message || String(error) });
        return false;
      });
  }
  if (!sqliteSaved) {
    await saveLibraryJsonCache(normalizedIndex).catch((error) => {
      writeLog("WARN", "library json cache save failed", { message: error?.message || String(error) });
    });
  }
  writeLog("INFO", "library sql cache snapshot saved", {
    count: normalizedIndex.length
  });
}

function scheduleIndexSnapshotSave(reason = "") {
  if (pendingIndexSaveTimer) {
    globalThis.clearTimeout(pendingIndexSaveTimer);
  }
  pendingIndexSaveTimer = globalThis.setTimeout(async () => {
    pendingIndexSaveTimer = 0;
    await saveIndexSnapshot(index).catch((error) => {
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

async function resolveLiveEditorProjectPath(maxAgeMs = 20000) {
  try {
    const bridgePath = path.join(os.homedir(), "Documents", "AssetHive", "editor-bridge.json");
    const raw = await fs.readFile(bridgePath, "utf-8");
    const parsed = JSON.parse(raw);
    const bridgeProjectPath = String(parsed?.projectPath || "").trim();
    const bridgeTimestamp = Number(parsed?.timestamp) || 0;
    if (!bridgeProjectPath || !bridgeTimestamp || Date.now() - bridgeTimestamp > maxAgeMs) {
      return "";
    }
    return await resolveProjectFilePath(bridgeProjectPath);
  } catch {
    return "";
  }
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
    path.join(engineRoot, "Engine", "Plugins", "Marketplace", "AssetHive", "AssetHive.uplugin"),
    path.join(engineRoot, "Engine", "Plugins", "AssetHive", "AssetHive.uplugin"),
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
  const resolvedProjectPath = await resolveProjectFilePath(targetProjectPath);
  const normalizedEditorPath = String(targetEditorPath || "").trim();
  const resolvedEditorPath = normalizedEditorPath ? path.resolve(normalizedEditorPath) : "";
  const [projectPluginInstalled, projectPluginEnabled, enginePluginInstalled] = await Promise.all([
    resolvedProjectPath ? hasProjectAssetHivePlugin(resolvedProjectPath) : Promise.resolve(false),
    resolvedProjectPath ? isProjectAssetHiveEnabled(resolvedProjectPath) : Promise.resolve(false),
    resolvedEditorPath ? hasEngineAssetHivePlugin(resolvedEditorPath) : Promise.resolve(false)
  ]);
  const projectReady = Boolean(resolvedProjectPath && projectPluginInstalled && projectPluginEnabled);
  const engineReady = Boolean(resolvedEditorPath && enginePluginInstalled);
  const projectName = resolvedProjectPath ? path.basename(resolvedProjectPath, path.extname(resolvedProjectPath)) : "";
  const editorName = resolvedEditorPath ? path.basename(path.resolve(path.dirname(resolvedEditorPath), "..", "..", "..")) : "";
  if (!projectReady && !engineReady) {
    return { connected: false, targetName: projectName || editorName || "" };
  }

  const output = await new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='UnrealEditor.exe'\" | Select-Object -ExpandProperty CommandLine"
      ],
      { windowsHide: true, timeout: 5000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(String(stdout || ""));
      }
    );
  });
  const lines = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const getBridgeProjectName = async () => {
    try {
      const bridgePath = path.join(os.homedir(), "Documents", "AssetHive", "editor-bridge.json");
      const raw = await fs.readFile(bridgePath, "utf-8");
      const parsed = JSON.parse(raw);
      const bridgeProjectPath = String(parsed?.projectPath || "").trim();
      const bridgeTimestamp = Number(parsed?.timestamp) || 0;
      if (!bridgeProjectPath || Date.now() - bridgeTimestamp > 20000) {
        return "";
      }
      return path.basename(bridgeProjectPath, path.extname(bridgeProjectPath));
    } catch {
      return "";
    }
  };
  const getProjectNameFromCommandLine = (commandLine) => {
    const line = String(commandLine || "");
    const quotedDoubleMatches = [...line.matchAll(/"([^"]+\.uproject)"/gi)].map((m) => m?.[1]).filter(Boolean);
    const quotedSingleMatches = [...line.matchAll(/'([^']+\.uproject)'/gi)].map((m) => m?.[1]).filter(Boolean);
    const plainMatches = [...line.matchAll(/[A-Za-z]:[\\/][^\r\n"' ]*?\.uproject/gi)].map((m) => m?.[0]).filter(Boolean);
    const allMatches = [...quotedDoubleMatches, ...quotedSingleMatches, ...plainMatches];
    if (allMatches.length > 0) {
      const candidate = String(allMatches[allMatches.length - 1] || "").trim();
      return candidate ? path.basename(candidate, path.extname(candidate)) : "";
    }
    return "";
  };
  if (lines.length === 0) {
    return { connected: false, targetName: projectName || editorName || "" };
  }
  if (projectReady) {
    const normalizedProject = resolvedProjectPath.replace(/\\/g, "/").toLowerCase();
    const normalizedProjectDir = path.dirname(resolvedProjectPath).replace(/\\/g, "/").toLowerCase();
    const matchedProject = lines.some((line) => {
      const normalizedLine = line.replace(/\\/g, "/").toLowerCase();
      return normalizedLine.includes(normalizedProject) || normalizedLine.includes(normalizedProjectDir);
    });
    if (matchedProject) {
      return { connected: true, targetName: projectName || "" };
    }
  }
  if (engineReady) {
    const normalizedEditor = resolvedEditorPath.replace(/\\/g, "/").toLowerCase();
    const matchedEditorLine = lines.find((line) => line.replace(/\\/g, "/").toLowerCase().includes(normalizedEditor));
    if (matchedEditorLine) {
      const runningProjectName = getProjectNameFromCommandLine(matchedEditorLine);
      const bridgeProjectName = await getBridgeProjectName();
      return { connected: true, targetName: runningProjectName || bridgeProjectName || projectName || editorName || "" };
    }
  }
  return { connected: false, targetName: projectName || editorName || "" };
}

function normalizePath(filePath) {
  return String(filePath || "").replaceAll("\\", "/");
}

function isModelAssetType(assetType) {
  return assetType === "3d" || assetType === "3dplant";
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
  return BrowserWindow.fromWebContents(sender) || BrowserWindow.getAllWindows()[0] || null;
}

async function cleanupFailedSaveArtifacts(customLibraryPath) {
  const root = String(customLibraryPath || "").trim();
  if (!root) {
    return 0;
  }
  const resolvedRoot = path.resolve(root);
  const rootStat = await statOrNull(resolvedRoot);
  if (!rootStat?.isDirectory()) {
    return 0;
  }
  const tempFilePattern = /^__assethive_tmp_(model|texture)_/i;
  let removedCount = 0;
  const queue = [resolvedRoot];
  while (queue.length > 0) {
    const currentDir = queue.pop();
    if (!currentDir) {
      continue;
    }
    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
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
        continue;
      }
    }
  }
  return removedCount;
}

function emitCustomSaveProgress(sender, assetId, progress, message = "") {
  const win = getMainWindowBySender(sender);
  if (!win || !assetId) {
    return;
  }
  win.webContents.send("assets:customSaveProgress", { assetId, progress, message });
}

async function decodeHdrOrExrToPng(sourcePath, outputPath, options = {}) {
  if (!sharp) {
    return "";
  }
  const resolved = path.resolve(String(sourcePath || ""));
  const ext = path.extname(resolved).toLowerCase();
  if (ext !== ".hdr" && ext !== ".exr") {
    return "";
  }
  const { HalfFloatType, DataUtils } = require("three");
  const buffer = await fs.readFile(resolved);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const texData = ext === ".hdr"
    ? (() => import("three/examples/jsm/loaders/HDRLoader.js").then(({ HDRLoader }) => {
      const loader = new HDRLoader();
      loader.setDataType(HalfFloatType);
      return loader.parse(arrayBuffer);
    }))()
    : (() => import("three/examples/jsm/loaders/EXRLoader.js").then(({ EXRLoader }) => {
      const loader = new EXRLoader();
      loader.setDataType(HalfFloatType);
      return loader.parse(arrayBuffer);
    }))();
  const parsed = await texData;
  const width = Math.max(1, Number(parsed?.width) || 1);
  const height = Math.max(1, Number(parsed?.height) || 1);
  const data = parsed?.data;
  if (!data || typeof data.length !== "number") {
    return "";
  }
  const channelGuess = Math.floor(Number(data.length) / (width * height));
  const channels = channelGuess >= 1 && channelGuess <= 4 ? channelGuess : 4;
  const isHalfFloat = data?.BYTES_PER_ELEMENT === 2;
  const readChannel = (index) => {
    const raw = data[index];
    if (raw === undefined) {
      return 0;
    }
    return isHalfFloat ? DataUtils.fromHalfFloat(raw) : Number(raw) || 0;
  };
  const maxWidth = Math.max(64, Number(options?.maxWidth) || 1024);
  const maxHeight = Math.max(64, Number(options?.maxHeight) || 1024);
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const out = Buffer.alloc(outW * outH * 3);
  const exposure = Math.max(0.001, Number(options?.exposure) || 1);
  const gamma = 1 / 2.2;
  for (let y = 0; y < outH; y += 1) {
    const sy = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < outW; x += 1) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const si = (sy * width + sx) * channels;
      const base = (y * outW + x) * 3;
      const r0 = readChannel(si);
      const g0 = readChannel(si + 1) || r0;
      const b0 = readChannel(si + 2) || r0;
      let r = r0 * exposure;
      let g = g0 * exposure;
      let b = b0 * exposure;
      r = r / (1 + r);
      g = g / (1 + g);
      b = b / (1 + b);
      r = Math.pow(Math.max(0, Math.min(1, r)), gamma);
      g = Math.pow(Math.max(0, Math.min(1, g)), gamma);
      b = Math.pow(Math.max(0, Math.min(1, b)), gamma);
      out[base] = Math.round(r * 255);
      out[base + 1] = Math.round(g * 255);
      out[base + 2] = Math.round(b * 255);
    }
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp(out, { raw: { width: outW, height: outH, channels: 3 } }).png({ compressionLevel: 9 }).toFile(outputPath);
  const st = await statOrNull(outputPath);
  return st?.isFile() ? outputPath : "";
}

async function compressPreviewImage(sourcePath, destinationDir, baseName, options = {}) {
  const resolved = path.resolve(sourcePath);
  const stats = await statOrNull(resolved);
  if (!stats?.isFile()) {
    return null;
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
  } catch {
  }
  if (!sharp) {
    return null;
  }
  try {
    const maxWidth = Math.max(64, Number(options?.maxWidth) || 1024);
    const maxHeight = Math.max(64, Number(options?.maxHeight) || 1024);
    const outputPath = path.join(destinationDir, `${baseName}.png`);
    let pipeline = sharp(resolved, { failOn: "none" }).rotate();
    const metadata = await pipeline.metadata().catch(() => null);
    if (metadata && (metadata.width > maxWidth || metadata.height > maxHeight)) {
      pipeline = pipeline.resize(maxWidth, maxHeight, { fit: "inside", withoutEnlargement: true });
    }
    await pipeline.png({ compressionLevel: 9 }).toFile(outputPath);
    const st = await statOrNull(outputPath);
    return st?.isFile() ? outputPath : null;
  } catch {
    const ext = path.extname(resolved).toLowerCase();
    if (ext !== ".hdr" && ext !== ".exr") {
      return null;
    }
    const outputPath = path.join(destinationDir, `${baseName}.png`);
    try {
      const converted = await decodeHdrOrExrToPng(resolved, outputPath, options);
      return converted ? outputPath : null;
    } catch {
      return null;
    }
  }
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
  return TEXTURE_SUFFIXES.find((item) => item.toLowerCase() === String(value || "").trim().toLowerCase()) || "";
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
  const name = path.basename(String(filePath || "")).toLowerCase();
  for (const suffix of TEXTURE_SUFFIXES) {
    if (name.includes(suffix.toLowerCase())) {
      return suffix;
    }
  }
  return detectTextureSuffix(filePath);
}

function getCustomAssetTypeFolder(assetType) {
  const normalized = sanitizeToken(assetType);
  return normalized || "custom";
}

function makeCustomModelBaseName(slot, assetName, assetId, options = {}) {
  const assetNameToken = sanitizeToken(assetName) || "asset";
  const normalizedSlot = String(slot || "").trim().toLowerCase();
  if (isMeshSlotName(normalizedSlot)) {
    const variantIndex = Number.isFinite(options.variantIndex) ? Math.max(0, Number(options.variantIndex)) : 0;
    const variantCount = Number.isFinite(options.variantCount) ? Math.max(1, Number(options.variantCount)) : 1;
    if (variantCount <= 1) {
      return `SM_${assetNameToken}_${assetId}`;
    }
    return `SM_${assetNameToken}_${assetId}_Var${String(variantIndex + 1).padStart(2, "0")}`;
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

async function normalizeModelFileNamesForAsset(modelSlotMap, assetDir, assetName, assetId) {
  const orderedEntries = sortModelSlotEntries([...modelSlotMap.entries()]);
  const meshEntries = orderedEntries.filter(([slot]) => isMeshSlotName(slot));
  const meshVariantCount = meshEntries.length;
  const meshVariantOrder = new Map(meshEntries.map(([slot], index) => [String(slot || "").toLowerCase(), index]));
  const renamePlans = orderedEntries.map(([slot, filePath]) => {
    const currentPath = path.resolve(String(filePath || ""));
    const ext = path.extname(currentPath);
    const slotKey = String(slot || "").toLowerCase();
    const desiredBase = makeCustomModelBaseName(slot, assetName, assetId, {
      variantIndex: meshVariantOrder.has(slotKey) ? meshVariantOrder.get(slotKey) : 0,
      variantCount: isMeshSlotName(slot) ? meshVariantCount : 1
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

function makeCustomTextureBaseName(suffix, assetName, assetId) {
  const assetNameToken = sanitizeToken(assetName) || "asset";
  // Remove any UUID-like suffix (e.g. _import-default-displacement-2) before creating the filename
  const cleanSuffix = String(suffix || "").replace(/_import-.*|_edit-.*/i, "");
  const lower = cleanSuffix.trim().toLowerCase();
  if (lower === "hdr") {
    return `T_${assetNameToken}_${assetId}`;
  }
  return `T_${assetNameToken}_${assetId}_${cleanSuffix}`;
}

function makeUniqueId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 7; i += 1) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return result;
}

async function makeAssetIdentity(assetType, assetName, destinationRoot) {
  const typeToken = sanitizeToken(assetType) || "asset";
  const assetNameToken = sanitizeToken(assetName) || "asset";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const uniqueId = makeUniqueId();
    const assetFolderName = `${typeToken}_${assetNameToken}_${uniqueId}`;
    const destinationDir = path.join(destinationRoot, assetFolderName);
    const existing = await statOrNull(destinationDir);
    if (!existing) {
      return { uniqueId, assetFolderName, destinationDir };
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

function getPreviewEditTempPath() {
  const fileName = `assethive_preview_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
  return path.join(os.tmpdir(), fileName);
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

function findLargestOpaqueRegion(bitmap, width, height, alphaThreshold = 10) {
  const visited = new Uint8Array(width * height);
  let best = null;
  const stack = [];
  for (let i = 0; i < width * height; i += 1) {
    if (visited[i]) {
      continue;
    }
    const base = i * 4;
    if (bitmap[base + 3] <= alphaThreshold) {
      continue;
    }
    let minX = i % width;
    let maxX = minX;
    let minY = Math.floor(i / width);
    let maxY = minY;
    let count = 0;
    stack.push(i);
    while (stack.length > 0) {
      const index = stack.pop();
      if (index === undefined || visited[index]) {
        continue;
      }
      visited[index] = 1;
      const offset = index * 4;
      if (bitmap[offset + 3] <= alphaThreshold) {
        continue;
      }
      count += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0) stack.push(index - 1);
      if (x < width - 1) stack.push(index + 1);
      if (y > 0) stack.push(index - width);
      if (y < height - 1) stack.push(index + width);
    }
    if (!best || count > best.count) {
      best = { minX, maxX, minY, maxY, count };
    }
  }
  return best;
}

async function finalizePreviewCutout(sourcePath, options = {}) {
  const imageData = getBitmapFromImagePath(sourcePath);
  if (!imageData) {
    return { ok: false, message: "预览图读取失败" };
  }
  const { bitmap, width, height } = imageData;
  const region = findLargestOpaqueRegion(bitmap, width, height, 10);
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
  const base = path.basename(String(filePath || ""), path.extname(String(filePath || ""))).toLowerCase();
  if (!base) {
    return false;
  }
  const tokens = [
    "albedo",
    "basecolor",
    "base_color",
    "diffuse",
    "color",
    "normal",
    "nrm",
    "nor",
    "roughness",
    "rough",
    "rgh",
    "metalness",
    "metallic",
    "metal",
    "ao",
    "ambientocclusion",
    "ambient_occlusion",
    "occlusion",
    "displacement",
    "disp",
    "height",
    "specular",
    "spec",
    "gloss",
    "glossiness",
    "cavity",
    "mask",
    "opacity",
    "alpha",
    "transparency",
    "bump",
    "fuzz",
    "translucency",
    "translucent",
    "hdr"
  ];
  return tokens.some((token) => base.includes(token));
}

async function resolvePreviewFile(sourcePath, previewImagePath) {
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
  const withExplicitPreview = scored.filter((item) => item.hasPreviewToken);
  if (withExplicitPreview.length > 0) {
    return [...withExplicitPreview].sort((a, b) => b.score - a.score)[0]?.filePath || null;
  }
  const withoutTextureSuffix = scored.filter((item) => !item.isTextureLike);
  if (withoutTextureSuffix.length > 0) {
    return [...withoutTextureSuffix].sort((a, b) => b.score - a.score)[0]?.filePath || null;
  }
  return [...scored].sort((a, b) => b.score - a.score)[0]?.filePath || null;
}

async function copyRenamedFile(sourcePath, destinationDir, baseName) {
  const resolved = path.resolve(sourcePath);
  const stats = await statOrNull(resolved);
  if (!stats?.isFile()) {
    return null;
  }
  const ext = path.extname(resolved).toLowerCase();
  const destinationPath = path.join(destinationDir, `${baseName}${ext}`);
  await fs.copyFile(resolved, destinationPath);
  return destinationPath;
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
  if (currentPreviewStats?.isFile()) {
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
    const previewDir = path.join(assetDir, "Preview");
    const previewDest = await compressPreviewImage(hdrSourcePath, previewDir, `${assetId}_preview`);
    if (!previewDest) {
      return normalizedAsset;
    }
    const previewUri = toPreviewRelativeUri(assetDir, previewDest);
    const previewAbsolutePath = normalizePath(previewDest);
    const previewContentLength = (await statOrNull(previewDest))?.size || 0;
    const nextMeta = normalizedAsset?.meta && typeof normalizedAsset.meta === "object"
      ? { ...normalizedAsset.meta }
      : {};
    nextMeta.previews = nextMeta.previews && typeof nextMeta.previews === "object" ? { ...nextMeta.previews } : {};
    nextMeta.previews.images = [
      {
        contentLength: previewContentLength,
        resolution: "unknown",
        uri: previewUri,
        tags: ["preview"]
      }
    ];
    if (!nextMeta.previews.relativeSize) {
      nextMeta.previews.relativeSize = await computeRelativeSizeFromPreview(previewDest, "hdri");
    }
    nextMeta.previewImage = previewUri;
    nextMeta.detailImage = previewUri;
    const metaPath = String(normalizedAsset.metaPath || "").trim();
    if (metaPath) {
      await saveJson(metaPath, nextMeta);
    }
    const repairedAsset = {
      ...normalizedAsset,
      preview: previewAbsolutePath,
      previewImage: previewAbsolutePath,
      detailImage: previewAbsolutePath,
      meta: nextMeta
    };
    scheduleIndexSnapshotSave("repair_hdri_preview");
    return repairedAsset;
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
  return ensureCustomHdriPreview(normalizeAssetPreviewFields(asset));
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
        stack.push(fullPath);
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
  const name = path.basename(filePath).toLowerCase();
  const patterns = [
    { suffix: "Albedo", matcher: /(albedo|basecolor|base_color|diffuse|color)/i },
    { suffix: "AO", matcher: /(ao|ambientocclusion|ambient_occlusion)/i },
    { suffix: "Normal", matcher: /(normal|nrm|nor)/i },
    { suffix: "Roughness", matcher: /(roughness|rough)/i },
    { suffix: "Metalness", matcher: /(metalness|metallic|metal)/i },
    { suffix: "Displacement", matcher: /(displacement|height)/i },
    { suffix: "Specular", matcher: /(specular|spec)/i },
    { suffix: "Gloss", matcher: /(gloss|glossiness)/i },
    { suffix: "Opacity", matcher: /(opacity|alpha|transparency)/i },
    { suffix: "Cavity", matcher: /(cavity)/i },
    { suffix: "Mask", matcher: /(mask)/i },
    { suffix: "Bump", matcher: /(bump)/i },
    { suffix: "Brush", matcher: /(brush)/i },
    { suffix: "Fuzz", matcher: /(fuzz)/i },
    { suffix: "Translucency", matcher: /(translucency|translucent)/i }
  ];
  for (const pattern of patterns) {
    if (pattern.matcher.test(name)) {
      return pattern.suffix;
    }
  }
  return "";
}

function hasLodToken(filePath) {
  const base = path.basename(String(filePath || ""), path.extname(String(filePath || ""))).toLowerCase();
  if (!base) {
    return false;
  }
  return /(?:^|[_.-])lod(?:[_-]?\d+)?(?:$|[_.-])/.test(base);
}

async function importCustomAsset(payload, sender) {
  if (payload?.__action === "deleteCustom") {
    return deleteCustomAsset({ assetId: payload?.assetId });
  }
  if (!settings.customLibraryPath) {
    return { ok: false, message: "请先在设置中配置 Custom Library 路径" };
  }
  const assetName = convertChineseToPinyin(String(payload?.assetName || "").trim());
  const assetType = sanitizeToken(payload?.assetType || "");
  const category = String(payload?.category || "custom").trim() || "custom";
  const tags = Array.isArray(payload?.tags)
    ? payload.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean)
    : [];
  if (!assetName) {
    return { ok: false, message: "请填写资产名称" };
  }
  if (!assetType) {
    return { ok: false, message: "请选择资产分类" };
  }
  markInternalLibraryMutation(25000);

  const destinationRoot = path.join(settings.customLibraryPath, getCustomAssetTypeFolder(assetType));
  await fs.mkdir(destinationRoot, { recursive: true });
  const assetIdentity = await makeAssetIdentity(assetType, assetName, destinationRoot);
  const { uniqueId, assetFolderName, destinationDir } = assetIdentity;
  await fs.mkdir(destinationDir, { recursive: true });

  const sourcePath = String(payload?.sourcePath || "").trim();
  const modelPath = String(payload?.modelPath || "").trim();
  const normalizedNormalMapFormat = normalizeNormalMapFormatValue(payload?.normalMapFormat, "dx");
  const payloadNormalMapFormats = payload?.normalMapFormats && typeof payload.normalMapFormats === "object" ? payload.normalMapFormats : {};
  const modelSlots = payload?.modelSlots && typeof payload.modelSlots === "object" ? payload.modelSlots : {};
  const textureSlots = payload?.textureSlots && typeof payload.textureSlots === "object" ? payload.textureSlots : {};
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
  const normalizedTextureSlots = Object.entries(textureSlots)
    .filter(([, value]) => typeof value === "string" && value.trim())
    .map(([key, value]) => {
      const parsed = parseTextureSlotToken(key);
      if (!parsed) {
        return null;
      }
      return { suffix: parsed.token, source: String(value).trim() };
    })
    .filter(Boolean);

  const sourceModelCandidates = sourcePath
    ? (await collectFilesByExtensions(sourcePath, MODEL_EXTENSIONS)).filter((filePath) => !hasLodToken(filePath))
    : [];
  const sourceTextureCandidates = sourcePath
    ? (await collectFilesByExtensions(sourcePath, IMAGE_EXTENSIONS)).filter((filePath) => !hasLodToken(filePath))
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
  const resolvedModelSlots = sortModelSlotEntries([...modelSlotMap.values()].map((item) => [item.suffix, item])).map(([, item]) => item);

  const slotMap = new Map(normalizedTextureSlots.map((item) => [item.suffix.toLowerCase(), item]));
  for (const sourceTexture of sourceTextureCandidates) {
    const detectedSuffix = detectTextureSuffix(sourceTexture);
    if (!detectedSuffix) {
      continue;
    }
    const key = detectedSuffix.toLowerCase();
    if (!slotMap.has(key)) {
      slotMap.set(key, { suffix: detectedSuffix, source: sourceTexture });
    }
  }
  const resolvedTextureSlots = [...slotMap.values()];

  if (isModelAssetType(assetType) && resolvedModelSlots.length === 0 && resolvedTextureSlots.length === 0) {
    return { ok: false, message: "请至少导入模型或贴图" };
  }
  if (!isModelAssetType(assetType) && resolvedTextureSlots.length === 0) {
    return { ok: false, message: "请至少导入一张贴图" };
  }

  const copiedModelEntries = [];
  const copiedTextureFiles = [];
  const meshVariantEntries = resolvedModelSlots.filter((model) => isMeshSlotName(model.suffix));
  const meshVariantCount = meshVariantEntries.length;
  const meshVariantOrder = new Map(meshVariantEntries.map((model, index) => [String(model.suffix || "").toLowerCase(), index]));
  for (const model of resolvedModelSlots) {
    const modelExt = path.extname(model.source).toLowerCase();
    if (!MODEL_EXTENSIONS.has(modelExt)) {
      return { ok: false, message: "模型格式无效，请选择 fbx/obj/abc/gltf/glb" };
    }
    const slotKey = String(model.suffix || "").toLowerCase();
    const copiedModel = await copyRenamedFile(
      model.source,
      destinationDir,
      makeCustomModelBaseName(model.suffix, assetName, uniqueId, {
        variantIndex: meshVariantOrder.has(slotKey) ? meshVariantOrder.get(slotKey) : 0,
        variantCount: isMeshSlotName(model.suffix) ? meshVariantCount : 1
      })
    );
    if (!copiedModel) {
      return { ok: false, message: `模型文件不存在：${model.suffix}` };
    }
    copiedModelEntries.push({ suffix: model.suffix, path: copiedModel });
  }

  for (const texture of resolvedTextureSlots) {
    const parsedTextureSlot = parseTextureSlotToken(texture.suffix);
    const textureSlotToken = parsedTextureSlot?.token || String(texture.suffix || "").trim();
    if (assetType.toLowerCase() === "hdri") {
      const ext = path.extname(texture.source).toLowerCase();
      if (ext !== ".hdr" && ext !== ".exr") {
        return { ok: false, message: "HDRI 仅支持导入 .hdr 或 .exr" };
      }
    }
    const copiedTexture = await copyRenamedFile(texture.source, destinationDir, makeCustomTextureBaseName(texture.suffix, assetName, uniqueId));
    if (!copiedTexture) {
      return { ok: false, message: `贴图不存在：${texture.suffix}` };
    }
    copiedTextureFiles.push({
      suffix: textureSlotToken,
      textureType: parsedTextureSlot?.textureType || textureSlotToken,
      areaIndex: parsedTextureSlot?.areaIndex || 1,
      path: copiedTexture
    });
  }
  const areaNormalMapFormats = buildAreaNormalMapFormats(copiedTextureFiles, payloadNormalMapFormats, normalizedNormalMapFormat);

  let previewDest = null;
  const previewImagePath = String(payload?.previewImagePath || "").trim();
  const previewDir = path.join(destinationDir, "Preview");
  await fs.mkdir(previewDir, { recursive: true });
  if (previewImagePath) {
    previewDest = await compressPreviewImage(previewImagePath, previewDir, `${uniqueId}_preview`);
    if (!previewDest) {
      return { ok: false, message: "预览图路径无效" };
    }
  } else {
    if (assetType.toLowerCase() === "hdri") {
      const hdrLike = copiedTextureFiles.find((item) => item.textureType && item.textureType.toLowerCase() === "hdr") || copiedTextureFiles[0];
      if (hdrLike) {
        const copiedFromTexture = await compressPreviewImage(hdrLike.path, previewDir, `${uniqueId}_preview`);
        previewDest = copiedFromTexture || null;
      }
    } else {
      const albedoLike = copiedTextureFiles.find((item) => item.suffix.toLowerCase() === "albedo" || item.suffix.toLowerCase() === "diffuse");
      if (albedoLike) {
        const copiedFromTexture = await compressPreviewImage(albedoLike.path, previewDir, `${uniqueId}_preview`);
        previewDest = copiedFromTexture || null;
      } else if (sourcePath) {
        const previewFile = await resolvePreviewFile(sourcePath, "");
        if (previewFile) {
          previewDest = await compressPreviewImage(previewFile, previewDir, `${uniqueId}_preview`);
        }
      }
    }
  }

  let previewFileUri = null;
  let previewContentLength = 0;
  let previewWidth = 0;
  let previewHeight = 0;
  if (previewDest) {
    previewFileUri = toPreviewRelativeUri(destinationDir, previewDest);
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
  const previewAbsolutePath = previewFileUri ? normalizePath(path.join(destinationDir, previewFileUri)) : "";
  const computedRelativeSize = (previewWidth > 0 && previewHeight > 0)
    ? `${previewWidth}x${previewHeight}`
    : (assetType.toLowerCase() === "hdri" ? "2x1" : "1x1");

  let dimensions = null;
  if (sender && isModelAssetType(assetType)) {
    const highPolySlot = resolvedModelSlots.find((s) => s.suffix.toLowerCase() === "highpoly") || resolvedModelSlots[0];
    if (highPolySlot && highPolySlot.source) {
      try {
        dimensions = await requestBoundsFromRenderer(sender, highPolySlot.source);
      } catch (err) {
        writeLog("WARN", "failed to calculate bounds", { message: err.message });
      }
    }
  }

  const now = new Date().toISOString();
  const normalizedTags = [...new Set([assetType, category, ...tags].map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  const meta = {
    pack: null,
    scanInformation: dimensions ? { dimensions } : undefined,
    semanticTags: {
      name: assetName,
      asset_type: assetType,
      contains: normalizedTags,
      theme: [category],
      descriptive: [],
      state: [],
      subject_matter: category,
      environment: []
    },
    name: assetName,
    assetID: uniqueId,
    slug: assetFolderName,
    assetType,
    category,
    tags: normalizedTags,
    previews: {
      images: previewFileUri
        ? [
          {
            contentLength: previewContentLength,
            resolution: "unknown",
            uri: previewFileUri,
            tags: ["preview"]
          }
        ]
        : [],
      relativeSize: computedRelativeSize
    },
    json: {
      contentLength: 0,
      uri: `${uniqueId}.json`
    },
    categories: [assetType, category.toLowerCase()],
    meta: [],
    components: [
      ...copiedModelEntries.map((item) => ({ type: "model", slot: item.suffix, uri: path.basename(item.path) })),
      ...copiedTextureFiles.map((item) => {
        const nextItem = { type: "texture", slot: item.textureType, areaIndex: item.areaIndex, uri: path.basename(item.path) };
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
        .filter((item) => item.areaIndex === 1)
        .map((item) => [item.textureType, normalizePath(item.path)])
    ),
    textureEntries: copiedTextureFiles.map((item) => ({
      textureType: item.textureType,
      areaIndex: item.areaIndex,
      uri: path.basename(item.path),
      ...(String(item.textureType || "").toLowerCase() === "normal"
        ? { normalMapFormat: areaNormalMapFormats[item.areaIndex] || normalizedNormalMapFormat }
        : {})
    })),
    normalMapFormat: normalizedNormalMapFormat,
    normalMapFormats: areaNormalMapFormats,
    createdAt: now
  };
  const colorTags = await inferColorTagsSafely(copiedTextureFiles.map((item) => item.path));
  applyColorTagsToMeta(meta, colorTags);
  if (previewFileUri) {
    meta.previewImage = previewFileUri;
    meta.detailImage = previewFileUri;
  }
  const jsonPath = path.join(destinationDir, `${uniqueId}.json`);
  await saveJson(jsonPath, meta);
  const jsonStats = await statOrNull(jsonPath);
  if (jsonStats?.isFile()) {
    meta.json.contentLength = jsonStats.size;
    await saveJson(jsonPath, meta);
  }
  const newAsset = {
    id: uniqueId,
    name: assetName,
    slug: assetFolderName,
    source: "custom",
    sourceRoot: settings.customLibraryPath,
    path: destinationDir,
    metaPath: jsonPath,
    assetType,
    tags: normalizedTags,
    themes: [category.toLowerCase()],
    categories: [assetType, category.toLowerCase()],
    preview: previewAbsolutePath,
    previewImage: previewAbsolutePath,
    detailImage: previewAbsolutePath,
    modelFiles: meta.modelFiles,
    textureFiles: meta.textureFiles,
    colorTags,
    meta
  };
  index.push(newAsset);

  // 抑制文件监控引发的二次扫描，给它10秒的时间窗口
  markInternalLibraryMutation(10000);

  scheduleIndexSnapshotSave("import_custom_asset");

  applyLibrarySqlCacheChanges({ upsertAssets: [newAsset], deleteIds: [] }).catch(err => {
    writeLog("ERROR", "applyLibrarySqlCacheChanges failed during importCustomAsset", { message: err.message });
  });

  if (sender && !sender.isDestroyed()) {
    sender.send("assets:change", { incremental: true, count: index.length });
  }

  return {
    ok: true,
    message: "自定义资产已导入",
    assetId: uniqueId,
    assetPath: destinationDir,
    metaPath: jsonPath
  };
}

async function updateCustomAsset(payload, sender) {
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
  const meta = await loadJson(metaPath, null);
  if (!meta || typeof meta !== "object") {
    return { ok: false, message: "资产元数据读取失败" };
  }
  const previousName = String(meta.name || target.name || "Custom Asset");
  const previousType = sanitizeToken(meta.assetType || meta?.semanticTags?.asset_type || target.assetType || "3d") || "3d";
  const previousCategory = String(meta.category || meta?.semanticTags?.subject_matter || "custom").trim() || "custom";
  const previousTags = Array.isArray(meta.tags) ? meta.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean) : [];

  const nextName = convertChineseToPinyin(String(payload?.assetName ?? previousName).trim()) || previousName;
  const nextAssetType = sanitizeToken(payload?.assetType ?? previousType) || previousType;
  const nextCategory = String(payload?.category ?? previousCategory).trim() || previousCategory;
  const inputTags = Array.isArray(payload?.tags)
    ? payload.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase()).filter(Boolean)
    : previousTags;
  const mergedTags = [...new Set([nextAssetType, nextCategory.toLowerCase(), ...inputTags])];
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
  const normalizeTextureSlot = (value) => normalizeTextureSlotName(value);
  const makeTextureToken = (textureType, areaIndex) => {
    const normalizedType = normalizeTextureSlot(textureType);
    if (!normalizedType) {
      return "";
    }
    const normalizedArea = Math.max(1, Number(areaIndex) || 1);
    if (normalizedArea <= 1) {
      return normalizedType;
    }
    return `${String(normalizedArea).padStart(3, "0")}_${normalizedType}`;
  };

  let assetDir = path.resolve(target.path);
  const nextTypeDir = path.join(settings.customLibraryPath, getCustomAssetTypeFolder(nextAssetType));
  await fs.mkdir(nextTypeDir, { recursive: true });
  const previousNameToken = sanitizeToken(previousName);
  const nextNameToken = sanitizeToken(nextName);
  const keepOriginalFolderName = true; // DO NOT rename the folder to avoid EPERM on locked preview images
  const nextFolderName = keepOriginalFolderName
    ? path.basename(assetDir)
    : `${nextAssetType}_${sanitizeToken(nextName) || "asset"}_${assetId}`;
  const movedAssetDir = path.join(nextTypeDir, nextFolderName);
  if (path.resolve(assetDir).toLowerCase() !== path.resolve(movedAssetDir).toLowerCase()) {
    emitCustomSaveProgress(sender, assetId, 8, "rename-folder");
    assetDir = await renamePathSafely(assetDir, movedAssetDir);
  }
  const normalizeFileIdentity = (filePath) => path.resolve(String(filePath || "")).toLowerCase();
  const toAssetFilePath = (rawPath) => path.join(assetDir, path.basename(String(rawPath || "").trim()));
  const previousModelFiles = new Set();
  const previousTextureFiles = new Set();
  if (meta.modelSlots && typeof meta.modelSlots === "object" && !Array.isArray(meta.modelSlots)) {
    for (const filePath of Object.values(meta.modelSlots)) {
      const resolvedPath = toAssetFilePath(filePath);
      if (path.basename(resolvedPath)) {
        previousModelFiles.add(resolvedPath);
      }
    }
  }
  for (const filePath of Array.isArray(meta.modelFiles) ? meta.modelFiles : target.modelFiles || []) {
    const resolvedPath = toAssetFilePath(filePath);
    if (path.basename(resolvedPath)) {
      previousModelFiles.add(resolvedPath);
    }
  }
  if (Array.isArray(meta.components)) {
    for (const component of meta.components) {
      if (!component || component.type !== "model") {
        continue;
      }
      const resolvedPath = toAssetFilePath(component.uri || component.path);
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
      const resolvedPath = path.join(assetDir, path.basename(normalizedPath));
      const modelStat = await statOrNull(resolvedPath);
      if (!modelStat?.isFile()) {
        continue;
      }
      modelSlotMap.set(normalizedSlot, resolvedPath);
    }
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
  for (const filePath of Array.isArray(meta.modelFiles) ? meta.modelFiles : target.modelFiles || []) {
    const resolvedPath = path.join(assetDir, path.basename(String(filePath || "")));
    const resolvedKey = path.resolve(resolvedPath).toLowerCase();
    if (!resolvedKey || existingModelPathSet.has(resolvedKey)) {
      continue;
    }
    const modelStat = await statOrNull(resolvedPath);
    if (!modelStat?.isFile()) {
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
  if (isMeshAssetType && modelSlotMap.size === 0) {
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
      const textureToken = makeTextureToken(textureEntry.textureType, textureEntry.areaIndex);
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
      const normalizedToken = makeTextureToken(normalizedSlot, component.areaIndex);
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
      const normalizedToken = parsedSlot ? parsedSlot.token : "";
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
    const token = makeTextureToken(slot, areaIndex);
    if (token && !textureSlotMap.has(token)) {
      textureSlotMap.set(token, path.join(assetDir, path.basename(String(filePath || ""))));
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
    const resolved = path.resolve(source);
    // 如果传入的就是资产目录内的文件，说明只是名称重命名带来的更新，不需要再 copyRenamedFile，后续 normalizeModelFileNamesForAsset 会处理
    if (resolved.toLowerCase().startsWith(assetDir.toLowerCase())) {
      continue;
    }
    const stats = await statOrNull(resolved);
    if (!stats?.isFile()) {
      return { ok: false, message: `模型路径无效：${normalizedSlot}` };
    }
    const ext = path.extname(resolved).toLowerCase();
    if (!MODEL_EXTENSIONS.has(ext)) {
      return { ok: false, message: `模型格式无效：${normalizedSlot}` };
    }
    emitCustomSaveProgress(sender, assetId, 35, `model-${normalizedSlot}`);
    const copied = await copyRenamedFile(resolved, assetDir, `${makeCustomModelBaseName(normalizedSlot, nextName, assetId)}_${sanitizeToken(normalizedSlot) || "mesh"}`);
    if (!copied) {
      return { ok: false, message: `模型复制失败：${normalizedSlot}` };
    }
    modelSlotMap.set(normalizedSlot, copied);
  }

  const removeModelSlots = Array.isArray(payload?.removeModelSlots) ? payload.removeModelSlots : [];
  for (const slotKey of removeModelSlots) {
    const normalizedSlot = normalizeModelSlot(slotKey);
    const filePath = modelSlotMap.get(normalizedSlot);
    if (filePath) {
      await fs.rm(filePath, { force: true });
      modelSlotMap.delete(normalizedSlot);
    }
  }

  const inputTextureSlots = payload?.textureSlots && typeof payload.textureSlots === "object" ? payload.textureSlots : {};
  for (const [slotKey, sourcePath] of Object.entries(inputTextureSlots)) {
    const parsedSlot = parseTextureSlotToken(slotKey);
    const normalizedSlot = parsedSlot?.token || "";
    const source = String(sourcePath || "").trim();
    if (!normalizedSlot || !source) {
      continue;
    }
    const resolved = path.resolve(source);
    // 如果传入的就是资产目录内的文件，说明只是名称重命名带来的更新，不需要再 copyRenamedFile，后续 normalizeTextureFileNamesForAsset 会处理
    if (resolved.toLowerCase().startsWith(assetDir.toLowerCase())) {
      continue;
    }
    const stats = await statOrNull(resolved);
    if (!stats?.isFile()) {
      return { ok: false, message: `贴图路径无效：${normalizedSlot}` };
    }
    emitCustomSaveProgress(sender, assetId, 55, `texture-${normalizedSlot}`);
    const copied = await copyRenamedFile(resolved, assetDir, makeCustomTextureBaseName(normalizedSlot, nextName, assetId));
    if (!copied) {
      return { ok: false, message: `贴图复制失败：${normalizedSlot}` };
    }
    textureSlotMap.set(normalizedSlot, copied);
  }

  const removeTextureSlots = Array.isArray(payload?.removeTextureSlots) ? payload.removeTextureSlots : [];
  for (const slotKey of removeTextureSlots) {
    const parsedSlot = parseTextureSlotToken(slotKey);
    const normalizedSlot = parsedSlot?.token || "";
    const filePath = textureSlotMap.get(normalizedSlot);
    if (filePath) {
      await fs.rm(filePath, { force: true });
      textureSlotMap.delete(normalizedSlot);
    }
  }

  // SKIP renaming files to avoid slow copy fallbacks on EPERM
  // await normalizeModelFileNamesForAsset(modelSlotMap, assetDir, nextName, assetId);
  // await normalizeTextureFileNamesForAsset(textureSlotMap, assetDir, nextName, assetId);

  const previewImagePath = String(payload?.previewImagePath || "").trim();
  const previewDir = path.join(assetDir, "Preview");
  if (payload?.clearPreview) {
    await clearPreviewDir(previewDir);
    meta.previews = typeof meta.previews === "object" && meta.previews ? meta.previews : {};
    meta.previews.images = [];
    delete meta.previewImage;
    delete meta.detailImage;
  } else if (previewImagePath) {
    emitCustomSaveProgress(sender, assetId, 72, "preview");
    await fs.mkdir(previewDir, { recursive: true });
    await clearPreviewDir(previewDir);
    const previewDest = await compressPreviewImage(previewImagePath, previewDir, `${assetId}_preview`);
    if (!previewDest) {
      return { ok: false, message: "预览图路径无效" };
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
    if (!meta.previews.relativeSize) {
      meta.previews.relativeSize = await computeRelativeSizeFromPreview(previewDest, nextAssetType);
    }
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
  const textureEntries = [...textureSlotMap.entries()];
  const existingNormalMapFormats = meta?.normalMapFormats && typeof meta.normalMapFormats === "object" ? meta.normalMapFormats : {};
  const areaNormalMapFormats = buildAreaNormalMapFormats(
    textureEntries.map(([slot]) => {
      const parsedSlot = parseTextureSlotToken(slot);
      return { areaIndex: parsedSlot?.areaIndex || 1 };
    }),
    { ...existingNormalMapFormats, ...payloadNormalMapFormats },
    normalizedNormalMapFormat
  );
  const activeModelFiles = new Set(modelEntries.map(([, filePath]) => normalizeFileIdentity(filePath)).filter(Boolean));
  const activeTextureFiles = new Set(textureEntries.map(([, filePath]) => normalizeFileIdentity(filePath)).filter(Boolean));
  for (const filePath of previousModelFiles) {
    if (!activeModelFiles.has(normalizeFileIdentity(filePath))) {
      await fs.rm(filePath, { force: true });
    }
  }
  for (const filePath of previousTextureFiles) {
    if (!activeTextureFiles.has(normalizeFileIdentity(filePath))) {
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
  meta.assetType = nextAssetType;
  meta.asset_type = nextAssetType;
  meta.slug = path.basename(assetDir);
  meta.category = nextCategory;
  meta.tags = mergedTags;
  meta.normalMapFormat = normalizedNormalMapFormat;
  meta.normalMapFormats = areaNormalMapFormats;
  meta.categories = [nextAssetType, nextCategory.toLowerCase()];
  meta.semanticTags = typeof meta.semanticTags === "object" && meta.semanticTags ? meta.semanticTags : {};
  meta.semanticTags.name = nextName;
  meta.semanticTags.asset_type = nextAssetType;
  meta.semanticTags.contains = mergedTags;
  meta.semanticTags.theme = [nextCategory];
  meta.semanticTags.subject_matter = nextCategory;

  // Ensure we update the asset name in asset_info.json as well if it exists
  await updateAssetMetadata(assetDir, { name: nextName, tags: mergedTags, categories: meta.categories });

  if (!meta.createdAt) {
    meta.createdAt = new Date().toISOString();
  }
  meta.components = [
    ...baseComponents,
    ...modelEntries.map(([slot, filePath]) => ({ type: "model", slot, uri: path.basename(filePath) })),
    ...textureEntries.map(([slot, filePath]) => {
      const parsedSlot = parseTextureSlotToken(slot);
      const nextItem = {
        type: "texture",
        slot: parsedSlot?.textureType || slot,
        areaIndex: parsedSlot?.areaIndex || 1,
        uri: path.basename(filePath)
      };
      if (String(parsedSlot?.textureType || slot).toLowerCase() === "normal") {
        nextItem.normalMapFormat = areaNormalMapFormats[parsedSlot?.areaIndex || 1] || normalizedNormalMapFormat;
      }
      return nextItem;
    })
  ];
  meta.modelFiles = modelEntries.map(([, filePath]) => normalizePath(filePath));
  meta.modelSlots = Object.fromEntries(modelEntries.map(([slot, filePath]) => [slot, normalizePath(filePath)]));
  meta.textureFiles = textureEntries.map(([, filePath]) => normalizePath(filePath));
  meta.textureSlots = Object.fromEntries(
    textureEntries
      .map(([slot, filePath]) => {
        const parsedSlot = parseTextureSlotToken(slot);
        if (!parsedSlot || parsedSlot.areaIndex > 1) {
          return null;
        }
        return [parsedSlot.textureType, normalizePath(filePath)];
      })
      .filter(Boolean)
  );
  meta.textureEntries = textureEntries.map(([slot, filePath]) => {
    const parsedSlot = parseTextureSlotToken(slot);
    const nextItem = {
      textureType: parsedSlot?.textureType || slot,
      areaIndex: parsedSlot?.areaIndex || 1,
      uri: path.basename(filePath)
    };
    if (String(parsedSlot?.textureType || slot).toLowerCase() === "normal") {
      nextItem.normalMapFormat = areaNormalMapFormats[parsedSlot?.areaIndex || 1] || normalizedNormalMapFormat;
    }
    return nextItem;
  });

  const hasTextureChanges = Object.keys(inputTextureSlots).length > 0 || removeTextureSlots.length > 0 || Array.isArray(payload?.textureEntries);
  const updatedColorTags = hasTextureChanges ? await inferColorTagsSafely(textureEntries.map(([, filePath]) => filePath)) : (meta.colorTags || target.colorTags || collectColorTagsFromMeta(meta) || []);
  applyColorTagsToMeta(meta, updatedColorTags);

  const nextMetaPath = path.join(assetDir, path.basename(metaPath || `${assetId}.json`));
  await saveJson(nextMetaPath, meta);
  const jsonStats = await statOrNull(nextMetaPath);
  if (jsonStats?.isFile()) {
    meta.json = typeof meta.json === "object" && meta.json ? meta.json : {};
    meta.json.contentLength = jsonStats.size;
    meta.json.uri = path.basename(nextMetaPath);
    await saveJson(nextMetaPath, meta);
  }

  const previewRel = (meta?.previews?.images?.[0]?.uri || meta.previewImage || meta.detailImage || "").trim();
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
    assetType: nextAssetType,
    tags: mergedTags,
    themes: [nextCategory.toLowerCase()],
    categories: [nextAssetType, nextCategory.toLowerCase()],
    preview: previewUri ? normalizePath(previewUri) : "",
    previewImage: previewUri ? normalizePath(previewUri) : "",
    detailImage: previewUri ? normalizePath(previewUri) : "",
    modelFiles: meta.modelFiles,
    textureFiles: meta.textureFiles,
    colorTags: collectColorTagsFromMeta(meta),
    meta
  };
  const assetIndex = index.findIndex((asset) => asset.id === assetId && asset.source === "custom");
  if (assetIndex >= 0) {
    index[assetIndex] = updatedAsset;
  } else {
    index.push(updatedAsset);
  }

  // 抑制文件监控引发的二次扫描，给它10秒的时间窗口
  markInternalLibraryMutation(10000);

  scheduleIndexSnapshotSave("update_custom_asset");

  const refreshedAsset = updatedAsset;

  // 更新数据库缓存并发送增量更新给前端
  applyLibrarySqlCacheChanges({ upsertAssets: [updatedAsset], deleteIds: [] }).catch(err => {
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
    asset: refreshedAsset
  };
}

async function deleteCustomAsset(payload) {
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
    return { ok: false, message: "未配置 Custom Library 路径" };
  }
  const resolvedRoot = path.resolve(customRoot);
  const resolvedTarget = path.resolve(target.path || "");
  const normalizedRoot = resolvedRoot.toLowerCase();
  const normalizedTarget = resolvedTarget.toLowerCase();
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep.toLowerCase()}`)) {
    return { ok: false, message: "删除路径不在自定义库目录中" };
  }
  const targetStat = await statOrNull(resolvedTarget);
  if (!targetStat?.isDirectory()) {
    return { ok: false, message: "资产目录不存在或无效" };
  }
  markInternalLibraryMutation(25000);
  await fs.rm(resolvedTarget, { recursive: true, force: true });
  index = index.filter((asset) => !(asset.id === assetId && asset.source === "custom"));

  // 抑制文件监控引发的二次扫描，给它10秒的时间窗口
  markInternalLibraryMutation(10000);

  scheduleIndexSnapshotSave("delete_custom_asset");

  applyLibrarySqlCacheChanges({ upsertAssets: [], deleteIds: [assetId] }).catch(err => {
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

async function rewriteCustomJsonFiles() {
  markInternalLibraryMutation(60000);
  const customAssets = index.filter((asset) => asset.source === "custom");
  let updatedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  for (const asset of customAssets) {
    try {
      const metaPath = String(asset.metaPath || "").trim();
      if (!metaPath) {
        skippedCount += 1;
        continue;
      }
      const loadedMeta = await loadJson(metaPath, null);
      if (!loadedMeta || typeof loadedMeta !== "object") {
        skippedCount += 1;
        continue;
      }
      const meta = loadedMeta;
      const assetDir = path.resolve(asset.path || path.dirname(metaPath));
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
      const isMeshAssetType = isModelAssetType(String(meta.assetType || asset.assetType || "").trim().toLowerCase());
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
      if (modelSlotMap.size === 0) {
        const diskModelFiles = await collectFilesByExtensions(assetDir, MODEL_EXTENSIONS);
        for (const filePath of diskModelFiles) {
          tryAddModel("", filePath);
        }
      }

      const textureSlotMap = new Map();
      const textureNormalMapFormatsByArea = {};
      const fallbackNormalFormat = normalizeNormalMapFormatValue(meta?.normalMapFormat, "dx");
      const persistedNormalFormats = meta?.normalMapFormats && typeof meta.normalMapFormats === "object" ? meta.normalMapFormats : {};
      const tryAddTexture = (slotCandidate, filePath, areaCandidate = 1, normalMapFormatCandidate = "") => {
        const normalizedPath = normalizeAssetFilePath(filePath);
        if (!normalizedPath) {
          return;
        }
        const normalizedSlot = normalizeTextureSlotName(slotCandidate) || normalizeTextureSlotName(inferTextureSlotFromFileName(normalizedPath));
        if (!normalizedSlot) {
          return;
        }
        const areaIndex = Math.max(1, Number(areaCandidate) || 1);
        const token = areaIndex > 1 ? `${String(areaIndex).padStart(3, "0")}_${normalizedSlot}` : normalizedSlot;
        if (!textureSlotMap.has(token)) {
          textureSlotMap.set(token, normalizedPath);
        }
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
        tryAddTexture(slotCandidate, uriCandidate, item.areaIndex, item.normalMapFormat);
      }
      if (Array.isArray(meta.textureEntries)) {
        for (const item of meta.textureEntries) {
          if (!item || typeof item !== "object") {
            continue;
          }
          const slotCandidate = String(item.slot || item.textureType || "").trim();
          const uriCandidate = String(item.uri || item.path || "").trim();
          tryAddTexture(slotCandidate, uriCandidate, item.areaIndex, item.normalMapFormat);
        }
      }
      const fallbackTextureFiles = Array.isArray(meta.textureFiles) ? meta.textureFiles : [];
      for (const filePath of fallbackTextureFiles) {
        tryAddTexture("", filePath, 1, "");
      }

      const modelEntries = [...modelSlotMap.entries()];
      const textureEntries = [...textureSlotMap.entries()];
      const baseComponents = Array.isArray(meta.components)
        ? meta.components.filter((item) => item && item.type !== "model" && item.type !== "texture")
        : [];

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
      const areaNormalMapFormats = buildAreaNormalMapFormats(
        textureEntries.map(([slot]) => {
          const parsedSlot = parseTextureSlotToken(slot);
          return { areaIndex: parsedSlot?.areaIndex || 1 };
        }),
        { ...persistedNormalFormats, ...textureNormalMapFormatsByArea },
        fallbackNormalFormat
      );
      meta.components = [
        ...baseComponents,
        ...modelEntries.map(([slot, filePath]) => ({ type: "model", slot, uri: path.basename(filePath) })),
        ...textureEntries.map(([slot, filePath]) => {
          const parsedSlot = parseTextureSlotToken(slot);
          const areaIndex = parsedSlot?.areaIndex || 1;
          const textureType = parsedSlot?.textureType || slot;
          const nextItem = { type: "texture", slot: textureType, areaIndex, uri: path.basename(filePath) };
          if (String(textureType || "").toLowerCase() === "normal") {
            nextItem.normalMapFormat = areaNormalMapFormats[areaIndex] || fallbackNormalFormat;
          }
          return nextItem;
        })
      ];
      meta.modelFiles = modelEntries.map(([, filePath]) => filePath);
      meta.modelSlots = Object.fromEntries(modelEntries.map(([slot, filePath]) => [slot, filePath]));
      meta.textureFiles = textureEntries.map(([, filePath]) => filePath);
      meta.textureSlots = Object.fromEntries(
        textureEntries
          .map(([slot, filePath]) => {
            const parsedSlot = parseTextureSlotToken(slot);
            if (!parsedSlot || parsedSlot.areaIndex > 1) {
              return null;
            }
            return [parsedSlot.textureType, filePath];
          })
          .filter(Boolean)
      );
      meta.textureEntries = textureEntries.map(([slot, filePath]) => {
        const parsedSlot = parseTextureSlotToken(slot);
        const areaIndex = parsedSlot?.areaIndex || 1;
        const textureType = parsedSlot?.textureType || slot;
        const nextItem = { textureType, areaIndex, uri: path.basename(filePath) };
        if (String(textureType || "").toLowerCase() === "normal") {
          nextItem.normalMapFormat = areaNormalMapFormats[areaIndex] || fallbackNormalFormat;
        }
        return nextItem;
      });
      meta.normalMapFormat = areaNormalMapFormats[1] || fallbackNormalFormat;
      meta.normalMapFormats = areaNormalMapFormats;

      await saveJson(metaPath, meta);
      const jsonStats = await statOrNull(metaPath);
      if (jsonStats?.isFile()) {
        meta.json = typeof meta.json === "object" && meta.json ? meta.json : {};
        meta.json.contentLength = jsonStats.size;
        meta.json.uri = path.basename(metaPath);
        await saveJson(metaPath, meta);
      }
      updatedCount += 1;
    } catch (error) {
      failedCount += 1;
      writeLog("WARN", "rewrite custom json failed", { id: asset.id, message: error?.message });
    }
  }

  index = await scanLibraryInWorker(settings.megascanLibraryPath, settings.customLibraryPath, { forceFullScan: true });
  await saveIndexSnapshot(index);
  return {
    ok: true,
    updatedCount,
    skippedCount,
    failedCount
  };
}

async function reconcileCustomAssetFolders() {
  const customRootRaw = String(settings.customLibraryPath || "").trim();
  if (!customRootRaw) {
    return { ok: false, message: "未配置 Custom Library 路径", renamedCount: 0, skippedCount: 0, failedCount: 0 };
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

  index = await scanLibraryInWorker(settings.megascanLibraryPath, settings.customLibraryPath, { forceFullScan: true });
  await saveIndexSnapshot(index);
  return {
    ok: failedCount === 0,
    message: `目录对齐完成：重命名 ${renamedCount}，跳过 ${skippedCount}，失败 ${failedCount}`,
    renamedCount,
    skippedCount,
    failedCount
  };
}

async function loadState() {
  const settingsPath = getSettingsFilePath();
  const currentStat = await statOrNull(settingsPath);
  const loadedCurrent = await loadJson(settingsPath, null);
  const hasCurrent = Boolean(currentStat?.isFile() && Number(currentStat.size) > 0 && loadedCurrent && typeof loadedCurrent === "object");
  if (hasCurrent) {
    settings = { ...settings, ...loadedCurrent };
  } else {
    const legacy = await loadLegacySettings();
    if (legacy) {
      settings = { ...settings, ...legacy.settings };
      await saveJson(settingsPath, settings).catch(() => { });
    }
  }
  startupScanRequired = false;

  // Ensure new fields exist
  if (typeof settings.megascanLibraryPath !== "string") settings.megascanLibraryPath = "";
  if (typeof settings.customLibraryPath !== "string") settings.customLibraryPath = "";
  if (typeof settings.unrealEditorPath !== "string") settings.unrealEditorPath = "";
  if (typeof settings.unrealProjectPath !== "string") settings.unrealProjectPath = "";
  if (typeof settings.unrealLogPath !== "string") settings.unrealLogPath = "";
  const configuredPluginRepo = typeof settings.pluginRepo === "string" ? settings.pluginRepo.trim() : "";
  if (!configuredPluginRepo || /AssetHive[-_]UE-Plugin/i.test(configuredPluginRepo)) {
    settings.pluginRepo = "blackbladestudio/AssetHive";
  }
  settings.uiLanguage = settings.uiLanguage === "en" ? "en" : "zh";

  const legacyRoots = getLegacyUserDataRoots();
  const legacySqlCandidates = legacyRoots.map((root) => path.join(root, LIBRARY_SQLITE_CACHE_FILE_NAME));
  index = await loadLibrarySqlCache({ extraCandidates: legacySqlCandidates });
  if (index.length === 0) {
    const legacyJsonCandidates = legacyRoots.map((root) => path.join(root, LIBRARY_JSON_CACHE_FILE_NAME));
    index = await loadLibraryJsonCache(legacyJsonCandidates);
  }
  if (index.length === 0 && (settings.megascanLibraryPath || settings.customLibraryPath)) {
    startupScanRequired = true;
    return;
  }
  const hasCustomPath = Boolean(String(settings.customLibraryPath || "").trim());
  if (hasCustomPath && !hasCustomAssetsInIndex(index, settings.customLibraryPath)) {
    try {
      const customRoot = path.resolve(String(settings.customLibraryPath || ""));
      const stat = await statOrNull(customRoot);
      let hasEntries = false;
      if (stat?.isDirectory()) {
        const entries = await fs.readdir(customRoot, { withFileTypes: true }).catch(() => []);
        hasEntries = Array.isArray(entries) && entries.some((e) => e.isFile() || e.isDirectory());
      }
      if (hasEntries) {
        writeLog("INFO", "startup cache missing custom assets, rescanning cache", {
          customLibraryPath: settings.customLibraryPath
        });
        startupScanRequired = true;
      }
    } catch {
      void 0;
    }
  }
}

async function performScan(window, options = {}) {
  const reason = String(options?.reason || "manual");
  const force = Boolean(options?.force);
  if (scanInProgress) {
    if (reason.startsWith("watch")) {
      pendingWatcherScan = true;
    }
    writeLog("INFO", "scan skipped: already in progress", { reason });
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
  const emitIntervalMs = 1400;
  let lastIncrementalEmitAt = 0;
  const reportScanProgress = (payload = {}) => {
    if (!window || window.isDestroyed()) {
      return;
    }
    const progress = Math.max(0, Math.min(100, Number(payload?.progress) || 0));
    const source = String(payload?.source || "all");
    const phase = String(payload?.phase || "scan");
    const processed = Math.max(0, Number(payload?.processed) || 0);
    const total = Math.max(0, Number(payload?.total) || 0);
    const message = String(payload?.message || "");
    window.webContents.send("assets:scanProgress", { active: true, progress, source, phase, processed, total, message });
  };
  scanInProgress = true;
  try {
    writeLog("INFO", "performing library scan", { reason });
    const favoriteIds = await loadFavoriteIds();
    const favoriteMetaTokens = await loadFavoriteMetaTokens();
    const cleanedCount = await cleanupFailedSaveArtifacts(settings.customLibraryPath);
    if (cleanedCount > 0) {
      writeLog("INFO", "cleanup failed-save artifacts", { count: cleanedCount });
    }
    reportScanProgress({ progress: 1, source: "all", phase: "start" });
    const incrementalMap = new Map();
    const emitIncrementalAssets = (force = false) => {
      if (!window || window.isDestroyed()) {
        return;
      }
      const now = Date.now();
      if (!force && now - lastIncrementalEmitAt < emitIntervalMs) {
        return;
      }
      index = [...incrementalMap.values()];
      window.webContents.send("assets:change", { incremental: true, count: index.length });
      lastIncrementalEmitAt = now;
    };
    index = await scanLibraryInWorker(settings.megascanLibraryPath, settings.customLibraryPath, {
      forceFullScan: true,
      onProgress: reportScanProgress,
      onRecord: (record) => {
        if (!record || !record.id) {
          return;
        }
        if (favoriteIds.has(record.id) || favoriteMetaTokens.has(normalizeComparePath(String(record.metaPath || "").trim()))) {
          record.favorite = true;
        }
        incrementalMap.set(record.id, record);
        if (incrementalMap.size <= 8 || incrementalMap.size % 200 === 0) {
          emitIncrementalAssets(false);
        }
      }
    });
    emitIncrementalAssets(true);
    applyFavoriteIds(index, favoriteIds, favoriteMetaTokens);
    reportScanProgress({ progress: 96, source: "all", phase: "save", processed: index.length, total: index.length });
    await saveIndexSnapshot(index, {
      onProgress: (fraction) => {
        const safeFraction = Math.max(0, Math.min(1, Number(fraction) || 0));
        reportScanProgress({ progress: 96 + safeFraction * 3, source: "all", phase: "save", processed: index.length, total: index.length });
      }
    });
    reportScanProgress({ progress: 99, source: "all", phase: "finalize", processed: index.length, total: index.length });
    if (window && !window.isDestroyed()) {
      window.webContents.send("assets:scanProgress", { active: false, progress: 100, source: "all", phase: "done", processed: index.length, total: index.length });
      window.webContents.send("assets:change");
    }
    startupScanRequired = false;
    writeLog("INFO", "scan complete", { count: index.length, durationMs: Date.now() - startedAt });
  } catch (error) {
    writeLog("ERROR", "scan failed", { message: error?.message });
    if (window && !window.isDestroyed()) {
      window.webContents.send("assets:scanProgress", { active: false, progress: 0, source: "all", phase: "failed" });
    }
  } finally {
    scanInProgress = false;
    if (pendingWatcherScan) {
      pendingWatcherScan = false;
      void performScan(window, { reason: "watch-followup", force: true });
    }
  }
  return index;
}

async function clearAssetCaches() {
  const cacheFiles = new Set([
    getDataFilePath(LIBRARY_JSON_CACHE_FILE_NAME),
    getLibrarySqlCachePath(),
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
  index = [];
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
  if (!assetDir) {
    return target;
  }
  const fullDetails = await getAssetDetails(assetDir, target.source);
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
  index[assetIndex] = refreshed;
  return refreshed;
}

function collectJsonDeepStrings(value, collector, depth = 0) {
  if (depth > 10) {
    return;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      collector.push(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectJsonDeepStrings(entry, collector, depth + 1);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      collectJsonDeepStrings(entry, collector, depth + 1);
    }
  }
}

function normalizeMegascanAssetDirFromToken(rawToken, megascanRoot) {
  const token = String(rawToken || "").trim();
  if (!token) {
    return "";
  }
  const normalizedRoot = String(megascanRoot || "").trim();
  if (!normalizedRoot) {
    return "";
  }
  const root = path.resolve(normalizedRoot);
  const downloadedRoot = path.join(root, "Downloaded");
  const cleaned = token.replace(/\//g, path.sep);
  const withoutQuotes = cleaned.replace(/^"|"$/g, "");
  const maybePath = withoutQuotes.toLowerCase().endsWith(".json") ? path.dirname(withoutQuotes) : withoutQuotes;
  const resolved = path.isAbsolute(maybePath)
    ? path.resolve(maybePath)
    : path.resolve(
      maybePath.toLowerCase().startsWith(`downloaded${path.sep.toLowerCase()}`)
        ? path.join(root, maybePath)
        : path.join(downloadedRoot, maybePath)
    );
  if (!isUnderRoot(downloadedRoot, resolved)) {
    return "";
  }
  const base = path.basename(resolved).trim();
  if (!base || base.toLowerCase() === "downloaded") {
    return "";
  }
  return resolved;
}

async function syncMegascanFromAssetsData(window, megascanRoot, megascanSignalFile) {
  const root = String(megascanRoot || "").trim();
  const signalPath = String(megascanSignalFile || "").trim();
  if (!root || !signalPath) {
    return;
  }
  if (scanInProgress) {
    return;
  }
  if (!window || window.isDestroyed()) {
    return;
  }

  const report = (payload) => {
    if (!window || window.isDestroyed()) {
      return;
    }
    const progress = Math.max(0, Math.min(100, Number(payload?.progress) || 0));
    window.webContents.send("assets:scanProgress", { active: true, progress, source: "quixel", phase: String(payload?.phase || "sync"), processed: Number(payload?.processed) || 0, total: Number(payload?.total) || 0 });
  };

  try {
    const favoriteMetaTokens = await loadFavoriteMetaTokens();
    report({ progress: 1, phase: "sync" });
    const raw = await fs.readFile(signalPath, "utf-8");
    const parsed = JSON.parse(raw);
    const strings = [];
    collectJsonDeepStrings(parsed, strings);
    const dirCandidates = new Set();
    for (const entry of strings) {
      const resolved = normalizeMegascanAssetDirFromToken(entry, root);
      if (resolved) {
        dirCandidates.add(resolved);
      }
    }
    const dirs = [...dirCandidates];
    if (dirs.length === 0) {
      report({ progress: 100, phase: "sync", processed: 0, total: 0 });
      window.webContents.send("assets:scanProgress", { active: false, progress: 100, source: "quixel", phase: "done", processed: 0, total: 0 });
      return;
    }

    const existing = new Set(
      index
        .filter((asset) => String(asset?.source || "").trim().toLowerCase() === "quixel")
        .map((asset) => normalizeComparePath(asset?.path || ""))
        .filter(Boolean)
    );

    const upserts = [];
    let processed = 0;
    for (const assetDir of dirs) {
      processed += 1;
      if (processed % 6 === 0) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      }
      const token = normalizeComparePath(assetDir);
      if (!token || existing.has(token)) {
        if (processed % 40 === 0) {
          report({ progress: 5 + (processed / dirs.length) * 90, phase: "sync", processed, total: dirs.length });
        }
        continue;
      }
      const stats = await statOrNull(assetDir);
      if (!stats?.isDirectory()) {
        continue;
      }
      const record = await getAssetDetails(assetDir, "quixel");
      if (!record || !record.id) {
        continue;
      }
      const recordMetaToken = normalizeComparePath(String(record.metaPath || "").trim());
      if (recordMetaToken && favoriteMetaTokens.has(recordMetaToken)) {
        record.favorite = true;
      }
      const existingIdIndex = index.findIndex((asset) => String(asset?.id || "").trim() === String(record.id || "").trim());
      if (existingIdIndex >= 0) {
        const existingAsset = index[existingIdIndex];
        const merged = { ...existingAsset, ...record, favorite: existingAsset.favorite };
        index[existingIdIndex] = merged;
        upserts.push(merged);
      } else {
        const existingByPath = index.find((asset) => normalizeComparePath(asset?.path || "") === token);
        if (existingByPath?.favorite) {
          record.favorite = true;
        }
        index.push(record);
        upserts.push(record);
      }
      existing.add(token);
      if (processed % 12 === 0 || processed === dirs.length) {
        report({ progress: 5 + (processed / dirs.length) * 90, phase: "sync", processed, total: dirs.length });
      }
    }

    report({ progress: 96, phase: "save", processed: index.length, total: index.length });
    await applyLibrarySqlCacheChanges({ upsertAssets: upserts, deleteIds: [] });
    report({ progress: 100, phase: "done", processed: index.length, total: index.length });
    window.webContents.send("assets:change", { incremental: true, count: index.length });
    window.webContents.send("assets:scanProgress", { active: false, progress: 100, source: "quixel", phase: "done", processed: index.length, total: index.length });
  } catch (error) {
    writeLog("WARN", "megascan assetsData sync failed", { message: error?.message || String(error) });
    if (window && !window.isDestroyed()) {
      window.webContents.send("assets:scanProgress", { active: false, progress: 0, source: "quixel", phase: "failed" });
    }
    if (Date.now() - lastWatcherScanAt >= WATCH_SCAN_COOLDOWN_MS) {
      void performScan(window, { reason: "watch-megascan-signal-fallback", force: false });
    }
  }
}

function startWatching(window) {
  const megascanRoot = String(settings.megascanLibraryPath || "").trim();
  const customRoot = String(settings.customLibraryPath || "").trim();
  const megascanSignalFile = megascanRoot ? path.join(megascanRoot, "Downloaded", "assetsData.json") : "";
  const watchTargets = [megascanSignalFile, megascanRoot, customRoot]
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
      const hasMegascanSignalChange = normalizedChanges.some((item) => path.basename(item.path).toLowerCase() === "assetsdata.json");
      if (hasMegascanSignalChange) {
        void syncMegascanFromAssetsData(window, megascanRoot, megascanSignalFile);
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
            isUnderRoot(settings.megascanLibraryPath, resolvedMetaPath) ? "quixel"
              : isUnderRoot(settings.customLibraryPath, resolvedMetaPath) ? "custom"
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
            const merged = { ...existing, ...record, favorite: existing.favorite };
            index[existingIndex] = merged;
            upserts.push(merged);
          } else {
            record.favorite = existingFavorite;
            index.push(record);
            upserts.push(record);
          }
          changed = true;
          continue;
        }

        const isImage = ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".bmp";
        if (isImage) {
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
        await applyLibrarySqlCacheChanges({ upsertAssets: upserts, deleteIds: deletes });
        window.webContents.send("assets:change", { incremental: true, count: index.length });
      }
    }, { explicitWatchFiles: megascanSignalFile ? [megascanSignalFile] : [], debounceMs: 1400, megascanRoot, depth: 6 });
  }
}

function shouldAutoScanOnStartup() {
  if (!ENABLE_STARTUP_AUTO_SCAN) {
    return false;
  }
  const hasLibraryPath = Boolean(String(settings.megascanLibraryPath || "").trim() || String(settings.customLibraryPath || "").trim());
  if (!hasLibraryPath) {
    return false;
  }
  if (Array.isArray(index) && index.length > 0) {
    return false;
  }
  if (startupScanRequired) {
    return true;
  }
  return false;
}

function createWindow() {
  const appIconPath = app.isPackaged
    ? path.join(process.resourcesPath, "LOGO", "Icon_V2_256.png")
    : path.resolve(__dirname, "..", "LOGO", "Icon_V2_256.png");
  const windowOptions = {
    width: 1280,
    height: 800,
    title: "AssetHive",
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
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

  const devServerUrl = process.env.VITE_DEV_SERVER_URL || (!app.isPackaged ? "http://localhost:5173" : "");
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
  };

  const fallbackShowTimer = globalThis.setTimeout(() => {
    writeLog("WARN", "ready-to-show timeout, force show");
    showWindow();
  }, 3000);

  win.once("ready-to-show", () => {
    globalThis.clearTimeout(fallbackShowTimer);
    writeLog("INFO", "window ready-to-show");
    showWindow();
    startWatching(win);
    if (shouldAutoScanOnStartup()) {
      writeLog("INFO", "startup auto scan scheduled");
      globalThis.setTimeout(() => {
        if (!win.isDestroyed()) {
          void performScan(win, { reason: "startup", force: true });
        }
      }, 1200);
    }
  });

  win.webContents.on("did-finish-load", () => {
    writeLog("INFO", "did-finish-load");
    showWindow();
  });

  win.webContents.on("did-fail-load", async (_, errorCode, errorDescription, validatedURL) => {
    writeLog("ERROR", "did-fail-load", { errorCode, errorDescription, validatedURL });
    await dialog.showMessageBox(win, {
      type: "error",
      title: "页面加载失败",
      message: `${errorDescription} (${errorCode})`,
      detail: validatedURL || "unknown url"
    });
  });

  win.webContents.on("render-process-gone", async (_, details) => {
    writeLog("ERROR", "render-process-gone", details);
    await dialog.showMessageBox(win, {
      type: "error",
      title: "渲染进程崩溃",
      message: details.reason,
      detail: `exitCode: ${details.exitCode}`
    });
  });

  win.webContents.on("console-message", (_, level, message, line, sourceId) => {
    if (level >= 2) {
      writeLog("RENDERER", "console-message", { level, sourceId, line, message });
    }
  });

  return win;
}

app.whenReady().then(async () => {
  await loadState();
  logManager.init({ app, getSettings: () => settings });
  setupLogger();
  writeLog("INFO", "app ready");
  await clearRuntimeCaches("startup-once");
  startRuntimeCacheMonitor();
  startBridgeHeartbeat();
  if (process.env.ASSETHIVE_CLEAR_CACHE_ON_START === "1") {
    await clearAssetCaches();
    writeLog("INFO", "startup cache clear executed");
  }
  if (process.env.ASSETHIVE_RECONCILE_FOLDERS_ON_START === "1") {
    const reconcileResult = await reconcileCustomAssetFolders();
    writeLog("INFO", "startup reconcile folders executed", reconcileResult);
  }
  createWindow();

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

  ipcMain.handle("settings:update", async (_, patch) => {
    const oldSettings = { ...settings };
    settings = { ...settings, ...patch };
    await saveJson(getSettingsFilePath(), settings);
    if (patch.unrealLogPath !== undefined && patch.unrealLogPath !== oldSettings.unrealLogPath) {
      refreshLoggerPath();
    }

    // Update watcher if library paths changed
    const libraryPathsChanged = (patch.megascanLibraryPath !== undefined && patch.megascanLibraryPath !== oldSettings.megascanLibraryPath) ||
      (patch.customLibraryPath !== undefined && patch.customLibraryPath !== oldSettings.customLibraryPath);
    if (libraryPathsChanged) {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        startWatching(windows[0]);
        // Trigger immediate scan after path change
        void performScan(windows[0], { reason: "settings-change", force: true });
      }
    }

    return settings;
  });
  ipcMain.handle("settings:clearCaches", async (event) => {
    const result = await clearAssetCaches();
    await waitForScanIdle(6000);
    const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getAllWindows()[0] || null;
    if (win && !win.isDestroyed()) {
      await performScan(win, { reason: "clear-cache", force: true });
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

  ipcMain.handle("plugins:getStatus", async (_, { projectPath, editorPath }) => {
    try {
      const resolvedProjectPath = await resolveProjectFilePath(projectPath);
      const fallbackProjectPath = resolvedProjectPath ? "" : await resolveLiveEditorProjectPath();
      const effectiveProjectPath = resolvedProjectPath || fallbackProjectPath;
      let installed = false;
      let enabled = false;
      let installedViaEngine = false;
      let message = "";
      if (effectiveProjectPath) {
        installed = await hasProjectAssetHivePlugin(effectiveProjectPath);
        enabled = installed ? await isProjectAssetHiveEnabled(effectiveProjectPath) : false;
        if (installed && !enabled) {
          message = "AssetHive plugin is installed but disabled in this project";
        }
      }
      if (!installed && editorPath) {
        installed = await hasEngineAssetHivePlugin(editorPath);
        if (installed) {
          installedViaEngine = true;
          enabled = true;
          message = "";
        }
      }
      return {
        installed,
        enabled: installed ? (installedViaEngine ? true : (effectiveProjectPath ? enabled : true)) : false,
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

      const effectiveRepo = repo || settings.pluginRepo || "blackbladestudio/AssetHive";

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
      const repo = settings.pluginRepo || "blackbladestudio/AssetHive";
      const release = await fetchLatestRelease(repo);
      return { ok: true, version: release.version, name: release.name, publishedAt: release.publishedAt };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle("app:checkUpdate", async () => {
    try {
      const currentVersion = app.getVersion();
      const release = await fetchLatestAppRelease(APP_UPDATE_REPO_CANDIDATES);
      const latestVersion = normalizeVersionTag(release.version);
      const normalizedCurrent = normalizeVersionTag(currentVersion);
      const hasUpdate = compareVersions(latestVersion, normalizedCurrent) > 0;
      const { updateDir } = getUpdateStorageContext();
      const localPackagePath = hasUpdate ? await findLocalUpdatePackage(updateDir, latestVersion) : "";
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
        releaseUrl: release.htmlUrl
      };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle("app:getVersion", async () => {
    try {
      return { ok: true, version: String(app.getVersion() || "") };
    } catch (e) {
      return { ok: false, version: "", message: String(e?.message || e || "") };
    }
  });

  ipcMain.handle("app:downloadUpdate", async (event) => {
    const sendDownloadProgress = (payload) => {
      event.sender.send("app:updateDownloadProgress", payload);
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
      await fs.mkdir(updateDir, { recursive: true }).catch(() => { });
      const existingPackagePath = await findLocalUpdatePackage(updateDir, latestVersion);
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

      const pickedAsset = pickWindowsUpdateAsset(release.assets);
      if (pickedAsset?.browser_download_url) {
        const isZip = String(pickedAsset.name).toLowerCase().endsWith('.zip');
        const targetFilePath = path.join(updateDir, String(pickedAsset.name || `AssetHive-${latestVersion}${isZip ? '.zip' : '.exe'}`));

        sendDownloadProgress({ phase: "downloading", progress: 0, source: "release" });
        await downloadReleaseAsset(String(pickedAsset.browser_download_url), targetFilePath, ({ progress, loaded, total }) => {
          sendDownloadProgress({ phase: "downloading", progress, loaded, total, source: "release" });
        });
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
      const latestChannelUrl = `https://github.com/${release.repo}/raw/main/${APP_UPDATE_LATEST_CHANNEL_EXE}`;
      const latestChannelFilePath = path.join(updateDir, `AssetHive-latest-${latestVersion}.exe`);
      let latestChannelError = "";
      try {
        sendDownloadProgress({ phase: "downloading", progress: 0, source: "latest" });
        await downloadReleaseAsset(latestChannelUrl, latestChannelFilePath, ({ progress, loaded, total }) => {
          sendDownloadProgress({ phase: "downloading", progress, loaded, total, source: "latest" });
        });
        if (!await isValidWindowsExecutable(latestChannelFilePath)) {
          throw new Error("latest 通道文件不是有效 Windows 可执行文件");
        }
        sendDownloadProgress({ phase: "done", progress: 100, source: "latest" });

        return {
          ok: true,
          hasUpdate: true,
          message: "更新包下载完成，请点击安装",
          currentVersion,
          latestVersion,
          filePath: latestChannelFilePath,
          updateReady: true,
          releaseUrl: release.htmlUrl,
          repo: release.repo || ""
        };
      } catch (error) {
        latestChannelError = String(error?.message || error || "");
      }
      sendDownloadProgress({ phase: "error", progress: 0 });
      return {
        ok: false,
        hasUpdate: true,
        message: latestChannelError ? `下载失败：${latestChannelError}` : "未找到可下载的 Windows 更新包",
        releaseUrl: release.htmlUrl,
        repo: release.repo || ""
      };
    } catch (e) {
      sendDownloadProgress({ phase: "error", progress: 0 });
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle("app:installDownloadedUpdate", async (_event, payload) => {
    const filePath = String(payload?.filePath || "").trim();
    if (!filePath) {
      return { ok: false, message: "缺少安装包路径" };
    }
    return await launchDownloadedUpdatePackage(filePath);
  });

  ipcMain.handle("plugins:installFromGithub", async () => {
    try {
      if (!settings.unrealProjectPath) {
        return { ok: false, message: "Please set Unreal Project path first." };
      }
      const repo = settings.pluginRepo || "blackbladestudio/AssetHive";
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

  ipcMain.handle("settings:pickLog", async () => {
    const defaultLogFile = path.join(path.dirname(logManager.getActiveLogFilePath() || logManager.getLogFilePath()), "AssetHiveImport.log");
    const result = await dialog.showSaveDialog({
      title: "选择 Unreal 导入日志路径",
      defaultPath: defaultLogFile,
      filters: [{ name: "Log", extensions: ["log", "txt"] }]
    });
    if (result.canceled || !result.filePath) {
      return null;
    }
    return result.filePath;
  });

  ipcMain.handle("assets:getIndex", async () => index);
  ipcMain.handle("assets:getById", async (_, assetId) => {
    const asset = await refreshAssetById(assetId);
    return {
      ok: Boolean(asset),
      asset: asset || null
    };
  });
  ipcMain.handle("unreal:getConnectionStatus", async () => {
    try {
      return await getUnrealConnectionStatus(settings.unrealProjectPath, settings.unrealEditorPath);
    } catch (error) {
      writeLog("WARN", "unreal:getConnectionStatus failed", { message: error?.message });
      return { connected: false };
    }
  });

  ipcMain.handle("assets:rescan", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getAllWindows()[0] || null;
    await performScan(win, { reason: "manual-rescan", force: true });
    return hydrateIndexPreviewFields(index);
  });

  ipcMain.handle("assets:search", async (_, query) => searchAssets(index, query));

  ipcMain.handle("assets:exportToUnreal", async (event, payload) => {
    const rawAssets = index.filter((asset) => payload.assetIds.includes(asset.id));
    const selectedAssets = [];
    for (const asset of rawAssets) {
      const full = await refreshAssetById(asset.id);
      if (full) {
        selectedAssets.push(full);
      }
    }

    const payloadOptions = payload?.options && typeof payload.options === "object" ? payload.options : {};
    const mergedOptions = {
      ...settings,
      ...payloadOptions
    };
    if (!String(mergedOptions.unrealLogPath || "").trim()) {
      mergedOptions.unrealLogPath = String(logManager.getActiveLogFilePath() || logManager.getConfiguredLogFilePath() || "").trim();
    }
    writeLog("INFO", "assets:exportToUnreal start", {
      count: selectedAssets.length,
      unrealProjectPath: mergedOptions.unrealProjectPath,
      unrealEditorPath: mergedOptions.unrealEditorPath,
      unrealLogPath: mergedOptions.unrealLogPath
    });
    const sendProgress = (progress) => {
      event.sender.send("assets:exportProgress", progress);
    };
    return exportToUnreal(selectedAssets, mergedOptions, sendProgress)
      .then((result) => {
        writeLog("INFO", "assets:exportToUnreal success", {
          ok: Boolean(result?.ok),
          jobFile: result?.jobFile || "",
          logFile: result?.logFile || ""
        });
        return result;
      })
      .catch((error) => {
        writeLog("ERROR", "assets:exportToUnreal failed", {
          message: error?.message || String(error),
          stack: error?.stack
        });
        throw error;
      });
  });

  ipcMain.handle("assets:openFolder", async (_, assetPath) => {
    if (!assetPath) return;
    try {
      await shell.openPath(assetPath);
    } catch {
      writeLog("ERROR", "openFolder failed", { assetPath });
      return;
    }
  });

  ipcMain.handle("assets:copyText", async (_, text) => {
    const value = String(text || "");
    clipboard.writeText(value);
    return { ok: true };
  });

  ipcMain.handle("assets:pickFolder", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"]
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

  ipcMain.handle("assets:pickFile", async (_, kind) => {
    const normalizedKind = String(kind || "any").trim().toLowerCase();
    let filters = [];
    if (normalizedKind === "model") {
      filters = [{ name: "Model", extensions: ["fbx", "obj", "abc", "gltf", "glb", "ztl"] }];
    } else if (normalizedKind === "texture") {
      filters = [{ name: "Texture", extensions: ["png", "jpg", "jpeg", "tif", "tiff", "exr", "tga", "webp", "bmp"] }];
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

  ipcMain.handle("assets:materializeDroppedFile", async (_, payload) => {
    const fileName = path.basename(String(payload?.name || "").trim());
    const bytes = payload?.bytes;
    if (!fileName || !bytes) {
      return "";
    }
    const ext = path.extname(fileName).toLowerCase();
    const baseName = path.basename(fileName, ext).replace(/[\\/:*?"<>|]/g, "_") || "dropped";
    const safeExt = ext || ".bin";
    const dropDir = path.join(os.tmpdir(), "AssetHive", "DroppedFiles");
    await fs.mkdir(dropDir, { recursive: true });
    const targetPath = path.join(dropDir, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${baseName}${safeExt}`);
    const buffer = Buffer.from(bytes);
    await fs.writeFile(targetPath, buffer);
    return targetPath;
  });

  const dropResolveJobs = new Map();

  ipcMain.handle("assets:resolveDroppedItems", async (event, payload) => {
    const requestId = String(payload?.requestId || "").trim() || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = { aborted: false, processes: new Set(), tempDirs: [] };
    dropResolveJobs.set(requestId, job);
    const rawPaths = Array.isArray(payload?.paths) ? payload.paths : [];
    const inputPaths = rawPaths
      .map((p) => String(p || "").trim())
      .filter(Boolean)
      .map((p) => path.resolve(p));
    const modelExts = new Set([".fbx", ".obj", ".abc", ".gltf", ".glb", ".ztl"]);
    const textureExts = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".exr", ".hdr", ".tga", ".webp", ".bmp"]);
    const archiveExts = new Set([".zip", ".7z"]);
    const files = [];
    const seen = new Set();
    let lastProgress = -1;
    let lastProgressSentAt = 0;
    let heartbeatTimer = 0;

    const sendProgress = (percent, message = "") => {
      const normalized = Math.max(0, Math.min(100, Number(percent) || 0));
      const now = Date.now();
      if (normalized === lastProgress && now - lastProgressSentAt < 200) {
        return;
      }
      lastProgress = normalized;
      lastProgressSentAt = now;
      try {
        event.sender.send("assets:resolveDroppedItemsProgress", {
          requestId,
          active: normalized >= 0 && normalized < 100,
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

    const extractArchiveToTemp = async (archivePath) => {
      if (job.aborted) return null;
      const base = path.basename(archivePath, path.extname(archivePath)).replace(/[\\/:*?"<>|]/g, "_") || "archive";
      const outDir = path.join(os.tmpdir(), "AssetHive", "DroppedArchives", `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${base}`);
      await fs.mkdir(outDir, { recursive: true });
      job.tempDirs.push(outDir);
      const { spawn } = require("child_process");
      sendProgress(1, "Extracting");

      const ext = path.extname(String(archivePath || "")).toLowerCase();
      const sevenZip = await resolve7zExecutable();
      if (sevenZip) {
        const stopAt = 95;
        let progressTimer = global.setInterval(() => {
          const next = Math.min(stopAt, Math.max(1, lastProgress + 1));
          if (next > lastProgress) {
            sendProgress(next, "Extracting");
          }
        }, 700);
        progressTimer.unref?.();
        const ps = spawn(sevenZip, ["x", "-y", `-o${outDir}`, archivePath, "-bsp1", "-bb0"], { windowsHide: true });
        job.processes.add(ps);
        await new Promise((resolve, reject) => {
          let stderr = "";
          let stdout = "";
          const flushOutput = (chunk) => {
            stdout += String(chunk || "");
            const lines = stdout.split(/[\r\n]+/);
            stdout = lines.pop() || "";
            for (const line of lines) {
              const match = String(line || "").match(/(\d{1,3})%/);
              if (match) {
                sendProgress(Number(match[1]) || 0, "Extracting");
              }
            }
          };
          ps.stdout.on("data", flushOutput);
          ps.stderr.on("data", (d) => {
            stderr += String(d || "");
            flushOutput(d);
          });
          ps.on("error", reject);
          ps.on("close", (code) => {
            if (progressTimer) {
              global.clearInterval(progressTimer);
              progressTimer = 0;
            }
            job.processes.delete(ps);
            if (code === 0) resolve();
            else reject(new Error(stderr || `7z extract failed (${code})`));
          });
        }).catch(() => null);
        sendProgress(100, "Extracted");
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
        sendProgress(100, "Extracted");
      } else {
        return null;
      }

      global.setTimeout(() => {
        fs.rm(outDir, { recursive: true, force: true }).catch(() => null);
      }, 10 * 60 * 1000).unref?.();
      return outDir;
    };

    const walk = async (targetPath, depth = 0) => {
      if (job.aborted) return;
      if (depth > 8) return;
      const stats = await statOrNull(targetPath);
      if (!stats) return;
      if (stats.isDirectory()) {
        const entries = await fs.readdir(targetPath, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const full = path.join(targetPath, entry.name);
          if (entry.isDirectory()) {
            await walk(full, depth + 1);
          } else if (entry.isFile()) {
            await walk(full, depth + 1);
          }
        }
        return;
      }
      if (!stats.isFile()) return;
      const ext = path.extname(targetPath).toLowerCase();
      if (archiveExts.has(ext)) {
        const extractedDir = await extractArchiveToTemp(targetPath);
        if (extractedDir) {
          await walk(extractedDir, depth + 1);
        }
        return;
      }
      if ((modelExts.has(ext) || textureExts.has(ext)) && !hasLodToken(targetPath)) {
        addFile(targetPath);
      }
    };

    try {
      sendProgress(1, "Preparing");
      heartbeatTimer = global.setInterval(() => {
        if (job.aborted) {
          return;
        }
        const ceiling = 92;
        const next = Math.min(ceiling, Math.max(1, lastProgress + 1));
        if (next > lastProgress) {
          sendProgress(next, "Working");
        }
      }, 900);
      heartbeatTimer.unref?.();
      for (const p of inputPaths) {
        await walk(p, 0);
      }
      if (job.aborted) {
        return { files: [], preferredName: "" };
      }
      const preferredName = await pickPreferredName();
      sendProgress(100, "Done");
      return { files, preferredName };
    } finally {
      if (heartbeatTimer) {
        global.clearInterval(heartbeatTimer);
        heartbeatTimer = 0;
      }
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

  ipcMain.handle("assets:pathExists", async (_, rawPath) => {
    const targetPath = String(rawPath || "").trim();
    if (!targetPath) {
      return false;
    }
    const stats = await statOrNull(path.resolve(targetPath));
    return Boolean(stats?.isFile());
  });

  ipcMain.handle("assets:getPreviewThumbnail", async (_, rawPath) => {
    const targetPath = String(rawPath || "").trim();
    if (!targetPath) {
      return "";
    }
    const resolvedPath = path.resolve(targetPath);
    const thumbPath = await resolvePreviewThumbnailPath(resolvedPath).catch(() => resolvedPath);
    return String(thumbPath || resolvedPath);
  });

  ipcMain.handle("assets:importCustom", async (event, payload) => {
    const result = await importCustomAsset(payload, event.sender);
    const windows = BrowserWindow.getAllWindows();
    if (result.ok && windows.length > 0) {
      windows[0].webContents.send("assets:change");
    }
    return result;
  });

  ipcMain.handle("assets:updateCustom", async (event, payload) => {
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
    }
  });

  ipcMain.handle("assets:toggleFavorite", async (event, { assetId, isFavorite }) => {
    const changed = await updateAssetFavorite(assetId, isFavorite, index);
    if (changed) {
      await saveIndexSnapshot(index);
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed()) {
        win.webContents.send("assets:change");
      }
    }
    return changed;
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
      padding: Number(payload?.padding),
      maxSize: Number(payload?.maxSize)
    });
  });

  ipcMain.handle("assets:deleteCustom", async (_, payload) => {
    const result = await deleteCustomAsset(payload);
    const windows = BrowserWindow.getAllWindows();
    if (result.ok && windows.length > 0) {
      windows[0].webContents.send("assets:change");
    }
    return result;
  });

  ipcMain.handle("assets:rewriteCustomJson", async (event) => {
    const result = await rewriteCustomJsonFiles();
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

  ipcMain.handle("assets:recalculateSizes", async (event) => {
    const customAssets = index.filter((asset) => asset.source === "custom");
    let updatedCount = 0;

    for (const asset of customAssets) {
      const normalizedAssetType = String(asset.assetType || "").trim().toLowerCase();
      const shouldHandleSize = normalizedAssetType === "3d" || normalizedAssetType === "3dplant";
      let touched = false;
      const metaPath = asset.metaPath;
      const meta = await loadJson(metaPath, null);
      if (!meta || typeof meta !== "object") {
        continue;
      }

      if (!meta.assetID || String(meta.assetID).trim() !== String(asset.id || "").trim()) {
        meta.assetID = String(asset.id || "").trim() || String(meta.assetID || "").trim();
        touched = true;
      }
      if ("id" in meta) {
        delete meta.id;
        touched = true;
      }
      if ("uniqueId" in meta) {
        delete meta.uniqueId;
        touched = true;
      }

      if (!shouldHandleSize) {
        if (meta?.scanInformation && typeof meta.scanInformation === "object" && "dimensions" in meta.scanInformation) {
          delete meta.scanInformation.dimensions;
          touched = true;
        }
        if (touched) {
          await saveJson(metaPath, meta);
          updatedCount += 1;
          asset.meta = meta;
        }
        continue;
      }

      if (meta?.scanInformation?.dimensions) {
        if (touched) {
          await saveJson(metaPath, meta);
          updatedCount += 1;
          asset.meta = meta;
        }
        continue;
      }

      const modelFiles = asset.modelFiles || [];
      if (modelFiles.length === 0) {
        if (touched) {
          await saveJson(metaPath, meta);
          updatedCount += 1;
          asset.meta = meta;
        }
        continue;
      }

      let targetModel = modelFiles.find((f) => /highpoly/i.test(f));
      if (!targetModel) targetModel = modelFiles.find((f) => /lod0/i.test(f));
      if (!targetModel) targetModel = modelFiles[0];
      if (!targetModel) {
        if (touched) {
          await saveJson(metaPath, meta);
          updatedCount += 1;
          asset.meta = meta;
        }
        continue;
      }

      try {
        const dimensions = await requestBoundsFromRenderer(event.sender, targetModel);
        if (dimensions) {
          meta.scanInformation = meta.scanInformation || {};
          meta.scanInformation.dimensions = dimensions;
          touched = true;
        }
        if (touched) {
          await saveJson(metaPath, meta);
          updatedCount += 1;
          asset.meta = meta;
        }
      } catch (err) {
        writeLog("WARN", "batch recalculate failed for asset", { id: asset.id, error: err.message });
      }
    }

    if (updatedCount > 0) {
      await saveIndexSnapshot(index);
      event.sender.send("assets:change");
    }

    return { ok: true, count: updatedCount };
  });

  ipcMain.handle("assets:respondBounds", (_, payload) => {
    const { requestId, bounds } = payload;
    const request = pendingBoundsRequests.get(requestId);
    if (request) {
      globalThis.clearTimeout(request.timeout);
      request.resolve(bounds);
      pendingBoundsRequests.delete(requestId);
    }
    return { ok: true };
  });
});

app.on("before-quit", () => {
  if (bridgeHeartbeatTimer) {
    globalThis.clearInterval(bridgeHeartbeatTimer);
    bridgeHeartbeatTimer = null;
  }
  if (runtimeCacheMonitorTimer) {
    globalThis.clearInterval(runtimeCacheMonitorTimer);
    runtimeCacheMonitorTimer = null;
  }
  if (libraryDb) {
    try {
      libraryDb.close();
    } catch {
    }
    libraryDb = null;
    libraryDbPath = "";
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
