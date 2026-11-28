const { analyzeNaniteFoliage } = require("./naniteFoliage");
const { useNaniteFoliageBranch } = require("../../shared/plantBranches.mjs");
const { isMaskAsset, normalizeMaskGroups } = require("../../shared/maskMaterials.mjs");
const { buildMaskMaterial } = require("./maskMaterials");
const fsSync = require("node:fs");
const { runImageTask } = require("./imageTasks");
const fs = require("node:fs/promises");
const path = require("node:path");
const { parseModelVariantKey, normalizeModelVariantKey, modelVariantNumberFromKey, compareModelVariantKeys } = require("./modelVariants");
const { normalizeTextureMaterialRole } = require("./textureMaterialRole");
const { materialStem, materialKey, normalizeMaterialNames, namedTextureMetadata, namedPlantTextureMetadata, namedMaterialCatalog, prepareNamedMaterialBatch } = require("./zion3dMaterials");
const { normalizeNativePlantWind } = require("./nativePlantWind");
const { inspectPlantLayerSource } = require("./plantWindLayers");
const { PLANT_WIND_FORMS, classifyBridgePlantWind, fitsMicroSizeCm, isMicroPlantTag } = require("./plantWindPreset");
const { analyzeFbxInWorker } = require("./modelAnalysis");
const { isMegascansBridgeMetadata } = require("./sourceDetection");
const { detectTextureTypeFromFileName, normalizeTextureType } = require("./textureTypes");
const { spawn, execFile } = require("node:child_process");
const os = require("node:os");
const { Buffer } = require("node:buffer");
const { nativeImage, app } = require("electron");
const { tcpClient } = require("./unrealDiscovery");
let sharp = null;
try {
  sharp = require("sharp");
} catch (err) {
  console.warn("[AssetHive] sharp module not found, EXR to PNG conversion will not be available");
}
if (sharp && typeof sharp.concurrency === "function") {
  const configured = Number(process.env.ASSETHIVE_SHARP_CONCURRENCY);
  const cpuCount = Array.isArray(os.cpus?.()) ? os.cpus().length : 0;
  const fallback = cpuCount > 0 ? Math.max(1, Math.min(2, Math.floor(cpuCount / 2))) : 1;
  const concurrency = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : fallback;
  sharp.concurrency(concurrency);
}
// 导出槽位白名单（2026-10-29 定稿）：Fuzz **永不导出** —— 母材质不再按 fuzz 分叉，
// 导入侧即使识别到 fuzz 贴图也只留在库里，不进导出 job。
const ALLOWED_EXPORT_TEXTURE_SLOTS = new Set(["albedo", "roughness", "gloss", "normal", "ao", "displacement", "mask", "metalness", "emissive", "opacity", "translucency", "subsurfacecolor", "orm", "uv2ao"]);
const SURFACE_EXPORT_TEXTURE_SLOTS = new Set([...ALLOWED_EXPORT_TEXTURE_SLOTS, "orm"]);
const MODEL_FILE_EXTENSIONS = new Set([".fbx", ".st9", ".obj", ".abc", ".gltf", ".glb", ".ztl"]);
const HAS_NATIVE_IMAGE = Boolean(nativeImage && typeof nativeImage.createFromPath === "function" && typeof nativeImage.createFromBitmap === "function");
const resizedTextureCache = new Map();
const normalizedJpegCache = new Map();
const EXPORT_COOPERATIVE_YIELD_INTERVAL = 3;

function normalizeExportResolution(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "2k") return "2k";
  if (normalized === "8k") return "8k";
  return "4k";
}

function normalizeDecalParentType(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized === "pom" || normalized === "parallax" || normalized === "pomdecal" || normalized === "视差贴花") return "pomDecal";
  if (normalized === "tri" || normalized === "triplanar" || normalized === "triplanardecal" || normalized === "decaltri" || normalized === "三平面投射贴花") return "decalTri";
  if (normalized === "pomtri" || normalized === "triplanarpom" || normalized === "pomdecaltri" || normalized === "三平面视差贴花") return "pomDecalTri";
  return "decal";
}

function exportResolutionToPixels(value) {
  const normalized = normalizeExportResolution(value);
  if (normalized === "2k") return 2048;
  if (normalized === "8k") return 8192;
  return 4096;
}

function extractResolutionPixelsFromName(filePath) {
  const base = path.basename(String(filePath || ""), path.extname(String(filePath || ""))).toLowerCase();
  const match = base.match(/(?:^|[_\-.])(1k|2k|4k|8k|16k)(?:$|[_\-.])/i);
  if (!match) {
    return 0;
  }
  const token = String(match[1] || "").toLowerCase();
  if (token === "1k") return 1024;
  if (token === "2k") return 2048;
  if (token === "4k") return 4096;
  if (token === "8k") return 8192;
  if (token === "16k") return 16384;
  return 0;
}

function detectTextureSlotByFileName(filePath) {
  const textureType = detectTextureTypeFromFileName(filePath);
  return normalizeExportTextureSlot(textureType, { allowOrm: true });
}
function detectSurfaceTextureSlotByFileName(filePath) {
  const textureType = detectTextureTypeFromFileName(filePath);
  return normalizeExportTextureSlot(textureType, { allowOrm: true });
}
function extractAreaTokensFromFileName(filePath) {
  const base = path.basename(String(filePath || ""), path.extname(String(filePath || ""))).toLowerCase();
  if (!base) {
    return [];
  }
  const matches = [...base.matchAll(/(?:^|_)(\d{1,3})(?=_|$)/g)];
  return matches
    .map((item) => Number(item?.[1]))
    .filter((value) => Number.isInteger(value) && value >= 0);
}

function pickResolutionMatchedTexture(slot, currentPath, textureCandidates, targetPixels, options = {}) {
  if (!targetPixels || targetPixels <= 0) {
    return currentPath;
  }
  const slotDetector = typeof options?.slotDetector === "function" ? options.slotDetector : detectTextureSlotByFileName;
  let sameSlot = textureCandidates.filter((candidate) => slotDetector(candidate) === slot);
  const desiredMaterialRole = normalizeTextureMaterialRole(options?.materialRole, "", "");
  if (desiredMaterialRole) {
    sameSlot = sameSlot.filter((candidate) => normalizeTextureMaterialRole("", candidate, "atlas") === desiredMaterialRole);
  }
  if (sameSlot.length === 0) {
    return currentPath;
  }
  const currentName = path.basename(String(currentPath || "")).toLowerCase();
  const normalLodHint = slot === "normal"
    ? (currentName.includes("lod1") ? "lod1" : currentName.includes("lod0") ? "lod0" : "")
    : "";
  const filteredByLod = normalLodHint
    ? sameSlot.filter((candidate) => path.basename(String(candidate || "")).toLowerCase().includes(normalLodHint))
    : sameSlot;
  const desiredAreaIndex = Math.max(1, Number(options?.areaIndex ?? options?.groupId) || 1);
  let pool = filteredByLod.length > 0 ? filteredByLod : sameSlot;
  if (desiredAreaIndex > 1) {
    const groupMatched = pool.filter((candidate) => extractAreaTokensFromFileName(candidate).includes(desiredAreaIndex));
    if (groupMatched.length > 0) {
      pool = groupMatched;
    }
  }
  const withRes = pool
    .map((filePath) => ({ filePath, res: extractResolutionPixelsFromName(filePath) }))
    .filter((item) => item.res > 0);
  const extRank = (filePath) => {
    const lower = path.basename(String(filePath || "")).toLowerCase();
    if (slot === "displacement") {
      if (lower.endsWith(".exr")) return 3;
      if (lower.endsWith(".png")) return 2;
      if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return 1;
      return 0;
    }
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return 3;
    if (lower.endsWith(".png")) return 2;
    if (lower.endsWith(".exr")) return 1;
    return 0;
  };
  const pickBest = (list, compare) =>
    [...list].sort((a, b) => {
      const cmp = compare(a, b);
      if (cmp !== 0) return cmp;
      return extRank(b.filePath) - extRank(a.filePath);
    })[0];
  const atOrBelow = withRes.filter((item) => item.res <= targetPixels);
  if (atOrBelow.length > 0) {
    return pickBest(atOrBelow, (a, b) => b.res - a.res)?.filePath || currentPath;
  }
  const above = withRes.filter((item) => item.res > targetPixels);
  if (above.length > 0) {
    return pickBest(above, (a, b) => a.res - b.res)?.filePath || currentPath;
  }
  return currentPath;
}

async function convertExrToPngIfNeeded(filePath, slotHint = "") {
  if (!filePath || !filePath.toLowerCase().endsWith(".exr")) {
    return filePath;
  }
  if (!sharp) {
    return filePath;
  }
  try {
    const tempDir = path.join(os.tmpdir(), "assethive", "converted_exr");
    await fs.mkdir(tempDir, { recursive: true });
    const crypto = require("node:crypto");
    const mode = String(slotHint || "").trim().toLowerCase();
    const safeHash = crypto.createHash("md5").update(`${String(filePath)}|${mode}`).digest("hex").substring(0, 12);
    const newPath = path.join(tempDir, `${path.basename(filePath, ".exr")}_${safeHash}.png`);
    if (await exists(newPath)) {
      return newPath;
    }
    const singleChannelSlots = new Set(["ao", "roughness", "displacement", "opacity"]);
    if (singleChannelSlots.has(mode)) {
      const stats = await sharp(filePath).stats();
      const firstChannel = Array.isArray(stats?.channels) && stats.channels.length > 0 ? stats.channels[0] : null;
      const min = Number(firstChannel?.min);
      const max = Number(firstChannel?.max);
      const validRange = Number.isFinite(min) && Number.isFinite(max) && max > min;
      const scale = validRange ? (1 / (max - min)) : 1;
      const offset = validRange ? (-min * scale) : 0;
      await sharp(filePath)
        .toColorspace("b-w")
        .linear(scale, offset)
        .png({ compressionLevel: 6, effort: 4 })
        .toFile(newPath);
    } else {
      await sharp(filePath)
        .toColorspace("srgb")
        .png({ compressionLevel: 6, effort: 4 })
        .toFile(newPath);
    }
    return newPath;
  } catch (error) {
    console.error("[AssetHive] Failed to convert EXR to PNG:", filePath, error);
    return filePath;
  }
}

