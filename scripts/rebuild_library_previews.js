const fs = require("node:fs/promises");
const { Buffer } = require("node:buffer");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const sharp = require("sharp");

const BACKUPS = ".arkhive-preview-backups";
function inside(root, file) {
  const rel = path.relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

async function* jsonFiles(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === BACKUPS || entry.name.startsWith(".")) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonFiles(file);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) yield file;
  }
}

async function resolvePreview(meta, dir, root) {
  const refs = [
    ...(Array.isArray(meta.previews?.images) ? meta.previews.images.map(image => image?.uri) : []),
    meta.previewImage, meta.detailImage
  ].filter(ref => typeof ref === "string" && ref.trim());
  for (const ref of refs) {
    const candidate = path.resolve(dir, ref);
    if (!inside(root, candidate)) continue;
    try {
      const real = await fs.realpath(candidate);
      if (inside(root, real) && (await fs.stat(real)).isFile()) return real;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error("No readable preview referenced inside the selected library");
}

async function replace(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, data, { flag: "wx" });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function rebuild(rootArg, { apply = false, metadataOnly = false, log = console.log } = {}) {
  const root = await fs.realpath(rootArg);
  if (!(await fs.stat(root)).isDirectory()) throw new Error("Library must be a directory");
  const runDir = path.join(root, BACKUPS, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  const summary = { scanned: 0, processed: 0, changed: 0, skipped: 0, failed: 0, apply, backupDir: null };
  async function backup(file) {
    try {
      // Reject symbolic-link destinations, including an existing thumbnail.
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe output: ${file}`);
      const dest = path.join(runDir, "files", path.relative(root, file));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      try { await fs.copyFile(file, dest, require("node:fs").constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
  if (apply) {
    await fs.mkdir(runDir, { recursive: true });
    summary.backupDir = runDir;
  }
  log(`${apply ? "APPLY" : "DRY RUN"}: ${root}`);
  for await (const jsonPath of jsonFiles(root)) {
    summary.scanned++;
    try {
      const raw = await fs.readFile(jsonPath);
      const meta = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
      if (!meta || !(meta.assetID || meta.id || meta.assetType || meta.asset_type)
          || !(meta.previews || meta.previewImage || meta.detailImage)) {
        summary.skipped++;
        continue;
      }
      const source = await resolvePreview(meta, path.dirname(jsonPath), root);
      if (/_thumb$/i.test(path.parse(source).name)) throw new Error("Preview reference points to a thumbnail; original required");
      const info = await sharp(source).metadata();
      const rotated = info.orientation >= 5 && info.orientation <= 8;
      const width = rotated ? info.height : info.width;
      const height = rotated ? info.width : info.height;
      if (!(width > 0 && height > 0)) throw new Error("Invalid preview dimensions");
      const relativeSize = `${width}x${height}`;
      const previousSize = meta.previews?.relativeSize ?? null;
      const changed = previousSize !== relativeSize;
      const thumb = path.join(path.dirname(source), `${path.parse(source).name}_thumb${info.hasAlpha ? ".png" : ".jpg"}`);
      const record = { jsonPath, source, thumb: metadataOnly ? null : thumb, previousSize, relativeSize };
      if (apply && (changed || !metadataOnly)) {
        // Decode completely before modifying any library files.
        let pixels;
        if (!metadataOnly) {
          const pipeline = sharp(source).rotate().resize(512, 512, { fit: "inside", withoutEnlargement: true });
          pixels = await (info.hasAlpha ? pipeline.png({ compressionLevel: 6 }) : pipeline.jpeg({ quality: 72 })).toBuffer();
        }
        const thumbExisted = metadataOnly ? null : await backup(thumb);
        if (changed) await backup(jsonPath);
        await fs.appendFile(path.join(runDir, "manifest.jsonl"), JSON.stringify({ ...record, thumbExisted, status: "planned" }) + "\n");
        if (pixels) await replace(thumb, pixels);
        if (changed) {
          meta.previews = { ...meta.previews, relativeSize };
          await replace(jsonPath, Buffer.from(JSON.stringify(meta, null, 2) + "\n"));
        }
        await fs.appendFile(path.join(runDir, "manifest.jsonl"), JSON.stringify({ ...record, status: "done" }) + "\n");
      }
      summary.processed++;
      if (changed) summary.changed++;
      log(`${apply ? "OK" : "PLAN"} ${path.relative(root, jsonPath)}: ${previousSize} -> ${relativeSize}${metadataOnly ? "" : " | rebuild thumbnail"}`);
    } catch (error) {
      summary.failed++;
      log(`ERROR ${jsonPath}: ${error.message}`);
      if (apply) await fs.appendFile(path.join(runDir, "manifest.jsonl"), JSON.stringify({ jsonPath, status: "error", error: error.message }) + "\n");
    }
  }
  log(JSON.stringify(summary, null, 2));
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log('Usage: node scripts/rebuild_library_previews.js [library-directory] [--apply] [--metadata-only]\nDefault directory: F:\\ArkLibrayData. Without --apply: read-only dry run.\nRebuilds 512px thumbnails from existing originals and fixes previews.relativeSize.\nOriginal previews are preserved; overwritten files are backed up inside .arkhive-preview-backups.');
    return;
  }
  const flags = new Set(["--apply", "--metadata-only"]);
  const unknown = args.find(arg => arg.startsWith("--") && !flags.has(arg));
  const dirs = args.filter(arg => !arg.startsWith("--"));
  if (unknown || dirs.length > 1) throw new Error(`Invalid arguments: ${args.join(" ")}`);
  const result = await rebuild(dirs[0] || "F:\\ArkLibrayData", { apply: args.includes("--apply"), metadataOnly: args.includes("--metadata-only") });
  if (result.failed) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { rebuild };
