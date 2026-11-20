const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomUUID } = require("node:crypto");
const { Buffer } = require("node:buffer");
const { gzip, gunzip } = require("node:zlib");
const { promisify } = require("node:util");
const { toAssetListRecord } = require("./assetListRecord");
const { isAnimationLibraryPath } = require("./customAssetLayout");

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Upgrade the old local SQLite projection from its existing local scan memo.
// This reads one local file; it never scans or probes asset folders.
async function readScanMemoRecords({ memoPath, root }) {
  const stat = await fs.stat(memoPath).catch(() => null);
  if (!stat?.isFile() || stat.size > 128 * 1024 * 1024) return null;
  const raw = await gunzipAsync(await fs.readFile(memoPath), { maxOutputLength: 512 * 1024 * 1024 });
  const memo = JSON.parse(raw);
  if (memo.version !== 2 || !Array.isArray(memo.assets)
    || path.resolve(String(memo.root || "")).toLowerCase() !== path.resolve(root).toLowerCase()) return null;
  return memo.assets.map(entry => toAssetListRecord(entry?.record))
    .filter(record => record && relativeToRoot(root, record.metaPath) !== null);
}
const PATH_FIELDS = ["path", "metaPath", "preview", "previewImage", "detailImage", "previewSkeletonPath", "previewSkeletalMeshPath"];
let sharp;
function image() {
  if (!sharp) {
    sharp = require("sharp");
    sharp.concurrency(1);
    sharp.cache(false);
  }
  return sharp;
}

function relativeToRoot(root, candidate) {
  if (!root || !candidate) return null;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

function restorePath(root, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative) || /^[a-z]:/i.test(relative)) return null;
  const full = path.resolve(root, relative);
  return relativeToRoot(root, full) === null ? null : full;
}

function encodeSnapshot(root, assets, now = Date.now()) {
  const records = [];
  const ids = new Set();
  for (const asset of assets) {
    const record = toAssetListRecord(asset);
    if (!record || ids.has(record.id) || relativeToRoot(root, record.path) === null || relativeToRoot(root, record.metaPath) === null) continue;
    ids.add(record.id);
    delete record.favorite;
    for (const field of PATH_FIELDS) record[field] = relativeToRoot(root, record[field]);
    // Original model filenames may be relative to the asset directory. Absolute
    // filenames must be rebased for clients using a different drive mapping.
    record.modelFiles = (Array.isArray(record.modelFiles) ? record.modelFiles : [])
      .filter(file => typeof file === "string" && relativeToRoot(root, path.resolve(asset.path, file)) !== null)
      .map(file => path.isAbsolute(file) ? { libraryPath: relativeToRoot(root, file) } : { assetPath: file });
    records.push(record);
  }
  return { version: SNAPSHOT_VERSION, generatedAt: now, assets: records };
}

function decodeSnapshot(root, snapshot, now = Date.now()) {
  if (snapshot?.version !== SNAPSHOT_VERSION || !Array.isArray(snapshot.assets)
    || snapshot.assets.length > 250000 || !Number.isFinite(snapshot.generatedAt)
    || snapshot.generatedAt > now + 5 * 60 * 1000 || now - snapshot.generatedAt > SNAPSHOT_MAX_AGE_MS) return null;
  const result = [];
  const ids = new Set();
  for (const item of snapshot.assets) {
    if (!item || typeof item.id !== "string" || !item.id.trim() || ids.has(item.id)
      || (item.modelFiles != null && !Array.isArray(item.modelFiles))) return null;
    ids.add(item.id);
    const record = { ...toAssetListRecord(item), favorite: false };
    for (const field of PATH_FIELDS) record[field] = restorePath(root, item[field]);
    if (!record.path || !record.metaPath) return null;
    record.modelFiles = (item.modelFiles || []).flatMap(file => {
      if (typeof file?.assetPath === "string" && !path.isAbsolute(file.assetPath)
        && !/^[a-z]:/i.test(file.assetPath)
        && relativeToRoot(root, path.resolve(record.path, file.assetPath)) !== null) return [file.assetPath];
      const full = restorePath(root, file?.libraryPath);
      return full ? [full] : [];
    });
    result.push(record);
  }
  return result;
}