async function normalizeJpegForUnrealIfNeeded(filePath, slotHint = "") {
  const sourcePath = String(filePath || "");
  if (!sourcePath || !/\.(jpe?g)$/i.test(sourcePath)) {
    return filePath;
  }
  try {
    const cacheKey = `${path.resolve(sourcePath)}|${String(slotHint || "").toLowerCase()}`;
    if (normalizedJpegCache.has(cacheKey)) {
      const cachedPath = normalizedJpegCache.get(cacheKey);
      if (cachedPath && await exists(cachedPath)) {
        return cachedPath;
      }
      normalizedJpegCache.delete(cacheKey);
    }
    const tempDir = path.join(os.tmpdir(), "assethive", "normalized_jpeg");
    await fs.mkdir(tempDir, { recursive: true });
    const crypto = require("node:crypto");
    const safeHash = crypto.createHash("md5").update(cacheKey).digest("hex").substring(0, 12);
    const newPath = path.join(tempDir, `${path.basename(sourcePath, path.extname(sourcePath))}_${safeHash}.png`);
    if (await exists(newPath)) {
      normalizedJpegCache.set(cacheKey, newPath);
      return newPath;
    }
    if (sharp) {
      await sharp(sourcePath).toColorspace("srgb").png({ compressionLevel: 6, effort: 4 }).toFile(newPath);
    } else if (HAS_NATIVE_IMAGE) {
      const image = nativeImage.createFromPath(sourcePath);
      if (image.isEmpty()) {
        return filePath;
      }
      await fs.writeFile(newPath, image.toPNG());
    } else {
      return filePath;
    }
    normalizedJpegCache.set(cacheKey, newPath);
    return newPath;
  } catch (error) {
    console.warn("[AssetHive] Failed to normalize JPEG for Unreal:", filePath, error?.message || error);
    return filePath;
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function statOrNull(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

function getProjectRoot(unrealProjectPath) {
  try {
    return path.dirname(path.resolve(String(unrealProjectPath || "")));
  } catch {
    return path.dirname(String(unrealProjectPath || ""));
  }
}

async function statFile(filePath) {
  try {
    const st = await fs.stat(filePath);
    return st?.isFile() ? st : null;
  } catch {
    return null;
  }
}

function getEnginePluginCandidateRoots(unrealEditorPath) {
  // Editor exe lives at <engineRoot>/Engine/Binaries/Win64/UnrealEditor.exe
  const engineRoot = path.resolve(path.dirname(unrealEditorPath), "..", "..", "..");
  return [
    path.join(engineRoot, "Engine", "Plugins", "AssetHive"),
    path.join(engineRoot, "Engine", "Plugins", "Marketplace", "AssetHive"),
    path.join(engineRoot, "Engine", "Plugins", "Runtime", "AssetHive"),
    // Legacy / installer-side fallback (older AssetHive builds wrote here)
    path.join(engineRoot, "Plugins", "AssetHive"),
  ];
}

// 插件可以随项目分发（Project/Plugins/AssetHive），此时引擎目录里没有它。
// 这种布局下引擎同样会加载插件，必须视为"已安装"：否则导出流程会把手里的
// 自带副本再拷一份进引擎，既污染引擎工作区，又会在下次启动时和项目插件
// 同名冲突（引擎/项目两份同名插件 → 模块加载来源不确定）。
function getProjectPluginCandidateRoots(unrealProjectPath) {
  const projectRoot = getProjectRoot(unrealProjectPath);
  if (!projectRoot) return [];
  return [
    path.join(projectRoot, "Plugins", "AssetHive"),
    path.join(projectRoot, "Plugins", "Marketplace", "AssetHive"),
  ];
}

async function findEngineAssetHivePluginRoot(unrealEditorPath) {
  for (const candidate of getEnginePluginCandidateRoots(unrealEditorPath)) {
    if (await statFile(path.join(candidate, "AssetHive.uplugin"))) {
      return candidate;
    }
  }
  return "";
}

// 查找顺序：项目插件优先，其次引擎。项目里存在即代表这套工程用的是项目分发形态。
async function findAssetHivePluginRoot(unrealProjectPath, unrealEditorPath) {
  for (const candidate of getProjectPluginCandidateRoots(unrealProjectPath)) {
    if (await statFile(path.join(candidate, "AssetHive.uplugin"))) {
      return candidate;
    }
  }
  return findEngineAssetHivePluginRoot(unrealEditorPath);
}

async function ensureCommonMaterialAvailable(unrealProjectPath, unrealEditorPath) {
  const projectRoot = getProjectRoot(unrealProjectPath);
  const pluginRoot = await findAssetHivePluginRoot(unrealProjectPath, unrealEditorPath);
  const enginePluginMat = pluginRoot
    ? path.join(pluginRoot, "Content", "Common", "MaterialInstance", "MMI_GeneralMat.uasset")
    : "";
  const engineHas = Boolean(enginePluginMat && await statFile(enginePluginMat));
  if (!projectRoot) {
    return engineHas ? { ok: true, source: "engine-only" } : { ok: false, reason: "missing-common-material" };
  }
  const projectMat = path.join(projectRoot, "Content", "Common", "MaterialInstance", "MMI_GeneralMat.uasset");
  const projectHas = Boolean(await statFile(projectMat));
  // Existing projects still need newly shipped VT parents and their dependencies.
  // Copy missing files only so project-specific material edits are preserved.

  const projectPluginCandidates = [
    path.join(projectRoot, "Plugins", "AssetHive", "Content", "Common"),
    path.join(projectRoot, "Plugins", "AssetHive", "AssetHive", "Content", "Common")
  ];
  for (const candidateDir of projectPluginCandidates) {
    const candidateMat = path.join(candidateDir, "MaterialInstance", "MMI_GeneralMat.uasset");
    if (await statFile(candidateMat)) {
      const projectCommonDir = path.join(projectRoot, "Content", "Common");
      try {
        await fs.mkdir(projectCommonDir, { recursive: true });
        await fs.cp(candidateDir, projectCommonDir, { recursive: true, force: !projectHas });
        return { ok: true, source: "project-plugin-copied" };
      } catch (e) {
        return { ok: false, reason: "copy-failed", message: e?.message || String(e) };
      }
    }
  }

  if (!engineHas) {
    if (projectHas) return { ok: true, source: "project" };
    return { ok: false, reason: "missing-common-material" };
  }
  const engineCommonDir = path.join(pluginRoot, "Content", "Common");
  const projectCommonDir = path.join(projectRoot, "Content", "Common");
  try {
    await fs.mkdir(projectCommonDir, { recursive: true });
    await fs.cp(engineCommonDir, projectCommonDir, { recursive: true, force: !projectHas });
    return { ok: true, source: "engine-copied" };
  } catch (e) {
    return { ok: false, reason: "copy-failed", message: e?.message || String(e) };
  }
}

async function yieldToEventLoop() {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

function toNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function toSafeCacheToken(value) {
  const text = String(value || "");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

async function firstExistingFile(candidates) {
  for (const candidate of candidates) {
    const target = toNonEmptyString(candidate);
    if (!target) {
      continue;
    }
    const resolved = path.resolve(target);
    if (await exists(resolved)) {
      return resolved;
    }
  }
  return "";
}

async function readEngineAssociation(uprojectPath) {
  try {
    const raw = await fs.readFile(uprojectPath, "utf-8");
    const parsed = JSON.parse(raw);
    return toNonEmptyString(parsed?.EngineAssociation);
  } catch {
    return "";
  }
}

async function readUnrealImportLog(logPath, lastProcessedLine = 0) {
  if (!logPath || !(await exists(logPath))) {
    return { lines: [], lastLine: lastProcessedLine };
  }
  try {
    const content = await fs.readFile(logPath, "utf-8");
    const allLines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (allLines.length <= lastProcessedLine) {
      return { lines: [], lastLine: lastProcessedLine };
    }
    return {
      lines: allLines.slice(lastProcessedLine),
      lastLine: allLines.length
    };
  } catch {
    return { lines: [], lastLine: lastProcessedLine };
  }
}

async function readLiveEditorProjectPath() {
  const info = await tcpClient.getEditorInfo();
  return info?.projectPath || "";
}

async function readRunningUnrealEditorPaths() {
  if (os.platform() !== "win32") {
    return [];
  }
  return new Promise((resolve) => {
    // 1. 第一步：快速检测是否有 UnrealEditor.exe 进程
    execFile(
      "tasklist.exe",
      ["/FI", "IMAGENAME eq UnrealEditor.exe", "/NH"],
      { windowsHide: true, timeout: 2000 },
      (tasklistError, tasklistStdout) => {
        const isRunning = !tasklistError && String(tasklistStdout || "").toLowerCase().includes("unrealeditor.exe");
        
        if (!isRunning) {
          resolve([]);
          return;
        }

        // 2. 第二步：只有确认启动了，才去执行昂贵的 PowerShell 查询来获取可执行文件路径
        execFile(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process -Filter \"Name='UnrealEditor.exe'\" 2>$null | Select-Object -ExpandProperty ExecutablePath"
          ],
          { windowsHide: true, timeout: 3000 },
          (error, stdout) => {
            if (error || !stdout) {
              resolve([]);
              return;
            }
            const lines = String(stdout)
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line.toLowerCase().endsWith(".exe"));
            resolve([...new Set(lines)]);
          }
        );
      }
    );
  });
}

async function readRunningUnrealProjectPaths() {
  if (os.platform() !== "win32") {
    return [];
  }
  return new Promise((resolve) => {
    // 1. 第一步：快速检测是否有 UnrealEditor.exe 进程
    execFile(
      "tasklist.exe",
      ["/FI", "IMAGENAME eq UnrealEditor.exe", "/NH"],
      { windowsHide: true, timeout: 2000 },
      (tasklistError, tasklistStdout) => {
        const isRunning = !tasklistError && String(tasklistStdout || "").toLowerCase().includes("unrealeditor.exe");
        
        if (!isRunning) {
          resolve([]);
          return;
        }

        // 2. 第二步：只有确认启动了，才去执行昂贵的 PowerShell 查询来获取工程路径
        execFile(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process -Filter \"Name='UnrealEditor.exe'\" 2>$null | Select-Object -ExpandProperty CommandLine"
          ],
          { windowsHide: true, timeout: 3000 },
          (error, stdout) => {
            if (error || !stdout) {
              resolve([]);
              return;
            }
            const lines = String(stdout)
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);

            const projectPaths = [];
            for (const line of lines) {
              const quotedDoubleMatches = [...line.matchAll(/"([^"]+\.uproject)"/gi)].map((m) => m?.[1]).filter(Boolean);
              const quotedSingleMatches = [...line.matchAll(/'([^']+\.uproject)'/gi)].map((m) => m?.[1]).filter(Boolean);
              const plainMatches = [...line.matchAll(/[A-Za-z]:[\\/][^\r\n"' ]*?\.uproject/gi)].map((m) => m?.[0]).filter(Boolean);
              const allMatches = [...new Set([...quotedDoubleMatches, ...quotedSingleMatches, ...plainMatches])];
              projectPaths.push(...allMatches);
            }
            resolve([...new Set(projectPaths)]);
          }
        );
      }
    );
  });
}

async function readFocusedUnrealProjectPath() {
  if (os.platform() !== "win32") {
    return "";
  }
  return new Promise((resolve) => {
    const psScript = [
      "Add-Type @\"",
      "using System;",
      "using System.Runtime.InteropServices;",
      "public class Win32 {",
      "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
      "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);",
      "}",
      "\"@;",
      "$hwnd = [Win32]::GetForegroundWindow();",
      "if ($hwnd -eq [IntPtr]::Zero) { exit 0 }",
      "$pid = 0;",
      "[Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null;",
      "if ($pid -le 0) { exit 0 }",
      "$proc = Get-CimInstance Win32_Process -Filter \"ProcessId=$pid\" 2>$null;",
      "if (!$proc) { exit 0 }",
      "if ($proc.Name -ne 'UnrealEditor.exe' -and $proc.Name -ne 'UE4Editor.exe') { exit 0 }",
      "$proc.CommandLine"
    ].join(" ");

    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psScript],
      { windowsHide: true, timeout: 2500 },
      async (error, stdout) => {
        if (error || !stdout) {
          resolve("");
          return;
        }
        const text = String(stdout || "").trim();
        if (!text) {
          resolve("");
          return;
        }
        const quotedDoubleMatches = [...text.matchAll(/"([^"]+\.uproject)"/gi)].map((m) => m?.[1]).filter(Boolean);
        const quotedSingleMatches = [...text.matchAll(/'([^']+\.uproject)'/gi)].map((m) => m?.[1]).filter(Boolean);
        const plainMatches = [...text.matchAll(/[A-Za-z]:[\\/][^\r\n"' ]*?\.uproject/gi)].map((m) => m?.[0]).filter(Boolean);
        const candidate = [...new Set([...quotedDoubleMatches, ...quotedSingleMatches, ...plainMatches])][0] || "";
        if (!candidate) {
          resolve("");
          return;
        }
        const resolvedPath = path.resolve(candidate);
        if (!(await exists(resolvedPath))) {
          resolve("");
          return;
        }
        resolve(resolvedPath);
      }
    );
  });
}

async function resolveUnrealOptions(options) {
  const info = await tcpClient.getEditorInfo(2500, {
    projectPath: options.unrealProjectPath, editorPath: options.unrealEditorPath
  });
  if (!info) throw new Error("未连接到兼容的 AssetHive 插件，请更新插件并打开 Unreal 项目");
  return {
    ...options,
    unrealProjectPath: info.projectPath,
    unrealRequestProjectPath: info.projectPath,
    unrealEditorPath: info.editorPath,
    unrealCommandPath: info.editorPath,
    unrealLogPath: path.join(app.getPath("userData"), "Log", "AssetHiveImport.log")
  };
}

async function ensurePluginInstalled(unrealProjectPath, unrealEditorPath) {
  const localPluginDir = await firstExistingFile([
    path.resolve(__dirname, "..", "..", "AssetHive-UE-Plugin", "AssetHive"),
    path.resolve(__dirname, "..", "..", "ue-plugin", "AssetHive")
  ]);

  // Already installed somewhere the engine will load? Treat as success.
  // 项目插件（Project/Plugins/AssetHive）也算已安装：见 getProjectPluginCandidateRoots 的说明。
  const existingPluginRoot = await findAssetHivePluginRoot(unrealProjectPath, unrealEditorPath);
  if (existingPluginRoot) {
    const inProject = getProjectPluginCandidateRoots(unrealProjectPath)
      .some((candidate) => path.resolve(candidate).toLowerCase() === path.resolve(existingPluginRoot).toLowerCase());
    return {
      copied: false,
      reason: inProject ? "Project already has AssetHive plugin" : "Engine already has AssetHive plugin",
      target: inProject ? "project" : "engine",
      path: existingPluginRoot
    };
  }

  if (!localPluginDir || !(await exists(localPluginDir))) {
    return { copied: false, reason: "AssetHive plugin is missing in local package" };
  }

  // Install directly under the engine's Plugins directory.
  const engineRoot = path.resolve(path.dirname(unrealEditorPath), "..", "..", "..");
  const enginePluginsDir = path.join(engineRoot, "Engine", "Plugins", "AssetHive");

  try {
    await fs.mkdir(path.dirname(enginePluginsDir), { recursive: true });
    await fs.cp(localPluginDir, enginePluginsDir, { recursive: true });
    return { copied: true, target: "engine", path: enginePluginsDir };
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EACCES")) {
      throw new Error("无法安装插件到引擎目录（权限不足）。请尝试以管理员身份运行软件，或手动将插件拷贝到引擎的 Engine/Plugins 目录。");
    }
    throw error;
  }
}

async function installPendingPlugins(unrealProjectPath, pluginsSourceDir) {
  if (!unrealProjectPath || !pluginsSourceDir || !(await exists(pluginsSourceDir))) return { installed: false, reason: "Invalid paths" };
  
  // Also default to engine plugins if possible, but this function seems to be for generic pending plugins
  // For now, let's keep it as is or remove if not used. 
  const projectPluginsDir = path.join(path.dirname(unrealProjectPath), "Plugins");
  
  try {
    const entries = await fs.readdir(pluginsSourceDir, { withFileTypes: true });
    if (entries.length === 0) return { installed: false, reason: "No plugins to install" };

    await fs.mkdir(projectPluginsDir, { recursive: true });

    let count = 0;
    for (const entry of entries) {
      const srcPath = path.join(pluginsSourceDir, entry.name);
      const destPath = path.join(projectPluginsDir, entry.name);
      
      // Copy directory or file
      await fs.cp(srcPath, destPath, { recursive: true, force: true });
      count++;
    }
    return { installed: true, count };
  } catch (e) {
    console.error("Failed to install pending plugins:", e);
    return { installed: false, error: e.message };
  }
}

function is3DAssetType(assetType) {
  const normalized = String(assetType || "").trim().toLowerCase();
  return normalized === "3d" || normalized === "3dplant";
}

function isAtlasAssetType(assetType) {
  return /^(atlas|atlases)$/i.test(String(assetType || "").trim());
}

function shouldAllowDisplacementByAssetType(assetType) {
  const normalized = String(assetType || "").trim().toLowerCase();
  return normalized === "surface" || normalized === "3dplant" || normalized === "3d" || normalized === "decal" || isAtlasAssetType(normalized);
}

// Zion 资产（zionTags 非空）走单独导出：按标准标签确定分类目录，用户选定的二级目录
// 追加在它之后（<分类>/<二级>/...），资产自身文件夹结构在该目录下保留。
// 非 Zion 资产仍按类型落到 3D_Assets/Surfaces/... 等分类。
// 插件侧能按 Asset Tag 判定的基础分类目录，权威定义在插件的
// ResolveEnvironmentAssetProfile（Dressing/Megascans/PBRMAX → Objects、
// Kits/Kit → Kit、Props → Props、Destructible → Destructible、MEGA → MEGA）。
//
// 这里只用来判断"插件的推导能不能给出结果"，不复制映射关系本身 ——
// 复刻一份必然与插件漂移。
const PLUGIN_CATEGORY_TAGS = Object.freeze([
  "mask", "mega", "kits", "kit", "destructible", "props", "dressing", "megascans", "pbrmax",
  // 第三方标签（2026-10-19）：插件据此把第三方资产落到 Objects/ThirdParty；
  // 这里必须一并列为"插件可推导"，否则导出侧会给出 3D_Assets 覆盖掉插件结果。
  "thirdparty",
]);

// 导出侧是否应该把基础分类目录交给插件推导。
//
// 判定为"能推导"时返回空串：插件拿到空串才会走 ResolveEnvironmentAssetProfile，
// 按 Asset Tag 落到对应目录。否则导出侧直接给目录名（3D_Assets / Surfaces / …）。
//
// 为什么 Megascans / PBRMAX 必须走这条路：它们的 standardAssetTags 里就带
// "Megascans" / "PBRMAX"，插件会正确地落到 Objects；而导出侧按 assetType="3d"
// 推出来的是 3D_Assets，一旦把 "3D_Assets" 传下去就会**覆盖**插件的正确结果
// （插件只在为空时推导）。实测这两个来源的资产正是这样跑到了 3D_Assets 下。
function shouldDelegateCategoryFolderToPlugin(tags) {
  return (Array.isArray(tags) ? tags : []).some((tag) => {
    // 与插件 HasAssetTag 的归一化保持一致：忽略大小写与空格/下划线/连字符，
    // 这样 "Third Party" / "third-party" / "PBR-MAX" 等写法都能识别。
    const normalized = String(tag || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
    return normalized.length > 0 && PLUGIN_CATEGORY_TAGS.includes(normalized);
  });
}

// 非 Zion、且插件无法按 tag 推导的资产，仍按类型落到 3D_Assets/Surfaces/... 等分类。
function resolveImportCategoryFolder(asset) {
  const normalized = String(asset?.assetType || "").trim().toLowerCase();
  if (normalized === "3d") return "3D_Assets";
  if (normalized === "3dplant") return "3D_Plants";
  if (normalized === "surface") return "Surfaces";
  if (normalized === "decal") return "Decals";
  if (normalized === "hdri") return "HDRI";
  return "Others";
}

// 第三方标记（2026-10-29 定稿）：标准 Asset Tag 的 ThirdParty，或 tags 里的
// Megascans / PBRMAX 来源标记。命中即为第三方资产，否则**默认按 Zion 资产**处理
// （含 Temp 资产）。
const THIRD_PARTY_MARKER_TAGS = Object.freeze(["thirdparty", "第三方", "megascans", "pbrmax"]);

function hasThirdPartyMarker(asset, meta) {
  if (String(asset?.assetType || meta?.assetType || "").trim().toLowerCase() === "3dplant") {
    const source = String(meta?.identity?.sourceKind || meta?.sourceKind || "").trim().toLowerCase();
    if (THIRD_PARTY_MARKER_TAGS.includes(source) || isMegascansBridgeMetadata(meta)) return true;
  }
  const collect = (value) => (Array.isArray(value) ? value : []);
  const all = [
    ...collect(asset?.standardAssetTags),
    ...collect(meta?.standardAssetTags),
    ...collect(asset?.tags),
    ...collect(meta?.tags),
  ];
  return all.some((tag) => {
    // 归一化与插件 HasAssetTag 保持一致：忽略大小写与空格/下划线/连字符。
    const normalized = String(tag || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
    return normalized.length > 0 && THIRD_PARTY_MARKER_TAGS.includes(normalized);
  });
}

// Zion 资产判定（2026-10-29 定稿）：**默认就是 Zion** —— 只要没有第三方标记
// （ThirdParty 标准标签 / Megascans / PBRMAX），就按 Zion 资产导出。
// **带 Temp 的一律视作 Zion**（即使同时带第三方标记）：Temp 是工作状态标记，
// 走 Zion 的目录/命名约定（<分类>/… + zionSubfolder + 无 _<id>），只额外叠 Temp_ 前缀。
// 之前依据"zionTags 非空"判定，导致未打第三方标签的自研资产被当成普通资产。
function isZionAsset(asset, meta) {
  return hasTempTag(asset, meta) || !hasThirdPartyMarker(asset, meta);
}

// 植被策略与 UE 收到的 Zion 标记一致；显式 Zion Tags 优先于历史来源标签。
function isZionPlantAsset(asset, meta = asset?.meta) {
  if (String(asset?.assetType || meta?.assetType || "").trim().toLowerCase() !== "3dplant") return false;
  const zionTags = Array.isArray(asset?.zionTags) ? asset.zionTags : meta?.zionTags;
  const hasZionTags = Array.isArray(zionTags) && zionTags.some((tag) => typeof tag === "string" && tag.trim());
  return hasZionTags || isZionAsset(asset, meta);
}

function isNamedZionPlantAsset(asset, meta = asset?.meta) {
  const tags = Array.isArray(asset?.zionTags) ? asset.zionTags : meta?.zionTags;
  return isZionPlantAsset(asset, meta) && Array.isArray(tags)
    && tags.some((tag) => typeof tag === "string" && tag.trim());
}

// Temp 标记（临时/草稿资产）：命中后资产文件夹加 Temp_ 前缀、对象名带 Temp 段。
// 与 Zion 共存时 Temp 优先，但保留 Zion 的"无 ID 后缀 / 去 Env_ 前缀"规则，只叠加前缀。
function hasTempTag(asset, meta) {
  const collect = (value) => (Array.isArray(value) ? value : []);
  const all = [
    ...collect(asset?.standardAssetTags),
    ...collect(meta?.standardAssetTags),
    ...collect(asset?.tags),
  ];
  return all.some((tag) => String(tag || "").trim().toLowerCase() === "temp");
}

// Zion 资产的目标二级目录：只取资产自身元数据（zionExportSubfolder，由导出面板的
// 按钮弹层写入 asset_info.json），每个资产各自独立。
//
// 空串是有效取值，表示"直接放在各自分类目录下"——既包括用户明确清空，也包括从未设置过
// 的资产。刻意不做任何应用设置层面的回退：一旦回退，某个资产的目标目录就取决于
// 上一次在别的资产上填过什么，既不可预期，也会让"清空"被静默改回来。
function resolveZionSubfolderForAsset(asset) {
  const own = asset?.zionExportSubfolder;
  if (own === undefined || own === null) {
    return "";
  }
  return String(own).trim();
}

function sanitizeImportPathSegment(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  return normalized.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_");
}

function sanitizeFolderToken(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\s\-.]+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function stripTrailingIdSuffix(name, idToken) {
  if (!name || !idToken) {
    return name;
  }
  const lowerName = name.toLowerCase();
  const lowerId = idToken.toLowerCase();
  if (lowerName.endsWith(`_${lowerId}`)) {
    const trimmed = name.slice(0, -(`_${lowerId}`.length));
    return trimmed || name;
  }
  return name;
}

// Env_ 与 Temp_ 属"前缀层"，不参与名字本身。二者可能以任意顺序叠加
// （Env_Temp_x / Temp_Env_x），因此循环剥离直到都不匹配为止，
// 再由调用方按标记统一加回，避免叠成 Temp_Env_Temp_...。
function stripObjectPrefixLayers(value, { stripEnvPrefix = false } = {}) {
  let result = String(value || "").trim();
  for (let guard = 0; guard < 8; guard += 1) {
    if (/^temp_/i.test(result)) { result = result.slice(5).trim(); continue; }
    if (stripEnvPrefix && /^env_/i.test(result)) { result = result.slice(4).trim(); continue; }
    break;
  }
  return result;
}

// Zion 资产（zionTags 非空）走单独的导出约定：资产文件夹不带 _<id> 后缀，
// 以便与美术在引擎里约定的目录结构保持一致。第三方资产仍带后缀，避免同名覆盖。
function resolveImportAssetFolderName(asset, options = {}) {
  const omitIdSuffix = Boolean(options?.omitIdSuffix);
  const safeId = sanitizeFolderToken(asset?.id) || "UnknownId";
  const candidates = [
    asset?.name,
    asset?.slug,
    asset?.path ? path.basename(String(asset.path)) : "",
  ];
  let baseName = "";
  for (const candidate of candidates) {
    const cleaned = sanitizeFolderToken(candidate);
    if (!cleaned) {
      continue;
    }
    const trimmed = stripTrailingIdSuffix(cleaned, safeId);
    // Strip leading asset-type prefix that some sources (e.g. Megascans path
    // basenames like "3d_xxx" or "surface_xxx") prepend, so the folder name
    // matches the displayed asset name as closely as possible.
    const withoutTypePrefix = trimmed.replace(/^(?:3dplant|3d|surface|decal|hdri)_/i, "");
    const finalCandidate = withoutTypePrefix || trimmed;
    if (finalCandidate) {
      baseName = finalCandidate;
      break;
    }
  }
  if (!baseName) {
    baseName = "AssetHiveAsset";
  }
  // 先剥 ID 后缀，再剥前缀层（Env_ / Temp_ 可任意顺序叠加），
  // 最后由调用方按标记加回 Temp_，并在需要时补回 ID 后缀。
  // 顺序很重要：若先剥前缀会把 ID 一起带走，导致 ID 被重复拼接。
  const baseWithoutId = stripTrailingIdSuffix(baseName, safeId) || baseName;
  const cleaned = stripObjectPrefixLayers(baseWithoutId, { stripEnvPrefix: true });
  const finalName = cleaned || baseName;
  return omitIdSuffix ? finalName : `${finalName}_${safeId}`;
}

function pickHighPolyModel(asset) {
  const candidates = Array.isArray(asset?.modelFiles) ? asset.modelFiles.filter((item) => typeof item === "string" && item.trim()) : [];
  if (candidates.length === 0) {
    return "";
  }

  const resolveFromCandidates = (value) => {
    const normalized = String(value || "").trim();
    if (!normalized) {
      return "";
    }
    const byAbsolute = candidates.find((item) => path.resolve(item).toLowerCase() === path.resolve(normalized).toLowerCase());
    if (byAbsolute) {
      return byAbsolute;
    }
    const normalizedToken = normalized.replace(/\\/g, "/").toLowerCase();
    const byEndsWith = candidates.find((item) => item.replace(/\\/g, "/").toLowerCase().endsWith(normalizedToken));
    if (byEndsWith) {
      return byEndsWith;
    }
    const baseName = path.basename(normalized).toLowerCase();
    if (!baseName) {
      return "";
    }
    return candidates.find((item) => path.basename(item).toLowerCase() === baseName) || "";
  };

  const meta = asset?.meta && typeof asset.meta === "object" ? asset.meta : null;
  const modelSlots = meta?.modelSlots && typeof meta.modelSlots === "object" && !Array.isArray(meta.modelSlots) ? meta.modelSlots : null;
  if (modelSlots) {
    const highPolyFromSlots = Object.entries(modelSlots).find(([slot]) => String(slot || "").trim().toLowerCase() === "highpoly");
    if (highPolyFromSlots && typeof highPolyFromSlots[1] === "string" && highPolyFromSlots[1].trim()) {
      return resolveFromCandidates(highPolyFromSlots[1]);
    }
  }

  const components = Array.isArray(meta?.components) ? meta.components : [];
  const highPolyComponent = components.find((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    if (String(item.type || "").trim().toLowerCase() !== "model") {
      return false;
    }
    return String(item.slot || "").trim().toLowerCase() === "highpoly";
  });
  if (highPolyComponent) {
    return resolveFromCandidates(highPolyComponent.uri || highPolyComponent.path || "");
  }
  return "";
}

function exportModelVariantFields(value) {
  const rawVariant = value && typeof value === "object"
    ? (value.variantKey ?? value.variation ?? value.variant ?? value.variantNumber)
    : value;
  const variantKey = normalizeModelVariantKey(rawVariant, "01");
  const variantNumber = modelVariantNumberFromKey(variantKey);
  return {
    variantKey,
    ...(variantNumber > 0 ? { variantNumber } : {})
  };
}

function collectCustomJsonModelVariants(asset, metaOverride) {
  const meta = metaOverride && typeof metaOverride === "object" ? metaOverride : (asset?.meta && typeof asset.meta === "object" ? asset.meta : null);
  const assetRoot = typeof asset?.path === "string" && asset.path.trim() ? asset.path : "";
  const unique = new Map();
  const pushPath = (value, variantCandidate) => {
    const raw = typeof value === "string"
      ? value
      : String(value?.file || value?.path || value?.uri || "").trim();
    if (!raw) {
      return;
    }
    const resolved = path.isAbsolute(raw)
      ? path.resolve(raw)
      : (assetRoot ? path.resolve(assetRoot, raw) : path.resolve(raw));
    if (!MODEL_FILE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      return;
    }
    const key = resolved.toLowerCase();
    const previous = unique.get(key);
    const candidateKey = normalizeModelVariantKey(
      variantCandidate?.variantKey
        ?? variantCandidate?.variation
        ?? variantCandidate?.variant
        ?? variantCandidate?.variantNumber
    );
    const variantKey = previous?.variantKey
      || candidateKey
      || parseModelVariantKey(resolved)
      || "01";
    unique.set(key, {
      file: resolved,
      ...exportModelVariantFields(variantKey)
    });
  };

  if (Array.isArray(meta?.modelVariants)) {
    for (const item of meta.modelVariants) {
      pushPath(item, item);
    }
  }
  if (Array.isArray(meta?.components)) {
    for (const item of meta.components) {
      if (!item || typeof item !== "object" || String(item.type || "").trim().toLowerCase() !== "model") {
        continue;
      }
      pushPath(item.path || item.uri || item.file, item);
    }
  }
  if (meta?.modelSlots && typeof meta.modelSlots === "object" && !Array.isArray(meta.modelSlots)) {
    for (const item of Object.values(meta.modelSlots)) {
      pushPath(item);
    }
  }
  if (Array.isArray(meta?.modelFiles)) {
    for (const item of meta.modelFiles) {
      pushPath(item);
    }
  }
  return [...unique.values()].sort((a, b) => (
    compareModelVariantKeys(a.variantKey, b.variantKey) || a.file.localeCompare(b.file)
  ));
}

function collectCustomJsonModelFiles(asset, metaOverride) {
  return collectCustomJsonModelVariants(asset, metaOverride).map((item) => item.file);
}

function pickExportModelVariants(asset, metaOverride) {
  const assetType = String(asset?.assetType || "").trim().toLowerCase();
  if (!is3DAssetType(assetType)) {
    return [];
  }
  const source = String(asset?.source || "").trim().toLowerCase();
  if (source === "custom") {
    const variants = collectCustomJsonModelVariants(asset, metaOverride);
    if (variants.length > 0) {
      return variants;
    }
    return pickExportModelFiles(asset, metaOverride).map((file) => ({
    file,
    ...exportModelVariantFields(parseModelVariantKey(file) || "01")
  })).sort((a, b) => (
    compareModelVariantKeys(a.variantKey, b.variantKey) || a.file.localeCompare(b.file)
  ));
  }
  return pickExportModelFiles(asset, metaOverride).map((file) => ({
    file,
    ...exportModelVariantFields(parseModelVariantKey(file) || "01")
  })).sort((a, b) => (
    compareModelVariantKeys(a.variantKey, b.variantKey) || a.file.localeCompare(b.file)
  ));
}

function pickExportModelFiles(asset, metaOverride) {
  const assetType = String(asset?.assetType || "").trim().toLowerCase();
  if (!is3DAssetType(assetType)) {
    return [];
  }
  const source = String(asset?.source || "").trim().toLowerCase();
  const candidates = Array.isArray(asset?.modelFiles) ? asset.modelFiles.filter((item) => typeof item === "string" && item.trim()) : [];
  if (source === "custom") {
    const jsonModelFiles = collectCustomJsonModelFiles(asset, metaOverride);
    return jsonModelFiles.length > 0 ? jsonModelFiles : candidates;
  }
  if (candidates.length === 0) {
    return [];
  }
  const highPoly = pickHighPolyModel(asset);
  if (highPoly) {
    return [highPoly];
  }
  const preferred = [...candidates].sort((a, b) => {
    const rank = (filePath) => {
      const name = path.basename(String(filePath || "")).toLowerCase();
      if (name.includes("highpoly") || name.includes("_high") || name.includes("-high")) return 0;
      if (name.includes("lod0")) return 1;
      if (name.includes("lod1")) return 2;
      if (name.includes("lod2")) return 3;
      return 4;
    };
    return rank(a) - rank(b);
  });
  return [preferred[0]];
}

function normalizeExportTag(value) {
  return String(value || "").trim().toLowerCase();
}

function collectExportStandardTags(asset, meta) {
  const tags = new Set();
  const pushValue = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach(pushValue);
      return;
    }
    if (typeof value === "object") {
      for (const key of ["contains", "theme", "descriptive", "environment", "subject_matter", "asset_type", "tags", "standardAssetTags", "categories"]) {
        pushValue(value[key]);
      }
      return;
    }
    const normalized = normalizeExportTag(value);
    if (normalized) tags.add(normalized);
  };
  for (const source of [
    meta?.standardAssetTags,
    asset?.standardAssetTags,
    meta?.tags,
    asset?.tags,
    meta?.category,
    asset?.category,
    meta?.categories,
    asset?.categories,
    meta?.themes,
    asset?.themes,
    meta?.semanticTags,
    asset?.semanticTags
  ]) {
    pushValue(source);
  }
  return tags;
}

// 导出 job 的 tags 只带"真实标签"，剔掉库内为了搜索而混进来的派生词。
//
// 背景：库内 tagsJson 由 [assetType, category, animationAffiliation, 标准标签, Zion 标签,
// 用户标签] 合并归一化而成。插件侧 CollectAssetTags 会把 job 的 standardAssetTags 与 tags
// 合并后再分类，于是 3D 资产的 category（常见 "Props"）以 "props" 混进 tags，让
// Megascans / PBRMAX 资产被 ResolveEnvironmentAssetProfile 误判成 Props 档：预算降档
// （次要贴图上限 1024）、对象名带 Prop 段、资产落 Props/ 目录，并且 ORM 等次要贴图因
// <2048 无法开 VT（UE 警告 "expects texture to be Virtual"）。插件侧已改为只认
// standardAssetTags 做分类；这里再从数据源头清掉派生词，避免其它消费方踩同样的坑。
//
// 规则：
//   - 显式出现在 standardAssetTags / zionTags 里的词一律保留（那确实是真标签，
//     例如显式 Props 标准标签；已撤销的 Tile 标准标签不保留）；
//   - 3D Plants 整包保留原 tags：其 category 派生词（tree/bush/grass/fern…）是插件判定
//     植被子类的语义信号，剔除会改变落点与预算；
//   - 其它类型剔除 assetType / subType / category / animationAffiliation 的派生词。
function resolveExportJobTags(asset, fullMeta) {
  const tags = Array.isArray(asset?.tags)
    ? asset.tags.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const assetType = String(asset?.assetType || "").trim().toLowerCase();
  if (assetType === "3dplant") {
    return tags;
  }
  const normalize = (value) => String(value || "").trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "");
  const explicitTags = new Set();
  for (const source of [
    asset?.standardAssetTags, fullMeta?.standardAssetTags,
    asset?.zionTags, fullMeta?.zionTags,
  ]) {
    if (!Array.isArray(source)) continue;
    for (const value of source) {
      const token = normalize(value);
      if (token && !(assetType === "surface" && token === "tile")) explicitTags.add(token);
    }
  }
  const derivedTags = new Set();
  const addDerived = (value) => {
    const token = normalize(value);
    if (token) derivedTags.add(token);
  };
  // assetType 的派生写法（含库内 subType 形式，如 "3D Assets" / "Decals" / "Surfaces"）。
  const assetTypeDerivedAliases = {
    "3d": ["3d", "3d assets", "3d asset", "3dassets", "asset3d"],
    surface: ["surface", "surfaces", "material", "materials", "tile", "tiles"],
    decal: ["decal", "decals"],
    atlas: ["atlas", "atlases"],
    atlases: ["atlas", "atlases"],
    hdri: ["hdri", "hdr"],
    animation: ["animation"],
  };
  addDerived(assetType);
  addDerived(asset?.subType);
  addDerived(fullMeta?.subType);
  addDerived(fullMeta?.category ?? asset?.category);
  addDerived(fullMeta?.animationAffiliation ?? asset?.animationAffiliation);
  for (const alias of assetTypeDerivedAliases[assetType] || []) {
    addDerived(alias);
  }
  const result = [];
  const seen = new Set();
  for (const tag of tags) {
    const token = normalize(tag);
    if (!token || seen.has(token)) continue;
    if (derivedTags.has(token) && !explicitTags.has(token)) continue;
    seen.add(token);
    result.push(tag);
  }
  return result;
}

function isOpaqueExportVariantKey(value) {
  return /OPAQUE$/i.test(String(value || "").trim());
}

// Legacy library metadata numbered the cut meshes as extra implicit variants
// (…_01OPAQUE.fbx / …_01_OPAQUE.fbx stored as variant 21, 22, …). Both the key suffix and the
// file stem are therefore inspected before an entry is treated as the opaque
// cut of a source variant.
function isOpaqueExportModelFile(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  const stem = path.basename(raw, path.extname(raw));
  return isOpaqueExportVariantKey(stem);
}

function isOpaqueExportModelVariant(item) {
  if (!item) return false;
  if (item.opaque === true) return true;
  const key = item.variantKey ?? item.variation ?? item.variant ?? "";
  if (isOpaqueExportVariantKey(key)) return true;
  return isOpaqueExportModelFile(item.file || item.path || item.uri || "");
}

function readOpaqueExportBaseVariantKey(item) {
  if (!item) return "";
  const key = normalizeModelVariantKey(item.variantKey ?? item.variation ?? item.variant ?? "");
  if (isOpaqueExportVariantKey(key)) {
    return normalizeModelVariantKey(key.replace(/OPAQUE$/i, ""), "01");
  }
  const file = String(item.file || item.path || item.uri || "").trim();
  if (!file) return "";
  const stem = path.basename(file, path.extname(file));
  if (!isOpaqueExportVariantKey(stem)) return "";
  const withoutSuffix = stem.replace(/[_\-. ]*OPAQUE$/i, "");
  const parsed = parseModelVariantKey(withoutSuffix) || readExportModelVariantKey(withoutSuffix, "");
  if (!parsed || isOpaqueExportVariantKey(parsed)) return "";
  return normalizeModelVariantKey(parsed, "01");
}

function resolveExportModelPath(asset, value) {
  const raw = typeof value === "string"
    ? value
    : String(value?.file || value?.path || value?.uri || "").trim();
  if (!raw) return "";
  const assetRoot = typeof asset?.path === "string" && asset.path.trim() ? asset.path : "";
  const resolved = path.isAbsolute(raw)
    ? path.resolve(raw)
    : (assetRoot ? path.resolve(assetRoot, raw) : path.resolve(raw));
  return MODEL_FILE_EXTENSIONS.has(path.extname(resolved).toLowerCase()) ? resolved : "";
}

function readExportModelVariantKey(value, fallback = "01") {
  const explicit = value?.variantKey ?? value?.variation ?? value?.variant
    ?? value?.variantName ?? value?.variationName ?? value?.variantNumber;
  if (explicit != null && String(explicit).trim()) return normalizeModelVariantKey(explicit, fallback);
  const file = typeof value === "string" ? value : value?.file || value?.path || value?.uri;
  return parseModelVariantKey(file || "") || fallback;
}

function collectExportModelVariantsForPlan(asset, metaOverride) {
  const meta = metaOverride && typeof metaOverride === "object"
    ? metaOverride
    : (asset?.meta && typeof asset.meta === "object" ? asset.meta : null);
  const unique = new Map();
  const push = (value, candidate) => {
    const file = resolveExportModelPath(asset, value);
    if (!file) return;
    const key = file.toLowerCase();
    if (unique.has(key)) return;
    const variantKey = readExportModelVariantKey(
      candidate || value,
      parseModelVariantKey(file) || "01"
    );
    unique.set(key, { file, ...exportModelVariantFields(variantKey), ...(candidate?.opaque === true ? { opaque: true } : {}) });
  };

  if (Array.isArray(meta?.modelVariants)) {
    for (const item of meta.modelVariants) push(item, item);
  }
  if (Array.isArray(meta?.components)) {
    for (const item of meta.components) {
      if (!item || String(item.type || "").trim().toLowerCase() !== "model") continue;
      push(item.path || item.uri || item.file, item);
    }
  }
  if (meta?.modelSlots && typeof meta.modelSlots === "object" && !Array.isArray(meta.modelSlots)) {
    for (const item of Object.values(meta.modelSlots)) push(item);
  }
  if (Array.isArray(meta?.modelFiles)) {
    for (const item of meta.modelFiles) push(item);
  }
  if (unique.size === 0 && Array.isArray(asset?.modelFiles)) {
    for (const item of asset.modelFiles) push(item);
  }
  return [...unique.values()].sort((a, b) => (
    compareModelVariantKeys(a.variantKey, b.variantKey) || a.file.localeCompare(b.file)
  ));
}

function collectExportModelLodsForPlan(asset, metaOverride) {
  const meta = metaOverride && typeof metaOverride === "object"
    ? metaOverride
    : (asset?.meta && typeof asset.meta === "object" ? asset.meta : null);
  const unique = new Map();
  const list = Array.isArray(meta?.modelLods) ? meta.modelLods : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const file = resolveExportModelPath(asset, item);
    if (!file) continue;
    const lod = Math.max(0, Math.floor(Number(item.lod) || 0));
    const variantKey = readExportModelVariantKey(item, parseModelVariantKey(file) || "01");
    const key = variantKey + "\u0000" + String(lod);
    const billboard = item.materialRole === "billboard" || item.representation === "billboard" || item.useBillboardMaterial === true;
    if (!unique.has(key)) unique.set(key, { file, variantKey, lod,
      ...(billboard ? { materialRole: "billboard" } : {}), ...(item.opaque === true ? { opaque: true } : {}) });
  }
  return [...unique.values()].sort((a, b) => (
    compareModelVariantKeys(a.variantKey, b.variantKey) ||
    a.lod - b.lod ||
    a.file.localeCompare(b.file)
  ));
}

// FBX 植被导出方式。naniteMasked 仅使用原始 LOD0，不导出裁切网格、LOD 链或 Billboard。
// - "opaque"：使用 _OPAQUE 裁切模型作主模型，使用真正的 Opaque 材质，不带任何 LOD；
//   该变体没有裁切模型时回退为 Nanite Masked，仅使用原始 LOD0。
// - "lod"：使用原始 Masked 模型作 LOD0，并携带该变体自己的 LOD 链（目标 LOD1..N）。
function normalizePlantExportMode(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized === "nanitefoliage") return "naniteFoliage";
  if (normalized === "nanitemasked") return "naniteMasked";
  if (normalized === "lod" || normalized === "lods" || normalized === "masked" ||
      normalized === "maskedlod" || normalized === "maskedlods") {
    return "lod";
  }
  return "opaque";
}

// Zion 资产（zionTags 非空）导出时，由用户指定各自分类目录之后的二级目录。
// 该值会直接进入 Unreal 包路径，因此必须逐段净化：
//   - 统一分隔符为 "/"，丢弃空段与 "." / ".."（防路径穿越）
//   - 每段只保留字母/数字/下划线/横线，去掉其它字符后再把横线折成下划线
// 段数上限 4，避免长路径触发 Windows 路径长度限制。
function normalizeZionObjectSubfolder(value) {
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

function normalizePlantSyntheticWind(value) {
  const normalized = String(value ?? "auto").trim().toLowerCase().replace(/[\s_-]+/g, "");
  return (normalized === "auto" || normalized === "micro" || PLANT_WIND_FORMS.includes(normalized)) ? normalized : "";
}

async function fitsMicroPlantMeshes(asset, meta, inspection) {
  if (typeof inspection?.fitsMicroSize === "boolean") return inspection.fitsMicroSize;
  const originals = buildExportModelPlan(asset, meta, "naniteMasked").modelVariants;
  if (!originals.length || originals.length < (inspection?.variantCount ?? 0) || originals.some(isOpaqueExportModelVariant)) return false;
  for (const file of new Set(originals.map(model => model.file))) {
    const result = await analyzeFbxInWorker(file, { measurePlant: true });
    if (fitsMicroSizeCm(result.plantSizeCm) !== true) return false;
  }
  return true;
}

function collectPlantLodChain(base, lodsByVariant, variantKey) {
  const sourceLods = (lodsByVariant.get(variantKey) || []).slice().sort((a, b) => a.lod - b.lod);
  const lodByOrder = new Map();
  for (const item of sourceLods) {
    if (!lodByOrder.has(item.lod)) lodByOrder.set(item.lod, item);
  }
  const chain = [];
  const seen = new Set([String(base?.file || "").toLowerCase()]);
  for (const [, item] of [...lodByOrder.entries()].sort((a, b) => a[0] - b[0])) {
    const { file } = item;
    if (!file) continue;
    const key = String(file).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    chain.push({
      file,
      ...exportModelVariantFields(variantKey),
      lod: chain.length + 1,
      ...(item.materialRole === "billboard" ? { materialRole: "billboard" } : {})
    });
  }
  return chain;
}

function buildExportModelPlan(asset, metaOverride, plantExportMode = "opaque") {
  const assetType = String(asset?.assetType || "").trim().toLowerCase();
  if (!is3DAssetType(assetType)) {
    return { modelVariants: [], modelLods: [] };
  }
  const meta = metaOverride && typeof metaOverride === "object"
    ? metaOverride
    : (asset?.meta && typeof asset.meta === "object" ? asset.meta : null);
  const zionPlant = isZionPlantAsset(asset, meta);
  const defaultPlan = () => ({
    modelVariants: pickExportModelVariants(asset, meta).filter((item) => !zionPlant || !isOpaqueExportModelVariant(item)),
    modelLods: []
  });
  const requestedMode = normalizePlantExportMode(plantExportMode);
  const naniteMasked = assetType === "3dplant" && requestedMode === "naniteMasked";
  if (assetType !== "3dplant") {
    return defaultPlan();
  }

  const allVariants = collectExportModelVariantsForPlan(asset, meta);
  // 导出方式只对 FBX 原始资产生效：只要出现 st9 等非 FBX 模型（或没有模型文件），
  // 就退回默认导出计划（不带 _OPAQUE 裁切变体、不合并 LOD 链）。
  const lodEntries = collectExportModelLodsForPlan(asset, meta);
  if (naniteMasked) {
    const candidates = [...lodEntries, ...allVariants];
    if (!candidates.length || candidates.some(item => !/\.fbx$/i.test(item.file))) return defaultPlan();
    // Older libraries also list LOD1+ in modelFiles. Explicit LOD0 metadata
    // takes precedence over the unsuffixed original mesh of the same variant.
    const bases = new Map();
    const higherLods = new Set(lodEntries.filter(item => item.lod > 0).map(item => item.file.toLowerCase()));
    const cutFiles = new Set(candidates.filter(isOpaqueExportModelVariant).map(item => item.file.toLowerCase()));
    const required = new Set();
    for (const item of candidates) {
      const stem = path.parse(item.file).name;
      const namedLod = stem.match(/(?:^|[_ .-])lod[_ .-]*(\d+)(?:$|[_ .-])/i);
      if (/(?:^|[_ .-])billboard(?:$|[_ .-])/i.test(stem)) continue;
      if (cutFiles.has(item.file.toLowerCase())) {
        const originalKey = readOpaqueExportBaseVariantKey(item);
        if (originalKey) required.add(originalKey);
        continue;
      }
      required.add(item.variantKey);
      if (higherLods.has(item.file.toLowerCase()) || (namedLod && Number(namedLod[1]) > 0)) continue;
      const priority = item.lod === 0 ? 0 : namedLod ? 1 : 2;
      if (!bases.has(item.variantKey) || priority < bases.get(item.variantKey).priority) bases.set(item.variantKey, { item, priority });
    }
    const modelVariants = [...bases.values()].map(({ item }) => ({ file: item.file, ...exportModelVariantFields(item.variantKey) }))
      .sort((a, b) => compareModelVariantKeys(a.variantKey, b.variantKey));
    const missing = [...required].filter(key => !bases.has(key));
    if (!modelVariants.length || missing.length) throw new Error(`Nanite Masked 缺少原始 LOD0 FBX：${asset.name || asset.id} ${missing.join(", ")}`.trim());
    return { modelVariants, modelLods: [], naniteMasked: true };
  }
  const isFbxSource = allVariants.length > 0
    && allVariants.every((item) => path.extname(String(item.file || "")).toLowerCase() === ".fbx");
  if (!isFbxSource) {
    return defaultPlan();
  }
  const variantByKey = new Map();
  const opaqueByVariantKey = new Map();
  for (const item of allVariants) {
    if (isOpaqueExportModelVariant(item)) {
      const baseKey = readOpaqueExportBaseVariantKey(item);
      if (baseKey && !opaqueByVariantKey.has(baseKey)) {
        opaqueByVariantKey.set(baseKey, item);
      }
      // Cut meshes never act as standalone masked variants.
      continue;
    }
    const variantKey = normalizeModelVariantKey(item.variantKey || parseModelVariantKey(item.file) || "01");
    if (!variantByKey.has(variantKey)) variantByKey.set(variantKey, item);
  }
  const lodsByVariant = new Map();
  for (const item of lodEntries) {
    if (zionPlant && isOpaqueExportModelVariant(item)) continue;
    const list = lodsByVariant.get(item.variantKey) || [];
    list.push(item);
    lodsByVariant.set(item.variantKey, list);
  }

  const mode = requestedMode;
  const normalKeys = [...variantByKey.keys()].filter((key) => !isOpaqueExportVariantKey(key));
  normalKeys.sort(compareModelVariantKeys);
  const modelVariants = [];
  const modelLods = [];
  for (const variantKey of normalKeys) {
    const normal = variantByKey.get(variantKey);
    if (!normal) continue;
    const opaque = !zionPlant && (opaqueByVariantKey.get(variantKey)
      || variantByKey.get(variantKey + "OPAQUE"));
    if (mode === "opaque" && opaque) {
      modelVariants.push({
        file: opaque.file,
        ...exportModelVariantFields(variantKey),
        opaque: true
      });
      continue;
    }
    modelVariants.push({
      file: normal.file,
      ...exportModelVariantFields(variantKey),
      ...(mode === "opaque" ? { naniteMasked: true } : {})
    });
    if (mode === "lod") modelLods.push(...collectPlantLodChain(normal, lodsByVariant, variantKey));
  }
  if (modelVariants.length === 0) {
    return defaultPlan();
  }
  return { modelVariants, modelLods };
}

function shouldExcludeBillboardTextureGroups(asset, assetType, meta, plantExportMode = "opaque") {
  return assetType === "3dplant" && normalizePlantExportMode(plantExportMode) !== "lod";
}

function filterPlantTextureGroupsForExport(asset, assetType, meta, groups, plantExportMode = "opaque", exportModelPlan = null) {
  const list = Array.isArray(groups) ? groups : [];
  // OPAQUE is a job-level export choice, not a per-variant choice. Even when a
  // variant falls back to the masked source because no cut mesh exists, the
  // opaque job must not carry Billboard textures or materials.
  if (!exportModelPlan?.naniteMasked && !shouldExcludeBillboardTextureGroups(asset, assetType, meta, plantExportMode)) {
    return list;
  }
  const assetRoot = String(asset?.path || "").trim();
  const getRolePath = (value) => {
    const rawPath = typeof value === "string"
      ? value
      : String(value?.file || value?.path || value?.uri || "");
    if (!rawPath || !assetRoot || !path.isAbsolute(rawPath)) {
      return rawPath;
    }
    const relative = path.relative(assetRoot, rawPath);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
      ? relative
      : rawPath;
  };
  const filtered = [];
  for (const group of list) {
    if (!group || typeof group !== "object") continue;
    if (String(group.materialRole || "").trim().toLowerCase() === "billboard") {
      continue;
    }
    if (!(group.bySlot instanceof Map)) {
      filtered.push(group);
      continue;
    }
    const nextBySlot = new Map();
    for (const [slot, value] of group.bySlot.entries()) {
      if (normalizeTextureMaterialRole("", getRolePath(value), "") === "billboard") {
        continue;
      }
      nextBySlot.set(slot, value);
    }
    if (nextBySlot.size === 0) continue;
    filtered.push({ ...group, bySlot: nextBySlot });
  }
  return filtered;
}

function collectTextureBySlotFromJson(asset, assetType, targetResolutionPixels = 4096) {
  const normalizedAssetType = String(assetType || "").trim().toLowerCase();
  const slotDetector = normalizedAssetType === "surface" ? detectSurfaceTextureSlotByFileName : detectTextureSlotByFileName;
  const allowedSlots = normalizedAssetType === "surface" ? SURFACE_EXPORT_TEXTURE_SLOTS : ALLOWED_EXPORT_TEXTURE_SLOTS;
  const textureCandidates = Array.isArray(asset?.textureFiles)
    ? asset.textureFiles.filter((filePath) => typeof filePath === "string" && filePath.trim())
    : [];
  
  // Sort candidates globally so that higher resolution textures come first
  textureCandidates.sort((a, b) => {
    const getResScore = (name) => {
      const lowerName = path.basename(name).toLowerCase();
      // First priority is resolution
      let score = 0;
      if (lowerName.includes("8k") || lowerName.includes("_8k_")) score += 8000;
      else if (lowerName.includes("4k") || lowerName.includes("_4k_")) score += 4000;
      else if (lowerName.includes("2k") || lowerName.includes("_2k_")) score += 2000;
      else if (lowerName.includes("1k") || lowerName.includes("_1k_")) score += 1000;
      
      // Secondary priority: for displacement prefer EXR, for others prefer JPG/PNG
      if (lowerName.includes("displacement") || lowerName.includes("bump") || lowerName.includes("height")) {
        if (lowerName.endsWith(".exr")) score += 100;
        else if (lowerName.endsWith(".png")) score += 50;
        else if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) score += 40;
      } else {
        if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) score += 100;
        else if (lowerName.endsWith(".png")) score += 90;
        else if (lowerName.endsWith(".exr")) score += 50;
      }
      return score;
    };
    return getResScore(b) - getResScore(a);
  });

  const allowDisplacement = shouldAllowDisplacementByAssetType(normalizedAssetType);
  const resolveFromCandidates = (value) => {
    const normalized = String(value || "").trim();
    if (!normalized) {
      return "";
    }
    const byAbsolute = textureCandidates.find((item) => path.resolve(item).toLowerCase() === path.resolve(normalized).toLowerCase());
    if (byAbsolute) {
      return byAbsolute;
    }
    const normalizedToken = normalized.replace(/\\/g, "/").toLowerCase();
    const byEndsWith = textureCandidates.find((item) => item.replace(/\\/g, "/").toLowerCase().endsWith(normalizedToken));
    if (byEndsWith) {
      return byEndsWith;
    }
    const baseName = path.basename(normalized).toLowerCase();
    if (!baseName) {
      return "";
    }
    const byBase = textureCandidates.find((item) => path.basename(item).toLowerCase() === baseName) || "";
    if (byBase) {
      return byBase;
    }
    const baseDir = String(asset?.path || "").trim();
    if (baseDir) {
      const directPath = path.join(baseDir, baseName);
      if (fsSync.existsSync(directPath)) {
        return directPath;
      }
    }
    return "";
  };

  const bySlot = new Map();
  const meta = asset?.meta && typeof asset.meta === "object" ? asset.meta : null;
  const mapTypeToSlot = (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) return "";
    if (normalized === "orm" || normalized === "ormh") return "orm";
    if (normalized === "albedo" || normalized === "diffuse" || normalized === "basecolor" || normalized === "base_color") return "albedo";
    if (normalized === "normal" || normalized === "normalbump" || normalized === "normal_gl") return "normal";
    if (normalized === "roughness") return "roughness";
    if (normalized === "gloss" || normalized === "glossiness") return "gloss";
    if (normalized === "metalness" || normalized === "metallic" || normalized === "metal") return "metalness";
    if (normalized === "emissive" || normalized === "emission" || normalized === "emit") return "emissive";
    if (normalized === "ao" || normalized === "ambientocclusion" || normalized === "ambient_occlusion" || normalized === "cavity") return "ao";
    if (normalized === "displacement" || normalized === "height" || normalized === "bump") return "displacement";
    if (normalized === "opacitymasked" || normalized === "opacity_mask" || normalized === "opacitymask") return "opacity";
    if (normalized === "opacity" || normalized === "alpha") return "opacity";
    if (normalized === "subsurface") return "translucency";
    if (normalized === "subsurfacecolor" || normalized === "translucency" || normalized === "translucent" || normalized === "transmission" || normalized === "sss") return "subsurfacecolor";
    if (normalized === "fuzz") return "fuzz";
    if (normalized === "mask" || normalized === "ordp") return "mask";
    return "";
  };
  const components = Array.isArray(meta?.components) ? meta.components : [];
  const flattenComponentUris = (component) => {
    const paths = [];
    const pushPath = (value) => {
      const resolved = resolveFromCandidates(value);
      if (resolved) {
        paths.push(resolved);
      }
    };
    pushPath(component?.uri || component?.path || "");
    const uris = Array.isArray(component?.uris) ? component.uris : [];
    for (const uriItem of uris) {
      if (!uriItem || typeof uriItem !== "object") {
        continue;
      }
      pushPath(uriItem.uri || uriItem.path || "");
      const resolutions = Array.isArray(uriItem.resolutions) ? uriItem.resolutions : [];
      for (const resolutionItem of resolutions) {
        if (!resolutionItem || typeof resolutionItem !== "object") {
          continue;
        }
        const formats = Array.isArray(resolutionItem.formats) ? resolutionItem.formats : [];
        for (const formatItem of formats) {
          if (!formatItem || typeof formatItem !== "object") {
            continue;
          }
          pushPath(formatItem.uri || formatItem.path || "");
        }
      }
    }
    return [...new Set(paths)];
  };
  for (const component of components) {
    if (!component || typeof component !== "object") {
      continue;
    }
    const slot = mapTypeToSlot(component.slot || component.type || component.name);
    if (!slot || !allowedSlots.has(slot) || bySlot.has(slot)) {
      continue;
    }
    if (slot === "displacement" && !allowDisplacement) {
      continue;
    }
    const uriCandidates = flattenComponentUris(component);
    const preferredSource = uriCandidates;
    if (preferredSource.length === 0) {
      continue;
    }
    const preferred = preferredSource.sort((a, b) => {
      const rank = (filePath) => {
        const name = path.basename(String(filePath || "")).toLowerCase();
        if (slot === "normal") {
          if (name.includes("lod0")) return 0;
          if (name.includes("lod1")) return 1;
        }
        // Lower number means higher priority.
        // For Megascans we prefer JPG/PNG over EXR for general use because EXR is heavier and only truly needed for displacement
        // but since we want the best *quality* and resolution first, we just rank by resolution, and then by format.
        if (name.includes("_8k_") || name.includes("8k")) return 0;
        if (name.includes("_4k_") || name.includes("4k")) return 1;
        if (name.includes("_2k_") || name.includes("2k")) return 2;
        if (name.includes("_1k_") || name.includes("1k")) return 3;
        
        // If resolution is equal, we actually want to prefer JPG/PNG for normal/albedo/roughness, 
        // BUT for displacement, EXR is better. Let's make EXR higher priority for displacement only.
        if (slot === "displacement") {
          if (name.endsWith(".exr")) return 4;
          if (name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg")) return 5;
        } else {
          if (name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".png")) return 4;
          if (name.endsWith(".exr")) return 5;
        }
        return 6;
      };
      return rank(a) - rank(b);
    });
    bySlot.set(slot, preferred[0]);
  }
  const maps = Array.isArray(meta?.maps) ? meta.maps : [];
  for (const mapItem of maps) {
    if (!mapItem || typeof mapItem !== "object") {
      continue;
    }
    const slot = mapTypeToSlot(mapItem.type || mapItem.name);
    if (!slot) {
      continue;
    }
    if (!allowedSlots.has(slot)) {
      continue;
    }
    if (slot === "displacement" && !allowDisplacement) {
      continue;
    }
    if (bySlot.has(slot)) {
      continue;
    }
    const resolved = resolveFromCandidates(mapItem.uri || mapItem.path || "");
    const fallbackResolved = resolved;
    if (!fallbackResolved) {
      continue;
    }
    bySlot.set(slot, fallbackResolved);
  }
  for (const candidate of textureCandidates) {
    const slot = slotDetector(candidate);
    if (!slot) {
      continue;
    }
    if (!allowedSlots.has(slot)) {
      continue;
    }
    if (slot === "displacement" && !allowDisplacement) {
      continue;
    }
    
    // If we already have a texture for this slot, only replace it when the new one is higher resolution.
    if (bySlot.has(slot)) {
      const existing = bySlot.get(slot);
      const getResScore = (name) => {
        const lowerName = name.toLowerCase();
        let score = 0;
        if (lowerName.includes("8k") || lowerName.includes("_8k_")) score += 8000;
        else if (lowerName.includes("4k") || lowerName.includes("_4k_")) score += 4000;
        else if (lowerName.includes("2k") || lowerName.includes("_2k_")) score += 2000;
        else if (lowerName.includes("1k") || lowerName.includes("_1k_")) score += 1000;
        
        if (slot === "displacement") {
          if (lowerName.endsWith(".exr")) score += 100;
          else if (lowerName.endsWith(".png")) score += 50;
          else if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) score += 40;
        } else {
          if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) score += 100;
          else if (lowerName.endsWith(".png")) score += 90;
          else if (lowerName.endsWith(".exr")) score += 50;
        }
        return score;
      };
      const existingScore = getResScore(existing);
      const candidateScore = getResScore(candidate);
      
      // If the candidate has a higher resolution score, replace the existing one
      if (candidateScore > existingScore) {
        bySlot.set(slot, candidate);
      }
      continue;
    }
    bySlot.set(slot, candidate);
  }
  if (targetResolutionPixels > 0 && bySlot.size > 0) {
    for (const [slot, selectedPath] of [...bySlot.entries()]) {
      const matched = pickResolutionMatchedTexture(slot, selectedPath, textureCandidates, targetResolutionPixels);
      bySlot.set(slot, matched);
    }
  }
  return bySlot;
}

