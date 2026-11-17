const path = require("node:path");
const { fork } = require("node:child_process");

// Use a separate process, rather than a Worker: Workers share the main process's
// libuv filesystem pool. Hung SMB requests must not consume that pool at startup.
function createCacheProcess({ timeoutMs = 2000, cooldownMs = 60000, maxQueue = 64, concurrency = 1,
  workerPath = path.join(__dirname, "derivedCacheProcess.js"), onFailure = () => {} } = {}) {
  let child = null;
  const active = new Map();
  const limit = Math.max(1, Math.min(8, Math.trunc(Number(concurrency) || 1)));
  let nextId = 0;
  let unavailableUntil = 0;
  let disposed = false;
  let idleTimer;
  const queue = [];

  function stop() {
    globalThis.clearTimeout(idleTimer);
    const previous = child;
    child = null;
    previous?.kill();
  }

  function finish(job, value) {
    globalThis.clearTimeout(job.timer);
    job.resolve(value);
  }

  function fail(error) {
    stop();
    unavailableUntil = Date.now() + cooldownMs;
    for (const job of active.values()) finish(job, null);
    active.clear();
    for (const job of queue.splice(0)) finish(job, null);
    onFailure(error);
  }

  function dispatch() {
    if (active.size >= limit || !queue.length || disposed) return;
    globalThis.clearTimeout(idleTimer);
    try {
      if (!child) {
        const spawned = fork(workerPath, [], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, execArgv: [],
          stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
          serialization: "advanced"
        });
        child = spawned;
        spawned.on("message", message => {
          const job = active.get(message.id);
          if (child !== spawned || !job) return;
          if (!message.ok) { fail(new Error(message.error || "Cache I/O failed")); return; }
          active.delete(job.id);
          finish(job, message.result);
          if (!active.size && !queue.length) {
            idleTimer = globalThis.setTimeout(stop, 30000);
            idleTimer.unref?.();
          }
          dispatch();
        });
        spawned.on("error", error => { if (child === spawned) fail(error); });
        spawned.on("exit", () => { if (child === spawned) fail(new Error("Cache process exited")); });
        spawned.unref();
        spawned.channel?.unref();
      }
      while (queue.length && active.size < limit) {
        const job = queue.shift();
        active.set(job.id, job);
        const sending = child;
        sending.send({ id: job.id, operation: job.operation, args: job.args }, error => {
          if (error && child === sending) fail(error);
        });
      }
    } catch (error) { fail(error); }
  }

  return {
    run(operation, args) {
      if (disposed || Date.now() < unavailableUntil || queue.length >= maxQueue) return Promise.resolve(null);
      return new Promise(resolve => {
        const job = { id: ++nextId, operation, args, resolve };
        // The deadline includes queue time. Do not accumulate work behind a
        // stalled writer, and never wait for a shared lock or process exit.
        job.timer = globalThis.setTimeout(() => {
          if (active.has(job.id)) fail(new Error(`Cache ${operation} timed out`));
          else {
            const position = queue.indexOf(job);
            if (position >= 0) queue.splice(position, 1);
            finish(job, null);
          }
        }, timeoutMs);
        queue.push(job);
        dispatch();
      });
    },
    dispose() {
      disposed = true;
      stop();
      for (const job of active.values()) finish(job, null);
      active.clear();
      for (const job of queue.splice(0)) finish(job, null);
    }
  };
}

module.exports = { createCacheProcess };
