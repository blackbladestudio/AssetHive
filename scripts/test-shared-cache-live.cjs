// Explicit opt-in SMB smoke test. All remote writes stay in one unique hidden
// validation directory; the production library's caches and assets are untouched.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { gzipSync } = require("node:zlib");
const sharp = require("sharp");
const { createSharedDerivedCache } = require("../electron/services/sharedDerivedCache");
const { probeThumbnail } = require("../electron/services/derivedCacheProcess");
const { scanLibraryInWorker } = require("../electron/services/assetScanner");

async function main() {
  const library = process.argv[2];
  if (!library || !path.isAbsolute(library)) throw new Error("Pass the absolute library root explicitly");
  const validationRoot = path.join(library, ".assethive", "DerivedCache");
  await fs.mkdir(validationRoot, { recursive: true });
  const remote = await fs.mkdtemp(path.join(validationRoot, ".validation-"));
  const local = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-live-cache-"));
  const clients = [];
  let locker;
  try {
    const root = path.join(remote, "Library");
    await fs.mkdir(path.join(root, "Rock"), { recursive: true });
    const preview = path.join(root, "Rock", "preview.png");
    await sharp({ create: { width: 700, height: 350, channels: 4, background: { r: 80, g: 160, b: 90, alpha: 0.5 } } }).png().toFile(preview);
    const asset = { id: "shared-cache-validation", name: "Cache validation", source: "custom",
      path: path.join(root, "Rock"), metaPath: path.join(root, "Rock", "asset_info.json"), previewImage: preview };
    await fs.writeFile(asset.metaPath, JSON.stringify({ assetID: asset.id, name: asset.name, assetType: "3d", textureFiles: [],
      scanInformation: { dimensions: { x: 1.2, y: 0.8, z: 0.6 }, dimensionsSource: "measured" } }));
    await fs.mkdir(path.join(root, ".assethive"));
    const legacyFile = path.join(root, ".assethive", "custom-index.json.gz");
    const legacyBytes = gzipSync(JSON.stringify({ version: 2, root, assets: [] }));
    await fs.writeFile(legacyFile, legacyBytes);
    const metadataBefore = await fs.readFile(asset.metaPath);
    const scanned = await Promise.all(["writer", "reader"].map(client => scanLibraryInWorker(root, {
      scanMemoPath: path.join(local, client, "library.memo.json.gz"), concurrency: 2, refreshMetadata: true
    })));
    assert.ok(scanned.every(records => records.length === 1 && records[0].id === asset.id));
    assert.deepEqual(await fs.readFile(asset.metaPath), metadataBefore);
    assert.deepEqual(await fs.readFile(legacyFile), legacyBytes);
    const writer = createSharedDerivedCache({ libraryRoot: root, localRoot: path.join(local, "writer") });
    const reader = createSharedDerivedCache({ libraryRoot: root, localRoot: path.join(local, "reader") });
    clients.push(writer, reader);
    assert.equal(await writer.publishSnapshot([asset]), true);
    assert.equal((await reader.readSnapshot())[0].id, asset.id);
    const first = await writer.thumbnail(preview);
    assert.ok(first.startsWith(local + path.sep));
    // Snapshots use a separate process, so wait for the optional publication
    // itself before checking that another client can consume its bytes.
    const probe = await probeThumbnail({ sourcePath: preview, root, localDir: path.join(local, "probe") });
    const sharedThumbnail = path.join(writer.sharedDir, "Thumbnails", probe.key.slice(0, 2), `${probe.key}.png`);
    for (let attempt = 0; attempt < 100 && !(await fs.stat(sharedThumbnail).catch(() => null)); attempt++) {
      await new Promise(resolve => globalThis.setTimeout(resolve, 20));
    }
    assert.deepEqual(await fs.readFile(sharedThumbnail), await fs.readFile(first));
    const second = await reader.thumbnail(preview);
    assert.ok(second.startsWith(local + path.sep));
    assert.deepEqual(await fs.readFile(first), await fs.readFile(second));
    const snapshotDir = path.join(writer.sharedDir, "Snapshots");
    const [name] = await fs.readdir(snapshotDir);
    const snapshotFile = path.join(snapshotDir, name);
    const before = await fs.readFile(snapshotFile);
    if (process.platform === "win32") {
      const quoted = snapshotFile.replace(/'/g, "''");
      locker = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$held = [IO.File]::Open('${quoted}', [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Seconds 20; $held.Dispose()`],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      await new Promise((resolve, reject) => {
        const timer = globalThis.setTimeout(() => reject(new Error("Lock helper timed out")), 8000);
        locker.stdout.on("data", data => { if (String(data).includes("locked")) { globalThis.clearTimeout(timer); resolve(); } });
        locker.on("error", error => { globalThis.clearTimeout(timer); reject(error); });
        locker.on("exit", code => { globalThis.clearTimeout(timer); reject(new Error(`Lock helper exited: ${code}`)); });
      });
      const started = Date.now();
      assert.equal(await reader.readSnapshot(), null);
      assert.equal(await writer.publishSnapshot([{ ...asset, name: "Blocked replacement" }]), null);
      assert.ok(Date.now() - started < 5000, "an exclusive writer must not cause an unbounded wait");
      assert.equal(await reader.thumbnail(preview), second, "local thumbnail must remain usable during the lock");
      const exited = once(locker, "exit");
      locker.kill();
      await exited;
      locker = null;
      assert.deepEqual(await fs.readFile(snapshotFile), before, "the complete snapshot survives a failed replacement");
    }
    process.stdout.write("SMB smoke passed: simultaneous read-only scans, unchanged metadata/legacy index, shared snapshot, cross-client thumbnail, local warm hit, exclusive writer fallback.\n");
  } finally {
    if (locker) { const exited = once(locker, "exit"); locker.kill(); await exited; }
    clients.forEach(client => client.dispose());
    // Verify both resolved deletion targets before recursively removing our own
    // test directories. Never delete the library or production cache directory.
    const realBase = await fs.realpath(validationRoot);
    const realRemote = await fs.realpath(remote);
    assert.equal(path.dirname(realRemote).toLowerCase(), realBase.toLowerCase());
    assert.ok(path.basename(realRemote).startsWith(".validation-"));
    const realLocal = await fs.realpath(local);
    assert.equal(path.dirname(realLocal).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
    assert.ok(path.basename(realLocal).startsWith("assethive-live-cache-"));
    await fs.rm(realRemote, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fs.rm(realLocal, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