function normalizeExportTextureSlot(value, options = {}) {
  const canonicalType = normalizeTextureType(value) || String(value || "").trim();
  const normalized = canonicalType.toLowerCase();
  if (!normalized) return "";
  const compact = normalized.replace(/[^a-z0-9]+/g, "");
  if (compact === "orm" || compact === "ormh") return "orm";
  if (compact === "albedo" || compact === "diffuse" || compact === "basecolor" || compact === "basecolour"
    || compact === "albedoopacitymasked" || compact === "diffuseopacitymasked" || compact === "basecoloropacitymasked"
    || compact === "basecolorroughness" || compact === "basecolourroughness") return "albedo";
  if (compact === "normal" || compact === "normalbump" || compact === "normalgl" || compact === "normaldx") return "normal";
  if (compact === "roughness") return "roughness";
  if (compact === "gloss" || compact === "glossiness") return "gloss";
  if (compact === "metalness" || compact === "metallic" || compact === "metal") return "metalness";
  if (compact === "emissive" || compact === "emission" || compact === "emit") return "emissive";
  if (compact === "ao" || compact === "ambientocclusion" || compact === "cavity") return "ao";
  if (compact === "displacement" || compact === "height" || compact === "bump" || compact === "disp" || compact === "dis") return "displacement";
  if (compact === "opacity" || compact === "alpha" || compact === "opacitymasked" || compact === "opacitymask" || compact === "ordp") return "opacity";
  if (compact === "subsurface" || compact === "opacitymaskroughnesstranslucency"
    || compact === "opacityroughnesstranslucency") return "translucency";
  if (compact === "subsurfacecolor" || compact === "translucency" || compact === "translucent"
    || compact === "transmission" || compact === "sss") return "subsurfacecolor";
  if (compact === "fuzz") return "fuzz";
  if (compact === "uv2ao") return "uv2ao";
  if (compact === "mask" || compact === "detailpack") return "mask";
  return "";
}
function resolveTextureCandidatePath(value, textureCandidates, baseDir) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  const byAbsolute = textureCandidates.find((item) => path.resolve(item).toLowerCase() === path.resolve(normalized).toLowerCase());
  if (byAbsolute) {
    return byAbsolute;
  }
  const normalizedToken = normalized.replace(/\\/g, "/").toLowerCase();
  const byEndsWith = textureCandidates.find((item) => item.replace(/\\/g, "/").toLowerCase().endsWith(normalizedToken));
  if (byEndsWith) {
    return byEndsWith;
  }
  const baseName = path.basename(normalized).toLowerCase();
  if (!baseName) {
    return "";
  }
  const byBase = textureCandidates.find((item) => path.basename(item).toLowerCase() === baseName);
  if (byBase) {
    return byBase;
  }
  if (baseDir) {
    const directPath = path.join(baseDir, baseName);
    if (fsSync.existsSync(directPath)) {
      return directPath;
    }
  }
  return "";
}

