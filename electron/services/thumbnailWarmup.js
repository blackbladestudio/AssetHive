// Background work only. Card requests use their own processes and take priority.
function createThumbnailWarmup({ ensure, canRun = () => true, onProgress = () => {},
  initialDelayMs = 30000, delayMs = 250, checkIntervalMs = 30 * 60 * 1000, retryMs = 60000 } = {}) {
  const entries = new Map();
  const urgent = new Map();
  const priorityStack = [];
  const normal = new Map();
  const active = new Set();
  const stats = { checked: 0, cached: 0, published: 0, failed: 0 };
  let timer;
  let disposed = false;
  let notBefore = Date.now() + initialDelayMs;
  let failuresInRow = 0;

  function status() { return { ...stats, queued: urgent.size + normal.size, active: active.size }; }
  function schedule(wait = delayMs) {
    if (disposed || timer || (!urgent.size && !normal.size) || active.size) return;
    timer = globalThis.setTimeout(() => { timer = null; void pump(); }, wait);
    timer.unref?.();
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
    if (!entry) {
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
      if (revision !== entry.revision) { urgent.set(entry.path, entry); priorityStack.push(entry); }
      else if (failed) { entry.dueAt = Date.now() + retryMs; normal.set(entry.path, entry); }
      else entry.checkedAt = Date.now();
    } else {
      const replacement = entries.get(entry.path);
      if (replacement && !urgent.has(entry.path) && !normal.has(entry.path)) {
        urgent.set(entry.path, replacement); priorityStack.push(replacement);
      }
    }
    if (failuresInRow >= 3) notBefore = Date.now() + retryMs;
    onProgress({ ...status(), sourcePath: entry.path, result });
    schedule();
  }

  return {
    enqueue(paths, { replace = false, priority = false } = {}) {
      if (disposed) return;
      const wanted = new Set(paths.filter(Boolean));
      if (replace) for (const sourcePath of entries.keys()) {
        if (!wanted.has(sourcePath)) { entries.delete(sourcePath); urgent.delete(sourcePath); normal.delete(sourcePath); }
      }
      for (const sourcePath of wanted) {
        let entry = entries.get(sourcePath);
        if (!entry) { entry = { path: sourcePath, revision: 0, checkedAt: 0, dueAt: 0 }; entries.set(sourcePath, entry); }
        if (priority) {
          entry.revision++; entry.checkedAt = 0; entry.dueAt = 0;
          normal.delete(sourcePath);
          if (!active.has(sourcePath)) { urgent.set(sourcePath, entry); priorityStack.push(entry); }
        } else if (!active.has(sourcePath) && !urgent.has(sourcePath) && !normal.has(sourcePath)
          && Date.now() - entry.checkedAt >= checkIntervalMs) normal.set(sourcePath, entry);
      }
      if (priority && failuresInRow < 3) notBefore = 0;
      // A new edit must not wait behind a timer armed for an old failed item.
      if (priority && timer) { globalThis.clearTimeout(timer); timer = null; }
      schedule();
    },
    status,
    dispose() { disposed = true; globalThis.clearTimeout(timer); entries.clear(); urgent.clear(); priorityStack.length = 0; normal.clear(); }
  };
}

module.exports = { createThumbnailWarmup };
