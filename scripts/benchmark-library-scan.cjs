// Synthetic SMB latency benchmark. Never scans or modifies a user's library.
// node scripts/benchmark-library-scan.cjs [asset-count] [latency-ms] [baseline-ref]
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const count = Number(process.argv[2]) || 256;
const latency = Number(process.argv[3]) || 4;
const baselineRef = process.argv[4] || "HEAD";
const scannerPath = path.resolve(__dirname, "../electron/services/assetScanner.js");
const baseline = new Module(scannerPath, module);
baseline.filename = scannerPath;
baseline.paths = Module._nodeModulePaths(path.dirname(scannerPath));
baseline._compile(execFileSync("git", ["show", `${baselineRef}:electron/services/assetScanner.js`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }), scannerPath);
const current = require(scannerPath);

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-scan-benchmark-"));
  try {
    for (let i = 0; i < count; i += 1) {
      const dir = path.join(root, `asset_${String(i).padStart(5, "0")}`);
      await fs.mkdir(path.join(dir, "Textures"), { recursive: true });
      const textureFiles = [];
      for (let map = 0; map < 12; map += 1) {
        const name = `Textures/map_${map}.png`;
        textureFiles.push(name);
        // Surfaces without previews need only file existence during scanning.
        await fs.writeFile(path.join(dir, name), "fixture");
      }
      await fs.writeFile(path.join(dir, "asset_info.json"), JSON.stringify({
        assetID: `asset_${i}`, name: `Asset ${i}`, assetType: "surface", textureFiles
      }));
    }
    const rows = [];
    for (const [version, scanner] of [[baselineRef, baseline.exports], ["working-tree", current]]) {
      await fs.rm(path.join(root, ".assethive"), { recursive: true, force: true });
      for (const mode of (version === "working-tree" ? ["cold", "warm", "incremental-poll"] : ["cold", "warm"])) {
        const originals = {};
        const calls = { readdir: 0, stat: 0, readFile: 0, writeFile: 0 };
        for (const operation of Object.keys(calls)) {
          originals[operation] = fs[operation];
          fs[operation] = async function (...args) {
            calls[operation] += 1;
            await new Promise((resolve) => globalThis.setTimeout(resolve, latency));
            return originals[operation].apply(this, args);
          };
        }
        const started = performance.now();
        let firstCardMs;
        try {
          const result = await scanner.scanLibrary(root, {
            scanMemoPath: `${root}.memo.json.gz`,
            incrementalScan: mode === "incremental-poll",
            pollShard: 0,
            onRecord: () => { firstCardMs ??= Math.round(performance.now() - started); }
          });
          if (result.length !== count) throw new Error(`Expected ${count} assets; got ${result.length}`);
          rows.push({ version, mode, assets: result.length, totalMs: Math.round(performance.now() - started), firstCardMs, ...calls });
        } finally {
          Object.assign(fs, originals);
        }
      }
    }
    console.log(JSON.stringify({ simulatedLatencyMs: latency, nestedTexturesPerAsset: 12, results: rows }, null, 2));
  } finally {
    await fs.rm(`${root}.memo.json.gz`, { force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