function collectTextureGroupsForExport(asset, assetType, fullMeta, targetResolutionPixels = 4096) {
  const normalizedAssetType = String(assetType || "").trim().toLowerCase();
  const slotDetector = normalizedAssetType === "surface" ? detectSurfaceTextureSlotByFileName : detectTextureSlotByFileName;
  const allowedSlots = normalizedAssetType === "surface" ? SURFACE_EXPORT_TEXTURE_SLOTS : ALLOWED_EXPORT_TEXTURE_SLOTS;
  const allowDisplacement = shouldAllowDisplacementByAssetType(normalizedAssetType);
  const textureCandidates = Array.isArray(asset?.textureFiles)
    ? asset.textureFiles.filter((filePath) => typeof filePath === "string" && filePath.trim())
    : [];
    
  // Sort candidates globally so that higher resolution textures come first
  textureCandidates.sort((a, b) => {
    const getResScore = (name) => {
      const lowerName = path.basename(name).toLowerCase();
      // First priority is resolution
      let score = 0;
      if (lowerName.includes("8k") || lowerName.includes("_8k_")) score += 8000;
      else if (lowerName.includes("4k") || lowerName.includes("_4k_")) score += 4000;
      else if (lowerName.includes("2k") || lowerName.includes("_2k_")) score += 2000;
      else if (lowerName.includes("1k") || lowerName.includes("_1k_")) score += 1000;
      
      // Secondary priority: for displacement prefer EXR, for others prefer JPG/PNG
      if (lowerName.includes("displacement") || lowerName.includes("bump") || lowerName.includes("height")) {
        if (lowerName.endsWith(".exr")) score += 100;
        else if (lowerName.endsWith(".png")) score += 50;
        else if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) score += 40;
      } else {
        if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) score += 100;
        else if (lowerName.endsWith(".png")) score += 90;
        else if (lowerName.endsWith(".exr")) score += 50;
      }
      return score;
    };
    return getResScore(b) - getResScore(a);
  });

  const baseDir = String(asset?.path || "").trim();
  const fallbackNormalMapFormat = String(fullMeta?.normalMapFormat || asset?.meta?.normalMapFormat || "dx").trim().toLowerCase() === "opengl" ? "opengl" : "dx";
  const namedZionPlant = normalizedAssetType === "3dplant" && isNamedZionPlantAsset(asset, fullMeta);
  const namedZion3d = (normalizedAssetType === "3d" && isZionAsset(asset, fullMeta)) || namedZionPlant;
  let materialNames = namedZion3d ? normalizeMaterialNames(fullMeta?.materialNames) : {};
  let inferredEntries = [];
  if (namedZion3d && !Object.keys(materialNames).length) {
    // Unrenamed Zion exports can be classified without rewriting old metadata.
    const inferred = namedZionPlant
      ? namedPlantTextureMetadata(textureCandidates, normalizeNativePlantWind(fullMeta?.nativePlantWind))
      : namedTextureMetadata(textureCandidates.filter((file) => /^T_Env_/i.test(path.basename(file))));
    materialNames = inferred.materialNames;
    inferredEntries = inferred.textureSlots.map((entry) => ({ ...entry, file: entry.filePath, areaIndex: entry.areaId }));
  }
  const normalMapFormats = fullMeta?.normalMapFormats && typeof fullMeta.normalMapFormats === "object" ? fullMeta.normalMapFormats : {};
  const groups = new Map();
  const groupIdsByKey = new Map();
  const splitByMaterialRole = normalizedAssetType === "3dplant";
  let nextGroupId = 1;
  const ensureGroup = (areaIndex, materialRole = "") => {
    const normalizedArea = Math.max(1, Number(areaIndex) || 1);
    const normalizedRole = splitByMaterialRole
      ? normalizeTextureMaterialRole(materialRole, "", "atlas")
      : "";
    const groupKey = `${normalizedArea}|${normalizedRole}`;
    if (!groupIdsByKey.has(groupKey)) {
      groupIdsByKey.set(groupKey, nextGroupId++);
    }
    const groupId = groupIdsByKey.get(groupKey);
    if (!groups.has(groupKey)) {
      const groupFallback = String(normalMapFormats[normalizedArea] || normalMapFormats[String(normalizedArea)] || fallbackNormalMapFormat).trim().toLowerCase() === "opengl" ? "opengl" : "dx";
      groups.set(groupKey, {
        groupId,
        areaIndex: normalizedArea,
        materialRole: normalizedRole,
        ...(materialNames[normalizedArea] ? { materialName: materialNames[normalizedArea] } : {}),
        normalMapFormat: groupFallback,
        bySlot: new Map()
      });
    }
    return groups.get(groupKey);
  };

  const addTextureEntry = (entryLike) => {
    const slot = normalizeExportTextureSlot(entryLike?.textureType || entryLike?.slot || entryLike?.type || entryLike?.name, { allowOrm: true });
    if (!slot || !allowedSlots.has(slot)) {
      return;
    }
    if (slot === "displacement" && !allowDisplacement) {
      return;
    }
    const areaIndex = Math.max(1, Number(entryLike?.areaIndex) || 1);
    const materialRole = normalizeTextureMaterialRole(entryLike?.materialRole, entryLike?.file || entryLike?.uri || entryLike?.path || "", "atlas");
    const group = ensureGroup(areaIndex, materialRole);
    const resolvedPath = resolveTextureCandidatePath(entryLike?.file || entryLike?.uri || entryLike?.path || "", textureCandidates, baseDir);
    if (!resolvedPath) {
      return;
    }
    if (slot === "albedo" && group.materialName && !group.baseColorSuffix) {
      const type = normalizeTextureType(entryLike?.textureType || entryLike?.slot || detectTextureTypeFromFileName(resolvedPath));
      group.baseColorSuffix = type.startsWith("Diffuse") ? "D" : type.startsWith("Basecolor") ? "BC" : "AL";
    }
    const namedCandidates = group.materialName
      ? [...(fullMeta?.textureEntries || []), ...(fullMeta?.components || []), ...inferredEntries]
        .filter((entry) => (Number(entry.areaIndex ?? entry.areaId) || 1) === areaIndex)
        .map((entry) => resolveTextureCandidatePath(entry.file || entry.uri || entry.path || entry.filePath, textureCandidates, baseDir)).filter(Boolean)
      : textureCandidates;
    const resolutionMatched = pickResolutionMatchedTexture(slot, resolvedPath, namedCandidates, targetResolutionPixels, {
      areaIndex: group.areaIndex,
      materialRole: splitByMaterialRole ? group.materialRole : "",
      slotDetector
    });
    
    // Support multiple files for displacement (e.g. EXR and JPG)
    if (slot === "displacement") {
      const existing = group.bySlot.get(slot);
      if (existing && existing !== resolutionMatched) {
        // If we already have one displacement, store the other in a special slot to avoid overwriting
        // For packing logic, we can keep the best format for packing and the other for standalone if needed.
        // Actually, the simplest is to store an array if we need both, or just keep them in bySlot as `displacement` and `displacement_exr` etc.
        const ext = path.extname(resolutionMatched).toLowerCase();
        const existingExt = path.extname(existing).toLowerCase();
        if (ext !== existingExt) {
            // Keep both, using extension to differentiate in the map
            group.bySlot.set(`displacement_${ext.replace('.','')}`, resolutionMatched);
            // Ensure the main `displacement` slot has a fallback or the preferred format (e.g. jpg for packing)
            if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') {
                 // Move existing to its ext slot
                 group.bySlot.set(`displacement_${existingExt.replace('.','')}`, existing);
                 group.bySlot.set(slot, resolutionMatched);
            } else if (!group.bySlot.has(`displacement_${existingExt.replace('.','')}`)) {
                 group.bySlot.set(`displacement_${existingExt.replace('.','')}`, existing);
            }
        }
      } else {
        group.bySlot.set(slot, resolutionMatched);
      }
    } else if (!group.bySlot.has(slot)) {
      group.bySlot.set(slot, resolutionMatched);
    }
    if (slot === "normal") {
      group.normalMapFormat = String(entryLike?.normalMapFormat || group.normalMapFormat || fallbackNormalMapFormat).trim().toLowerCase() === "opengl" ? "opengl" : "dx";
    }
  };

  const textureEntries = inferredEntries.length ? inferredEntries : (Array.isArray(fullMeta?.textureEntries) ? fullMeta.textureEntries : []);
  for (const item of textureEntries) {
    addTextureEntry(item);
  }
  const textureComponents = Array.isArray(fullMeta?.components)
    ? fullMeta.components.filter((item) => item && String(item.type || "").toLowerCase() === "texture")
    : [];
  for (const item of textureComponents) {
    if (inferredEntries.length) continue;
    addTextureEntry(item);
  }

  if (groups.size === 0) {
    if (splitByMaterialRole) {
      const filesByRole = new Map();
      for (const filePath of textureCandidates) {
        const role = normalizeTextureMaterialRole("", filePath, "atlas");
        if (!filesByRole.has(role)) filesByRole.set(role, []);
        filesByRole.get(role).push(filePath);
      }
      for (const [role, files] of filesByRole.entries()) {
        const fallbackSlots = collectTextureBySlotFromJson(
          { ...asset, meta: fullMeta, textureFiles: files },
          assetType,
          targetResolutionPixels
        );
        const fallbackGroup = ensureGroup(1, role);
        for (const [slot, filePath] of fallbackSlots.entries()) {
          fallbackGroup.bySlot.set(slot, filePath);
        }
      }
    } else {
      const fallbackSlots = collectTextureBySlotFromJson({ ...asset, meta: fullMeta }, assetType, targetResolutionPixels);
      const fallbackGroup = ensureGroup(1, "atlas");
      for (const [slot, filePath] of fallbackSlots.entries()) {
        fallbackGroup.bySlot.set(slot, filePath);
      }
    }
  }

  const channelMode = isMaskAsset({ ...fullMeta, assetType: normalizedAssetType });
  if (channelMode) {
    for (const area of Object.keys(fullMeta?.maskGroups || {})) ensureGroup(Number(area));
    if (!groups.size) ensureGroup(1);
  }
  return [...groups.values()]
    .filter((group) => channelMode || group.bySlot.size > 0)
    .sort((a, b) => {
      const roleOrder = (role) => role === "atlas" ? 0 : role === "billboard" ? 1 : 0;
      return roleOrder(a.materialRole) - roleOrder(b.materialRole) || a.groupId - b.groupId;
    });
}

