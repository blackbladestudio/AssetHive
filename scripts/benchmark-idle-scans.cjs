// Read-only repeated scan-cache replay, including Worker heaps and cross-thread
// records. Each scenario runs in its own process; no asset library is traversed.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const { performance } = require("node:perf_hooks");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { setInterval, clearInterval } = require("node:timers");
const { setImmediate } = require("node:timers/promises");
const { toAssetIndexRecord, toAssetListRecord } = require("../electron/services/assetListRecord");
const { readGzipJsonArray, gzipJsonArray } = require("../electron/services/jsonArrayStream");
const { createScanSeeds, createScanRecordSender } = require("../electron/services/scanRecordReuse");
const { compactScanMemoEntry } = require("../electron/services/residentScanMemo");

if (!isMainThread) {
  (async () => {
    // Match the scanner's native/module baseline in both scenarios.
    require("../electron/services/assetScanner");
    const { file, mode, seeds, projectionFile } = workerData;
    const document = mode.startsWith("working-tree") ? await readGzipJsonArray(file, { mapItem: compactScanMemoEntry })
      : JSON.parse((await promisify(zlib.gunzip)(await fs.readFile(file))).toString("utf8"));
    if (projectionFile) {
      const { assets, ...metadata } = document;
      await fs.writeFile(projectionFile, await gzipJsonArray(metadata, assets));
    }
    const sender = createScanRecordSender({ seeds, project: toAssetIndexRecord, send: message => parentPort.postMessage(message) });
    const tokens = document.assets.map(entry => sender.token(entry.record));
    parentPort.postMessage({ type: "done", tokens, stats: sender.stats, memory: process.memoryUsage() });
    parentPort.once("message", () => {
      if (document.assets.length !== tokens.length) throw new Error("Invalid benchmark data");
      parentPort.close();
    });
  })().catch(error => { parentPort.postMessage({ type: "error", error: String(error) }); parentPort.close(); });
} else if (process.argv[4]) {
  (async () => {
    const file = path.resolve(process.argv[2]), rounds = Number(process.argv[3]) || 6, mode = process.argv[4];
    const projectionFile = path.join(os.tmpdir(), `assethive-idle-${randomUUID()}.json.gz`);
    let index = [], peakRss = 0, measured = false;
    const capture = () => { if (measured) peakRss = Math.max(peakRss, process.memoryUsage().rss); };
    const timer = setInterval(capture, 20);
    async function cycle(scenario) {
      const started = performance.now(), base = index;
      const byId = new Map(base.map(record => [record.id, record]));
      const seeds = scenario === "working-tree" ? await createScanSeeds(base) : [];
      return new Promise((resolve, reject) => {
        const records = new Map();
        let done;
        const worker = new Worker(path.join(__dirname, "benchmark-idle-scans.cjs"), { workerData: {
          file: scenario === "working-tree" ? projectionFile : file, mode: scenario, seeds,
          ...(scenario === "working-tree-seed" ? { projectionFile } : {}) } });
        worker.on("message", message => {
          if (message.type === "record") {
            // Old periodic scans also serialized both records to compare them
            // before finally receiving another full set of resident objects.
            if (scenario === "baseline" && byId.has(message.payload.id)) {
              const previous = byId.get(message.payload.id);
              message.payload.favorite = previous.favorite;
              const firstMatch = JSON.stringify(previous) === JSON.stringify(message.payload);
              const secondMatch = JSON.stringify(previous) === JSON.stringify(message.payload);
              if (!firstMatch || !secondMatch) throw new Error("Baseline fixture changed between identical scan rounds");
            }
            records.set(message.token, message.payload);
            if (records.size % 256 === 0) capture();
          } else if (message.type === "done") {
            index = message.tokens.map(token => token < 0 ? base[-token - 1] : records.get(token));
            done = { ...message.stats, workerHeapMB: +(message.memory.heapUsed / 1048576).toFixed(1) };
            capture(); worker.postMessage("release");
          } else reject(new Error(message.error));
        });
        worker.on("error", reject);
        worker.on("exit", code => {
          if (code !== 0 || !done) reject(new Error(`Benchmark worker exited: ${code}`));
          else resolve({ ...done, ms: Math.round(performance.now() - started) });
        });
      });
    }
    try {
      await cycle(`${mode}-seed`);
      global.gc?.(); await setImmediate(); global.gc?.();
      const initialRssMB = +(process.memoryUsage().rss / 1048576).toFixed(1);
      measured = true; capture();
      const cycles = [];
      for (let i = 0; i < rounds; i++) {
        cycles.push({ round: i + 1, ...await cycle(mode), parentHeapMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1) });
      }
      measured = false;
      const hash = createHash("sha256");
      for (const record of index) hash.update(JSON.stringify(toAssetListRecord(record)));
      global.gc?.(); await setImmediate(); global.gc?.();
      console.log(JSON.stringify({ mode, count: index.length, rounds, initialRssMB, peakRssMB: +(peakRss / 1048576).toFixed(1),
        liveHeapMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1),
        finalRssMB: +(process.memoryUsage().rss / 1048576).toFixed(1), resultHash: hash.digest("hex"), cycles }));
    } finally { clearInterval(timer); await fs.rm(projectionFile, { force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const file = process.argv[2], rounds = process.argv[3] || "6";
  if (!file) throw new Error("Usage: node scripts/benchmark-idle-scans.cjs <local memo.json.gz> [rounds]");
  for (const scenario of ["baseline", "working-tree"]) {
    const result = spawnSync(process.execPath, ["--expose-gc", path.join(__dirname, "benchmark-idle-scans.cjs"), path.resolve(file), rounds, scenario],
      { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || "Benchmark did not complete");
    process.stdout.write(result.stdout);
  }
}