async function atomicWrite(target, buffer) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(temporary, buffer, { flag: "wx" });
    // No shared lock, no truncate, no delete-before-rename, no retry loop. A
    // locked destination is an optional cache miss; the previous file survives.
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function readSnapshot({ sharedDir, root }) {
  const directory = path.join(sharedDir, "Snapshots");
  let names;
  try { names = await fs.readdir(directory); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const candidates = [];
  const files = names.filter(name => /^[a-f0-9]{24}\.json\.gz$/.test(name));
  let next = 0;
  // One stat per client used to run serially. On SMB, even a small snapshot
  // could miss the startup deadline in a library used by many people.
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
    while (next < files.length) {
      const file = path.join(directory, files[next++]);
      const stat = await fs.stat(file).catch(() => null);
      if (stat?.isFile() && stat.size > 0 && stat.size <= SNAPSHOT_MAX_BYTES) candidates.push({ file, modified: stat.mtimeMs });
    }
  }));
  candidates.sort((a, b) => b.modified - a.modified);
  // The parent process bounds the whole operation. Several stale/corrupt
  // clients must not hide another client's still usable complete snapshot.
  for (const { file } of candidates) {
    try {
      const raw = await gunzipAsync(await fs.readFile(file), { maxOutputLength: 256 * 1024 * 1024 });
      const decoded = decodeSnapshot(root, JSON.parse(raw.toString("utf8")));
      if (decoded !== null) return decoded;
    } catch { /* Try another writer's last complete snapshot. */ }
  }
  return null;
}

async function writeSnapshot({ sharedDir, root, writer, assets }) {
  if (!/^[a-f0-9]{24}$/.test(writer)) throw new Error("Invalid cache writer");
  const snapshot = encodeSnapshot(root, assets);
  // A malformed/incomplete list must never replace a previous complete cache.
  if (snapshot.assets.length !== assets.length) return false;
  const compressed = await gzipAsync(JSON.stringify(snapshot), { level: 1 });
  if (compressed.length > SNAPSHOT_MAX_BYTES) return false;
  await atomicWrite(path.join(sharedDir, "Snapshots", `${writer}.json.gz`), compressed);
  return true;
}

function thumbnailBase(directory, key) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid thumbnail key");
  return path.join(directory, "Thumbnails", key.slice(0, 2), key);
}

async function thumbnailBytes(file) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile() || stat.size <= 0 || stat.size > 4 * 1024 * 1024) return null;
  const buffer = await fs.readFile(file);
  const decoder = image()(buffer, { failOn: "warning", limitInputPixels: 512 * 512 });
  const meta = await decoder.metadata();
  if (!["png", "jpeg"].includes(meta.format) || meta.width > 512 || meta.height > 512) return null;
  await decoder.raw().toBuffer();
  return buffer;
}

async function findThumbnail(directory, key, localOnly = false) {
  for (const ext of [".png", ".jpg"]) {
    const file = `${thumbnailBase(directory, key)}${ext}`;
    if (localOnly) {
      // Our local files were already fully decoded before atomic publication.
      // Let Chromium decode them for display instead of decoding a second time
      // on every cache hit. Its onError handler can still fall back to source.
      const stat = await fs.stat(file).catch(() => null);
      if (stat?.isFile() && stat.size > 0 && stat.size <= 4 * 1024 * 1024) return { file };
      continue;
    }
    try { const bytes = await thumbnailBytes(file); if (bytes) return { file, bytes, ext }; }
    catch { /* Incomplete, corrupt or locked files are cache misses. */ }
  }
  return null;
}

async function probeThumbnail({ sourcePath, root, localDir }) {
  const stat = await fs.stat(sourcePath);
  if (!stat.isFile()) return null;
  const relative = relativeToRoot(root, sourcePath);
  const key = createHash("sha256").update(JSON.stringify([
    "thumbnail-v1:512:png-alpha:jpeg72:hdr-v2", relative ?? path.resolve(sourcePath), stat.size, stat.mtimeMs
  ])).digest("hex");
  const hit = await findThumbnail(localDir, key, true);
  return { key, hit: hit?.file || null, shared: relative !== null, size: stat.size, mtimeMs: stat.mtimeMs };
}

async function renderThumbnail({ sourcePath, localDir, key, size, mtimeMs }) {
  const ext = path.extname(sourcePath).toLowerCase();
  let buffer;
  let suffix;
  if ([".hdr", ".exr"].includes(ext)) {
    const { runImageTask } = require("./imageTasks");
    // libvips writes via a native path API. Nested cache keys plus the image
    // worker's atomic suffix can exceed MAX_PATH on Windows.
    const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-derived-"));
    const temporary = path.join(temporaryDir, "preview.png");
    try {
      await runImageTask("hdrPreview", [sourcePath, temporary, { maxWidth: 512, maxHeight: 512 }]);
      buffer = await fs.readFile(temporary);
    } finally { await fs.rm(temporaryDir, { recursive: true, force: true }).catch(() => {}); }
    suffix = ".png";
  } else {
    const pipeline = image()(sourcePath).rotate().resize(512, 512, { fit: "inside", withoutEnlargement: true });
    const metadata = await pipeline.metadata();
    suffix = metadata.hasAlpha ? ".png" : ".jpg";
    buffer = metadata.hasAlpha
      ? await pipeline.png({ compressionLevel: 6, effort: 4 }).toBuffer()
      : await pipeline.jpeg({ quality: 72, mozjpeg: false }).toBuffer();
  }
  const after = await fs.stat(sourcePath);
  if (after.size !== size || after.mtimeMs !== mtimeMs) return null;
  const output = `${thumbnailBase(localDir, key)}${suffix}`;
  await atomicWrite(output, buffer);
  return output;
}