async function loadAssetMetaForExport(asset) {
  const metaPath = String(asset?.metaPath || "").trim();
  if (!metaPath) {
    return asset?.meta && typeof asset.meta === "object" ? asset.meta : {};
  }
  try {
    const raw = await fs.readFile(metaPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    void 0;
  }
  return asset?.meta && typeof asset.meta === "object" ? asset.meta : {};
}

async function resizeTextureIfNeeded(filePath, targetResolutionPixels = 4096) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const sharpSupportedExts = new Set([".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff"]);
    const nativeImageSupportedExts = new Set([".png", ".jpg", ".jpeg", ".bmp"]);
    if (!sharpSupportedExts.has(ext) && !nativeImageSupportedExts.has(ext)) {
      return filePath;
    }
    const stats = await fs.stat(filePath).catch(() => null);
    const maxSize = Math.max(256, Number(targetResolutionPixels) || 4096);
    const cacheKey = `${path.resolve(filePath)}|${stats?.size || 0}|${stats?.mtimeMs || 0}|${maxSize}`;
    if (resizedTextureCache.has(cacheKey)) {
      const cachedPath = resizedTextureCache.get(cacheKey);
      if (cachedPath && (await exists(cachedPath))) {
        return cachedPath;
      }
      resizedTextureCache.delete(cacheKey);
    }
    const tempDir = path.join(os.tmpdir(), "assethive", "resized");
    await fs.mkdir(tempDir, { recursive: true });
    const token = toSafeCacheToken(cacheKey);
    const newPath = path.join(tempDir, `${path.basename(filePath, ext)}_${token}_resized.png`);

    if (sharp && sharpSupportedExts.has(ext)) {
      const metadata = await sharp(filePath, { sequentialRead: true }).metadata();
      const width = Math.max(1, Number(metadata?.width) || 0);
      const height = Math.max(1, Number(metadata?.height) || 0);
      if (width <= 0 || height <= 0 || (width <= maxSize && height <= maxSize)) {
        return filePath;
      }
      if (!(await exists(newPath))) {
        await sharp(filePath, { sequentialRead: true })
          .resize({ width: maxSize, height: maxSize, fit: "inside", withoutEnlargement: true })
          .png({ compressionLevel: 6, effort: 4 })
          .toFile(newPath);
      }
      resizedTextureCache.set(cacheKey, newPath);
      return newPath;
    }

    if (!HAS_NATIVE_IMAGE || !nativeImageSupportedExts.has(ext)) {
      return filePath;
    }
    const image = nativeImage.createFromPath(filePath);
    if (image.isEmpty()) {
      return filePath;
    }
    const size = image.getSize();
    if (size.width <= maxSize && size.height <= maxSize) {
      return filePath;
    }
    const scale = Math.min(maxSize / size.width, maxSize / size.height);
    const newWidth = Math.round(size.width * scale);
    const newHeight = Math.round(size.height * scale);
    if (!(await exists(newPath))) {
      const resized = image.resize({ width: newWidth, height: newHeight, quality: "best" });
      await fs.writeFile(newPath, resized.toPNG());
    }
    resizedTextureCache.set(cacheKey, newPath);
    return newPath;
  } catch (error) {
    console.error("Failed to resize texture:", filePath, error);
    return filePath;
  }
}

function mergeAlbedoWithOpacityAlpha(albedoPath, opacityPath, assetId, groupId, maxSize) {
  return runImageTask("mergeAlbedo", [albedoPath, opacityPath, assetId, groupId, maxSize]);
}

function buildPackedMaskTexture(slotFileMap, assetId, sourceSlotFileMap, maxSize) {
  return runImageTask("packTextures", [[...slotFileMap], assetId, [...sourceSlotFileMap], maxSize]);
}

function buildPackedOrmTexture(aoPath, roughnessPath, metalnessPath, assetId, groupId, maxSize) {
  return runImageTask("packOrmTexture", [aoPath, roughnessPath, metalnessPath, assetId, groupId, maxSize]);
}
function buildPackedBcrTexture(albedoPath, roughnessPath, assetId, groupId, maxSize) {
  return runImageTask("packBcrTexture", [albedoPath, roughnessPath, assetId, groupId, maxSize]);
}

function unpackPackedTextureChannel(sourcePath, channelIndex, assetId, groupId, channelTag, maxSize) {
  return runImageTask("unpackPackedTextureChannel", [sourcePath, channelIndex, `${assetId}_g${groupId}_${channelTag}`, maxSize]);
}

function readTgaSizeHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 18) return null;
  const width = buffer.readUInt16LE(12);
  const height = buffer.readUInt16LE(14);
  if (width <= 0 || height <= 0) return null;
  return { width, height, bits: buffer[16] };
}

// Surface 的 Metallic（2026-10-29）：源贴图不存在、或像素纯 0（全黑，即没有金属度信息）
// 就不导出该槽位。读取失败时不当作空，按"存在"处理，避免误删有效贴图。
async function isTextureSourceEffectivelyEmpty(sourcePath) {
  if (!sourcePath) return true;
  try {
    const stats = await sharp(sourcePath).stats();
    const channels = Array.isArray(stats?.channels) ? stats.channels : [];
    if (channels.length === 0) return false;
    return channels.every((channel) => Number(channel?.max) === 0);
  } catch {
    return false;
  }
}

// 基础色贴图导出后缀（2026-10-30）：Decal / 3D Plants 不再用 BCR，而是按**源贴图叫法**定名 ——
// 源里叫 Diffuse / BaseColor 的导出 _D，叫 Albedo 的导出 _AL；判不出来时按 D 兜底。
function resolveBaseColorSlotLabel(asset, meta) {
  const hints = [];
  const slots = meta && typeof meta.textureSlots === "object" && meta.textureSlots ? meta.textureSlots : null;
  if (slots) {
    for (const key of Object.keys(slots)) {
      const value = slots[key];
      if (typeof value === "string" && value.trim()) hints.push(key);
    }
  }
  const entries = Array.isArray(meta?.textureEntries) ? meta.textureEntries : [];
  for (const entry of entries) {
    const type = String(entry?.textureType || "").trim();
    if (type) hints.push(type);
  }
  const joined = hints.join(" ").toLowerCase();
  const hasAlbedo = /albedo/.test(joined);
  const hasDiffuse = /diffuse|base\s*colou?r/.test(joined);
  if (hasAlbedo && !hasDiffuse) return "AL";
  if (hasDiffuse && !hasAlbedo) return "D";
  // 两边都出现（或都没有）时按首个命中顺序判断：Albedo 优先，与库内 Megascans 习惯一致。
  return hasAlbedo ? "AL" : "D";
}

// Surface 的 AO 兜底（2026-10-30）：既没有独立 AO、也没有 ORM 可拆时，生成一张纯白纹理
// （AO=1.0，表示"无遮挡"）作为 AO 槽位的内容 —— Surface 的 AO 因此永远会导出。
async function createWhiteAoFallbackTexture(assetId, groupId, targetPixels) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-white-ao-"));
  const file = path.join(dir, `${assetId || "surface"}_${groupId || 1}_AO_white.png`);
  await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  }).png().toFile(file);
  return file;
}

async function convertTextureToTga(sourcePath, assetId, groupId, slotName, maxSize, includeAlpha) {
  // 原生 TGA 直通：尺寸不超目标且 alpha 需求兼容时直接导出源文件（不重编码、不经过 sharp）。
  if (path.extname(sourcePath).toLowerCase() === ".tga") {
    try {
      const handle = await fs.open(sourcePath, "r");
      let header = null;
      try {
        const buffer = Buffer.alloc(18);
        const { bytesRead } = await handle.read(buffer, 0, 18, 0);
        if (bytesRead === 18) header = readTgaSizeHeader(buffer);
      } finally {
        await handle.close();
      }
      const limit = Math.max(1, Number(maxSize) || 4096);
      if (header && header.width <= limit && header.height <= limit && (!includeAlpha || header.bits === 32)) {
        return sourcePath;
      }
    } catch {
      void 0;
    }
  }
  const stats = await fs.stat(sourcePath).catch(() => null);
  const outputDir = path.join(os.tmpdir(), "assethive", "texture-tga");
  const outputPath = path.join(outputDir, `${toSafeCacheToken(`${assetId}_${groupId}_${slotName}_${sourcePath}_${stats?.mtimeMs || 0}_${maxSize}_${includeAlpha ? "a" : "rgb"}`)}.tga`);
  return runImageTask("convertTextureToTga", [sourcePath, outputPath, maxSize, { includeAlpha }]);
}

function resolveSurfaceAssetFolderName(asset, folderNameCounts) {
  const baseName = sanitizeFolderToken(asset?.name) || sanitizeFolderToken(asset?.id) || "Surface";
  const countKey = `surface:${baseName.toLowerCase()}`;
  const current = Math.max(0, Number(folderNameCounts.get(countKey)) || 0);
  folderNameCounts.set(countKey, current + 1);
  return current > 0 ? `${baseName}_${current + 1}` : baseName;
}

function buildSurfaceObjectName(assetName, assetId, slotTag) {
  const safeName = sanitizeFolderToken(assetName) || "Surface";
  const safeId = sanitizeFolderToken(assetId);
  // 除动画资产外，导出对象名统一附带内部资产 ID：T_Env_Tile_<资产名>_<资产ID>_<贴图缩写>。
  const stem = safeId ? `${safeName}_${safeId}` : safeName;
  return `T_Env_Tile_${stem}_${slotTag}`;
}

