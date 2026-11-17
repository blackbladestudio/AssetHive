const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { readLibraryChanges } = require("./libraryChanges");

const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHANGE_CHECK_INTERVAL_MS = 4 * 1000;
const DISCOVERY_INTERVAL_MS = 5 * 60 * 1000;

// This state belongs to the local user/cache, never to the shared library.
function createScanSchedule(filePath, now = Date.now) {
  let state;
  let lastDiscovery;
  let failedAttempt;
  async function load(root) {
    if (!state) {
      try {
        state = JSON.parse(await fs.readFile(filePath, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        state = {};
      }
    }
    if (state?.version !== 1 || state.root !== root
      || !Number.isFinite(state.lastReconciledAt) || state.lastReconciledAt <= 0
      || state.lastReconciledAt > now()) {
      state = { version: 1, root, lastReconciledAt: 0, pollShard: 0 };
    }
    state.pollShard = Math.abs(Math.trunc(Number(state.pollShard) || 0)) % 6;
    if (!lastDiscovery && state.lastDiscoveredAt > 0 && state.lastDiscoveredAt <= now()) {
      lastDiscovery = { root, at: state.lastDiscoveredAt };
    }
    return state;
  }

  async function plan({ root, libraryRoot, reason, hasCache, idle }) {
    const current = await load(root);
    const automatic = reason === "periodic" || reason === "startup";
    const canReuse = current.lastReconciledAt > 0 && hasCache;
    const due = now() - current.lastReconciledAt >= RECONCILE_INTERVAL_MS;
    let incremental = automatic && canReuse && (!due || !idle);
    const changes = libraryRoot ? await readLibraryChanges(libraryRoot, current.changeCursor) : null;
    // A new/replaced journal needs a complete baseline before acknowledging it.
    // Startup discovers external edits made while this client was closed.
    if (changes?.cursor && (changes.directories === null || reason === "startup")) incremental = false;
    const discoveryDue = !lastDiscovery || lastDiscovery.root !== root
      || now() < lastDiscovery.at || now() - lastDiscovery.at >= DISCOVERY_INTERVAL_MS;
    const indexed = reason === "periodic" && incremental && !discoveryDue
      && changes?.cursor && changes.directories !== null;
    const retrying = reason === "periodic" && failedAttempt?.root === root
      && now() >= failedAttempt.at && now() - failedAttempt.at < DISCOVERY_INTERVAL_MS;
    const throttled = retrying || reason === "periodic" && !indexed && !discoveryDue
      && !(!incremental && canReuse && due);
    if (!indexed && !throttled) lastDiscovery = { root, at: now() };
    return {
      incremental,
      pollShard: Math.abs(Math.trunc(Number(current.pollShard) || 0)) % 6,
      deferred: automatic && canReuse && due && !idle,
      changedDirectories: indexed ? changes.directories : null,
      skip: Boolean(throttled || indexed && changes.directories.length === 0),
      throttled,
      // Directory discovery checks only one shard: retain unprocessed deltas
      // unless a full scan will validate all of them.
      changeCursor: !incremental || indexed ? changes?.cursor : current.changeCursor
    };
  }

  async function complete(root, incremental, successful, changeCursor, targeted = false) {
    if (!successful) { failedAttempt = { root, at: now() }; return; }
    const current = await load(root);
    const next = {
      version: 1, root,
      lastReconciledAt: incremental ? current.lastReconciledAt : now(),
      pollShard: incremental ? (current.pollShard + (targeted ? 0 : 1)) % 6 : 0,
      lastDiscoveredAt: lastDiscovery?.root === root ? lastDiscovery.at : current.lastDiscoveredAt,
      changeCursor: changeCursor || undefined
    };
    const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(temporary, JSON.stringify(next), "utf8");
      await fs.rename(temporary, filePath);
      state = next;
      failedAttempt = null;
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  return { plan, complete };
}

module.exports = { createScanSchedule, RECONCILE_INTERVAL_MS, CHANGE_CHECK_INTERVAL_MS, DISCOVERY_INTERVAL_MS };
