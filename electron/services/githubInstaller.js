const fs = require("node:fs/promises");
const path = require("node:path");
const { Buffer } = require("node:buffer");
const { spawn } = require("node:child_process");
const os = require("node:os");
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

function extractEngineVersion(text) {
  const value = String(text || "");
  const match = value.match(/(\d+\.\d+)/);
  return match ? match[1] : "";
}

function engineVersionTokens(engineVersion) {
  const v = extractEngineVersion(engineVersion);
  if (!v) {
    return [];
  }
  const compact = v.replace(".", "");
  const underscored = v.replace(".", "_");
  return [v, `ue${v}`, `ue_${v}`, `ue-${v}`, `ue${compact}`, `ue_${underscored}`, `ue-${underscored}`];
}

function scoreReleaseAsset(name, engineVersion) {
  const lowerName = String(name || "").toLowerCase();
  let score = 0;
  for (const token of engineVersionTokens(engineVersion)) {
    if (lowerName.includes(token.toLowerCase())) {
      score += 20;
    }
  }
  if (lowerName.includes("precompiled") || lowerName.includes("binary")) {
    score += 8;
  }
  if (lowerName.includes("source")) {
    score -= 50;
  }
  return score;
}

async function detectProjectEngineVersion(projectPath) {
  const input = String(projectPath || "").trim();
  if (!input) {
    return "";
  }
  const stat = await fs.stat(input).catch(() => null);
  if (!stat) {
    return "";
  }
  let uprojectPath = "";
  if (stat.isFile() && input.toLowerCase().endsWith(".uproject")) {
    uprojectPath = input;
  } else if (stat.isDirectory()) {
    const files = await fs.readdir(input).catch(() => []);
    const found = files.find((name) => String(name || "").toLowerCase().endsWith(".uproject"));
    if (found) {
      uprojectPath = path.join(input, found);
    }
  }
  if (!uprojectPath) {
    return "";
  }
  const raw = await fs.readFile(uprojectPath, "utf-8").catch(() => "");
  if (!raw) {
    return "";
  }
  try {
    const parsed = JSON.parse(raw);
    return extractEngineVersion(parsed?.EngineAssociation || "");
  } catch {
    return "";
  }
}

async function readFileHeadText(filePath, maxBytes = 256) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.slice(0, bytesRead).toString("utf-8");
  } finally {
    await handle.close();
  }
}

async function isGitLfsPointerFile(filePath) {
  const head = await readFileHeadText(filePath, 128).catch(() => "");
  return head.startsWith("version https://git-lfs.github.com/spec/v1");
}

async function isValidPngFile(filePath) {
  const handle = await fs.open(filePath, "r").catch(() => null);
  if (!handle) {
    return false;
  }
  try {
    const buffer = Buffer.alloc(8);
    const { bytesRead } = await handle.read(buffer, 0, 8, 0);
    if (bytesRead < 8) {
      return false;
    }
    return (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    );
  } finally {
    await handle.close();
  }
}

async function findFirstLfsPointerInContent(contentDir, limit = 120) {
  const stack = [contentDir];
  let checked = 0;
  while (stack.length > 0 && checked < limit) {
    const dir = stack.pop();
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (checked >= limit) {
        break;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      const lowerName = entry.name.toLowerCase();
      if (!lowerName.endsWith(".uasset") && !lowerName.endsWith(".umap")) {
        continue;
      }
      checked += 1;
      if (await isGitLfsPointerFile(fullPath)) {
        return fullPath;
      }
    }
  }
  return "";
}