function resolveDecalAssetFolderName(asset, folderNameCounts) {
  const baseName = sanitizeFolderToken(asset?.name) || sanitizeFolderToken(asset?.id) || "Decal";
  const countKey = `decal:${baseName.toLowerCase()}`;
  const current = Math.max(0, Number(folderNameCounts.get(countKey)) || 0);
  folderNameCounts.set(countKey, current + 1);
  return current > 0 ? `${baseName}_${current + 1}` : baseName;
}

function buildDecalObjectName(assetName, assetId, slotTag) {
  const safeName = sanitizeFolderToken(assetName) || "Decal";
  const safeId = sanitizeFolderToken(assetId);
  const stem = safeId ? `${safeName}_${safeId}` : safeName;
  return `T_Env_Decal_${stem}_${slotTag}`;
}

// Decal 纹理槽位仅作为建议；缺失时继续导出已有槽位，避免阻断整个任务。
const DECAL_ADVISORY_SLOTS = [
  { slot: "albedo", label: "D" },
  { slot: "normal", label: "N" },
  { slot: "opacity", label: "O" },
  { slot: "orm", label: "ORM" }
];

function hasDecalOrmSource(group) {
  if (!group?.bySlot) return false;
  return group.bySlot.has("orm") || group.bySlot.has("ao") || group.bySlot.has("roughness") || group.bySlot.has("metalness");
}

function getMissingDecalSlots(group) {
  if (!group?.bySlot) return DECAL_ADVISORY_SLOTS.map((entry) => entry.label);
  return DECAL_ADVISORY_SLOTS
    .filter((entry) => {
      if (entry.slot === "orm" && hasDecalOrmSource(group)) return false;
      return !group.bySlot.has(entry.slot);
    })
    .map((entry) => entry.label);
}

