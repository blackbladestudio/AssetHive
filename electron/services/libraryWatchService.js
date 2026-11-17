const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { planLibraryWatch } = require("./libraryWatchPolicy");
const { writeLog } = require("../logManager");

let activeWatch = null;

function startLibraryWatch(paths, onKeyChange, options = {}) {
  let worker;
  let closed = false;
  let closePromise;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Existing callers do not await readiness. Keep failures visible without an
  // unhandled rejection; tests and diagnostics can still await the same promise.
  void ready.catch(() => {});
  void (async () => {
    const plan = await planLibraryWatch(paths);
    if (closed) return;
    for (const skipped of plan.skipped) {
      writeLog(skipped.reason === "network" ? "INFO" : "WARN", "library watcher skipped; periodic scans remain active", skipped);
    }
    if (!plan.watchPaths.length) {
      resolveReady({ type: "ready", directories: 0, entries: 0, skipped: plan.skipped });
      return;
    }
    worker = new Worker(path.join(__dirname, "libraryWatchWorker.js"), {
      workerData: { paths: plan.watchPaths, options }
    });
    worker.on("message", (message) => {
      if (closed) return;
      if (message.type === "ready") resolveReady(message);
      else if (message.type === "error") {
        console.warn("Library watcher error:", message.message);
        rejectReady(new Error(message.message));
      } else if (message.type === "changes") {
        void Promise.resolve().then(() => {
          if (!closed) return onKeyChange(message.payload);
        }).catch((error) => console.warn("Library watcher callback failed:", error));
      }
    });
    worker.on("error", (error) => {
      if (!closed) console.warn("Library watcher worker failed:", error);
      rejectReady(error);
    });
    worker.on("exit", (code) => {
      if (!closed) {
        const error = new Error(`Library watcher exited unexpectedly (${code})`);
        console.warn(error.message);
        rejectReady(error);
      }
    });
    // Watching the library must not keep the app alive after its windows close.
    worker.unref();
  })().catch(rejectReady);
  return {
    ready,
    close() {
      if (!closePromise) {
        closed = true;
        resolveReady({ type: "closed" });
        closePromise = worker ? worker.terminate() : Promise.resolve();
      }
      return closePromise;
    }
  };
}

function watchLibrary(paths, onKeyChange, options = {}) {
  if (activeWatch) void activeWatch.close();
  activeWatch = startLibraryWatch(paths, onKeyChange, options);
  return activeWatch;
}

function stopLibraryWatch() {
  const current = activeWatch;
  activeWatch = null;
  return current?.close();
}

module.exports = { startLibraryWatch, watchLibrary, stopLibraryWatch };
