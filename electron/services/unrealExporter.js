const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const os = require("node:os");
const { Buffer } = require("node:buffer");
const { nativeImage } = require("electron");
const { tcpClient, connectToUE, sendToUE, onUEMessage, isUEConnected, waitForUEConnection } = require("./tcpClient");
let sharp = null;
try {
  sharp = require("sharp");
} catch (err) {
  console.warn("[AssetHive] sharp module not found, EXR to PNG conversion will not be available");
}
if (sharp && typeof sharp.concurrency === "function") {
  const configured = Number(process.env.ASSETHIVE_SHARP_CONCURRENCY);
  const cpuCount = Array.isArray(os.cpus?.()) ? os.cpus().length : 0;
  const fallback = cpuCount > 0 ? Math.max(1, Math.min(4, Math.floor(cpuCount / 2))) : 2;
  const concurrency = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : fallback;
  sharp.concurrency(concurrency);
}
const ALLOWED_EXPORT_TEXTURE_SLOTS = new Set(["albedo", "roughness", "normal", "ao", "displacement", "fuzz", "ordp", "opacity", "translucency"]);
const MODEL_FILE_EXTENSIONS = new Set([".fbx", ".obj", ".abc", ".gltf", ".glb", ".ztl"]);
const HAS_NATIVE_IMAGE = Boolean(nativeImage && typeof nativeImage.createFromPath === "function" && typeof nativeImage.createFromBitmap === "function");
const resizedTextureCache = new Map();
const normalizedJpegCache = new Map();
const EXPORT_COOPERATIVE_YIELD_INTERVAL = 3;
const PACKED_INTERLEAVE_CHUNK_PIXELS = 262144;
const LIVE_EDITOR_BRIDGE_MAX_AGE_MS = 20 * 1000;
const ASSETHIVE_UE_PORT = 13430;