async function validatePluginPackage(pluginRoot, engineVersion) {
  const binaryFile = path.join(pluginRoot, "Binaries", "Win64", "UnrealEditor-AssetHive.dll");
  const binaryStat = await fs.stat(binaryFile).catch(() => null);
  if (!binaryStat || !binaryStat.isFile()) {
    throw new Error("下载包缺少预编译二进制 UnrealEditor-AssetHive.dll，请上传正确的 Release 预编译包。");
  }
  const upluginPath = path.join(pluginRoot, "AssetHive.uplugin");
  const upluginStat = await fs.stat(upluginPath).catch(() => null);
  if (!upluginStat || !upluginStat.isFile()) {
    throw new Error("下载包缺少 AssetHive.uplugin。");
  }
  const buildCs = path.join(pluginRoot, "Source", "AssetHive", "AssetHive.Build.cs");
  const buildCsStat = await fs.stat(buildCs).catch(() => null);
  const iconFile = path.join(pluginRoot, "Resources", "Icon128.png");
  const iconStat = await fs.stat(iconFile).catch(() => null);
  if (iconStat && iconStat.isFile()) {
    if (!await isValidPngFile(iconFile)) {
      throw new Error("下载包的 Icon128.png 不是有效 PNG（疑似 Git LFS 指针文件）。");
    }
  }
  const contentDir = path.join(pluginRoot, "Content");
  const contentStat = await fs.stat(contentDir).catch(() => null);
  if (contentStat && contentStat.isDirectory()) {
    const lfsPointer = await findFirstLfsPointerInContent(contentDir);
    if (lfsPointer) {
      const relPath = path.relative(pluginRoot, lfsPointer).replace(/\\/g, "/");
      throw new Error(`下载包包含 Git LFS 指针资源：${relPath}，请发布真实二进制资源后重试。`);
    }
  }
  const pickedVersion = extractEngineVersion(engineVersion);
  if (pickedVersion) {
    const descriptor = await fs.readFile(upluginPath, "utf-8").catch(() => "");
    if (!descriptor) {
      throw new Error("下载包缺少 AssetHive.uplugin。");
    }
  }
}

async function fetchPluginPackage(repo, options = {}) {
  const targetEngineVersion = extractEngineVersion(options?.engineVersion || "");
  const primaryRepo = String(repo || "").trim();
  const repoCandidates = [...new Set([
    primaryRepo,
    primaryRepo.endsWith("_Source") ? primaryRepo.replace(/_Source$/i, "") : `${primaryRepo}_Source`
  ].map((item) => String(item || "").trim()).filter(Boolean))];
  try {
    const headers = { "User-Agent": "AssetHive-App", "Accept": "application/vnd.github+json" };
    let sourceFallback = null;
    let lastError = "";
    for (const repoName of repoCandidates) {
      let releaseData = null;
      try {
        releaseData = await fetchGithubJsonWithFallback(`https://api.github.com/repos/${repoName}/releases/latest`, headers);
      } catch {
        const list = await fetchGithubJsonWithFallback(`https://api.github.com/repos/${repoName}/releases?per_page=30`, headers);
        const pickedRelease = Array.isArray(list) ? list.find((item) => item && !item.draft) : null;
        if (pickedRelease) {
          releaseData = pickedRelease;
        }
      }
      if (releaseData) {
        const assets = Array.isArray(releaseData?.assets) ? releaseData.assets : [];
        const zipAssets = assets.filter((asset) => String(asset?.name || "").toLowerCase().endsWith(".zip"));
        if (zipAssets.length > 0) {
          const sorted = [...zipAssets].sort((a, b) => {
            return scoreReleaseAsset(b?.name, targetEngineVersion) - scoreReleaseAsset(a?.name, targetEngineVersion);
          });
          const picked = sorted[0];
          if (picked?.browser_download_url) {
            return {
              version: releaseData.tag_name || "latest",
              downloadUrl: picked.browser_download_url,
              name: picked.name,
              publishedAt: releaseData.published_at,
              isSource: false,
              engineVersion: targetEngineVersion
            };
          }
        }
      }
      try {
        const repoData = await fetchGithubJsonWithFallback(`https://api.github.com/repos/${repoName}`, headers);
        const defaultBranch = String(repoData?.default_branch || "main").trim() || "main";
        sourceFallback = {
          version: releaseData?.tag_name || `source-${defaultBranch}`,
          downloadUrl: `https://codeload.github.com/${repoName}/zip/refs/heads/${defaultBranch}`,
          name: `AssetHive-plugin-${defaultBranch}.zip`,
          publishedAt: releaseData?.published_at || "",
          isSource: true,
          engineVersion: targetEngineVersion
        };
      } catch (error) {
        lastError = error?.message || String(error);
      }
    }
    if (sourceFallback) {
      return sourceFallback;
    }
    throw new Error(lastError || "无法访问插件仓库信息");
  } catch (error) {
    throw new Error(`无法获取可用的预编译 Release 插件包：${error.message || error}`);
  }
}

