const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { createCacheProcess } = require("./cacheProcess");
const { createThumbnailWarmup } = require("./thumbnailWarmup");

function createSharedDerivedCache({ libraryRoot, localRoot, onFailure, canWarm = () => true, onWarmProgress,
  warmConcurrency = 1, sharedTimeoutMs = 2000, snapshotTimeoutMs = 10000,
  sourceTimeoutMs = 15000 } = {}) {
  const root = libraryRoot ? path.resolve(libraryRoot) : "";
  const key = createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 16);
  const localDir = path.join(localRoot, "DerivedCache", "v1", key);
  const sharedDir = root ? path.join(root, ".assethive", "DerivedCache", "v1") : "";
  const writer = createHash("sha256").update(`${os.hostname()}|${path.resolve(localRoot)}`).digest("hex").slice(0, 24);
  const shared = createCacheProcess({ timeoutMs: sharedTimeoutMs, concurrency: 4, onFailure });
  // Optional publishing must never hold up visible cards waiting for a read.
  const publisher = createCacheProcess({ timeoutMs: sharedTimeoutMs, maxQueue: 16, onFailure });
  // Large snapshots must not expire behind thumbnail traffic. Keep the bounded
  // startup read independent, including its circuit breaker and process.
  const snapshots = createCacheProcess({ timeoutMs: snapshotTimeoutMs, onFailure });
  const source = createCacheProcess({ timeoutMs: sourceTimeoutMs, cooldownMs: 3000, concurrency: 4, onFailure });
  // A large PNG/HDR conversion cannot block probes for already cached images.
  const renderer = createCacheProcess({ timeoutMs: sourceTimeoutMs, cooldownMs: 3000, concurrency: 2, onFailure });
  const warmer = createCacheProcess({ timeoutMs: Math.max(30000, sourceTimeoutMs),
    concurrency: Math.max(1, Math.min(8, Math.trunc(Number(warmConcurrency) || 1))), onFailure });
  const pending = new Map();
  const animationReads = new Map();
  const animationPublications = new Set();
  const sharedAnimationPreviews = new Set();
  let foregroundAt = 0;
  const warmThumbnail = (sourcePath, options = {}) => sharedDir
    ? warmer.run("warmThumbnail", { sourcePath, root, localDir, sharedDir, verify: Boolean(options.verify) })
    : Promise.resolve({ status: "skipped", reason: "no-library" });
  const warmup = createThumbnailWarmup({ ensure: warmThumbnail,
    canRun: () => pending.size === 0 && animationReads.size === 0 && Date.now() - foregroundAt > 2000 && canWarm(), onProgress: onWarmProgress });

  async function thumbnail(sourcePath) {
    const probe = await source.run("probeThumbnail", { sourcePath, root, localDir });
    if (!probe) return sourcePath;
    if (probe.hit) return probe.hit;
    if (probe.shared && sharedDir) {
      const hit = await shared.run("readThumbnail", { sharedDir, localDir, key: probe.key });
      if (hit) return hit;
    }
    const generated = await renderer.run("renderThumbnail", { ...probe, sourcePath, localDir });
    if (!generated) return sourcePath;
    if (probe.shared && sharedDir) {
      // Publishing is optional. The card returns its local file immediately.
      void publisher.run("writeThumbnail", { sharedDir, localFile: generated, key: probe.key });
    }
    return generated;
  }

  function rememberSharedAnimation(key) {
    sharedAnimationPreviews.add(key);
    if (sharedAnimationPreviews.size > 2048) sharedAnimationPreviews.delete(sharedAnimationPreviews.values().next().value);
  }

  function publishAnimation(key, localFile) {
    if (!sharedDir || sharedAnimationPreviews.has(key) || animationPublications.has(key)) return;
    animationPublications.add(key);
    void publisher.run("publishAnimationPreview", { sharedDir, localFile, key }).then(file => {
      animationPublications.delete(key);
      if (file) rememberSharedAnimation(key);
    });
  }

  async function readAnimation(sourcePath) {
    const probe = await source.run("probeAnimationPreview", { sourcePath, root, localDir });
    if (!probe) return null;
    if (probe.path) {
      publishAnimation(probe.key, probe.path);
      return probe;
    }
    const file = sharedDir ? await shared.run("readAnimationPreview", { sharedDir, localDir, key: probe.key }) : null;
    if (file) rememberSharedAnimation(probe.key);
    return { key: probe.key, path: file || "" };
  }

  return {
    sharedDir,
    readSnapshot: () => sharedDir ? snapshots.run("readSnapshot", { sharedDir, root }) : Promise.resolve(null),
    publishSnapshot: assets => sharedDir
      ? snapshots.run("writeSnapshot", { sharedDir, root, writer, assets }) : Promise.resolve(null),
    warmThumbnail,
    warmAssets(assets, options) {
      if (!sharedDir) return;
      warmup.enqueue([...new Set(assets.map(asset => {
        const file = String(asset.previewImage || asset.preview || "").trim();
        const relative = path.relative(root, file);
        return relative.startsWith("..") || path.isAbsolute(relative) ? String(asset.preview || file).trim() : file;
      })
        .filter(file => file && !/\.(webm|mp4|gif)$/i.test(file)))], options);
    },
    thumbnail(sourcePath) {
      foregroundAt = Date.now();
      if (/\.(webm|mp4|gif)$/i.test(sourcePath)) return Promise.resolve(sourcePath);
      if (pending.has(sourcePath)) return pending.get(sourcePath);
      const task = thumbnail(sourcePath).catch(() => sourcePath);
      pending.set(sourcePath, task);
      void task.finally(() => pending.delete(sourcePath));
      return task;
    },
    animationPreview(sourcePath) {
      foregroundAt = Date.now();
      const resolvedPath = path.resolve(sourcePath);
      const pendingRead = animationReads.get(resolvedPath);
      if (pendingRead) return pendingRead;
      const task = readAnimation(resolvedPath).finally(() => animationReads.delete(resolvedPath));
      animationReads.set(resolvedPath, task);
      return task;
    },
    async saveAnimationPreview(sourcePath, key, bytes) {
      const probe = await source.run("probeAnimationPreview", { sourcePath, root, localDir });
      if (!probe || probe.key !== key) return null;
      const file = probe.path || await source.run("saveAnimationPreview", { directory: localDir, key, bytes });
      if (file) publishAnimation(key, file);
      return file;
    },
    dispose() { warmup.dispose(); source.dispose(); renderer.dispose(); shared.dispose(); publisher.dispose(); snapshots.dispose(); warmer.dispose(); }
  };
}

module.exports = { createSharedDerivedCache };
