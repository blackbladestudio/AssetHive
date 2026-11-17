const { parentPort, workerData } = require("node:worker_threads");
const { createLibraryWatcher } = require("./libraryWatcher");

// Chokidar's initial traversal and native watch registration can stall for
// seconds on large libraries. Keep that work off Electron's window thread.
const watcher = createLibraryWatcher(workerData.paths, (payload) => {
  parentPort.postMessage({ type: "changes", payload });
}, workerData.options);
watcher.on("error", (error) => {
  parentPort.postMessage({ type: "error", message: error.message });
});
watcher.once("ready", () => {
  const watched = watcher.getWatched();
  parentPort.postMessage({ type: "ready", directories: Object.keys(watched).length,
    entries: Object.values(watched).reduce((count, entries) => count + entries.length, 0) });
});
