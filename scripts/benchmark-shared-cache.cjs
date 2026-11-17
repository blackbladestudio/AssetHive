// Read-only against an existing library. --synthetic creates only a temporary
// cache: no per-asset directories exist, so success cannot depend on scanning.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { performance } = require("node:perf_hooks");
const { createSharedDerivedCache } = require("../electron/services/sharedDerivedCache");

async function main() {
  const synthetic = process.argv[2] === "--synthetic";
  if (!synthetic && !path.isAbsolute(process.argv[2] || "")) throw new Error("Pass an absolute library root or --synthetic");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-cache-benchmark-"));
  const root = synthetic ? path.join(directory, "Library") : process.argv[2];
  const clients = [];
  try {
    if (synthetic) {
      const writer = createSharedDerivedCache({ libraryRoot: root, localRoot: path.join(directory, "writer") });
      clients.push(writer);
      const assets = Array.from({ length: 20000 }, (_, i) => ({
        id: `asset_${i}`, name: `Rock Surface ${i}`, source: "custom", assetType: "surface", topCategory: "environment",
        path: path.join(root, "Surface", `Rock_${i}`), metaPath: path.join(root, "Surface", `Rock_${i}`, "asset_info.json"),
        previewImage: path.join(root, "Surface", `Rock_${i}`, "Preview", "preview.png"),
        tags: ["Rock", "Surface", "ThirdParty"], modelFiles: [],
        meta: { identity: { sourceKind: "megascans", sourceAssetId: `native_${i}` }, previews: { relativeSize: "1:1" } }
      }));
      assert.equal(await writer.publishSnapshot(assets), true);
    }
    const results = [];
    for (let i = 0; i < 3; i++) {
      const reader = createSharedDerivedCache({ libraryRoot: root, localRoot: path.join(directory, `new-user-${i}`) });
      clients.push(reader);
      const started = performance.now();
      const records = await reader.readSnapshot();
      const durationMs = Math.round(performance.now() - started);
      assert.ok(records !== null, "No usable shared snapshot was restored within its deadline");
      if (synthetic) assert.equal(records.length, 20000);
      results.push({ assets: records.length, durationMs, localIndexExisted: false });
      reader.dispose();
    }
    process.stdout.write(JSON.stringify({ mode: synthetic ? "synthetic" : "existing-library-read-only", root, results }, null, 2) + "\n");
  } finally {
    clients.forEach(client => client.dispose());
    const realDirectory = await fs.realpath(directory);
    assert.equal(path.dirname(realDirectory).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
    assert.ok(path.basename(realDirectory).startsWith("assethive-cache-benchmark-"));
    await fs.rm(realDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