async function downloadFile(url, destPath, onProgress) {
  const candidateUrls = buildGithubDownloadCandidates(url);
  const requestHeaders = {
    "User-Agent": "AssetHive-App"
  };
  const orderedCandidateUrls = await sortDownloadCandidatesBySpeed(candidateUrls, requestHeaders);
  let response = null;
  let lastError = "";
  for (const candidateUrl of orderedCandidateUrls) {
    try {
      await fs.rm(destPath, { force: true }).catch(() => {});
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
  if (!response || !response.ok) throw new Error(lastError || "Download failed");
  const contentLength = response.headers.get("content-length");
  const total = contentLength ? parseInt(contentLength, 10) : 0;
  let loaded = 0;
  if (!response.body) throw new Error("Response body is empty");
  const reader = response.body.getReader();
  const fileHandle = await fs.open(destPath, "w");
  
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      await fileHandle.write(value);
      loaded += value.length;
      
      if (onProgress) {
        if (total > 0) {
          onProgress(loaded / total);
        } else {
          onProgress(0.5);
        }
      }
    }
  } finally {
    await fileHandle.close();
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
      await reader.cancel().catch(() => {});
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

async function preparePluginRootFromRelease(_repo, release, tempDir, onProgress) {
  const extractDir = path.join(tempDir, "extracted");
  await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(extractDir, { recursive: true });
  if (release?.isSource) {
    throw new Error("当前插件仓库没有可用的预编译 Release zip 资产。无需安装 Git/LFS 的方式：在插件仓库发布并上传预编译 zip 后再安装。");
  }
  const zipPath = path.join(tempDir, release.name);
  if (onProgress) onProgress("downloading", 0);
  await downloadFile(release.downloadUrl, zipPath, (progress) => {
    if (onProgress) onProgress("downloading", progress);
  });
  if (onProgress) onProgress("extracting", 0.2);
  await unzipFile(zipPath, extractDir);
  if (onProgress) onProgress("extracting", 1);
  return extractDir;
}

async function unzipFile(zipPath, destDir) {
  // Try using 'tar' first (available on Windows 10+ and much faster)
  try {
    return await new Promise((resolve, reject) => {
      // tar -xf "zipPath" -C "destDir"
      // Note: tar on Windows might not like backslashes in paths sometimes, but usually fine.
      const child = spawn("tar", ["-xf", zipPath, "-C", destDir]);
      
      let errorOutput = "";
      child.stderr.on("data", (data) => { errorOutput += data.toString(); });

      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar failed with code ${code}: ${errorOutput}`));
      });
      
      child.on("error", (err) => reject(err));
    });
  } catch (e) {
    console.warn("tar failed, falling back to PowerShell:", e);
    // Fallback to PowerShell
    return new Promise((resolve, reject) => {
      const psCommand = `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`;
      const child = spawn("powershell", ["-NoProfile", "-Command", psCommand]);
      
      let errorOutput = "";
      child.stderr.on("data", (data) => { errorOutput += data.toString(); });

      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Unzip failed with code ${code}: ${errorOutput}`));
      });
    });
  }
}

async function findPluginRoot(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".uplugin")) {
      return dir;
    }
    if (entry.isDirectory()) {
      const found = await findPluginRoot(path.join(dir, entry.name));
      if (found) return found;
    }
  }
  return null;
}

async function cleanupPluginTargets(pluginsDir, preferredDirName) {
  const candidateNames = new Set(["AssetHive", "ArkHiveImport"]);
  if (typeof preferredDirName === "string" && preferredDirName.trim()) {
    candidateNames.add(preferredDirName.trim());
  }
  await fs.mkdir(pluginsDir, { recursive: true });
  for (const name of candidateNames) {
    const target = path.join(pluginsDir, name);
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
  }
}

