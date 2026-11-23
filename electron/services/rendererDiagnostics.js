const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeFileAtomicSync } = require("./atomicFile");

const SAMPLE_INTERVAL_MS = 15_000;
const HISTORY_MS = 3 * 60_000;
const PREVIEW_STAGES = new Set(["load", "render", "webgl-context-lost", "render-ended"]);

function startLocalCrashReporting(app, crashReporter) {
  try {
    const dumpDirectory = app.getPath("crashDumps");
    crashReporter.start({ uploadToServer: false });
    return { dumpDirectory, uploadToServer: false };
  } catch (error) {
    return { dumpDirectory: null, error: String(error?.message || error) };
  }
}

function createRendererDiagnostics({ app, webContents, crashReporting, getActivity, writeLog }) {
  const samples = [];
  const recentEvents = [];
  let rendererPid = null;

  function remember(history, fields, limit) {
    history.push({ timeMs: Date.now(), ...fields });
    if (history.length > limit) history.shift();
  }

  function recordEvent(event, detail) {
    remember(recentEvents, { event, ...detail }, 24);
  }

  function recordCharacterPreview(payload) {
    if (!PREVIEW_STAGES.has(payload?.stage)) return;
    const { stage, modelCount, textureCount, viewCount, imageSize, skeletonPreview } = payload;
    if (![modelCount, textureCount, viewCount, imageSize].every(value => Number.isSafeInteger(value) && value >= 0)) return;
    recordEvent("character-preview", { stage, modelCount, textureCount, viewCount, imageSize, skeletonPreview: skeletonPreview === true });
  }

  function readResources({ includeOtherProcesses = false } = {}) {
    let systemMemoryKiB = null;
    let processes = [];
    try { systemMemoryKiB = process.getSystemMemoryInfo(); } catch { /* Diagnostics are best effort. */ }
    try {
      processes = app.getAppMetrics()
        .filter(({ pid, type }) => includeOtherProcesses || pid === rendererPid || type === "Browser" || type === "GPU")
        .map(({ pid, type, name, creationTime, memory, cpu }) => ({
          pid, type, name, creationTime,
          memory, cpuPercent: cpu?.percentCPUUsage
        }));
    } catch { /* A process can exit while Electron is collecting metrics. */ }
    return { systemMemoryKiB, processes };
  }

  function sample() {
    if (webContents.isDestroyed() || webContents.isCrashed()) return;
    const pid = webContents.getOSProcessId();
    if (pid > 0) rendererPid = pid;
    remember(samples, { rendererPid, ...readResources(), activity: getActivity() }, 12);
  }

  const timer = globalThis.setInterval(sample, SAMPLE_INTERVAL_MS);
  timer.unref?.();
  webContents.on("dom-ready", sample);
  webContents.once("destroyed", () => globalThis.clearInterval(timer));

  function recordIncident(event, details, { persist = false } = {}) {
    const timeMs = Date.now();
    const recent = history => history.filter(entry => entry.timeMs >= timeMs - HISTORY_MS)
      .map(({ timeMs, ...entry }) => ({ at: new Date(timeMs).toISOString(), ...entry }));
    let gpuFeatures = null;
    try { gpuFeatures = app.getGPUFeatureStatus(); } catch { /* GPU discovery may still be running. */ }
    const payload = {
      ...details,
      ...(process.platform === "win32" && Number.isInteger(details.exitCode)
        ? { exitCodeHex: `0x${(details.exitCode >>> 0).toString(16).toUpperCase().padStart(8, "0")}` }
        : {}),
      at: new Date(timeMs).toISOString(),
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      osRelease: os.release(),
      mainPid: process.pid,
      rendererPid,
      memoryUnit: "KiB",
      ...readResources({ includeOtherProcesses: true }),
      activity: getActivity(),
      gpuFeatures,
      ...crashReporting,
      recentSamples: recent(samples),
      recentEvents: recent(recentEvents)
    };
    writeLog("ERROR", event, payload);
    if (persist) {
      try {
        const logDirectory = path.join(app.getPath("userData"), "Log");
        fs.mkdirSync(logDirectory, { recursive: true });
        writeFileAtomicSync(path.join(logDirectory, "last-renderer-crash.json"), JSON.stringify(payload, null, 2));
      } catch (error) {
        writeLog("WARN", "renderer crash report write failed", { message: error?.message });
      }
    }
  }

  return { recordEvent, recordCharacterPreview, recordIncident };
}

module.exports = { createRendererDiagnostics, startLocalCrashReporting };