function normalizeExportResolution(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "2k") return "2k";
  if (normalized === "8k") return "8k";
  return "4k";
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
  const base = path.basename(String(filePath || ""), path.extname(String(filePath || ""))).toLowerCase();
  if (!base) return "";
  if (/(^|[_\-.])(albedo|basecolor|base_color|diffuse|colou?r|d)($|[_\-.])/.test(base)) return "albedo";
  if (/(^|[_\-.])(normal|nrm|nor|n)($|[_\-.])/.test(base)) return "normal";
  if (/(^|[_\-.])(roughness|rough|r)($|[_\-.])/.test(base)) return "roughness";
  if (/(^|[_\-.])ao($|[_\-.])|ambientocclusion|ambient_occlusion/.test(base)) return "ao";
  if (/(^|[_\-.])(displacement|height|disp|h)($|[_\-.])/.test(base)) return "displacement";
  if (/(^|[_\-.])fuzz($|[_\-.])/.test(base)) return "fuzz";
  if (/(^|[_\-.])(ordp|orm|dprf|drf|m)($|[_\-.])/.test(base)) return "ordp";
  if (/(^|[_\-.])(opacity|alpha|o)($|[_\-.])|transparency/.test(base)) return "opacity";
  if (/(^|[_\-.])(translucency|translucent|transmission|sss)($|[_\-.])/.test(base)) return "translucency";
  return "";
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
  const sameSlot = textureCandidates.filter((candidate) => detectTextureSlotByFileName(candidate) === slot);
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
  const desiredGroupId = Math.max(1, Number(options?.groupId) || 1);
  let pool = filteredByLod.length > 0 ? filteredByLod : sameSlot;
  if (desiredGroupId > 1) {
    const groupMatched = pool.filter((candidate) => extractAreaTokensFromFileName(candidate).includes(desiredGroupId));
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
    const singleChannelSlots = new Set(["ao", "roughness", "displacement", "opacity", "ordp"]);
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
        .png()
        .toFile(newPath);
    } else {
      await sharp(filePath)
        .toColorspace("srgb")
        .png()
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
      await sharp(sourcePath).toColorspace("srgb").png().toFile(newPath);
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
    path.join(engineRoot, "Engine", "Plugins", "Marketplace", "AssetHive"),
    path.join(engineRoot, "Engine", "Plugins", "AssetHive"),
    path.join(engineRoot, "Engine", "Plugins", "Runtime", "AssetHive"),
    // Legacy / installer-side fallback (older AssetHive builds wrote here)
    path.join(engineRoot, "Plugins", "AssetHive"),
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

async function ensureCommonMaterialAvailable(unrealProjectPath, unrealEditorPath) {
  const projectRoot = getProjectRoot(unrealProjectPath);
  const enginePluginRoot = await findEngineAssetHivePluginRoot(unrealEditorPath);
  const enginePluginMat = enginePluginRoot
    ? path.join(enginePluginRoot, "Content", "Common", "MaterialInstance", "MMI_GeneralMat.uasset")
    : "";
  const engineHas = Boolean(enginePluginMat && await statFile(enginePluginMat));
  if (!projectRoot) {
    return engineHas ? { ok: true, source: "engine-only" } : { ok: false, reason: "missing-common-material" };
  }
  const projectMat = path.join(projectRoot, "Content", "Common", "MaterialInstance", "MMI_GeneralMat.uasset");
  const projectHas = Boolean(await statFile(projectMat));
  if (projectHas) return { ok: true, source: "project" };

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
        await fs.cp(candidateDir, projectCommonDir, { recursive: true, force: true });
        return { ok: true, source: "project-plugin-copied" };
      } catch (e) {
        return { ok: false, reason: "copy-failed", message: e?.message || String(e) };
      }
    }
  }

  if (!engineHas) {
    return { ok: false, reason: "missing-common-material" };
  }
  const engineCommonDir = path.join(enginePluginRoot, "Content", "Common");
  const projectCommonDir = path.join(projectRoot, "Content", "Common");
  try {
    await fs.mkdir(projectCommonDir, { recursive: true });
    await fs.cp(engineCommonDir, projectCommonDir, { recursive: true, force: true });
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
  const bridgePath = path.join(os.homedir(), "Documents", "AssetHive", "editor-bridge.json");
  try {
    const bridgeStats = await statOrNull(bridgePath);
    if (!bridgeStats || !bridgeStats.isFile()) {
      return "";
    }
    const raw = await fs.readFile(bridgePath, "utf-8");
    const parsed = JSON.parse(raw);
    const bridgeTimestamp = Number(parsed?.timestamp) || 0;
    if (!bridgeTimestamp || Date.now() - bridgeTimestamp > LIVE_EDITOR_BRIDGE_MAX_AGE_MS) {
      return "";
    }
    const candidate = toNonEmptyString(parsed?.projectPath);
    if (!candidate) {
      return "";
    }
    const resolved = path.resolve(candidate);
    if (!(await exists(resolved))) {
      return "";
    }
    return resolved;
  } catch {
    return "";
  }
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
  const focusedProject = await readFocusedUnrealProjectPath();
  const liveEditorProject = await readLiveEditorProjectPath();
  const runningProjects = await readRunningUnrealProjectPaths();
  const configuredProject = toNonEmptyString(options?.unrealProjectPath);
  let detectedProjectPath = "";
  let configuredProjectPath = "";

  if (focusedProject) {
    detectedProjectPath = focusedProject;
  } else if (liveEditorProject) {
    detectedProjectPath = liveEditorProject;
  } else if (runningProjects.length > 0) {
    detectedProjectPath = runningProjects[0];
  }

  if (configuredProject) {
    const resolvedConfigured = path.resolve(configuredProject);
    if (await exists(resolvedConfigured)) {
      const stat = await fs.stat(resolvedConfigured);
      if (stat.isDirectory()) {
        const entries = await fs.readdir(resolvedConfigured, { withFileTypes: true });
        const projectEntry = entries.find((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".uproject");
        if (projectEntry) {
          configuredProjectPath = path.join(resolvedConfigured, projectEntry.name);
        }
      } else if (path.extname(resolvedConfigured).toLowerCase() === ".uproject") {
        configuredProjectPath = resolvedConfigured;
      }
    }
  }
  const unrealProjectPath = detectedProjectPath || configuredProjectPath || "";
  const requestProjectPath = detectedProjectPath || "";

  const engineAssociation = unrealProjectPath ? await readEngineAssociation(unrealProjectPath) : "";
  const configuredEditor = toNonEmptyString(options?.unrealEditorPath);
  const editorCandidates = [];

  if (configuredEditor) {
    const resolvedEditor = path.resolve(configuredEditor);
    if (await exists(resolvedEditor)) {
      const editorStat = await fs.stat(resolvedEditor);
      if (editorStat.isDirectory()) {
        // If it's a directory, try to find the actual executable
        editorCandidates.push(path.join(resolvedEditor, "Engine", "Binaries", "Win64", "UnrealEditor.exe"));
        editorCandidates.push(path.join(resolvedEditor, "Engine", "Binaries", "Win64", "UE4Editor.exe"));
        editorCandidates.push(path.join(resolvedEditor, "Binaries", "Win64", "UnrealEditor.exe"));
      } else {
        editorCandidates.push(resolvedEditor);
      }
    }
  }

  const extractDrivePrefix = (inputPath) => {
    const normalized = toNonEmptyString(inputPath);
    if (!normalized) {
      return "";
    }
    const matched = normalized.match(/^[a-zA-Z]:/);
    return matched ? matched[0].toUpperCase() : "";
  };
  const drivePrefixes = [...new Set([
    "C:",
    "D:",
    "E:",
    "F:",
    "G:",
    extractDrivePrefix(unrealProjectPath),
    extractDrivePrefix(configuredProject),
    extractDrivePrefix(options?.unrealEditorPath)
  ].filter(Boolean))];
  const stores = ["Program Files\\Unreal Engine", "Program Files\\Epic Games", "Epic Games", "UE5", "UE"];
  if (engineAssociation) {
    for (const drive of drivePrefixes) {
      for (const store of stores) {
        editorCandidates.push(path.join(`${drive}\\`, store, `UE_${engineAssociation}`, "Engine", "Binaries", "Win64", "UnrealEditor.exe"));
      }
    }
  }
  for (const drive of drivePrefixes) {
    for (const store of stores) {
      editorCandidates.push(path.join(`${drive}\\`, store, "UE_5.5", "Engine", "Binaries", "Win64", "UnrealEditor.exe"));
    }
  }
  const unrealEditorPath = await firstExistingFile(editorCandidates);
  if (!unrealEditorPath) {
    const projectHint = unrealProjectPath ? `当前项目路径：${unrealProjectPath}` : "当前未探测到运行中的项目路径";
    const editorHint = unrealEditorPath ? `当前编辑器路径：${unrealEditorPath}` : "未找到有效的 UnrealEditor.exe 路径";
    throw new Error(`配置不完整或路径无效。${projectHint}，${editorHint}。请在设置中重新配置。`);
  }
  const commandletEditorPath = unrealEditorPath.toLowerCase().endsWith("unrealeditor.exe")
    ? unrealEditorPath.replace(/UnrealEditor\.exe$/i, "UnrealEditor-Cmd.exe")
    : unrealEditorPath;
  const unrealCommandPath = (await exists(commandletEditorPath)) ? commandletEditorPath : unrealEditorPath;
  
  // 优先使用设置中的路径，否则写入用户可写目录（Program Files 安装目录是只读的）。
  const userDataRoot = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const defaultLogDir = path.join(userDataRoot, "AssetHive", "Log");
  const defaultLogPath = path.join(defaultLogDir, "AssetHiveImport.log");
  
  const unrealLogPath = toNonEmptyString(options?.unrealLogPath) ? path.resolve(options.unrealLogPath) : defaultLogPath;
  
  return {
    ...options,
    unrealProjectPath,
    unrealRequestProjectPath: requestProjectPath,
    unrealEditorPath,
    unrealCommandPath,
    unrealLogPath
  };
}

async function ensurePluginInstalled(unrealProjectPath, unrealEditorPath) {
  const localPluginDir = await firstExistingFile([
    path.join(process.resourcesPath, "AssetHive-UE-Plugin", "AssetHive"),
    path.resolve(__dirname, "..", "..", "AssetHive-UE-Plugin", "AssetHive"),
    path.resolve(__dirname, "..", "..", "ue-plugin", "AssetHive")
  ]);

  // Already installed somewhere the engine will load? Treat as success.
  const existingPluginRoot = await findEngineAssetHivePluginRoot(unrealEditorPath);
  if (existingPluginRoot) {
    return { copied: false, reason: "Engine already has AssetHive plugin", path: existingPluginRoot };
  }

  if (!localPluginDir || !(await exists(localPluginDir))) {
    return { copied: false, reason: "AssetHive plugin is missing in local package" };
  }

  // Target: Engine/Plugins/Marketplace/AssetHive (the canonical UE plugin location)
  const engineRoot = path.resolve(path.dirname(unrealEditorPath), "..", "..", "..");
  const enginePluginsDir = path.join(engineRoot, "Engine", "Plugins", "Marketplace", "AssetHive");

  try {
    await fs.mkdir(path.dirname(enginePluginsDir), { recursive: true });
    await fs.cp(localPluginDir, enginePluginsDir, { recursive: true });
    return { copied: true, target: "engine", path: enginePluginsDir };
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EACCES")) {
      throw new Error("无法安装插件到引擎目录（权限不足）。请尝试以管理员身份运行软件，或手动将插件拷贝到引擎的 Engine/Plugins/Marketplace 目录。");
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

function shouldAllowDisplacementByAssetType(assetType) {
  const normalized = String(assetType || "").trim().toLowerCase();
  return normalized === "surface" || normalized === "3dplant" || normalized === "3d";
}

function resolveImportCategoryFolder(asset) {
  const assetType = String(asset?.assetType || "").trim().toLowerCase();
  const normalized = String(assetType || "").trim().toLowerCase();
  if (normalized === "3d") return "3D_Assets";
  if (normalized === "3dplant") return "3D_Plants";
  if (normalized === "surface") return "Surfaces";
  if (normalized === "decal") return "Decals";
  if (normalized === "hdri") return "HDRI";
  return "Others";
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

function resolveImportAssetFolderName(asset) {
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
  return `${baseName}_${safeId}`;
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

function collectCustomJsonModelFiles(asset) {
  const meta = asset?.meta && typeof asset.meta === "object" ? asset.meta : null;
  const assetRoot = typeof asset?.path === "string" && asset.path.trim() ? asset.path : "";
  const unique = new Set();
  const pushPath = (value) => {
    const raw = String(value || "").trim();
    if (!raw) {
      return;
    }
    const resolved = path.isAbsolute(raw)
      ? path.resolve(raw)
      : (assetRoot ? path.resolve(assetRoot, raw) : path.resolve(raw));
    unique.add(resolved);
  };
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
  if (Array.isArray(meta?.components)) {
    for (const item of meta.components) {
      if (!item || typeof item !== "object") {
        continue;
      }
      if (String(item.type || "").trim().toLowerCase() !== "model") {
        continue;
      }
      pushPath(item.path || item.uri);
    }
  }
  return [...unique].filter((item) => MODEL_FILE_EXTENSIONS.has(path.extname(item).toLowerCase()));
}

function pickExportModelFiles(asset) {
  const assetType = String(asset?.assetType || "").trim().toLowerCase();
  if (!is3DAssetType(assetType)) {
    return [];
  }
  const source = String(asset?.source || "").trim().toLowerCase();
  const candidates = Array.isArray(asset?.modelFiles) ? asset.modelFiles.filter((item) => typeof item === "string" && item.trim()) : [];
  if (source === "custom") {
    const jsonModelFiles = collectCustomJsonModelFiles(asset);
    return jsonModelFiles.length > 0 ? jsonModelFiles : candidates;
  }
  if (candidates.length === 0) {
    return [];
  }
  if (source === "quixel") {
    if (assetType === "3dplant") {
      const scored = [...candidates].map((filePath) => {
        const name = path.basename(String(filePath || "")).toLowerCase();
        const groupTokens = extractAreaTokensFromFileName(filePath);
        const groupId = groupTokens.length > 0 ? Math.max(1, Number(groupTokens[0]) || 1) : 1;
        const lodMatch = name.match(/(?:^|[_\-.])(lod)(\d+)(?:$|[_\-.])/i);
        const lodIndex = lodMatch ? Number.parseInt(lodMatch[2], 10) : Number.NaN;
        const isHigh = name.includes("highpoly") || name.includes("_high") || name.includes("-high");
        const lodRank = isHigh ? -1 : (Number.isFinite(lodIndex) ? lodIndex : 99);
        return { filePath, groupId, lodRank, name };
      });
      const uniqueByLower = new Set();
      const ordered = scored
        .filter((item) => {
          const key = String(item.filePath || "").toLowerCase();
          if (uniqueByLower.has(key)) {
            return false;
          }
          uniqueByLower.add(key);
          return true;
        })
        .sort((a, b) => {
          if (a.groupId !== b.groupId) return a.groupId - b.groupId;
          if (a.lodRank !== b.lodRank) return a.lodRank - b.lodRank;
          return a.name.localeCompare(b.name);
        })
        .map((item) => item.filePath);
      return ordered;
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

function collectTextureBySlotFromJson(asset, assetType, targetResolutionPixels = 4096) {
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

  const normalizedAssetType = String(assetType || "").trim().toLowerCase();
  const source = String(asset?.source || "").trim().toLowerCase();
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
    if (normalized === "albedo" || normalized === "diffuse" || normalized === "basecolor" || normalized === "base_color") return "albedo";
    if (normalized === "normal" || normalized === "normalbump" || normalized === "normal_gl") return "normal";
    if (normalized === "roughness" || normalized === "gloss") return "roughness";
    if (normalized === "ao" || normalized === "ambientocclusion" || normalized === "ambient_occlusion" || normalized === "cavity") return "ao";
    if (normalized === "displacement" || normalized === "height" || normalized === "bump") return "displacement";
    if (normalized === "opacity" || normalized === "alpha") return "opacity";
    if (normalized === "translucency" || normalized === "translucent" || normalized === "transmission" || normalized === "sss") return "translucency";
    if (normalized === "fuzz") return "fuzz";
    if (normalized === "ordp" || normalized === "orm") return "ordp";
    return "";
  };
  const components = Array.isArray(meta?.components) ? meta.components : [];
  const pickQuixelCandidateForSlot = (slot) => {
    const keywordsBySlot = {
      albedo: ["albedo", "basecolor", "base_color", "diffuse"],
      normal: ["normal_lod0", "normal", "normalbump"],
      roughness: ["roughness", "gloss"],
      ao: ["ao", "ambient_occlusion", "ambientocclusion", "cavity"],
      displacement: ["displacement", "height", "bump"],
      fuzz: ["fuzz"],
      opacity: ["opacity", "alpha"],
      translucency: ["translucency", "translucent", "transmission", "sss"],
      ordp: ["ordp", "orm"]
    };
    const keywords = keywordsBySlot[slot] || [];
    if (keywords.length === 0) {
      return "";
    }
    const filtered = textureCandidates.filter((filePath) => {
      const normalizedName = path.basename(String(filePath || "")).toLowerCase();
      if (normalizedName.includes("preview") || normalizedName.includes("thumb")) {
        return false;
      }
      return keywords.some((keyword) => normalizedName.includes(keyword));
    });
    if (filtered.length === 0) {
      return "";
    }
    filtered.sort((a, b) => {
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
    return filtered[0];
  };
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
    if (!slot || !ALLOWED_EXPORT_TEXTURE_SLOTS.has(slot) || bySlot.has(slot)) {
      continue;
    }
    if (slot === "displacement" && !allowDisplacement) {
      continue;
    }
    const uriCandidates = flattenComponentUris(component);
    const preferredSource = uriCandidates.length > 0 ? uriCandidates : (source === "quixel" ? [pickQuixelCandidateForSlot(slot)].filter(Boolean) : []);
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
    if (!ALLOWED_EXPORT_TEXTURE_SLOTS.has(slot)) {
      continue;
    }
    if (slot === "displacement" && !allowDisplacement) {
      continue;
    }
    if (bySlot.has(slot)) {
      continue;
    }
    const resolved = resolveFromCandidates(mapItem.uri || mapItem.path || "");
    const fallbackResolved = resolved || (source === "quixel" ? pickQuixelCandidateForSlot(slot) : "");
    if (!fallbackResolved) {
      continue;
    }
    bySlot.set(slot, fallbackResolved);
  }
  if (source === "quixel" && bySlot.size === 0) {
    for (const slot of ["albedo", "normal", "roughness", "ao", "displacement", "fuzz"]) {
      const fallback = pickQuixelCandidateForSlot(slot);
      if (fallback && !bySlot.has(slot)) {
        bySlot.set(slot, fallback);
      }
    }
  }
  for (const candidate of textureCandidates) {
    const slot = detectTextureSlotByFileName(candidate);
    if (!slot) {
      continue;
    }
    if (!ALLOWED_EXPORT_TEXTURE_SLOTS.has(slot)) {
      continue;
    }
    if (slot === "displacement" && !allowDisplacement) {
      continue;
    }
    
    // For Megascans/Quixel, if we already have a texture for this slot, we only replace it if the new one is higher resolution.
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

function normalizeExportTextureSlot(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "albedo" || normalized === "diffuse" || normalized === "basecolor" || normalized === "base_color") return "albedo";
  if (normalized === "normal" || normalized === "normalbump" || normalized === "normal_gl") return "normal";
  if (normalized === "roughness" || normalized === "gloss") return "roughness";
  if (normalized === "ao" || normalized === "ambientocclusion" || normalized === "ambient_occlusion" || normalized === "cavity") return "ao";
  if (normalized === "displacement" || normalized === "height" || normalized === "bump") return "displacement";
  if (normalized === "opacity" || normalized === "alpha") return "opacity";
  if (normalized === "translucency" || normalized === "translucent" || normalized === "transmission" || normalized === "sss") return "translucency";
  if (normalized === "fuzz") return "fuzz";
  if (normalized === "ordp" || normalized === "orm") return "ordp";
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
  const normalMapFormats = fullMeta?.normalMapFormats && typeof fullMeta.normalMapFormats === "object" ? fullMeta.normalMapFormats : {};
  const groups = new Map();
  const ensureGroup = (groupId) => {
    const normalizedGroupId = Math.max(1, Number(groupId) || 1);
    if (!groups.has(normalizedGroupId)) {
      const groupFallback = String(normalMapFormats[normalizedGroupId] || normalMapFormats[String(normalizedGroupId)] || fallbackNormalMapFormat).trim().toLowerCase() === "opengl" ? "opengl" : "dx";
      groups.set(normalizedGroupId, { groupId: normalizedGroupId, normalMapFormat: groupFallback, bySlot: new Map() });
    }
    return groups.get(normalizedGroupId);
  };

  const addTextureEntry = (entryLike) => {
    const slot = normalizeExportTextureSlot(entryLike?.textureType || entryLike?.slot || entryLike?.type || entryLike?.name);
    if (!slot || !ALLOWED_EXPORT_TEXTURE_SLOTS.has(slot)) {
      return;
    }
    if (slot === "displacement" && !allowDisplacement) {
      return;
    }
    const groupId = Math.max(1, Number(entryLike?.areaIndex) || 1);
    const group = ensureGroup(groupId);
    const resolvedPath = resolveTextureCandidatePath(entryLike?.file || entryLike?.uri || entryLike?.path || "", textureCandidates, baseDir);
    if (!resolvedPath) {
      return;
    }
    const resolutionMatched = pickResolutionMatchedTexture(slot, resolvedPath, textureCandidates, targetResolutionPixels, { groupId });
    
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

  const textureEntries = Array.isArray(fullMeta?.textureEntries) ? fullMeta.textureEntries : [];
  for (const item of textureEntries) {
    addTextureEntry(item);
  }
  const textureComponents = Array.isArray(fullMeta?.components)
    ? fullMeta.components.filter((item) => item && String(item.type || "").toLowerCase() === "texture")
    : [];
  for (const item of textureComponents) {
    addTextureEntry(item);
  }

  if (groups.size === 0) {
    const fallbackSlots = collectTextureBySlotFromJson({ ...asset, meta: fullMeta }, assetType, targetResolutionPixels);
    const fallbackGroup = ensureGroup(1);
    for (const [slot, filePath] of fallbackSlots.entries()) {
      fallbackGroup.bySlot.set(slot, filePath);
    }
  }

  return [...groups.values()]
    .filter((group) => group.bySlot.size > 0)
    .sort((a, b) => a.groupId - b.groupId);
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
          .png()
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

function getChannelValueFromBitmap(bitmap, width, x, y, mode = "luma") {
  const px = (y * width + x) * 4;
  // Electron's nativeImage toBitmap returns BGRA in little-endian on Windows.
  // B: px, G: px+1, R: px+2, A: px+3
  const b = bitmap[px] || 0;
  const g = bitmap[px + 1] || 0;
  const r = bitmap[px + 2] || 0;
  
  if (mode === "red") {
    // Return the red channel value
    return r;
  }
  // Standard luma formula: 0.299*R + 0.587*G + 0.114*B
  return Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
}

async function resolvePackedTextureSize(sourcePaths) {
  const candidates = Array.isArray(sourcePaths) ? sourcePaths.map((filePath) => String(filePath || "").trim()).filter(Boolean) : [];
  for (const filePath of candidates) {
    if (sharp) {
      try {
        const metadata = await sharp(filePath).metadata();
        const width = Math.max(1, Number(metadata?.width) || 0);
        const height = Math.max(1, Number(metadata?.height) || 0);
        if (width > 0 && height > 0) {
          return { width, height };
        }
      } catch {
        void 0;
      }
    }
    if (HAS_NATIVE_IMAGE && path.extname(filePath).toLowerCase() !== ".exr") {
      const image = nativeImage.createFromPath(filePath);
      if (!image.isEmpty()) {
        const size = image.getSize();
        const width = Math.max(1, Number(size?.width) || 0);
        const height = Math.max(1, Number(size?.height) || 0);
        if (width > 0 && height > 0) {
          return { width, height };
        }
      }
    }
  }
  return null;
}

async function loadPackedChannelBytes(filePath, width, height, slotName) {
  const resolvedPath = toNonEmptyString(filePath);
  if (!resolvedPath) {
    return null;
  }
  const lowerPath = resolvedPath.toLowerCase();
  if (sharp) {
    try {
      const normalizedSlot = String(slotName || "").trim().toLowerCase();
      const isScalarSlot = normalizedSlot === "ao" || normalizedSlot === "roughness" || normalizedSlot === "displacement" || normalizedSlot === "opacity";
      let pipeline = sharp(resolvedPath, { unlimited: true, sequentialRead: true }).resize(width, height, { fit: "fill" });
      if (isScalarSlot) {
        if (lowerPath.endsWith(".exr")) {
          const stats = await sharp(resolvedPath, { unlimited: true, sequentialRead: true }).stats();
          const firstChannel = Array.isArray(stats?.channels) && stats.channels.length > 0 ? stats.channels[0] : null;
          const min = Number(firstChannel?.min);
          const max = Number(firstChannel?.max);
          const validRange = Number.isFinite(min) && Number.isFinite(max) && max > min;
          const scale = validRange ? (1 / (max - min)) : 1;
          const offset = validRange ? (-min * scale) : 0;
          pipeline = pipeline.linear(scale, offset);
        }
        pipeline = pipeline.greyscale();
      } else {
        pipeline = pipeline.ensureAlpha();
      }
      const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
      const channels = Math.max(1, Number(info?.channels) || 1);
      if (isScalarSlot && channels === 1) {
        return data;
      }
      const pixels = width * height;
      const out = Buffer.alloc(pixels);
      for (let index = 0; index < pixels; index += 1) {
        const offset = index * channels;
        out[index] = data[offset] || 0;
      }
      return out;
    } catch (error) {
      console.warn(`[AssetHive] Failed to read packed channel via sharp: ${resolvedPath}`, error?.message || error);
    }
  }
  if (!HAS_NATIVE_IMAGE || lowerPath.endsWith(".exr")) {
    return null;
  }
  const image = nativeImage.createFromPath(resolvedPath);
  if (image.isEmpty()) {
    return null;
  }
  const next = image.getSize().width === width && image.getSize().height === height
    ? image
    : image.resize({ width, height, quality: "best" });
  const bitmap = next.toBitmap();
  const out = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      out[y * width + x] = getChannelValueFromBitmap(bitmap, width, x, y, "red");
    }
  }
  return out;
}

function resolveNonExrSibling(filePath) {
  const normalized = toNonEmptyString(filePath);
  if (!normalized) {
    return "";
  }
  const lower = normalized.toLowerCase();
  if (!lower.endsWith(".exr")) {
    return normalized;
  }
  const parsed = path.parse(normalized);
  const preferredExts = [".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"];
  for (const ext of preferredExts) {
    const candidate = path.join(parsed.dir, `${parsed.name}${ext}`);
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  return normalized;
}

function makeSolidChannelBuffer(width, height, scalarValue) {
  const buf = Buffer.alloc(width * height);
  buf.fill(Math.max(0, Math.min(255, Math.round(Number(scalarValue) * 255))));
  return buf;
}

async function interleavePackedChannels(width, height, channelBytesByName, defaultFill) {
  const outBufferRgba = Buffer.alloc(width * height * 4);
  const pixelCount = width * height;
  const toByte = (scalar) => Math.max(0, Math.min(255, Math.round(Number(scalar) * 255)));
  const defaults = {
    ao: toByte(defaultFill.ao),
    roughness: toByte(defaultFill.roughness),
    displacement: toByte(defaultFill.displacement),
    opacity: toByte(defaultFill.opacity)
  };
  for (let start = 0; start < pixelCount; start += PACKED_INTERLEAVE_CHUNK_PIXELS) {
    const end = Math.min(pixelCount, start + PACKED_INTERLEAVE_CHUNK_PIXELS);
    for (let index = start; index < end; index += 1) {
      const px = index * 4;
      outBufferRgba[px] = channelBytesByName.ao ? channelBytesByName.ao[index] : defaults.ao;
      outBufferRgba[px + 1] = channelBytesByName.roughness ? channelBytesByName.roughness[index] : defaults.roughness;
      outBufferRgba[px + 2] = channelBytesByName.displacement ? channelBytesByName.displacement[index] : defaults.displacement;
      outBufferRgba[px + 3] = channelBytesByName.opacity ? channelBytesByName.opacity[index] : defaults.opacity;
    }
    if (end < pixelCount) {
      await yieldToEventLoop();
    }
  }
  return outBufferRgba;
}

async function mergeAlbedoWithOpacityAlpha(albedoPath, opacityPath, assetId, groupId) {
  if (!albedoPath || !opacityPath) {
    return albedoPath;
  }
  if (!sharp && !HAS_NATIVE_IMAGE) {
    return albedoPath;
  }

  const tempDir = path.join(os.tmpdir(), "assethive", "merged_albedo");
  const safeId = String(assetId || "asset").replace(/[^\w-]/g, "_");
  const outPath = path.join(tempDir, `${safeId}_g${groupId || 0}_albedoA.png`);

  try {
    await fs.mkdir(tempDir, { recursive: true });

    if (sharp) {
      // Run everything in libvips worker threads — no per-pixel JS loop on main thread.
      const meta = await sharp(albedoPath, { unlimited: true, sequentialRead: true }).metadata();
      const width = Math.max(1, Number(meta?.width) || 0);
      const height = Math.max(1, Number(meta?.height) || 0);
      if (width <= 0 || height <= 0) {
        return albedoPath;
      }
      const alphaBytes = await loadPackedChannelBytes(opacityPath, width, height, "opacity");
      if (!alphaBytes) {
        return albedoPath;
      }
      await sharp(albedoPath, { unlimited: true, sequentialRead: true })
        .removeAlpha()
        .toColorspace("srgb")
        .joinChannel(alphaBytes, { raw: { width, height, channels: 1 } })
        .png()
        .toFile(outPath);
      return outPath;
    }

    // nativeImage fallback (no sharp): accept one JS loop, but yield periodically.
    const img = nativeImage.createFromPath(albedoPath);
    if (img.isEmpty()) {
      return albedoPath;
    }
    const size = img.getSize();
    const width = size.width;
    const height = size.height;
    const alphaBytes = await loadPackedChannelBytes(opacityPath, width, height, "opacity");
    if (!alphaBytes) {
      return albedoPath;
    }
    const bmp = img.toBitmap();
    const pixelCount = width * height;
    const bgraBytes = Buffer.alloc(pixelCount * 4);
    const CHUNK = PACKED_INTERLEAVE_CHUNK_PIXELS;
    for (let start = 0; start < pixelCount; start += CHUNK) {
      const end = Math.min(pixelCount, start + CHUNK);
      for (let i = start; i < end; i += 1) {
        const px = i * 4;
        bgraBytes[px] = bmp[px];
        bgraBytes[px + 1] = bmp[px + 1];
        bgraBytes[px + 2] = bmp[px + 2];
        bgraBytes[px + 3] = alphaBytes[i] || 0;
      }
      if (end < pixelCount) {
        await yieldToEventLoop();
      }
    }
    const composite = nativeImage.createFromBitmap(bgraBytes, { width, height });
    await fs.writeFile(outPath, composite.toPNG());
    return outPath;
  } catch (error) {
    console.warn(`[AssetHive] mergeAlbedoWithOpacityAlpha failed for ${assetId}:`, error?.message || error);
    return albedoPath;
  }
}

async function buildPackedOrdTexture(slotFileMap, assetId, sourceSlotFileMap) {
  if (!sharp && !HAS_NATIVE_IMAGE) {
    return "";
  }
  let aoPath = slotFileMap.get("ao") || "";
  let roughnessPath = slotFileMap.get("roughness") || "";
  const displacementKeys = [...slotFileMap.keys()].filter(k => k.startsWith("displacement"));
  let sourceDisplacementPath = "";
  let displacementPath = "";
  if (displacementKeys.length > 0) {
    const bestKey = displacementKeys.find((key) => {
      const candidate = String(slotFileMap.get(key) || "").toLowerCase();
      return candidate && !candidate.endsWith(".exr");
    }) || displacementKeys[0];
    displacementPath = slotFileMap.get(bestKey) || "";
    sourceDisplacementPath = sourceSlotFileMap instanceof Map ? (sourceSlotFileMap.get(bestKey) || "") : "";
  }
  displacementPath = resolveNonExrSibling(sourceDisplacementPath || displacementPath);
  let opacityPath = slotFileMap.get("opacity") || "";

  const sourcePaths = [aoPath, roughnessPath, displacementPath, opacityPath].filter(Boolean);
  if (sourcePaths.length === 0) {
    return "";
  }
  const size = await resolvePackedTextureSize(sourcePaths);
  if (!size) {
    return "";
  }
  const width = size.width;
  const height = size.height;
  const [aoBytes, roughnessBytes, displacementBytes, opacityBytes] = await Promise.all([
    loadPackedChannelBytes(aoPath, width, height, "ao"),
    loadPackedChannelBytes(roughnessPath, width, height, "roughness"),
    loadPackedChannelBytes(displacementPath, width, height, "displacement"),
    loadPackedChannelBytes(opacityPath, width, height, "opacity")
  ]);
  const defaultFill = {
    ao: 1.0,
    roughness: 0.8,
    displacement: 0.0,
    opacity: 1.0
  };
  const tempDir = path.join(os.tmpdir(), "assethive", "packed");
  await fs.mkdir(tempDir, { recursive: true });
  const packedPath = path.join(tempDir, `${assetId || Date.now()}_M.png`);
  const pixelCount = width * height;

  if (sharp) {
    try {
      // Hand the channel assembly to libvips so the main thread stays free.
      const channelRaw = { width, height, channels: 1 };
      const ao = aoBytes || makeSolidChannelBuffer(width, height, defaultFill.ao);
      const rough = roughnessBytes || makeSolidChannelBuffer(width, height, defaultFill.roughness);
      const disp = displacementBytes || makeSolidChannelBuffer(width, height, defaultFill.displacement);
      const opac = opacityBytes || makeSolidChannelBuffer(width, height, defaultFill.opacity);
      await sharp(ao, { raw: channelRaw })
        .joinChannel([rough, disp, opac], { raw: channelRaw })
        .png()
        .toFile(packedPath);
      return packedPath;
    } catch (error) {
      console.warn(`[AssetHive] Failed to pack via sharp joinChannel, falling back: ${assetId}`, error?.message || error);
    }
  }

  if (HAS_NATIVE_IMAGE) {
    const outBufferRgba = await interleavePackedChannels(width, height, {
      ao: aoBytes,
      roughness: roughnessBytes,
      displacement: displacementBytes,
      opacity: opacityBytes
    }, defaultFill);
    const outBufferBgra = Buffer.alloc(outBufferRgba.length);
    for (let index = 0; index < pixelCount; index += 1) {
      const px = index * 4;
      const r = outBufferRgba[px];
      const g = outBufferRgba[px + 1];
      const b = outBufferRgba[px + 2];
      const a = outBufferRgba[px + 3];
      outBufferBgra[px] = b;
      outBufferBgra[px + 1] = g;
      outBufferBgra[px + 2] = r;
      outBufferBgra[px + 3] = a;
    }
    const packedImage = nativeImage.createFromBitmap(outBufferBgra, { width, height, scaleFactor: 1 });
    await fs.writeFile(packedPath, packedImage.toPNG());
    return packedPath;
  }
  return "";
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

async function buildExportAssets(assets, onProgress, exportResolution = "4k") {
  const targetResolutionPixels = exportResolutionToPixels(exportResolution);
  const exportAssets = [];
  const folderNameCounts = new Map();
  const totalAssets = Math.max(1, assets.length);
  let scannedAssetCount = 0;
  let textureTaskCount = 0;
  let packedTaskCount = 0;
  const metaCache = new Map();
  for (const asset of assets) {
    scannedAssetCount += 1;
    if (typeof onProgress === "function") {
      const scanPercent = 12 + Math.round((scannedAssetCount / totalAssets) * 14);
      onProgress({ percent: scanPercent, message: `导出阶段：分析资产 ${scannedAssetCount}/${totalAssets}` });
    }
    const assetType = String(asset?.assetType || "").trim().toLowerCase();
    if (assetType !== "surface" && !is3DAssetType(assetType) && assetType !== "decal" && assetType !== "hdri") {
      continue;
    }
    if (assetType === "hdri") {
      continue;
    }
    const fullMeta = await loadAssetMetaForExport(asset);
    metaCache.set(asset.id, fullMeta);
    const groups = collectTextureGroupsForExport(asset, assetType, fullMeta, targetResolutionPixels);
    for (const group of groups) {
      textureTaskCount += group.bySlot.size;
      if (group.bySlot.has("ao") || group.bySlot.has("roughness") || group.bySlot.has("displacement") || group.bySlot.has("opacity")) {
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
    
    if (!isSurface && !is3D && !isDecal && !isHdri) {
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
        textureFiles: [hdriSource],
        textureSlots: [{ file: hdriSource, slot: "HDR", groupId: 1 }],
        materialGroups: [{
          groupId: 1,
          textureFiles: [hdriSource],
          textureSlots: [{ file: hdriSource, slot: "HDR", groupId: 1 }]
        }],
        tags: asset.tags
      });
      continue;
    }

    let exportModelFiles = [];
    if (is3D) {
      exportModelFiles = pickExportModelFiles(asset);
      if (exportModelFiles.length === 0) {
        continue;
      }
    }
    
    const fullMeta = metaCache.get(asset.id) || (await loadAssetMetaForExport(asset));
    const textureGroups = collectTextureGroupsForExport(asset, assetType, fullMeta, targetResolutionPixels);
    if (textureGroups.length === 0 && String(asset?.source || "").trim().toLowerCase() === "quixel") {
      console.warn(`[AssetHive] Quixel texture slots unresolved for asset ${asset.id} at ${asset.path || ""}`);
    }
    const materialGroups = [];
    for (const group of textureGroups) {
      if (isPlant) {
        const albedoSource = group.bySlot.get("albedo");
        const opacitySource = group.bySlot.get("opacity");
        if (albedoSource && opacitySource) {
          const mergedAlbedo = await mergeAlbedoWithOpacityAlpha(albedoSource, opacitySource, asset.id, group.groupId);
          if (mergedAlbedo && mergedAlbedo !== albedoSource) {
            group.bySlot.set("albedo", mergedAlbedo);
          }
        }
      }
      const processedTextureSlots = [];
      const processedTextureBySlot = new Map();
      const sourceTextureBySlot = new Map();
      for (const [slot, file] of group.bySlot.entries()) {
        if (isPlant && !["albedo", "normal", "roughness", "translucency", "opacity"].includes(slot)) {
          continue;
        }
        // Plants: opacity is not imported as a standalone texture in UE; it's only
        // included in the job so the UE side can read its bytes and pack it into
        // the albedo's alpha channel. Skip all per-slot processing (resize/normalize)
        // and just emit the raw source path for UE.
        if (isPlant && slot === "opacity") {
          sourceTextureBySlot.set(slot, file);
          processedTextureBySlot.set(slot, file);
          processedTextureSlots.push({ file, slot: "Opacity", groupId: group.groupId });
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
        
        // We only convert EXR to PNG for individual texture import if it's NOT a Surface asset's Displacement map.
        // Surface asset Displacement maps prefer EXR for high bit-depth.
        const isDisplacementSlot = slot.startsWith("displacement");
        const isSurfaceDisplacement = isSurface && isDisplacementSlot;
        const shouldSkipStandaloneDisplacement = is3D && isDisplacementSlot;

        if (shouldSkipStandaloneDisplacement) {
          processedTextureBySlot.set(slot, processedFile);
          continue;
        }
        
        if (processedFile.toLowerCase().endsWith(".exr") && !isSurfaceDisplacement) {
          processedFile = await convertExrToPngIfNeeded(processedFile, isDisplacementSlot ? "displacement" : slot);
        }
        processedFile = await normalizeJpegForUnrealIfNeeded(processedFile, slot);
        
        // If it's a Surface Displacement that was kept as EXR, we skip resizing because our nativeImage-based resizer
        // does not support EXR and will just return the original file anyway, but this is cleaner.
        const resizedPath = (isSurfaceDisplacement && processedFile.toLowerCase().endsWith(".exr")) 
          ? processedFile 
          : await resizeTextureIfNeeded(processedFile, targetResolutionPixels);
          
        let slotName = slot.charAt(0).toUpperCase() + slot.slice(1);
        if (slot === "ao") slotName = "AO";
        else if (slot === "ordp") slotName = "ORDp";
        else if (isDisplacementSlot) slotName = "Displacement";
        
        const entry = {
          file: resizedPath,
          slot: slotName,
          groupId: group.groupId
        };
        if (slot === "normal") {
          entry.normalMapFormat = group.normalMapFormat;
        }
        if (isDisplacementSlot) {
          entry.compression = "Displacement";
        }
        processedTextureBySlot.set(slot, resizedPath);
        if (!shouldSkipStandaloneDisplacement) {
          processedTextureSlots.push(entry);
        }
      }
      const hasPackedSource = !isPlant && processedTextureBySlot.has("ordp");
      const hasPackComponents = processedTextureBySlot.has("ao")
        || processedTextureBySlot.has("roughness")
        || [...processedTextureBySlot.keys()].some((key) => key.startsWith("displacement"))
        || processedTextureBySlot.has("opacity");
      const shouldPackOrd = !isPlant && hasPackComponents;
      
      // If we are packing, the buildPackedOrdTexture will now handle EXR conversion internally for its sources.
      
      if (shouldPackOrd && typeof onProgress === "function") {
        packedTaskIndex += 1;
        const packedPercent = 52 + Math.round((packedTaskIndex / Math.max(1, packedTaskCount)) * 8);
        onProgress({ percent: packedPercent, message: `导出阶段：合成贴图 ${packedTaskIndex}/${Math.max(1, packedTaskCount)}` });
      }
      if (!shouldPackOrd && hasPackedSource) {
        processedTextureSlots.push({
          file: processedTextureBySlot.get("ordp"),
          slot: "ORDp",
          groupId: group.groupId
        });
      } else if (shouldPackOrd) {
        const packedOrdPath = await buildPackedOrdTexture(processedTextureBySlot, `${asset.id}_g${group.groupId}`, sourceTextureBySlot);
        if (packedOrdPath) {
          processedTextureSlots.push({
            file: packedOrdPath,
            slot: "ORDp",
            groupId: group.groupId
          });
        }
      } else if (hasPackedSource) {
        processedTextureSlots.push({
          file: processedTextureBySlot.get("ordp"),
          slot: "ORDp",
          groupId: group.groupId
        });
      }
      materialGroups.push({
        groupId: group.groupId,
        textureFiles: processedTextureSlots.map((item) => item.file),
        textureSlots: processedTextureSlots
      });
    }
    const flattenedTextureFiles = materialGroups.flatMap((group) => group.textureFiles || []);
    const flattenedTextureSlots = materialGroups.flatMap((group) => group.textureSlots || []);
    
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
      modelFiles: exportModelFiles,
      textureFiles: flattenedTextureFiles,
      textureSlots: flattenedTextureSlots,
      materialGroups,
      tags: asset.tags
    });
  }
  return exportAssets;
}

function summarizeInvalidExportAssets(assets) {
  let unsupportedTypeCount = 0;
  let missingModelCount = 0;
  let missingHdriCount = 0;
  const unsupportedSamples = [];
  const missingModelSamples = [];
  const missingHdriSamples = [];
  for (const asset of assets || []) {
    const assetType = String(asset?.assetType || "").trim().toLowerCase();
    const isSurface = assetType === "surface";
    const is3D = is3DAssetType(assetType);
    const isDecal = assetType === "decal";
    const isHdri = assetType === "hdri";
    if (!isSurface && !is3D && !isDecal && !isHdri) {
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
  if (missingHdriCount > 0) {
    parts.push(`HDRI资产缺少可用HDR文件 ${missingHdriCount} 个${missingHdriSamples.length ? `：${missingHdriSamples.join("、")}` : ""}`);
  }
  return parts.join("；");
}

async function writeJobFile(assets, options) {
  const tempDir = path.join(os.tmpdir(), "assethive");
  await fs.mkdir(tempDir, { recursive: true });
  const jobFile = path.join(tempDir, `ue-import-${Date.now()}.json`);
  const payload = {
    createdAt: new Date().toISOString(),
    destinationPath: "/Game/AssetHive",
    resolution: options.exportResolution || "4k",
    assets
  };
  await fs.writeFile(jobFile, JSON.stringify(payload, null, 2), "utf-8");
  return jobFile;
}

function getUserBridgeDir() {
  return path.join(os.homedir(), "Documents", "AssetHive");
}

async function writeImportRequestFile({ jobFile, projectPath, requestId }) {
  const bridgeDir = getUserBridgeDir();
  await fs.mkdir(bridgeDir, { recursive: true });
  const targetPath = path.join(bridgeDir, "import-request.json");
  const payload = {
    timestamp: Date.now(),
    requestId,
    jobFile,
    projectPath: projectPath || ""
  };
  const tempPath = `${targetPath}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf-8");
  await fs.rename(tempPath, targetPath);
  return targetPath;
}

async function dispatchImportRequestFallback(jobFile, options, requestId, onProgress, reason = "") {
  const requestPath = await writeImportRequestFile({
    jobFile,
    projectPath: options.unrealRequestProjectPath || "",
    requestId
  });
  if (typeof onProgress === "function") {
    const detail = toNonEmptyString(reason);
    onProgress({
      percent: 100,
      message: detail
        ? `TCP 不可用（${detail}），已改用文件信号触发导入：${requestPath}`
        : `TCP 不可用，已改用文件信号触发导入：${requestPath}`
    });
  }
  return { used: true, output: "file-dispatched", requestId, requestPath };
}

async function runImportViaTCP(jobFile, options, onProgress) {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  if (!isUEConnected()) {
    connectToUE("127.0.0.1", ASSETHIVE_UE_PORT, { forceReconnect: true });
    const connected = await waitForUEConnection(2500);
    if (!connected) {
      return dispatchImportRequestFallback(jobFile, options, requestId, onProgress, "无法连接到 Unreal 插件");
    }
  }
  const requestPayload = {
    type: "import",
    requestId,
    jobFile,
    projectPath: options.unrealRequestProjectPath || "",
    timestamp: Date.now()
  };

  let completed = false;
  let result = null;

  const messageHandler = (message) => {
    try {
      const response = JSON.parse(message);
      if (response.requestId === requestId) {
        if (response.type === "progress" && typeof onProgress === "function") {
          const percent = Math.max(0, Math.min(100, Number(response.percent) || 78));
          const stage = toNonEmptyString(response.stage) || "Unreal 正在导入...";
          onProgress({ percent, message: stage });
        } else if (response.type === "complete") {
          completed = true;
          result = { used: true, output: "tcp-complete", requestId };
          if (typeof onProgress === "function") {
            onProgress({ percent: 100, message: response.message || "导入完成" });
          }
        } else if (response.type === "error") {
          completed = true;
          result = { used: false, error: response.message || "导入失败" };
        }
      }
    } catch {
      void 0;
    }
  };

  onUEMessage(messageHandler);

  const sent = sendToUE(JSON.stringify(requestPayload));
  if (!sent) {
    return dispatchImportRequestFallback(jobFile, options, requestId, onProgress, "发送 TCP 请求失败");
  }

  const gotAck = await new Promise((resolve) => {
    const timer = globalThis.setTimeout(() => resolve(false), 900);
    const poll = () => {
      if (completed) {
        globalThis.clearTimeout(timer);
        resolve(true);
        return;
      }
      globalThis.setTimeout(poll, 60);
    };
    poll();
  });

  if (!gotAck) {
    return dispatchImportRequestFallback(jobFile, options, requestId, onProgress, "TCP 未收到引擎响应");
  }

  if (result) {
    return result;
  }

  if (typeof onProgress === "function") {
    onProgress({ percent: 100, message: "已发送到 Unreal，导入在引擎中执行" });
  }
  return { used: true, output: "tcp-acked", requestId };
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
  const exportAssets = await buildExportAssets(assets, onProgress, exportResolution);
  if (exportAssets.length === 0) {
    const reason = summarizeInvalidExportAssets(assets);
    return {
      ok: false,
      message: reason
        ? `未找到可导入的有效资产（支持3D/3DPlant/Surface/Decal/HDRI）。${reason}`
        : "未找到可导入的有效资产（支持3D/3DPlant/Surface/Decal/HDRI）"
    };
  }
  const requiresCommonMaterial = exportAssets.some((asset) => {
    const assetType = String(asset?.assetType || "").trim().toLowerCase();
    return assetType !== "hdri";
  });
  const resolvedOptions = await resolveUnrealOptions(options);
  if (toNonEmptyString(resolvedOptions.unrealLogPath)) {
    await fs.mkdir(path.dirname(resolvedOptions.unrealLogPath), { recursive: true });
  }
  if (typeof onProgress === "function") {
    onProgress({ percent: 62, message: "检查插件状态..." });
  }
  const pluginState = await ensurePluginInstalled(resolvedOptions.unrealProjectPath, resolvedOptions.unrealEditorPath);
  if (requiresCommonMaterial) {
    const commonProbe = await ensureCommonMaterialAvailable(resolvedOptions.unrealProjectPath, resolvedOptions.unrealEditorPath);
    if (!commonProbe.ok && commonProbe.reason === "missing-common-material") {
      return {
        ok: false,
        message: "缺少 AssetHive 公共材质（/Game/Common/MaterialInstance/MMI_GeneralMat）。请安装或修复 AssetHive 插件，或在设置里使用插件安装到引擎。"
      };
    }
  }
  if (typeof onProgress === "function") {
    onProgress({ percent: 70, message: "生成导入清单..." });
  }
  const jobFile = await writeJobFile(exportAssets, { ...resolvedOptions, exportResolution });
  if (typeof onProgress === "function") {
    onProgress({ percent: 78, message: "启动 Unreal 导入..." });
  }
  const tcpResult = await runImportViaTCP(jobFile, resolvedOptions, onProgress);
  if (!tcpResult?.used) {
    return {
      ok: false,
      message: tcpResult?.error || "Unreal 未接收导入请求",
      jobFile,
      logFile: resolvedOptions.unrealLogPath,
      pluginState,
      output: tcpResult?.output || "dispatch-failed"
    };
  }
  return {
    ok: true,
    message: "已发送到 Unreal，导入在引擎中执行",
    jobFile,
    logFile: resolvedOptions.unrealLogPath,
    pluginState,
    output: tcpResult.output
  };
}

module.exports = {
  exportToUnreal,
  installPendingPlugins
};
