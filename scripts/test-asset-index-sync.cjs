const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { test } = require("node:test");

const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/ui/assetIndexSync.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;
const output = { exports: {} };
new Function("exports", compiled)(output.exports);
const { createAssetIndexSync } = output.exports;
const asset = id => ({ id, name: id, source: "custom", path: id, metaPath: `${id}/asset_info.json` });

function fixture(initial = []) {
  let assets = initial;
  let nextTimer = 0;
  const timers = new Map();
  const reads = [];
  const history = [];
  const sync = createAssetIndexSync({
    readIndex: () => new Promise(resolve => reads.push(resolve)),
    update: value => { assets = typeof value === "function" ? value(assets) : value; history.push(assets.length); },
    schedule: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    cancel: id => timers.delete(id)
  });
  return { sync, reads, history, assets: () => assets, timers,
    flush() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); } };
}

test("20,000 cached cards remain visible through partial scan batches and only confirmed deletions disappear", () => {
  const initial = Array.from({ length: 20000 }, (_, id) => asset(String(id)));
  const f = fixture(initial);
  f.sync.onChange({ incremental: true, count: 20000, records: [{ ...asset("0"), name: "Updated" }] });
  f.sync.onChange({ incremental: true, count: 20001, records: [asset("new")] });
  assert.deepEqual(f.history, [20000, 20001]);
  assert.equal(f.assets()[0].name, "Updated");
  f.sync.onChange({ incremental: true, complete: true, ids: initial.slice(1).map(a => a.id).concat("new"), favoriteIds: ["1"] });
  assert.equal(f.assets().length, 20000);
  assert.equal(f.assets().some(a => a.id === "0"), false);
  assert.equal(f.assets()[0].favorite, true);
  assert.equal(f.timers.size, 0, "normal batches do not reread the whole library");
});

test("an older full response cannot replace newer streamed cards or metadata", async () => {
  const f = fixture([asset("a"), asset("b")]);
  const reading = f.sync.refresh();
  f.sync.onChange({ incremental: true, records: [{ ...asset("a"), name: "Edited" }, asset("c")] });
  f.reads.shift()([asset("a")]);
  await reading;
  assert.deepEqual(f.assets().map(a => a.id), ["a", "b", "c"]);
  assert.equal(f.assets()[0].name, "Edited");
  assert.equal(f.timers.size, 0, "a streamed update does not discard and reread the full base");
});

test("late startup cache becomes searchable during an ongoing scan instead of waiting for completion", async () => {
  const f = fixture();
  const cached = Array.from({ length: 20000 }, (_, i) => asset(String(i)));
  cached.push(...["apg0erw", "7whmhcc", "9yzo6ux"].map((id, i) => ({ ...asset(id), name: `SM_Env_ZGNC_AItest_${i}` })));
  const reading = f.sync.refresh();
  f.sync.onChange({ incremental: true, count: cached.length, records: [{ ...cached[0], name: "Newer edit" }] });
  f.flush();
  assert.equal(f.reads.length, 1, "streaming cannot start competing reads that starve the startup response");
  f.reads.shift()(cached);
  await reading;
  assert.equal(f.assets().length, cached.length);
  assert.equal(f.assets()[0].name, "Newer edit");
  assert.deepEqual(f.assets().filter(a => /aitest/i.test(a.name)).map(a => a.id), ["apg0erw", "7whmhcc", "9yzo6ux"]);
  f.sync.onChange({ incremental: true, records: [{ ...cached[1], name: "Scan continues" }] });
  assert.equal(f.assets().length, cached.length);
});

test("a completion before the startup response prevents deleted assets from returning, while later imports survive", async () => {
  const f = fixture();
  const reading = f.sync.refresh();
  f.sync.onChange({ incremental: true, complete: true, ids: ["keep"], favoriteIds: ["keep"] });
  f.sync.onChange({ incremental: true, records: [asset("new-import")] });
  f.reads.shift()([asset("keep"), asset("deleted")]);
  await reading;
  assert.deepEqual(f.assets().map(a => a.id), ["keep", "new-import"]);
  assert.equal(f.assets()[0].favorite, true);
});

test("completion recovers a missed cached base instead of leaving only the scanned subset", async () => {
  const f = fixture([asset("a")]);
  f.sync.onChange({ incremental: true, complete: true, ids: ["a", "b"], favoriteIds: [] });
  assert.equal(f.assets().length, 1);
  f.flush();
  f.reads.shift()([asset("a"), asset("b")]);
  await Promise.resolve();
  assert.deepEqual(f.assets().map(a => a.id), ["a", "b"]);
});

test("library resets and disposal reject in-flight responses from the previous library", async () => {
  const f = fixture([asset("old")]);
  const reading = f.sync.refresh();
  f.sync.onChange({ reset: true });
  f.reads.shift()([asset("old")]);
  await reading;
  assert.deepEqual(f.assets(), []);
  f.flush();
  f.reads.shift()([asset("new")]);
  await f.sync.refresh();
  assert.equal(f.assets()[0].id, "new");
  const lastRead = f.sync.refresh();
  f.sync.dispose();
  f.reads.shift()([asset("late")]);
  await lastRead;
  assert.equal(f.assets()[0].id, "new");
  assert.equal(f.timers.size, 0);
});