function normalizeSurfaceBaseTiling(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function pickHdriSourceFile(asset) {
  const textureCandidates = Array.isArray(asset?.textureFiles)
    ? asset.textureFiles.filter((filePath) => typeof filePath === "string" && filePath.trim())
    : [];
  if (textureCandidates.length === 0) {
    return "";
  }
  const scored = [...textureCandidates].sort((a, b) => {
    const rank = (filePath) => {
      const lowerName = path.basename(String(filePath || "")).toLowerCase();
      let score = 0;
      if (lowerName.endsWith(".hdr")) score += 200;
      else if (lowerName.endsWith(".exr")) score += 180;
      if (lowerName.includes("8k")) score += 80;
      else if (lowerName.includes("4k")) score += 40;
      else if (lowerName.includes("2k")) score += 20;
      return score;
    };
    return rank(b) - rank(a);
  });
  return scored[0] || "";
}

function normalizeMeshOverwritePolicy(value) {
  if (!Array.isArray(value)) return value === "meshOnly" ? "meshOnly" : "all";
  const selected = ["material", "texture", "mesh"].filter(target => value.includes(target));
  if (selected.length === 3) return "all";
  if (selected.length === 1 && selected[0] === "mesh") return "meshOnly";
  return selected;
}

async function buildExportAssets(assets, onProgress, exportResolution = "4k", decalParentType = "decal", plantExportMode = "opaque", plantSyntheticWind = "auto",
  folderNameCounts = new Map(), { meshOverwritePolicy = "all", firstImportError = "" } = {}) {
  const targetResolutionPixels = exportResolutionToPixels(exportResolution);
  const normalizedDecalParentType = normalizeDecalParentType(decalParentType);
  const normalizedPlantSyntheticWind = normalizePlantSyntheticWind(plantSyntheticWind);
  const requestedPlantExportMode = plantExportMode;
  if (plantExportMode === "naniteFoliage") plantExportMode = "opaque";
  const exportAssets = [];
  const totalAssets = Math.max(1, assets.length);
  let scannedAssetCount = 0;
  let textureTaskCount = 0;
  let packedTaskCount = 0;
  const metaCache = new Map();
  const exportModelPlanCache = new Map();
  for (const asset of assets) {
    scannedAssetCount += 1;
    if (typeof onProgress === "function") {
      const scanPercent = 12 + Math.round((scannedAssetCount / totalAssets) * 14);
      onProgress({ percent: scanPercent, message: `导出阶段：分析资产 ${scannedAssetCount}/${totalAssets}` });
    }
    const assetType = String(asset?.assetType || "").trim().toLowerCase();
    if (assetType !== "surface" && !is3DAssetType(assetType) && assetType !== "decal" && assetType !== "hdri" && !isAtlasAssetType(assetType)) {
      continue;
    }
    if (assetType === "hdri") {
      continue;
    }
    const fullMeta = await loadAssetMetaForExport(asset);
    metaCache.set(asset.id, fullMeta);
    if (useNaniteFoliageBranch(asset, fullMeta, requestedPlantExportMode)) continue;
    const is3D = is3DAssetType(assetType);
    let exportModelPlan = { modelVariants: [], modelLods: [] };
    if (is3D) {
      exportModelPlan = buildExportModelPlan(asset, fullMeta, plantExportMode);
      exportModelPlanCache.set(asset.id, exportModelPlan);
      if (firstImportError) continue;
    }
    const groups = filterPlantTextureGroupsForExport(
      asset,
      assetType,
      fullMeta,
      collectTextureGroupsForExport(asset, assetType, fullMeta, targetResolutionPixels),
      plantExportMode,
      exportModelPlan
    );
    for (const group of groups) {
      textureTaskCount += group.bySlot.size;
      if (group.bySlot.has("mask") || group.bySlot.has("gloss") || group.bySlot.has("ao") || group.bySlot.has("roughness") || group.bySlot.has("displacement") || group.bySlot.has("opacity")) {
        packedTaskCount += 1;
      }
    }
  }
  let textureTaskIndex = 0;
  let packedTaskIndex = 0;
  let processedAssetCount = 0;
  for (const asset of assets) {
    processedAssetCount += 1;
    const assetType = String(asset?.assetType || "").trim().toLowerCase();
    const isSurface = assetType === "surface";
    const is3D = is3DAssetType(assetType);
    const isDecal = assetType === "decal";
    const isPlant = assetType === "3dplant";
    const isHdri = assetType === "hdri";
    const isAtlas = isAtlasAssetType(assetType);
    
    if (!isSurface && !is3D && !isDecal && !isHdri && !isAtlas) {
      continue;
    }
    
    if (typeof onProgress === "function") {
      const assetPercent = 28 + Math.round((processedAssetCount / totalAssets) * 10);
      onProgress({ percent: assetPercent, message: `导出阶段：整理资产 ${processedAssetCount}/${totalAssets}` });
    }

    if (isHdri) {
      const hdriSource = pickHdriSourceFile(asset);
      if (!hdriSource) {
        continue;
      }
      exportAssets.push({
        id: asset.id,
        name: asset.name,
        assetType,
        categoryFolder: resolveImportCategoryFolder(asset),
        assetFolderName: (() => {
          const baseName = resolveImportAssetFolderName(asset);
          const current = Math.max(0, Number(folderNameCounts.get(baseName)) || 0);
          folderNameCounts.set(baseName, current + 1);
          return current > 0 ? `${baseName}_${current + 1}` : baseName;
        })(),
        source: asset.source,
        modelFiles: [],
        modelVariants: [],
        textureFiles: [hdriSource],
        textureSlots: [{ file: hdriSource, slot: "HDR", groupId: 1 }],
        materialGroups: [{
          groupId: 1,
          textureFiles: [hdriSource],
          textureSlots: [{ file: hdriSource, slot: "HDR", groupId: 1 }]
        }],
        tags: resolveExportJobTags(asset, asset?.meta)
      });
      continue;
    }

    const fullMeta = metaCache.get(asset.id) || (await loadAssetMetaForExport(asset));
    if (isPlant && useNaniteFoliageBranch(asset, fullMeta, requestedPlantExportMode)) {
      const models = (fullMeta.naniteFoliage?.variants || []).map(v => path.isAbsolute(v.file) ? v.file : path.resolve(asset.path, v.file));
      const manifest = await analyzeNaniteFoliage(models.length ? models : (asset.modelFiles || []).filter(file => /\.usda$/i.test(file)), { roles: fullMeta.naniteFoliage?.roles, plantTag: (fullMeta.standardAssetTags || []).find(tag => /^(Grass|Bush|Tree|HeroFoliage)$/i.test(tag)) || "" });
      if (manifest.warnings.length) throw new Error(manifest.warnings.join("；"));
      for (const group of manifest.groups) {
        if (!group.textures.ORM && (group.textures.AO || group.textures.Gloss)) {
          const roughness = group.textures.Gloss ? await runImageTask("glossToRoughness", [group.textures.Gloss, `${asset.id}_${group.key}`, targetResolutionPixels]) : "";
          group.textures.ORM = await buildPackedOrmTexture(group.textures.AO || "", roughness, "", asset.id, group.key, targetResolutionPixels);
        }
        for (const slot of ["Diffuse", "Normal", "ORM", "SubsurfaceColor"]) if (group.textures[slot]) group.textures[slot] = await resizeTextureIfNeeded(group.textures[slot], targetResolutionPixels);
      }
      exportAssets.push({ id: asset.id, name: asset.name, assetType, plantAssetType: "naniteFoliage", plantExportMode: "naniteFoliage",
        naniteFoliage: manifest, assetFolderName: resolveImportAssetFolderName(asset, { omitIdSuffix: true }),
        zionSubfolder: resolveZionSubfolderForAsset(asset), standardAssetTags: fullMeta.standardAssetTags || [],
        meshOverwritePolicy: normalizeMeshOverwritePolicy(meshOverwritePolicy), modelFiles: manifest.variants.map(v => v.file),
        textureFiles: [...new Set(manifest.groups.flatMap(g => Object.values(g.textures)))], materialGroups: [] });
      continue;
    }
    if (isSurface) {
      const surfaceGroups = collectTextureGroupsForExport(asset, assetType, fullMeta, targetResolutionPixels);
      const surfaceGroup = surfaceGroups.find((group) => group.groupId === 1) || surfaceGroups[0];
      if (!surfaceGroup) {
        continue;
      }
      const bcrTargetPixels = exportResolution === "2k" ? 2048 : 4096;
      const secondaryTargetPixels = 2048;
      const bcrResolutionTag = exportResolution === "2k" ? "2K" : "4K";
      const secondaryResolutionTag = "2K";
      const surfaceTextureSlots = [];
      const prepareSurfaceSource = async (sourcePath, slotHint) => {
        if (!sourcePath) return "";
        const lower = String(sourcePath).toLowerCase();
        return lower.endsWith(".exr") ? convertExrToPngIfNeeded(sourcePath, slotHint) : sourcePath;
      };

      const albedoSource = surfaceGroup.bySlot.get("albedo");
      let roughnessSource = surfaceGroup.bySlot.get("roughness");
      let metalnessSource = surfaceGroup.bySlot.get("metalness");
      let aoSource = surfaceGroup.bySlot.get("ao");
      const ormSource = surfaceGroup.bySlot.get("orm");
      if (ormSource) {
        // PBRMAX-style ORM: R=AO, G=Roughness, B=Metallic.
        if (!aoSource) {
          aoSource = await unpackPackedTextureChannel(
            await prepareSurfaceSource(ormSource, "ao"),
            0,
            asset.id,
            surfaceGroup.groupId,
            "ao",
            secondaryTargetPixels
          );
        }
        if (!roughnessSource) {
          roughnessSource = await unpackPackedTextureChannel(
            await prepareSurfaceSource(ormSource, "roughness"),
            1,
            asset.id,
            surfaceGroup.groupId,
            "roughness",
            bcrTargetPixels
          );
        }
        if (!metalnessSource) {
          metalnessSource = await unpackPackedTextureChannel(
            await prepareSurfaceSource(ormSource, "metalness"),
            2,
            asset.id,
            surfaceGroup.groupId,
            "metalness",
            secondaryTargetPixels
          );
        }
      }
      if (albedoSource) {
        if (typeof onProgress === "function") {
          packedTaskIndex += 1;
          onProgress({ percent: 52 + Math.round((packedTaskIndex / Math.max(1, packedTaskCount)) * 8), message: `导出阶段：合成 BCR 贴图 ${packedTaskIndex}/${Math.max(1, packedTaskCount)}` });
        }
        const packedBcr = await buildPackedBcrTexture(
          await prepareSurfaceSource(albedoSource, "albedo"),
          await prepareSurfaceSource(roughnessSource, "roughness"),
          asset.id,
          surfaceGroup.groupId,
          bcrTargetPixels
        );
        if (packedBcr) {
          const file = await convertTextureToTga(packedBcr, asset.id, surfaceGroup.groupId, "BCR", bcrTargetPixels, true);
          surfaceTextureSlots.push({
            file,
            slot: "BCR",
            groupId: surfaceGroup.groupId,
            resolution: bcrResolutionTag,
            objectName: buildSurfaceObjectName(asset.name, asset.id, "BCR")
          });
        }
      }

      // AO 来源优先级（2026-10-30）：独立 AO 贴图 → ORM 的 R 通道（任何来源的 ORM，
      // 不限 PBRMAX）→ 纯白兜底纹理（AO=1.0）。Surface 因此永远导出 AO。
      if (!aoSource) {
        aoSource = await createWhiteAoFallbackTexture(asset.id, surfaceGroup.groupId, secondaryTargetPixels);
      }

      // Surface 固定导出：BCR、N、AO、Dis；Metallic 仅在源贴图存在且非全 0 时导出
      // （2026-10-29 定稿）。E（Emissive）不再固定导出。
      for (const [sourceSlot, exportSlot, slotTag, resolutionTag, targetPixels] of [
        ["normal", "N", "N", bcrResolutionTag, bcrTargetPixels],
        ["ao", "AO", "AO", secondaryResolutionTag, secondaryTargetPixels]
      ]) {
        const sourcePath = sourceSlot === "ao" ? aoSource : surfaceGroup.bySlot.get(sourceSlot);
        if (!sourcePath) continue;
        const prepared = await prepareSurfaceSource(sourcePath, sourceSlot);
        const file = await convertTextureToTga(prepared, asset.id, surfaceGroup.groupId, exportSlot, targetPixels, false);
        const entry = {
          file,
          slot: exportSlot,
          groupId: surfaceGroup.groupId,
          resolution: resolutionTag,
          objectName: buildSurfaceObjectName(asset.name, asset.id, slotTag)
        };
        if (sourceSlot === "normal") entry.normalMapFormat = surfaceGroup.normalMapFormat;
        surfaceTextureSlots.push(entry);
      }
      if (metalnessSource && !(await isTextureSourceEffectivelyEmpty(metalnessSource))) {
        const preparedMetallic = await prepareSurfaceSource(metalnessSource, "metalness");
        const metallicFile = await convertTextureToTga(
          preparedMetallic,
          asset.id,
          surfaceGroup.groupId,
          "M",
          secondaryTargetPixels,
          false
        );
        surfaceTextureSlots.push({
          file: metallicFile,
          slot: "M",
          groupId: surfaceGroup.groupId,
          resolution: secondaryResolutionTag,
          objectName: buildSurfaceObjectName(asset.name, asset.id, "M")
        });
      }

      // Height / Displacement（2026-10-27）：Surface 带高度贴图时额外导出一张 _Dis，
      // 只作为独立纹理资产落在资产文件夹里，不参与材质实例参数（插件侧不绑定）。
      // 尺寸跟 2K / 4K 档位走（与 BCR / Normal 同档），插件侧按 2K 及以上开 VT。
      const displacementSource = surfaceGroup.bySlot.get("displacement");
      if (displacementSource) {
        const bExrDisplacement = String(displacementSource).toLowerCase().endsWith(".exr");
        const displacementFile = bExrDisplacement
          ? displacementSource
          : await convertTextureToTga(
            await resizeTextureIfNeeded(displacementSource, bcrTargetPixels),
            asset.id,
            surfaceGroup.groupId,
            "Dis",
            bcrTargetPixels,
            false
          );
        surfaceTextureSlots.push({
          file: displacementFile,
          slot: "Displacement",
          groupId: surfaceGroup.groupId,
          resolution: bcrResolutionTag,
          objectName: buildSurfaceObjectName(asset.name, asset.id, "Dis")
        });
      }

      if (surfaceTextureSlots.length === 0) {
        continue;
      }
      const surfaceMaterialGroup = {
        groupId: surfaceGroup.groupId,
        textureFiles: surfaceTextureSlots.map((entry) => entry.file),
        textureSlots: surfaceTextureSlots
      };
      exportAssets.push({
        id: asset.id,
        name: asset.name,
        assetType,
        exportRootPath: "/Game/Environment/Asset",
        categoryFolder: "TilableTex",
        assetFolderName: resolveSurfaceAssetFolderName(asset, folderNameCounts),
        source: asset.source,
        modelFiles: [],
        modelVariants: [],
        textureFiles: surfaceMaterialGroup.textureFiles,
        textureSlots: surfaceMaterialGroup.textureSlots,
        materialGroups: [surfaceMaterialGroup],
        // 2026-10-27：Zion 标签的 Surface 仍按 MI / Tex 分目录导出；其余 Surface 与 Decal
        // 都直接平铺在资产文件夹下。这里只下发"是否分目录"，不改 Zion 的其它导出约定。
        ...(isZionAsset(asset, fullMeta) ? { materialFolders: true } : {}),
        materialParams: {
          baseTiling: normalizeSurfaceBaseTiling(fullMeta?.baseTiling ?? asset?.meta?.baseTiling)
        },
        tags: resolveExportJobTags(asset, fullMeta)
      });
      continue;
    }
    if (isDecal) {
      const decalGroups = collectTextureGroupsForExport(asset, assetType, fullMeta, targetResolutionPixels);
      const decalGroup = decalGroups.find((group) => group.groupId === 1) || decalGroups[0];
      if (!decalGroup) {
        continue;
      }
      const missingDecalSlots = getMissingDecalSlots(decalGroup);
      if (missingDecalSlots.length > 0 && typeof onProgress === "function") {
        onProgress({ percent: 50, message: `导出阶段：建议为 ${String(asset?.name || asset?.id || "Decal")} 补充纹理 ${missingDecalSlots.join("/")}，继续导出已有纹理` });
      }
      const decalPrimaryTargetPixels = exportResolution === "2k" ? 2048 : 4096;
      const decalSecondaryTargetPixels = 2048;
      const decalPrimaryResolutionTag = decalPrimaryTargetPixels >= 4096 ? "4K" : "2K";
      const decalSecondaryResolutionTag = "2K";
      const decalTextureSlots = [];
      const prepareDecalSource = async (sourcePath, slotHint) => {
        if (!sourcePath) return "";
        const lower = String(sourcePath).toLowerCase();
        return lower.endsWith(".exr") ? convertExrToPngIfNeeded(sourcePath, slotHint) : sourcePath;
      };
      const addDecalTextureSlot = async (sourcePath, sourceSlot, exportSlot, targetPixels, resolutionTag) => {
        if (!sourcePath) return;
        const prepared = await prepareDecalSource(sourcePath, sourceSlot);
        const file = await convertTextureToTga(prepared, asset.id, decalGroup.groupId, exportSlot, targetPixels, false);
        // Height / Displacement（2026-10-27）：后缀与 Surface 统一成 _Dis
        // （槽位仍用 Displacement，供插件识别）。
        const objectSuffix = exportSlot === "Displacement" ? "Dis" : exportSlot;
        const entry = {
          file,
          slot: exportSlot,
          groupId: decalGroup.groupId,
          resolution: resolutionTag,
          objectName: buildDecalObjectName(asset.name, asset.id, objectSuffix)
        };
        if (sourceSlot === "normal") entry.normalMapFormat = decalGroup.normalMapFormat;
        decalTextureSlots.push(entry);
      };

      await addDecalTextureSlot(decalGroup.bySlot.get("albedo"), "albedo", resolveBaseColorSlotLabel(asset, fullMeta), decalPrimaryTargetPixels, decalPrimaryResolutionTag);
      await addDecalTextureSlot(decalGroup.bySlot.get("normal"), "normal", "N", decalPrimaryTargetPixels, decalPrimaryResolutionTag);
      await addDecalTextureSlot(decalGroup.bySlot.get("opacity"), "opacity", "O", decalSecondaryTargetPixels, decalSecondaryResolutionTag);

      if (decalGroup.bySlot.has("orm")) {
        await addDecalTextureSlot(decalGroup.bySlot.get("orm"), "orm", "ORM", decalSecondaryTargetPixels, decalSecondaryResolutionTag);
      } else {
        const ormInputs = await Promise.all([
          prepareDecalSource(decalGroup.bySlot.get("ao") || "", "ao"),
          prepareDecalSource(decalGroup.bySlot.get("roughness") || "", "roughness"),
          prepareDecalSource(decalGroup.bySlot.get("metalness") || "", "metalness")
        ]);
        if (ormInputs.some(Boolean)) {
          const packedOrm = await buildPackedOrmTexture(
            ormInputs[0],
            ormInputs[1],
            ormInputs[2],
            asset.id,
            decalGroup.groupId,
            decalSecondaryTargetPixels
          );
          if (packedOrm) {
            await addDecalTextureSlot(packedOrm, "orm", "ORM", decalSecondaryTargetPixels, decalSecondaryResolutionTag);
          }
        }
      }
      // Height / Displacement（2026-10-27）：只有视差贴花（POM / Triplanar POM）额外导出
      // _Dis，固定 1K、不参与材质实例；普通贴花不导出该贴图。
      const usesDecalDisplacement =
        normalizedDecalParentType === "pomDecal" ||
        normalizedDecalParentType === "pomDecalTri";
      if (usesDecalDisplacement) {
        await addDecalTextureSlot(
          decalGroup.bySlot.get("displacement"),
          "displacement",
          "Displacement",
          1024,
          "1K"
        );
      }
      if (decalTextureSlots.length === 0) {
        continue;
      }
      const decalMaterialGroup = {
        groupId: decalGroup.groupId,
        textureFiles: decalTextureSlots.map((entry) => entry.file),
        textureSlots: decalTextureSlots
      };
      exportAssets.push({
        id: asset.id,
        name: asset.name,
        assetType,
        exportRootPath: "/Game/Environment/Asset",
        categoryFolder: "Decal",
        assetFolderName: resolveDecalAssetFolderName(asset, folderNameCounts),
        source: asset.source,
        modelFiles: [],
        modelVariants: [],
        textureFiles: decalMaterialGroup.textureFiles,
        textureSlots: decalMaterialGroup.textureSlots,
        materialGroups: [decalMaterialGroup],
        // 2026-10-27：Zion 标签的 Decal（与 Surface 一致）仍按 MI / Tex 分目录导出。
        ...(isZionAsset(asset, fullMeta) ? { materialFolders: true } : {}),
        materialParams: {
          useOpacityTexture: decalTextureSlots.some((entry) => entry.slot === "O"),
          decalParentType: normalizedDecalParentType
        },
        tags: resolveExportJobTags(asset, fullMeta)
      });
      continue;
    }

    let exportModelFiles = [];
    let exportModelVariants = [];
    let exportModelLods = [];
    let exportModelPlan = { modelVariants: [], modelLods: [] };
    if (is3D) {
      exportModelPlan = exportModelPlanCache.get(asset.id) || buildExportModelPlan(asset, fullMeta, plantExportMode);
      exportModelVariants = exportModelPlan.modelVariants;
      exportModelLods = exportModelPlan.modelLods;
      exportModelFiles = exportModelVariants.map((item) => item.file);
      if (exportModelFiles.length === 0) {
        continue;
      }
    }
    const naniteMasked = exportModelPlan.naniteMasked === true;
    const billboardExcluded = naniteMasked || is3D && shouldExcludeBillboardTextureGroups(asset, assetType, fullMeta, plantExportMode);
    const zionPlant = isZionPlantAsset(asset, fullMeta);
    const zion = !isAtlas && (zionPlant || isZionAsset(asset, fullMeta));
    const thirdPartyPlant = assetType === "3dplant" && !zionPlant;
    const sourceStandardTags = Array.isArray(asset.standardAssetTags)
      ? asset.standardAssetTags : (Array.isArray(fullMeta?.standardAssetTags) ? fullMeta.standardAssetTags : []);
    let microPlant = assetType === "3dplant" && sourceStandardTags.some(isMicroPlantTag);
    const nativePlantWind = !microPlant && isZionPlantAsset(asset, fullMeta)
      ? normalizeNativePlantWind(fullMeta?.nativePlantWind ?? asset?.meta?.nativePlantWind)
      : null;
    // 合成风只对原始资产为 FBX 的植被（3D Plants）生效，与导出面板显示条件一致；st9 等非 FBX 不发送。
    const supportsSyntheticWind = assetType === "3dplant"
      && !microPlant && !nativePlantWind
      && exportModelFiles.length > 0
      && exportModelFiles.every((file) => /\.fbx$/i.test(String(file || "")));
    let windPreset = supportsSyntheticWind ? normalizedPlantSyntheticWind : "";
    if (windPreset === "micro") {
      microPlant = true;
      windPreset = "";
    }
    const inspection = thirdPartyPlant && (windPreset || exportModelLods.length)
      ? await inspectPlantLayerSource(asset, fullMeta, exportModelVariants, exportModelLods) : null;
    const plantWindLayers = inspection?.layers;
    // Material roles must survive static Micro exports as well as synthetic wind jobs.
    exportModelLods = exportModelLods.map(lod => {
      const source = plantWindLayers?.sourceByVariant?.[lod.variantKey]?.lods?.[lod.lod];
      return source?.representation === "billboard" ? { ...lod, materialRole: "billboard" } : lod;
    });
    if (windPreset === "auto" && thirdPartyPlant) {
      // Managed imports expand search tags, which can suggest a different growth form.
      const inferredForm = classifyBridgePlantWind(fullMeta, asset);
      windPreset = plantWindLayers?.form ?? inferredForm;
      // Older static manifests use the same empty form for Micro and e.g. floating plants.
      if ((windPreset || inferredForm) && await fitsMicroPlantMeshes(asset, fullMeta, inspection)) {
        microPlant = true;
        windPreset = "";
      }
    }
    // A managed cut can be stored separately from its original FBX. Older
    // libraries without a hierarchy manifest still need the LOD0 for wind.
    let plantWindOriginals;
    if (windPreset && !plantWindLayers && exportModelVariants.some(model => model.opaque)) {
      const originals = buildExportModelPlan(asset, fullMeta, "lod").modelVariants;
      const cutKeys = new Set(exportModelVariants.filter(model => model.opaque).map(model => model.variantKey));
      plantWindOriginals = Object.fromEntries(originals.filter(model => cutKeys.has(model.variantKey))
        .map(model => [model.variantKey, model.file]));
    }
    const sourceTextureGroups = firstImportError ? [] : collectTextureGroupsForExport(asset, assetType, fullMeta, targetResolutionPixels);
    const textureGroups = filterPlantTextureGroupsForExport(
      asset,
      assetType,
      fullMeta,
      sourceTextureGroups,
      plantExportMode,
      exportModelPlan
    );
    if (isAtlas && !textureGroups.some(group => group.bySlot.size > 0)) {
      throw new Error("Atlas资产缺少可用纹理");
    }
    const maskAsset = isMaskAsset({ ...fullMeta, assetType, standardAssetTags: fullMeta?.standardAssetTags || asset.standardAssetTags });
    const maskGroups = maskAsset ? normalizeMaskGroups(fullMeta?.maskGroups) : {};
    const materialGroups = [];
    // Blank names retain the plugin's existing default matching. Texture-less
    // models can still borrow named material sets from the rest of the batch.
    const namedMaterialMatching = !firstImportError && ((assetType === "3d" && isZionAsset(asset, fullMeta)) || isNamedZionPlantAsset(asset, fullMeta))
      && (textureGroups.length === 0 || textureGroups.some((group) => group.materialName));
    const namedPlantMaterialMatching = assetType === "3dplant" && namedMaterialMatching;
    if (namedMaterialMatching && textureGroups.some((group) => !group.materialName)) {
      throw new Error(`贴图组 ${textureGroups.filter((group) => !group.materialName).map((group) => group.areaIndex).join("、")} 缺少材质名称，请补齐以按名称匹配，或全部留空使用默认匹配`);
    }
    if (namedMaterialMatching && new Set(textureGroups.map((group) => materialKey(group.materialName))).size !== textureGroups.length) {
      throw new Error("同一资产内存在重名贴图组，请将同一材质的纹理放在一个组内");
    }
    for (const lod of exportModelLods.filter(item => item.materialRole === "billboard")) {
      if (firstImportError) continue;
      const billboardGroups = textureGroups.filter(group => group.materialRole === "billboard");
      if (billboardGroups.length !== 1) {
        if (namedPlantMaterialMatching && textureGroups.length === 0) continue;
        throw new Error(`Billboard LOD 需要唯一的 Billboard 纹理组：${asset.name || asset.id}（找到 ${billboardGroups.length} 组）`);
      }
      lod.materialGroupId = billboardGroups[0].groupId;
    }
    for (const group of textureGroups) {
      // Preserve Gloss semantics until conversion; explicit Roughness takes priority.
      if (group.bySlot.has("gloss")) {
        if (!group.bySlot.has("roughness")) {
          group.bySlot.set("roughness", await runImageTask("glossToRoughness", [group.bySlot.get("gloss"), `${asset.id}_g${group.groupId}`, targetResolutionPixels]));
        }
        group.bySlot.delete("gloss");
      }
      let opacityInDiffuseAlpha = false;
      if (isPlant) {
        const albedoSource = group.bySlot.get("albedo");
        let opacitySource = group.bySlot.get("opacity");
        if (zionPlant && albedoSource && !opacitySource) {
          opacityInDiffuseAlpha = await runImageTask("hasOpacityAlpha", [albedoSource]).catch(() => false);
        } else if (naniteMasked && albedoSource && !opacitySource) {
          // 第三方 Nanite Masked 父材质使用独立透贴槽。
          try {
            opacitySource = await runImageTask("opacityFromAlpha", [albedoSource, `${asset.id}_g${group.groupId}`, targetResolutionPixels]);
          } catch {
            // 不可解码的可选 Alpha 不影响其余模型和贴图导出。
            opacitySource = "";
          }
          if (opacitySource) group.bySlot.set("opacity", opacitySource);
        }
        if (albedoSource && opacitySource) {
          const mergedAlbedo = await mergeAlbedoWithOpacityAlpha(albedoSource, opacitySource, asset.id, group.groupId, targetResolutionPixels);
          if (mergedAlbedo && mergedAlbedo !== albedoSource) {
            group.bySlot.set("albedo", mergedAlbedo);
            if (zionPlant) {
              opacityInDiffuseAlpha = true;
              group.bySlot.delete("opacity");
            }
          }
        }
      }
      const processedTextureSlots = [];
      const processedTextureBySlot = new Map();
      const sourceTextureBySlot = new Map();
      const isEnvironment3D = assetType === "3d" || isAtlas;
      const primaryTargetPixels = Math.min(4096, targetResolutionPixels);
      const secondaryTargetPixels = Math.min(2048, targetResolutionPixels);
      const primaryResolutionTag = primaryTargetPixels >= 4096 ? "4K" : "2K";
      const secondaryResolutionTag = "2K";
      for (const [slot, file] of group.bySlot.entries()) {
        if (isPlant && !["albedo", "normal", "orm", "ao", "roughness", "metalness", "translucency", "subsurfacecolor", "opacity"].includes(slot)) {
          continue;
        }
        // 第三方材质和只有透贴的组保留独立 Opacity 槽。
        if (isPlant && slot === "opacity") {
          const opacityFile = namedPlantMaterialMatching
            ? await convertTextureToTga(file, asset.id, group.groupId, "opacity", targetResolutionPixels, true) : file;
          sourceTextureBySlot.set(slot, file);
          processedTextureBySlot.set(slot, opacityFile);
          processedTextureSlots.push({
            file: opacityFile,
            slot: "Opacity",
            groupId: group.groupId,
            ...(group.materialRole ? { materialRole: group.materialRole } : {})
          });
          continue;
        }
        textureTaskIndex += 1;
        if (typeof onProgress === "function") {
          const texturePercent = 30 + Math.round((textureTaskIndex / Math.max(1, textureTaskCount)) * 20);
          onProgress({ percent: texturePercent, message: `导出阶段：压缩贴图 ${textureTaskIndex}/${Math.max(1, textureTaskCount)}` });
        }
        if (textureTaskIndex % EXPORT_COOPERATIVE_YIELD_INTERVAL === 0) {
          await yieldToEventLoop();
        }
        let processedFile = file;
        sourceTextureBySlot.set(slot, file);

        const isDisplacementSlot = slot.startsWith("displacement");
        const isSurfaceDisplacement = (isSurface || isAtlas) && isDisplacementSlot;
        // Alternate height formats are source candidates, not extra Atlas slots.
        if (isAtlas && isDisplacementSlot && slot !== "displacement") continue;
        const shouldSkipStandaloneDisplacement = is3D && isDisplacementSlot;

        if (shouldSkipStandaloneDisplacement) {
          processedTextureBySlot.set(slot, processedFile);
          continue;
        }

        if (processedFile.toLowerCase().endsWith(".exr") && !isSurfaceDisplacement) {
          processedFile = await convertExrToPngIfNeeded(processedFile, isDisplacementSlot ? "displacement" : slot);
        }
        processedFile = await normalizeJpegForUnrealIfNeeded(processedFile, slot);

        const resizedPath = (isSurfaceDisplacement && processedFile.toLowerCase().endsWith(".exr"))
          ? processedFile
          : await resizeTextureIfNeeded(processedFile, targetResolutionPixels);

        let outputFile = resizedPath;
        const isOrmInputSlot = ["ao", "roughness", "metalness"].includes(slot);
        const packedPlantColor = opacityInDiffuseAlpha && slot === "albedo";
        if ((isEnvironment3D || namedPlantMaterialMatching || (packedPlantColor && /\.tga$/i.test(resizedPath))) && !isOrmInputSlot && !(isAtlas && isDisplacementSlot && /\.exr$/i.test(resizedPath))) {
          const isPrimarySlot = slot === "albedo" || slot === "normal";
          const tgaMaxSize = isPrimarySlot ? primaryTargetPixels : secondaryTargetPixels;
          outputFile = await convertTextureToTga(resizedPath, asset.id, group.groupId, slot, tgaMaxSize, packedPlantColor || slot === "mask" || slot === "opacity");
        }

        let slotName = slot.charAt(0).toUpperCase() + slot.slice(1);
        // Decal / 3D Plants 的基础色贴图按源叫法导出 _D / _AL（2026-10-30）。
        if (!isEnvironment3D && slot === "albedo") {
          slotName = resolveBaseColorSlotLabel(asset, fullMeta);
        }
        if (slot === "ao") slotName = "AO";
        else if (slot === "orm") slotName = "ORM";
        else if (slot === "mask") slotName = "Mask";
        else if (slot === "uv2ao") slotName = "UV2AO";
        else if (isDisplacementSlot) slotName = "Displacement";

        const entry = {
          file: outputFile,
          slot: slotName,
          groupId: group.groupId,
          ...(group.materialRole ? { materialRole: group.materialRole } : {})
        };
        if (slot === "normal") {
          entry.normalMapFormat = group.normalMapFormat;
        }
        if (isDisplacementSlot) {
          entry.compression = "Displacement";
        }
        if (isEnvironment3D) {
          entry.resolution = slot === "albedo" || slot === "normal"
            ? primaryResolutionTag
            : secondaryResolutionTag;
          if (namedMaterialMatching && slot === "albedo") {
            entry.objectName = `T_${materialStem(group.materialName)}_${group.baseColorSuffix || "AL"}`;
          }
        }
        processedTextureBySlot.set(slot, outputFile);
        if (isEnvironment3D) {
          if (!["ao", "roughness", "metalness"].includes(slot)) {
            processedTextureSlots.push(entry);
          }
        } else if (!shouldSkipStandaloneDisplacement && slot !== "mask") {
          processedTextureSlots.push(entry);
        }
      }

      if (isEnvironment3D && !processedTextureBySlot.has("orm")) {
        const ormSlots = ["ao", "roughness", "metalness"];
        if (ormSlots.some((slot) => processedTextureBySlot.has(slot))) {
          if (typeof onProgress === "function") {
            packedTaskIndex += 1;
            onProgress({ percent: 52 + Math.round((packedTaskIndex / Math.max(1, packedTaskCount)) * 8), message: `导出阶段：合成贴图 ${packedTaskIndex}/${Math.max(1, packedTaskCount)}` });
          }
          const packedOrmPath = await buildPackedOrmTexture(
            processedTextureBySlot.get("ao") || "",
            processedTextureBySlot.get("roughness") || "",
            processedTextureBySlot.get("metalness") || "",
            asset.id,
            group.groupId,
            secondaryTargetPixels
          );
          if (packedOrmPath) {
            const ormFile = await convertTextureToTga(packedOrmPath, asset.id, group.groupId, "ORM", secondaryTargetPixels, false);
            processedTextureSlots.push({
              file: ormFile,
              slot: "ORM",
              groupId: group.groupId,
              resolution: secondaryResolutionTag,
              ...(group.materialRole ? { materialRole: group.materialRole } : {})
            });
          }
        }
      }

      const shouldPackMask = !isPlant && !isEnvironment3D && [...processedTextureBySlot.keys()]
        .some(slot => ["mask", "ao", "roughness", "opacity"].includes(slot) || slot.startsWith("displacement"));
      if (shouldPackMask) {
        if (typeof onProgress === "function") {
          packedTaskIndex += 1;
          onProgress({ percent: 52 + Math.round((packedTaskIndex / Math.max(1, packedTaskCount)) * 8), message: `导出阶段：合成贴图 ${packedTaskIndex}/${Math.max(1, packedTaskCount)}` });
        }
        const packedMaskPath = await buildPackedMaskTexture(processedTextureBySlot, `${asset.id}_g${group.groupId}`, sourceTextureBySlot, targetResolutionPixels);
        if (packedMaskPath) {
          processedTextureSlots.push({
            file: packedMaskPath,
            slot: "Mask",
            groupId: group.groupId,
            ...(group.materialRole ? { materialRole: group.materialRole } : {})
          });
        }
      }
      materialGroups.push({
        ...(maskAsset ? { maskMaterial: await buildMaskMaterial(group, maskGroups[group.areaIndex]) } : {}),
        groupId: group.groupId,
        ...(opacityInDiffuseAlpha ? { opacityInDiffuseAlpha: true } : {}),
        ...(namedMaterialMatching ? { materialName: group.materialName } : {}),
        ...(group.materialRole ? { materialRole: group.materialRole } : {}),
        textureFiles: processedTextureSlots.map((item) => item.file),
        textureSlots: processedTextureSlots
      });
    }
    const flattenedTextureFiles = materialGroups.flatMap((group) => group.textureFiles || []);
    const flattenedTextureSlots = materialGroups.flatMap((group) => group.textureSlots || []);
    // 标准 Asset Tag：资产上优先，缺失时退回库元数据。两处（分类目录推导、job 字段）
    // 必须用同一份值，否则会出现"判定用一套、下发用另一套"的分歧。
    const thirdPartySubtype = microPlant ? "Micro" : windPreset === "bush" ? "Bush" : windPreset === "tree" ? "Tree" : "Grass";
    const resolvedStandardAssetTags = thirdPartyPlant || microPlant
      ? [...sourceStandardTags.filter(tag => !/^(?:grass|bush|tree|herofoliage)$/i.test(String(tag).trim()) && !isMicroPlantTag(tag)), thirdPartySubtype]
      : sourceStandardTags;
    const resolvedZionTags = Array.isArray(asset.zionTags)
      ? asset.zionTags
      : (Array.isArray(fullMeta?.zionTags) ? fullMeta.zionTags : []);
    const explicitZionTags = resolvedZionTags.filter((tag) => typeof tag === "string" && tag.trim());
    
    exportAssets.push({
      id: asset.id,
      name: asset.name,
      assetType,
      textureGroupMode: maskAsset ? "channel" : "texture",
      categoryFolder: (() => {
        if (isAtlas) return "Objects";
        // 基础分类目录的权威定义在插件侧（按 Asset Tag 推导：
        // Dressing/Megascans/PBRMAX → Objects、Kits → Kit、Props → Props、
        // Destructible → Destructible、MEGA → MEGA）。凡是插件能推导的，这里一律传空串，
        // 否则导出侧给的 "3D_Assets" 会在插件里**覆盖**掉正确的 Objects。
        //   - Zion 资产：一直如此；
        //   - Megascans / PBRMAX 等带分类 tag 的第三方资产：standardAssetTags 里就带
        //     "Megascans" / "PBRMAX"，插件能推导 —— 实测它们曾因此跑到 3D_Assets 下。
        if (zion || shouldDelegateCategoryFolderToPlugin(resolvedStandardAssetTags)) {
          return "";
        }
        return resolveImportCategoryFolder(asset);
      })(),
      // Zion 资产的二级目录（基础分类目录之后的部分，可为空）。空串表示直接落在
      // 基础分类目录下，与"从未设置"同义 —— 不做任何历史值回退。
      // 植被（3dplant）的库分类，取自元数据的 category 字段（Megascans 的类别词表：
      // Shrub / Grass / Fern / Flowering Plant …）。插件用它决定落在
      // Vegetation/Bush 还是 Vegetation/Grass —— Shrub（灌木）进 Bush，其余进 Grass。
      // 非植被传空串，插件忽略该字段。
      plantCategory: assetType === "3dplant"
        ? (thirdPartyPlant || microPlant ? thirdPartySubtype : String(fullMeta?.category || "").trim())
        : "",
      ...(isAtlas ? { exportRootPath: "/Game/Environment/Asset" } : {}),
      // Temp 是 Zion 变体：规格跟随 Zion（无 _<id>、Zion 子目录），但插件按 Temp 标记
      // 进 <分类>/Temp，所以这里不传 zionSubfolder（显式 Zion 才用二级目录）。
      zionSubfolder: (zion && !hasTempTag(asset, fullMeta))
        ? resolveZionSubfolderForAsset(asset)
        : "",
      assetFolderName: (() => {
        const baseName = resolveImportAssetFolderName(asset, { omitIdSuffix: zion });
        const current = Math.max(0, Number(folderNameCounts.get(baseName)) || 0);
        folderNameCounts.set(baseName, current + 1);
        const name = current > 0 ? `${baseName}_${current + 1}` : baseName;
        // Temp 标记：文件夹再加一层 Temp_ 前缀（已带则不重复加）。
        if (hasTempTag(asset, fullMeta) && !/^temp_/i.test(name)) return `Temp_${name}`;
        return name;
      })(),
      source: asset.source,
      modelFiles: exportModelFiles,
      modelVariants: exportModelVariants,
      modelLods: exportModelLods,
      ...(is3D ? { meshOverwritePolicy: normalizeMeshOverwritePolicy(meshOverwritePolicy) } : {}),
      ...(firstImportError ? { firstImportError } : {}),
      ...(assetType === "3dplant" ? { plantExportMode: normalizePlantExportMode(plantExportMode), plantExportVersion: 2 } : {}),
      // 裁切变体的面数预设（0 = 插件按自己的植被档位表）：
      // 插件据此设 _OPAQUE 网格的 Nanite 面数上限。不随 job 下发的话，
      // 界面上改「面数预设」对 UE 侧完全无效（永远按档位表 15 万 / 30 万走）。
      opaqueFaceBudget: Math.max(0, Math.floor(Number(fullMeta?.foliageOpaque?.faceBudget) || 0)),
      textureFiles: flattenedTextureFiles,
      textureSlots: flattenedTextureSlots,
      materialGroups,
      ...(namedMaterialMatching ? { materialMatching: "name" } : {}),
      ...(namedPlantMaterialMatching && billboardExcluded ? {
        excludedPlantMaterialNames: sourceTextureGroups.filter((group) => group.materialRole === "billboard")
          .map((group) => group.materialName).filter(Boolean)
      } : {}),
      ...(namedPlantMaterialMatching && textureGroups.length === 0 &&
        !Object.values(fullMeta?.materialNames || {}).some((name) => typeof name === "string" && name.trim())
        ? { materialMatchingOptional: true } : {}),
      standardAssetTags: isAtlas ? ["ThirdParty"] : thirdPartyPlant && !hasThirdPartyMarker({ standardAssetTags: resolvedStandardAssetTags }, {})
        ? [...resolvedStandardAssetTags, "ThirdParty"] : resolvedStandardAssetTags,
      // 旧版插件从这个字段生成第三方植被的网格前缀。
      ...(thirdPartyPlant ? { plantNamingTags: ["Foliage"] } : {}),
      // 保留真实 Zion 来源标志以兼容旧接收端；植被父实例按标准子类和材质槽选择。
      ...(assetType === "3dplant" ? { hasExplicitZionTags: explicitZionTags.length > 0 } : {}),
      ...(nativePlantWind ? { nativePlantWind } : {}),
      ...(windPreset && plantWindLayers ? { plantWindLayers } : {}),
      ...(plantWindOriginals ? { plantWindOriginals } : {}),
      ...(naniteMasked ? { naniteMasked: true } : {}),
      // zionTags 随资产一起进入导入 job：插件侧据此识别 Zion 资产，
      // 决定是否给资产文件夹加 _<id> 后缀、以及是否启用 Material/Tex/Mesh 子目录。
      // 2026-10-29 起 Zion 是默认分类（没有第三方标记即 Zion），未显式打 zionTags 的
      // 资产在这里补一个占位标记，否则插件会当作普通资产追加 _<id> 后缀。
      zionTags: (() => {
        if (isAtlas) return [];
        if (explicitZionTags.length > 0) {
          return explicitZionTags;
        }
        // Temp 资产是 Zion 变体，但**不**下发 zionTags：插件按 Temp 标记进
        // <分类>/Temp，若当作显式 Zion 会走 zionSubfolder 落错目录。
        return (isZionAsset(asset, fullMeta) && !hasTempTag(asset, fullMeta))
          ? ["zion"]
          : [];
      })(),
      ...(windPreset
        ? { plantSyntheticWind: windPreset }
        : {}),
      tags: resolveExportJobTags(asset, fullMeta),
      ...(billboardExcluded ? { billboardExcluded: true } : {})
    });
  }
  const materialFailures = await prepareNamedMaterialBatch(exportAssets);
  if (materialFailures.size) throw new Error([...new Set(materialFailures.values())].join("；"));
  return exportAssets;
}

async function summarizeInvalidExportAssets(assets, targetResolutionPixels = 4096) {
  let unsupportedTypeCount = 0;
  let missingModelCount = 0;
  let missingHdriCount = 0;
  let missingDecalCount = 0;
  const unsupportedSamples = [];
  const missingModelSamples = [];
  const missingHdriSamples = [];
  const missingDecalSamples = [];
  for (const asset of assets || []) {
    const assetType = String(asset?.assetType || "").trim().toLowerCase();
    const isSurface = assetType === "surface";
    const is3D = is3DAssetType(assetType);
    const isDecal = assetType === "decal";
    const isHdri = assetType === "hdri";
    if (!isSurface && !is3D && !isDecal && !isHdri && !isAtlasAssetType(assetType)) {
      unsupportedTypeCount += 1;
      if (unsupportedSamples.length < 3) {
        unsupportedSamples.push(`${asset?.name || asset?.id || "未知资产"}(${assetType || "unknown"})`);
      }
      continue;
    }
    if (isHdri && !pickHdriSourceFile(asset)) {
      missingHdriCount += 1;
      if (missingHdriSamples.length < 3) {
        missingHdriSamples.push(String(asset?.name || asset?.id || "未知资产"));
      }
      continue;
    }
    if (isDecal) {
      const fullMeta = await loadAssetMetaForExport(asset);
      const groups = collectTextureGroupsForExport(asset, assetType, fullMeta, targetResolutionPixels);
      const group = groups.find((item) => item.groupId === 1) || groups[0];
      if (!group || !group.bySlot || group.bySlot.size === 0) {
        missingDecalCount += 1;
        if (missingDecalSamples.length < 3) {
          missingDecalSamples.push(String(asset?.name || asset?.id || "未知资产"));
        }
      }
      continue;
    }
    if (is3D && pickExportModelFiles(asset).length === 0) {
      missingModelCount += 1;
      if (missingModelSamples.length < 3) {
        missingModelSamples.push(String(asset?.name || asset?.id || "未知资产"));
      }
    }
  }
  const parts = [];
  if (unsupportedTypeCount > 0) {
    parts.push(`不支持类型 ${unsupportedTypeCount} 个${unsupportedSamples.length ? `：${unsupportedSamples.join("、")}` : ""}`);
  }
  if (missingModelCount > 0) {
    parts.push(`3D资产缺少可用模型 ${missingModelCount} 个${missingModelSamples.length ? `：${missingModelSamples.join("、")}` : ""}`);
  }
  if (missingDecalCount > 0) {
    parts.push(`Decal资产缺少可用纹理 ${missingDecalCount} 个${missingDecalSamples.length ? `：${missingDecalSamples.join("、")}` : ""}`);
  }
  if (missingHdriCount > 0) {
    parts.push(`HDRI资产缺少可用HDR文件 ${missingHdriCount} 个${missingHdriSamples.length ? `：${missingHdriSamples.join("、")}` : ""}`);
  }
  return parts.join("；");
}

async function exportToUnreal(assets, options, onProgress) {
  if (!assets || assets.length === 0) {
    return {
      ok: false,
      message: "未选择可导入资产"
    };
  }
  if (typeof onProgress === "function") {
    onProgress({ percent: 5, message: "分析资产..." });
    onProgress({ percent: 10, message: "准备导入任务..." });
  }
  const exportResolution = normalizeExportResolution(options?.exportResolution || "4k");
  const decalParentType = normalizeDecalParentType(options?.decalExportMode);
  const plantExportMode = normalizePlantExportMode(options?.plantExportMode);
  const plantSyntheticWind = normalizePlantSyntheticWind(options?.plantSyntheticWind);
  const results = [];
  const exportAssets = [];
  const folderNameCounts = new Map();
  for (const [position, asset] of assets.entries()) {
    const item = { assetId: String(asset.id || ""), name: String(asset.name || asset.id || ""), status: "pending", message: "" };
    results.push(item);
    try {
      if (asset.exportUnavailable) throw new Error(asset.exportError || "资产不存在或无法读取，请刷新资源库后重试");
      const build = firstImportError => buildExportAssets([asset], progress => onProgress?.({
        ...progress,
        percent: 10 + Math.round(((position + Math.min(1, Number(progress.percent) / 100)) / assets.length) * 50)
      }), exportResolution, decalParentType, plantExportMode, plantSyntheticWind, folderNameCounts,
      { meshOverwritePolicy: options?.meshOverwritePolicy, firstImportError });
      const built = await build().catch(error => {
        const policy = normalizeMeshOverwritePolicy(options?.meshOverwritePolicy);
        if ((policy !== "meshOnly" && policy.length !== 0) || !is3DAssetType(asset.assetType)) throw error;
        // UE can still update an existing mesh when only the material payload failed.
        return build(error.message || String(error));
      });
      if (!built.length) {
        item.status = "skipped";
        item.message = await summarizeInvalidExportAssets([asset], exportResolutionToPixels(exportResolution)) || "没有可导出的模型或贴图";
      } else exportAssets.push(...built);
    } catch (error) {
      item.status = "failed";
      item.message = error?.message || String(error);
    }
  }
  function handleMaterialFailures(failures) {
    for (let index = exportAssets.length - 1; index >= 0; index--) {
      const asset = exportAssets[index];
      const message = failures.get(String(asset.id));
      if (!message) continue;
      if (asset.meshOverwritePolicy === "meshOnly" || asset.meshOverwritePolicy?.length === 0) {
        asset.firstImportError = message;
        delete asset.materialMatching;
        continue;
      }
      const item = results.find(result => result.assetId === String(asset.id));
      if (item) { item.status = "failed"; item.message = message; }
      exportAssets.splice(index, 1);
    }
  }
  handleMaterialFailures(await prepareNamedMaterialBatch(exportAssets));
  const catalog = namedMaterialCatalog(exportAssets);
  handleMaterialFailures(catalog.failures);
  const finish = (status, message) => {
    for (const item of results) {
      if (item.status === "pending") { item.status = status; item.message = message; }
    }
    const counts = { success: 0, failed: 0, skipped: 0, unconfirmed: 0 };
    for (const item of results) counts[item.status]++;
    return { results, counts, partial: counts.success > 0 && counts.success < results.length,
      exportedAssetIds: results.filter(item => item.status === "success").map(item => item.assetId) };
  };
  if (exportAssets.length === 0) {
    const reason = results.map(item => item.message).filter(Boolean).join("；");
    return {
      ok: false,
      ...finish("skipped", "没有可导出内容"),
      message: reason
        ? `未找到可导入的有效资产（支持3D/3DPlant/Surface/Decal/Atlas/HDRI）。${reason}`
        : "未找到可导入的有效资产（支持3D/3DPlant/Surface/Decal/Atlas/HDRI）"
    };
  }
  const requiresCommonMaterial = exportAssets.some((asset) => {
    const assetType = String(asset?.assetType || "").trim().toLowerCase();
    return !Array.isArray(asset.meshOverwritePolicy) && asset.meshOverwritePolicy !== "meshOnly"
      && asset.plantAssetType !== "naniteFoliage" && assetType !== "hdri" && assetType !== "surface" && assetType !== "decal" && !isAtlasAssetType(assetType);
  });
  let resolvedOptions;
  let pluginState;
  try {
    resolvedOptions = await resolveUnrealOptions(options);
    if (toNonEmptyString(resolvedOptions.unrealLogPath)) {
      await fs.mkdir(path.dirname(resolvedOptions.unrealLogPath), { recursive: true });
    }
    if (typeof onProgress === "function") {
      onProgress({ percent: 62, message: "准备 Unreal 导入..." });
    }
    pluginState = await ensurePluginInstalled(resolvedOptions.unrealProjectPath, resolvedOptions.unrealEditorPath);
    if (requiresCommonMaterial) {
      const commonProbe = await ensureCommonMaterialAvailable(resolvedOptions.unrealProjectPath, resolvedOptions.unrealEditorPath);
      if (!commonProbe.ok && commonProbe.reason === "missing-common-material") {
        return {
          ok: false,
          ...finish("failed", "缺少 AssetHive 公共材质，请安装或修复插件"),
          message: "缺少 AssetHive 公共材质（/Game/Common/MaterialInstance/MMI_GeneralMat）。请安装或修复 AssetHive 插件，或在设置里使用插件安装到引擎。"
        };
      }
    }
  } catch (error) {
    return { ok: false, message: error?.message || String(error), ...finish("failed", error?.message || String(error)) };
  }
  if (typeof onProgress === "function") {
    onProgress({ percent: 70, message: "生成导入清单..." });
  }
  const job = { assets: exportAssets, resolution: exportResolution,
    ...(exportAssets.some(asset => asset.meshOverwritePolicy !== undefined && asset.meshOverwritePolicy !== "all") ? { prepareCommonOnFirstImport: true } : {}),
    ...(catalog.groups.length ? { namedMaterialGroups: catalog.groups } : {}) };
  if (typeof onProgress === "function") {
    onProgress({ percent: 78, message: "启动 Unreal 导入..." });
  }
  let tcpResult;
  try {
    const result = await tcpClient.importAssets(job, {
      projectPath: resolvedOptions.unrealRequestProjectPath || "", onProgress
    });
    tcpResult = { used: true, output: "tcp-complete", requestId: result.requestId };
    onProgress?.({ percent: 100, message: results.some(item => item.status !== "pending") ? "有效资产导入完成，请查看逐项结果" : "Unreal 导入完成" });
  } catch (error) {
    const confirmedFailure = error.code === "ASSETHIVE_IMPORT_FAILED";
    if (confirmedFailure && Array.isArray(error.assetResults)) {
      const receipts = new Map(error.assetResults.map(item => [item?.assetId, item]));
      for (const item of results) {
        const receipt = receipts.get(item.assetId);
        if (item.status !== "pending" || !["success", "failed"].includes(receipt?.status)) continue;
        item.status = receipt.status;
        item.message = receipt.message || (receipt.status === "success" ? "Unreal 导入完成" : error.message);
      }
    }
    // Older plugins report only a job-level failure. It identifies the item in
    // a single-asset job, but cannot identify completed items in a mixed batch.
    const failed = error.code === "ASSETHIVE_NOT_DISPATCHED" || (confirmedFailure && exportAssets.length === 1);
    tcpResult = { used: false, error: error.message, failed, requestId: error.requestId };
  }
  if (!tcpResult?.used) {
    const summary = finish(tcpResult?.failed ? "failed" : "unconfirmed", tcpResult?.error || "Unreal 导入结果未确认，请先检查引擎内的资产");
    return {
      ok: summary.counts.success > 0,
      ...summary,
      requestId: tcpResult?.requestId,
      message: summary.partial ? "部分资产已导入，请查看逐项结果" : (results.length === 1 ? results[0].message : tcpResult?.error),

      logFile: resolvedOptions.unrealLogPath,
      pluginState,
      output: tcpResult?.output || "dispatch-failed"
    };
  }
  return {
    ok: true,
    ...finish("success", "Unreal 导入完成"),
    message: results.every(item => item.status === "success") ? "Unreal 导入完成" : "部分资产已导入，请查看逐项结果",
    requestId: tcpResult.requestId,
    logFile: resolvedOptions.unrealLogPath,
    pluginState,
    output: tcpResult.output
  };
}

module.exports = {
  isZionPlantAsset,
  detectTextureSlotByFileName,
  detectSurfaceTextureSlotByFileName,
  normalizeExportTextureSlot,
  exportToUnreal,
  installPendingPlugins,
  collectCustomJsonModelVariants,
  buildExportModelPlan,
  buildExportAssets,
  normalizePlantExportMode,
  normalizePlantSyntheticWind,
  normalizeZionObjectSubfolder,
  pickExportModelFiles,
  pickExportModelVariants,
  collectTextureGroupsForExport,
  filterPlantTextureGroupsForExport
};
