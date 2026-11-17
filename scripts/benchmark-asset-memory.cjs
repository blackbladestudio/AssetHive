// Read-only replay of a local scan memo. Each case gets a fresh process so GC
// and retained heaps can be compared without changing the running application.
// Search compares against HEAD; ASSETHIVE_MEMORY_BASELINE_REF can pin an older
// commit after this optimization has been committed.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync, execFileSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { createHash } = require("node:crypto");
const ts = require("typescript");
const { toAssetListRecord, toAssetIndexRecord } = require("../electron/services/assetListRecord");

const mode = process.argv[2];
if (["full", "resident", "browse-full", "browse-selected", "search-full", "search-compact"].includes(mode)) {
  global.gc();
  const base = process.memoryUsage().heapUsed;
  const started = performance.now();
  const records = (() => {
    const memo = JSON.parse(zlib.gunzipSync(fs.readFileSync(process.argv[3])));
    const all = memo.assets.map(entry => entry.record).filter(Boolean);
    if (mode.startsWith("search-")) {
      const modules = new Map();
      function load(file) {
        if (modules.has(file)) return modules.get(file);
        const source = mode === "search-full" && file.endsWith("assetSearchIndex.ts")
          ? execFileSync("git", ["show", `${process.env.ASSETHIVE_MEMORY_BASELINE_REF || "HEAD"}:src/ui/assetSearchIndex.ts`], { cwd: path.resolve(__dirname, ".."), encoding: "utf8", windowsHide: true })
          : fs.readFileSync(file, "utf8");
        const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
        const output = {};
        new Function("require", "exports", compiled)(name => name.startsWith(".") ? load(path.resolve(path.dirname(file), `${name}.ts`)) : require(name), output);
        modules.set(file, output);
        return output;
      }
      const { AssetSearchIndex } = load(path.resolve(__dirname, "../src/ui/assetSearchIndex.ts"));
      const { createSearchDocument } = load(path.resolve(__dirname, "../src/ui/assetSearchDocument.ts"));
      const cards = all.map(toAssetListRecord);
      const documents = cards.map(asset => mode === "search-compact" ? createSearchDocument(asset) : {
        id: asset.id, name: asset.name,
        fields: [asset.name, asset.id, asset.assetID, asset.meta?.assetID, asset.meta?.slug,
          ...(asset.tags || []), ...(asset.standardAssetTags || []), ...(asset.zionTags || [])].filter(value => typeof value === "string"),
        identifiers: [asset.id, asset.assetID, asset.meta?.assetID].filter(value => typeof value === "string")
      });
      const synced = new Map(documents.map((doc, i) => [doc.id, mode === "search-full" ? JSON.stringify(doc.fields) : cards[i]]));
      const search = new AssetSearchIndex();
      search.update(globalThis.structuredClone(documents));
      return { cards, synced, search, count: all.length };
    }
    if (mode === "full") return all;
    if (mode === "resident") return all.map(toAssetIndexRecord);
    const cards = all.map(toAssetListRecord);
    // Replay 1,000 detail views: old behavior retained each complete reply.
    for (let i = 0; i < Math.min(1000, all.length); i++) cards[i] = mode === "browse-full" ? all[i] : toAssetListRecord(all[i]);
    return { cards, selected: all[Math.min(999, all.length - 1)] };
  })();
  const loadMs = performance.now() - started;
  let queries;
  if (records.search) queries = ["rock forest", "temp", "aitest", "shanshu", "graniet", "stone"].map(query => {
    const start = performance.now();
    const ids = records.search.search(query);
    return { query, count: ids.length, hash: createHash("sha256").update(JSON.stringify(ids)).digest("hex"), ms: +(performance.now() - start).toFixed(2) };
  });
  global.gc(); global.gc();
  console.log(JSON.stringify({ mode, count: Array.isArray(records) ? records.length : records.count || records.cards.length,
    heapMB: +((process.memoryUsage().heapUsed - base) / 1048576).toFixed(2), loadMs: +loadMs.toFixed(0), queries }));
  // Keep the graph observable through the final heap measurement.
  if (!records) process.exitCode = 1;
} else {
  const memoPath = process.argv[2];
  if (!memoPath) throw new Error("Usage: node scripts/benchmark-asset-memory.cjs <local memo.json.gz>");
  for (const scenario of ["full", "resident", "browse-full", "browse-selected", "search-full", "search-compact"]) {
    const run = spawnSync(process.execPath, ["--expose-gc", path.join(__dirname, "benchmark-asset-memory.cjs"), scenario, path.resolve(memoPath)], { encoding: "utf8", windowsHide: true });
    if (run.status !== 0) throw new Error(run.stderr || `Benchmark failed: ${scenario}`);
    process.stdout.write(run.stdout);
  }
}
