const path = require("node:path");
const chokidar = require("chokidar");
const { SKIP_DIRECTORY_NAMES, SKIP_FILE_NAMES } = require("./libraryIgnore");

function createLibraryWatcher(libraryPaths, onKeyChange, options = {}) {
  let debounceTimer = null;
  const WATCHABLE_EXTENSIONS = new Set([".json", ".jason"]);
  const WATCHABLE_PREVIEW_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".webm", ".mp4", ".gif"]);
  const WATCHABLE_MODEL_EXTENSIONS = new Set([".fbx", ".st9", ".obj", ".abc", ".gltf", ".glb"]);
  const explicitWatchSet = new Set(
    (Array.isArray(options?.explicitWatchFiles) ? options.explicitWatchFiles : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map((value) => path.resolve(value).toLowerCase())
  );
  const normalizedRoots = new Set(
    (Array.isArray(libraryPaths) ? libraryPaths : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map((value) => path.resolve(value).toLowerCase())
  );
  const shouldIgnoreWatchEventPath = (entryPath) => {
    const raw = String(entryPath || "").trim();
    if (!raw) {
      return true;
    }
    const resolvedLower = path.resolve(raw).toLowerCase();
    if (explicitWatchSet.has(resolvedLower)) {
      return false;
    }
    const baseName = path.basename(raw).toLowerCase();
    if (SKIP_FILE_NAMES.has(baseName)) {
      return true;
    }
    const ext = path.extname(raw).toLowerCase();
    if (!WATCHABLE_EXTENSIONS.has(ext)) {
      if (WATCHABLE_MODEL_EXTENSIONS.has(ext)) {
        return false;
      }
      if (!WATCHABLE_PREVIEW_IMAGE_EXTENSIONS.has(ext)) {
        return true;
      }
      const token = raw.replace(/\\/g, "/").toLowerCase();
      if (token.includes("/preview/") || token.includes("/previews/")) {
        return false;
      }
      return true;
    }
    if (normalizedRoots.has(resolvedLower)) {
      return true;
    }
    return false;
  };

  const watcher = chokidar.watch(libraryPaths, {
    ignored: (entryPath, stats) => {
      const resolvedLower = path.resolve(String(entryPath || "")).toLowerCase();
      if (explicitWatchSet.has(resolvedLower)) {
        return false;
      }
      const baseName = String(entryPath || "").split(/[\\/]/).pop().toLowerCase();
      if (stats?.isDirectory() && SKIP_DIRECTORY_NAMES.has(baseName)) {
        return true;
      }
      if (!stats?.isDirectory() && SKIP_FILE_NAMES.has(baseName)) {
        return true;
      }
      // ignoreInitial suppresses notifications, not the initial filesystem walk.
      // Keep directories (including dotted names) until stats identifies them;
      // exclude irrelevant files before Chokidar registers individual watches.
      if (stats?.isFile()) {
        return shouldIgnoreWatchEventPath(entryPath);
      }
      return false;
    },
    persistent: true,
    ignoreInitial: true,
    depth: Math.max(1, Number(options?.depth) || 4),
    useFsEvents: false, // Prevents excessive native bridge overhead in some dev environments
    disableGlobbing: true // We only pass raw paths
  });

  const debounceMs = Math.max(200, Number(options?.debounceMs) || 1200);
  const pending = new Map();
  const debouncedScan = () => {
    if (debounceTimer) globalThis.clearTimeout(debounceTimer);
    debounceTimer = globalThis.setTimeout(() => {
      const changes = [...pending.values()];
      pending.clear();
      onKeyChange({ changes });
    }, debounceMs);
  };

  const onWatchEvent = (eventType, entryPath) => {
    if (shouldIgnoreWatchEventPath(entryPath)) {
      return;
    }
    const resolved = path.resolve(String(entryPath || "")).toLowerCase();
    pending.set(resolved, { event: String(eventType || ""), path: String(entryPath || "") });
    debouncedScan();
  };
  watcher.on("add", (entryPath) => onWatchEvent("add", entryPath));
  watcher.on("unlink", (entryPath) => onWatchEvent("unlink", entryPath));
  watcher.on("change", (entryPath) => onWatchEvent("change", entryPath));
  watcher.on("unlinkDir", (entryPath) => {
    const baseName = String(entryPath || "").split(/[\\/]/).pop().toLowerCase();
    if (SKIP_DIRECTORY_NAMES.has(baseName)) {
      return;
    }
    const resolved = path.resolve(String(entryPath || "")).toLowerCase();
    pending.set(resolved, { event: "unlinkDir", path: String(entryPath || "") });
    debouncedScan();
  });
  const close = watcher.close.bind(watcher);
  watcher.close = () => {
    globalThis.clearTimeout(debounceTimer);
    pending.clear();
    return close();
  };
  return watcher;
}


module.exports = { createLibraryWatcher };
