// Background work only. Card requests use their own processes and take priority.
function createThumbnailWarmup({ ensure, canRun = () => true, onProgress = () => {},
  initialDelayMs = 30000, delayMs = 250, checkIntervalMs = 30 * 60 * 1000, retryMs = 60000 } = {}) {
  const entries = new Map();
  const urgent = new Map();
  const priorityStack = [];
  const discovered = new Map();
  const normal = new Map();
  const active = new Set();
  const stats = { checked: 0, cached: 0, published: 0, failed: 0 };
  let timer;
  let disposed = false;
  let normalPaused = false;
  let notBefore = Date.now() + initialDelayMs;
  let failuresInRow = 0;

  function status() { return { ...stats, queued: urgent.size + discovered.size + normal.size, active: active.size }; }
  function schedule(wait = delayMs) {
    if (disposed || timer || active.size || (!urgent.size && (normalPaused || (!discovered.size && !normal.size)))) return;
    timer = globalThis.setTimeout(() => { timer = null; void pump(); }, wait);
    timer.unref?.();
  }

  function prioritize(entry) {
    normal.delete(entry.path);
    if (entry.backgroundPriority) {
      discovered.delete(entry.path);
      urgent.set(entry.path, entry);
      priorityStack.push(entry);
    } else discovered.set(entry.path, entry);
  }
  async function pump() {
    if (disposed || active.size) return;
    if (Date.now() < notBefore || !canRun()) { schedule(Math.max(1000, notBefore - Date.now())); return; }
    let entry;
    let nextDue = Infinity;
    // New edits also overtake older edits discovered by a large scan.
    while (priorityStack.length) {
      const candidate = priorityStack.pop();
      if (urgent.get(candidate.path) !== candidate) continue;
      urgent.delete(candidate.path);
      entry = candidate;
      break;
    }
    if (!entry && !normalPaused) {
      entry = discovered.values().next().value;
      if (entry) discovered.delete(entry.path);
    }
    if (!entry && !normalPaused) {
      for (const candidate of normal.values()) {
        if (candidate.dueAt <= Date.now()) { entry = candidate; normal.delete(candidate.path); break; }
        nextDue = Math.min(nextDue, candidate.dueAt);
      }
    }
    if (!entry) { if (Number.isFinite(nextDue)) schedule(Math.max(delayMs, nextDue - Date.now())); return; }
    active.add(entry.path);
    const revision = entry.revision;
    const result = await Promise.resolve().then(() => ensure(entry.path)).catch(error => ({ status: "failed", message: error.message }));
    active.delete(entry.path);
    if (disposed) return;
    stats.checked++;
    const failed = !result || result.status === "failed";
    if (failed) { stats.failed++; failuresInRow++; }
    else { failuresInRow = 0; if (result.status in stats) stats[result.status]++; }
    if (entries.get(entry.path) === entry) {
      if (revision !== entry.revision) prioritize(entry);
      else {
        entry.backgroundPriority = false;
        if (failed) { entry.dueAt = Date.now() + retryMs; normal.set(entry.path, entry); }
        else entry.checkedAt = Date.now();
      }
    } else {
      const replacement = entries.get(entry.path);
      if (replacement && !urgent.has(entry.path) && !discovered.has(entry.path) && !normal.has(entry.path)) {
        prioritize(replacement);
      }
    }
    if (failuresInRow >= 3) notBefore = Date.now() + retryMs;
    onProgress({ ...status(), sourcePath: entry.path, result });
    schedule();
  }

  return {
    enqueue(paths, { replace = false, priority = false, foregroundOnly = false } = {}) {
      if (disposed) return;
      const wanted = new Set(paths.filter(Boolean));
      if (replace) for (const sourcePath of entries.keys()) {
        if (!wanted.has(sourcePath)) { entries.delete(sourcePath); urgent.delete(sourcePath); discovered.delete(sourcePath); normal.delete(sourcePath); }
      }
      for (const sourcePath of wanted) {
        let entry = entries.get(sourcePath);
        if (!entry) { entry = { path: sourcePath, revision: 0, checkedAt: 0, dueAt: 0, backgroundPriority: false }; entries.set(sourcePath, entry); }
        if (priority) {
          entry.revision++; entry.checkedAt = 0; entry.dueAt = 0;
          if (!foregroundOnly) entry.backgroundPriority = true;
          if (!active.has(sourcePath)) prioritize(entry);
        } else if (!active.has(sourcePath) && !urgent.has(sourcePath) && !discovered.has(sourcePath) && !normal.has(sourcePath)
          && Date.now() - entry.checkedAt >= checkIntervalMs) normal.set(sourcePath, entry);
      }
      const canPrioritize = priority && (!foregroundOnly || !normalPaused);
      if (canPrioritize && failuresInRow < 3) notBefore = 0;
      // A new edit must not wait behind a timer armed for an old failed item.
      if (canPrioritize && timer) { globalThis.clearTimeout(timer); timer = null; }
      schedule();
    },
    setNormalPaused(paused) {
      if (normalPaused === paused) return;
      normalPaused = paused;
      if (!paused && discovered.size && failuresInRow < 3) notBefore = 0;
      if (timer) { globalThis.clearTimeout(timer); timer = null; }
      schedule();
    },
    status,
    dispose() { disposed = true; globalThis.clearTimeout(timer); entries.clear(); urgent.clear(); priorityStack.length = 0; discovered.clear(); normal.clear(); }
  };
}

module.exports = { createThumbnailWarmup };