async function readThumbnail({ sharedDir, localDir, key }) {
  const found = await findThumbnail(sharedDir, key);
  if (!found) return null;
  const output = `${thumbnailBase(localDir, key)}${found.ext}`;
  await atomicWrite(output, found.bytes);
  return output;
}

async function writeThumbnail({ sharedDir, localFile, key }) {
  if (await findThumbnail(sharedDir, key)) return true;
  const bytes = await thumbnailBytes(localFile);
  if (!bytes) return false;
  await atomicWrite(`${thumbnailBase(sharedDir, key)}${path.extname(localFile)}`, bytes);
  return true;
}

function animationPreviewFile(directory, key) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid animation preview key");
  return path.join(directory, "AnimationPreviews", key.slice(0, 2), `${key}.webm`);
}

function isAnimationPreviewVideo(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 32 && bytes.length <= 2 * 1024 * 1024
    && bytes.readUInt32BE(0) === 0x1a45dfa3;
}

async function animationPreviewBytes(file) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile() || stat.size < 32 || stat.size > 2 * 1024 * 1024) return null;
  const bytes = await fs.readFile(file).catch(() => null);
  return isAnimationPreviewVideo(bytes) ? bytes : null;
}

async function probeAnimationPreview({ sourcePath, root, localDir }) {
  const relative = relativeToRoot(root, sourcePath);
  if (!relative || !isAnimationLibraryPath(relative) || !/\.fbx$/i.test(relative)) return null;
  const stat = await fs.stat(sourcePath).catch(() => null);
  if (!stat?.isFile()) return null;
  const key = createHash("sha256").update(JSON.stringify([
    "animation-webm-v1", relative.toLowerCase(), stat.size, stat.mtimeMs
  ])).digest("hex");
  const localFile = animationPreviewFile(localDir, key);
  return { key, path: await animationPreviewBytes(localFile) ? localFile : "" };
}

async function readAnimationPreview({ sharedDir, localDir, key }) {
  const bytes = await animationPreviewBytes(animationPreviewFile(sharedDir, key));
  if (!bytes) return null;
  return saveAnimationPreview({ directory: localDir, key, bytes });
}

async function saveAnimationPreview({ directory, key, bytes }) {
  if (!isAnimationPreviewVideo(bytes)) return null;
  const output = animationPreviewFile(directory, key);
  if (!await animationPreviewBytes(output)) await atomicWrite(output, bytes);
  return output;
}

async function publishAnimationPreview({ sharedDir, localFile, key }) {
  const bytes = await animationPreviewBytes(localFile);
  return bytes ? saveAnimationPreview({ directory: sharedDir, key, bytes }) : null;
}

async function warmThumbnail({ sourcePath, root, localDir, sharedDir, verify = false }) {
  if (relativeToRoot(root, sourcePath) === null) return { status: "skipped", reason: "outside-library" };
  if (/\.(webm|mp4|gif)$/i.test(sourcePath)) return { status: "skipped", reason: "motion-preview" };
  let stage = "source";
  try {
    const probe = await probeThumbnail({ sourcePath, root, localDir });
    if (!probe) return { status: "failed", stage, message: "Preview is not a file" };
    stage = "shared-read";
    const existing = await findThumbnail(sharedDir, probe.key, !verify);
    if (existing) return { status: "cached", key: probe.key, file: existing.file };
    stage = "render";
    let localFile = probe.hit;
    if (localFile && !await thumbnailBytes(localFile).catch(() => null)) localFile = null;
    localFile ||= await renderThumbnail({ ...probe, sourcePath, localDir });
    if (!localFile) return { status: "failed", stage, message: "Preview changed while rendering" };
    stage = "shared-write";
    if (!await writeThumbnail({ sharedDir, localFile, key: probe.key })) throw new Error("Thumbnail publication failed");
    return { status: "published", key: probe.key, file: `${thumbnailBase(sharedDir, probe.key)}${path.extname(localFile)}` };
  } catch (error) {
    // One missing/corrupt source must not abort the rest of a library warmup.
    return { status: "failed", stage, code: error.code, message: error.message };
  }
}

const operations = { readSnapshot, writeSnapshot, readScanMemoRecords, probeThumbnail, renderThumbnail, readThumbnail, writeThumbnail, warmThumbnail,
  probeAnimationPreview, readAnimationPreview, saveAnimationPreview, publishAnimationPreview };
if (require.main === module) {
  process.on("message", async ({ id, operation, args }) => {
    try {
      if (!operations[operation]) throw new Error("Unknown cache operation");
      const result = await operations[operation](args);
      process.send?.({ id, ok: true, result });
    } catch (error) { process.send?.({ id, ok: false, error: error.message }); }
  });
  process.on("disconnect", () => process.exit(0));
}

module.exports = { ...operations, encodeSnapshot, decodeSnapshot, relativeToRoot };
