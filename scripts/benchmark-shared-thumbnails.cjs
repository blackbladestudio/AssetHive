// Compare the checked-out pipeline with HEAD using 6 simultaneous card requests.
// Existing-library mode reads the share only; all generated files stay local.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const sharp = require("sharp");
const storage = require("../electron/services/derivedCacheProcess");
const { createSharedDerivedCache } = require("../electron/services/sharedDerivedCache");

async function pool(items, concurrency, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await task(items[index], index); }
  }));
  return results;
}

async function batch(client, files) {
  const start = performance.now();
  const completed = [];
  const outputs = await pool(files, 6, async file => {
    const result = await client.thumbnail(file);
    completed.push(performance.now() - start);
    return result;
  });
  completed.sort((a, b) => a - b);
  return { outputs, firstMs: Math.round(completed[0]), totalMs: Math.round(completed.at(-1)),
    sourceFallbacks: outputs.filter((file, index) => file === files[index]).length };
}

async function loadVersion(directory, baseline, readOnly) {
  await fs.mkdir(directory, { recursive: true });
  for (const name of ["sharedDerivedCache", "cacheProcess", "derivedCacheProcess"]) {
    const file = `electron/services/${name}.js`;
    await fs.writeFile(path.join(directory, name + ".js"), baseline
      ? execFileSync("git", ["show", `HEAD:${file}`], { cwd: path.resolve(__dirname, "..") })
      : await fs.readFile(path.resolve(__dirname, "..", file)));
  }
  for (const name of ["assetListRecord", "imageTasks", "thumbnailWarmup"]) {
    await fs.writeFile(path.join(directory, name + ".js"), `module.exports = require(${JSON.stringify(require.resolve(`../electron/services/${name}`))});`);
  }
  const workerPath = path.join(directory, "readonly.cjs");
  if (readOnly) await fs.writeFile(workerPath, `const storage = require('./derivedCacheProcess');
    process.on('message', async ({id, operation, args}) => {
      try {
        const result = operation.startsWith('write') ? false : await storage[operation](args);
        process.send({id, ok: true, result});
      } catch (error) { process.send({id, ok: false, error: error.message}); }
    });`);
  const loaded = { exports: {} };
  const io = require(path.join(directory, "cacheProcess"));
  new Function("require", "module", await fs.readFile(path.join(directory, "sharedDerivedCache.js"), "utf8"))(
    name => name === "./cacheProcess" ? { createCacheProcess: options => io.createCacheProcess({ ...options,
      workerPath: readOnly ? workerPath : path.join(directory, "derivedCacheProcess.js") }) }
      : name.startsWith(".") ? require(path.join(directory, name)) : require(name), loaded);
  return loaded.exports.createSharedDerivedCache;
}

async function main() {
  const synthetic = process.argv[2] === "--synthetic";
  const library = process.argv[2];
  if (!synthetic && !path.isAbsolute(library || "")) throw new Error("Pass --synthetic or an absolute library root");
  const temporaryRoot = path.resolve(__dirname, "../.tmp");
  await fs.mkdir(temporaryRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporaryRoot, "shared-thumbnail-benchmark-"));
  const clients = [];
  try {
    let sample;
    let coverage;
    if (!synthetic) {
      const reader = createSharedDerivedCache({ libraryRoot: library, localRoot: path.join(directory, "snapshot") });
      clients.push(reader);
      const records = await reader.readSnapshot();
      assert.ok(records, "No usable shared snapshot");
      const previews = [...new Set(records.map(record => record.previewImage || record.preview).filter(file => file && /\.(png|jpe?g|webp)$/i.test(file)))];
      const candidates = Array.from({ length: Math.min(96, previews.length) }, (_, i) => previews[Math.floor(i * previews.length / Math.min(96, previews.length))]);
      const probes = await pool(candidates, 6, async file => {
        try {
          const probe = await storage.probeThumbnail({ sourcePath: file, root: library, localDir: path.join(directory, "empty") });
          const base = path.join(reader.sharedDir, "Thumbnails", probe.key.slice(0, 2), probe.key);
          for (const ext of [".png", ".jpg"]) if ((await fs.stat(base + ext).catch(() => null))?.size > 0) return file;
        } catch { /* Missing source or cache is counted as a miss. */ }
        return null;
      });
      sample = probes.filter(Boolean).slice(0, 32);
      coverage = { sampled: candidates.length, sharedFilesPresent: probes.filter(Boolean).length, benchmarked: sample.length };
    }
    const results = [];
    const image = synthetic ? await sharp(randomBytes(1024 * 1024 * 4), { raw: { width: 1024, height: 1024, channels: 4 } }).png().toBuffer() : null;
    for (const baseline of [true, false]) {
      const version = baseline ? "HEAD" : "workspace";
      const root = synthetic ? path.join(directory, version, "Library") : library;
      const files = synthetic ? Array.from({ length: 24 }, (_, i) => path.join(root, `preview-${i}.png`)) : sample;
      if (!files.length) continue;
      if (synthetic) { await fs.mkdir(root, { recursive: true }); await pool(files, 4, file => fs.writeFile(file, image)); }
      const create = await loadVersion(path.join(directory, version, "code"), baseline, !synthetic);
      const options = { libraryRoot: root, localRoot: path.join(directory, version, "writer") };
      let cold;
      if (synthetic) {
        const writer = create(options); clients.push(writer);
        cold = await batch(writer, files);
        writer.dispose();
        // Establish identical complete shared caches outside the timed stages.
        await pool(files, 2, async (file, index) => {
          const probe = await storage.probeThumbnail({ sourcePath: file, root, localDir: path.join(directory, "empty") });
          assert.notEqual(cold.outputs[index], file);
          await storage.writeThumbnail({ sharedDir: writer.sharedDir, localFile: cold.outputs[index], key: probe.key });
        });
      }
      const reader = create({ ...options, localRoot: path.join(directory, version, "new-user") }); clients.push(reader);
      const shared = await batch(reader, files);
      const local = await batch(reader, files);
      for (const stage of [cold, shared, local].filter(Boolean)) delete stage.outputs;
      results.push({ version, images: files.length, cold, shared, local });
      reader.dispose();
    }
    process.stdout.write(JSON.stringify({ mode: synthetic ? "synthetic-local-24x1024px-RGBA" : "existing-library-read-only", coverage, results }, null, 2) + "\n");
  } finally {
    clients.forEach(client => client.dispose());
    const realDirectory = await fs.realpath(directory);
    assert.equal(path.dirname(realDirectory).toLowerCase(), (await fs.realpath(temporaryRoot)).toLowerCase());
    assert.ok(path.basename(realDirectory).startsWith("shared-thumbnail-benchmark-"));
    await fs.rm(realDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