async function installPluginFromGithub(repo, projectPath, onProgress) {
  if (!repo || !projectPath) throw new Error("Missing repo or project path");

  if (onProgress) onProgress("fetching_info", 0);

  // Determine Project Root
  let projectRoot = projectPath;
  const stat = await fs.stat(projectPath);
  if (stat.isFile()) {
      projectRoot = path.dirname(projectPath);
  }

  const projectEngineVersion = await detectProjectEngineVersion(projectPath);
  const release = await fetchPluginPackage(repo, { engineVersion: projectEngineVersion });
  
  // 2. Prepare Temp Paths
  const tempDir = path.join(os.tmpdir(), "assethive-plugin-update");
  await fs.mkdir(tempDir, { recursive: true });
  let extractDir = "";
  try {
    extractDir = await preparePluginRootFromRelease(repo, release, tempDir, onProgress);
  } catch (e) {
    throw new Error(`Download failed: ${e.message}`);
  }
  
  // 5. Locate Plugin Content
  if (onProgress) onProgress("installing", 0);
  // The zip usually contains a folder named "AssetHive" or similar.
  // We need to find the .uplugin file to identify the root.
  const pluginRoot = await findPluginRoot(extractDir);
  if (!pluginRoot) {
    throw new Error("Could not find .uplugin file in the downloaded archive");
  }
  await validatePluginPackage(pluginRoot, release.engineVersion);
  
  const projectPluginsDir = path.join(projectRoot, "Plugins");
  const pluginDirName = path.basename(pluginRoot);
  const targetDir = path.join(projectPluginsDir, pluginDirName);
  await cleanupPluginTargets(projectPluginsDir, pluginDirName);
  try {
      await fs.cp(pluginRoot, targetDir, { recursive: true });
  } catch (e) {
      throw new Error(`Copy to plugins folder failed: ${e.message}`);
  }
  
  // Cleanup
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  
  if (onProgress) onProgress("completed", 1);
  return { version: release.version, installedPath: targetDir };
}

async function installPluginToEngine(repo, editorPath, onProgress) {
  if (!repo || !editorPath) throw new Error("Missing repo or editor path");

  if (onProgress) onProgress("fetching_info", 0);

  // Calculate Engine Plugins Directory
  let engineRoot;
  // Check if editorPath is a directory (Engine Root) or file (Executable)
  const stat = await fs.stat(editorPath).catch(() => null);
  if (stat && stat.isDirectory()) {
      engineRoot = editorPath;
  } else {
      // editorPath: .../Engine/Binaries/Win64/UnrealEditor.exe
      // Up 4 levels: Win64 -> Binaries -> Engine -> Root
      // path.dirname(editorPath) is .../Win64
      // resolve(..., "..", "..", "..") -> Root
      engineRoot = path.resolve(path.dirname(editorPath), "..", "..", "..");
  }
  
  const pluginsDir = path.join(engineRoot, "Engine", "Plugins", "Marketplace");
  
  const release = await fetchPluginPackage(repo, { engineVersion: extractEngineVersion(editorPath) });
  
  // 2. Prepare Temp Paths
  const tempDir = path.join(os.tmpdir(), "assethive-plugin-update");
  await fs.mkdir(tempDir, { recursive: true });
  let extractDir = "";
  try {
    extractDir = await preparePluginRootFromRelease(repo, release, tempDir, onProgress);
  } catch (e) {
    throw new Error(`Download failed: ${e.message}`);
  }
  
  const pluginRoot = await findPluginRoot(extractDir);
  if (!pluginRoot) {
    throw new Error("Could not find .uplugin file in the downloaded archive");
  }
  await validatePluginPackage(pluginRoot, release.engineVersion);
  
  if (onProgress) onProgress("installing", 0);
  const pluginDirName = path.basename(pluginRoot);
  const targetDir = path.join(pluginsDir, pluginDirName);
  await cleanupPluginTargets(pluginsDir, pluginDirName);
  try {
      await fs.cp(pluginRoot, targetDir, { recursive: true });
  } catch (e) {
      throw new Error(`Copy to plugins folder failed: ${e.message}`);
  }
  
  // Cleanup
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  
  if (onProgress) onProgress("completed", 1);
  return { version: release.version, installedPath: targetDir };
}

module.exports = {
  fetchLatestRelease: fetchPluginPackage,
  installPluginFromGithub,
  installPluginToEngine
};
