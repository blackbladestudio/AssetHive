const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { recordLibraryChanges, readLibraryChanges, changedDirectories } = require("../electron/services/libraryChanges");
const { createScanSchedule, RECONCILE_INTERVAL_MS, CHANGE_CHECK_INTERVAL_MS, DISCOVERY_INTERVAL_MS } = require("../electron/services/scanSchedule");
const { scanLibrary, scanLibraryInWorker } = require("../electron/services/assetScanner");

async function fixture(t) {
  const temporaryRoot = path.resolve(process.env.ASSETHIVE_SCAN_TEST_TMPDIR || os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, "assethive-changes-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    return fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  const root = path.join(directory, "assets");
  await fs.mkdir(path.join(root, ".assethive"), { recursive: true });
  await fs.writeFile(path.join(root, ".assethive", "changes.jsonl"), "");
  let clock = 1_800_000_000_000;
  const options = { root, libraryRoot: root, reason: "periodic", hasCache: true, idle: true };
  const file = path.join(directory, "index.scan.json");
  return { root, directory, options, file, now: () => clock, schedule: createScanSchedule(file, () => clock),
    advance: milliseconds => { clock += milliseconds; } };
}

test("journal reads only appended changes, merges overlapping paths, and supports concurrent import writers", async t => {
  const f = await fixture(t);
  const baseline = await readLibraryChanges(f.root);
  assert.equal(baseline.directories, null);
  await Promise.all(Array.from({ length: 40 }, (_, i) => recordLibraryChanges(f.root, [`Collection/Asset${i}`])));
  await recordLibraryChanges(f.root, ["Collection/Asset0/Preview", "Other/A", "Other"]);
  const delta = await readLibraryChanges(f.root, baseline.cursor);
  assert.equal(delta.directories.length, 41);
  assert.ok(delta.directories.includes(path.join(f.root, "Other")));
  assert.deepEqual((await readLibraryChanges(f.root, delta.cursor)).directories, []);
  await assert.rejects(recordLibraryChanges(f.root, ["../outside"]), /outside/);
  assert.deepEqual(changedDirectories(f.root, ["A", "A-other", "A/Child"]), [path.join(f.root, "A"), path.join(f.root, "A-other")]);
});

test("quiet polls persist across restart; failed and in-flight changes are never acknowledged early", async t => {
  const f = await fixture(t);
  const baseline = await f.schedule.plan(f.options);
  assert.equal(baseline.skip, false);
  await f.schedule.complete(f.root, false, true, baseline.changeCursor);
  const restarted = createScanSchedule(f.file, f.now);
  assert.equal((await restarted.plan(f.options)).skip, true);
  await recordLibraryChanges(f.root, ["A"]);
  const first = await f.schedule.plan(f.options);
  assert.deepEqual(first.changedDirectories, [path.join(f.root, "A")]);
  await f.schedule.complete(f.root, true, false, first.changeCursor);
  assert.deepEqual((await f.schedule.plan(f.options)).changedDirectories, first.changedDirectories);
  await recordLibraryChanges(f.root, ["B"]);
  await f.schedule.complete(f.root, true, true, first.changeCursor);
  assert.deepEqual((await f.schedule.plan(f.options)).changedDirectories, [path.join(f.root, "B")]);
  f.advance(RECONCILE_INTERVAL_MS);
  assert.equal((await f.schedule.plan(f.options)).incremental, false);
  assert.equal((await f.schedule.plan({ ...f.options, reason: "startup" })).incremental, false);
  const missingCache = await createScanSchedule(f.file, f.now).plan({ ...f.options, hasCache: false });
  assert.equal(missingCache.skip, false);
  assert.equal(missingCache.incremental, false);
});

test("truncated, replaced, malformed and unsafe journals fall back to discovery", async t => {
  const f = await fixture(t);
  const journal = path.join(f.root, ".assethive", "changes.jsonl");
  const baseline = await readLibraryChanges(f.root);
  for (const text of ['{"version":1', '{"version":1,"directories":["../outside"]}\n', '{"version":2,"directories":["A"]}\n']) {
    await fs.writeFile(journal, text);
    const result = await readLibraryChanges(f.root, baseline.cursor);
    assert.equal(result.directories, null);
  }
  const before = await readLibraryChanges(f.root);
  await fs.writeFile(journal, "");
  assert.equal((await readLibraryChanges(f.root, before.cursor)).directories, null);
  await fs.rename(journal, `${journal}.old`);
  assert.equal((await readLibraryChanges(f.root, baseline.cursor)).directories, null);
});

test("an offline or removed library is never recreated by journal probing", async t => {
  const f = await fixture(t);
  await fs.rm(f.root, { recursive: true });
  assert.equal((await readLibraryChanges(f.root)).cursor, null);
  await assert.rejects(fs.stat(f.root), { code: "ENOENT" });
});

test("targeted scans discover imports, edits, renames and deletions without visiting unchanged assets", async t => {
  const f = await fixture(t);
  async function asset(name) {
    const directory = path.join(f.root, name);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "asset_info.json"), JSON.stringify({ id: name, name }));
    await fs.writeFile(path.join(directory, "mesh.obj"), "o mesh\n");
    return directory;
  }
  const [a, b, c, untouched] = await Promise.all(["A", "B", "C", "Unchanged"].map(asset));
  const memo = path.join(f.directory, "memo.json.gz");
  const before = await scanLibrary(f.root, { scanMemoPath: memo });
  await fs.writeFile(path.join(a, "asset_info.json"), JSON.stringify({ id: "A", name: "Edited" }));
  await fs.rm(b, { recursive: true });
  const moved = path.join(f.root, "Moved");
  await fs.rename(c, moved);
  const added = await asset("New");
  const paths = [a, b, c, moved, added];
  let assetVisits = 0;
  const originals = {};
  for (const method of ["readdir", "stat", "readFile"]) {
    originals[method] = fs[method];
    fs[method] = async function (file, ...args) {
      if (path.resolve(String(file)).startsWith(untouched)) assetVisits++;
      return originals[method].call(this, file, ...args);
    };
  }
  let after;
  try { after = await scanLibrary(f.root, { scanMemoPath: memo, incrementalScan: true, changedDirectories: paths }); }
  finally { Object.assign(fs, originals); }
  assert.equal(assetVisits, 0, "cached assets outside the delta must incur zero file/directory probes");
  assert.deepEqual(after.map(a => a.id).sort(), ["A", "C", "New", "Unchanged"]);
  assert.equal(after.find(a => a.id === "A").name, "Edited");
  assert.equal(path.resolve(after.find(a => a.id === "C").path), moved);
  const worker = await scanLibraryInWorker(f.root, { scanMemoPath: memo, residentIndex: true, residentBase: after,
    incrementalScan: true, changedDirectories: [a] });
  assert.deepEqual(worker.map(a => a.id).sort(), after.map(a => a.id).sort());
  assert.equal(before.length, 4);
});

test("failed targeted directory reads preserve cached cards and remain retryable", async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, "A");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "asset_info.json"), '{"id":"a","name":"Keep"}');
  await fs.writeFile(path.join(directory, "mesh.obj"), "o mesh");
  const scanMemoPath = path.join(f.directory, "memo.json.gz");
  await scanLibrary(f.root, { scanMemoPath });
  const original = fs.readdir;
  fs.readdir = async (file, ...args) => {
    if (path.resolve(file) === directory) throw Object.assign(new Error("offline"), { code: "EIO" });
    return original(file, ...args);
  };
  const warnings = [];
  try {
    const records = await scanLibrary(f.root, { scanMemoPath, changedDirectories: [directory], onWarning: warning => warnings.push(warning) });
    assert.deepEqual(records.map(a => a.id), ["a"]);
    assert.equal(warnings.length, 1);
  } finally { fs.readdir = original; }
});

test("failed memo publication cannot consume changes and let a later scan restore stale records", async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, "A");
  await fs.mkdir(directory);
  const metaPath = path.join(directory, "asset_info.json");
  await fs.writeFile(metaPath, '{"id":"a","name":"Before"}');
  await fs.writeFile(path.join(directory, "mesh.obj"), "o mesh");
  const scanMemoPath = path.join(f.directory, "memo.json.gz");
  const baseline = await f.schedule.plan(f.options);
  await scanLibrary(f.root, { scanMemoPath });
  await f.schedule.complete(f.root, false, true, baseline.changeCursor);
  await fs.writeFile(metaPath, '{"id":"a","name":"After"}');
  await recordLibraryChanges(f.root, [directory]);
  const plan = await f.schedule.plan(f.options);
  const warnings = [];
  const original = fs.rename;
  fs.rename = async (source, target) => {
    if (target === scanMemoPath) throw Object.assign(new Error("write failed"), { code: "EIO" });
    return original(source, target);
  };
  try {
    const records = await scanLibrary(f.root, { scanMemoPath, changedDirectories: plan.changedDirectories, onWarning: value => warnings.push(value) });
    assert.equal(records[0].name, "After");
    assert.equal(warnings[0]?.operation, "scan-memo-write");
    await f.schedule.complete(f.root, true, warnings.length === 0, plan.changeCursor);
  } finally { fs.rename = original; }
  assert.deepEqual((await f.schedule.plan(f.options)).changedDirectories, [directory]);
});

test("independent clients publish separate journals without losing simultaneous changes", async t => {
  const f = await fixture(t);
  const baseline = await readLibraryChanges(f.root);
  const run = promisify(execFile);
  const modulePath = path.resolve(__dirname, "../electron/services/libraryChanges.js");
  const code = `const { recordLibraryChanges } = require(process.argv[1]);
    Promise.all(Array.from({ length: 25 }, (_, i) => recordLibraryChanges(process.argv[2],
      [process.argv[3] + '/Asset' + i]))).catch(error => { console.error(error); process.exitCode = 1; });`;
  await Promise.all(Array.from({ length: 6 }, (_, i) => run(process.execPath,
    ["-e", code, modulePath, f.root, `Client${i}`], { windowsHide: true, timeout: 30000 })));
  const delta = await readLibraryChanges(f.root, baseline.cursor);
  assert.equal(delta.directories.length, 150);
  assert.equal(Object.keys(delta.cursor.journals).length, 7);
  assert.deepEqual((await readLibraryChanges(f.root, delta.cursor)).directories, []);
});

test("journal probing is read-only, including legacy libraries without a journal", async t => {
  const f = await fixture(t);
  await fs.rm(path.join(f.root, ".assethive"), { recursive: true });
  const originals = { mkdir: fs.mkdir, open: fs.open, appendFile: fs.appendFile };
  fs.mkdir = fs.appendFile = () => assert.fail("poll must never create a shared file or directory");
  fs.open = (file, flags, ...args) => {
    assert.equal(flags, "r");
    return originals.open(file, flags, ...args);
  };
  try {
    assert.equal((await readLibraryChanges(f.root)).cursor, null);
  } finally { Object.assign(fs, originals); }
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("four-second healthy polls process edits immediately and still discover old-client changes", async t => {
  const f = await fixture(t);
  const baseline = await f.schedule.plan(f.options);
  await f.schedule.complete(f.root, false, true, baseline.changeCursor);
  for (let i = 0; i < 3; i++) {
    f.advance(CHANGE_CHECK_INTERVAL_MS);
    assert.equal((await f.schedule.plan(f.options)).skip, true);
    await recordLibraryChanges(f.root, [`Asset${i}`]);
    const changed = await f.schedule.plan(f.options);
    assert.equal(changed.skip, false);
    assert.deepEqual(changed.changedDirectories, [path.join(f.root, `Asset${i}`)]);
    await f.schedule.complete(f.root, true, true, changed.changeCursor);
  }
  f.advance(DISCOVERY_INTERVAL_MS);
  const discovery = await f.schedule.plan(f.options);
  assert.equal(discovery.skip, false);
  assert.equal(discovery.changedDirectories, null);
});

test("failed automatic scans wait before retrying while manual scans remain available", async t => {
  const f = await fixture(t);
  const baseline = await f.schedule.plan(f.options);
  await f.schedule.complete(f.root, false, true, baseline.changeCursor);
  await recordLibraryChanges(f.root, ["Changed"]);
  const first = await f.schedule.plan(f.options);
  await f.schedule.complete(f.root, true, false, first.changeCursor);
  f.advance(CHANGE_CHECK_INTERVAL_MS);
  assert.equal((await f.schedule.plan(f.options)).throttled, true);
  assert.equal((await f.schedule.plan({ ...f.options, reason: "manual-rescan" })).skip, false);
  f.advance(DISCOVERY_INTERVAL_MS);
  assert.equal((await f.schedule.plan(f.options)).skip, false);
});

test("partial append and same-size rewrites cannot look like an unchanged journal", async t => {
  const f = await fixture(t);
  const file = path.join(f.root, ".assethive", "changes.jsonl");
  const baseline = await readLibraryChanges(f.root);
  await fs.appendFile(file, '{"version":1,"directories":["A"]}');
  assert.equal((await readLibraryChanges(f.root, baseline.cursor)).cursor, null);
  await fs.appendFile(file, "\n");
  const complete = await readLibraryChanges(f.root, baseline.cursor);
  assert.deepEqual(complete.directories, [path.join(f.root, "A")]);
  await fs.writeFile(file, '{"version":1,"directories":["B"]}\n');
  const stamp = new Date(Date.now() + 2000);
  await fs.utimes(file, stamp, stamp);
  assert.equal((await readLibraryChanges(f.root, complete.cursor)).directories, null);
});

test("schedule publication failure retains the old cursor in memory and on disk", async t => {
  const f = await fixture(t);
  const baseline = await f.schedule.plan(f.options);
  await f.schedule.complete(f.root, false, true, baseline.changeCursor);
  const before = await fs.readFile(f.file);
  await recordLibraryChanges(f.root, ["Changed"]);
  const delta = await f.schedule.plan(f.options);
  const original = fs.rename;
  fs.rename = async (...args) => {
    if (args[1] === f.file) throw Object.assign(new Error("cache busy"), { code: "EPERM" });
    return original(...args);
  };
  try { await assert.rejects(f.schedule.complete(f.root, true, true, delta.changeCursor), { code: "EPERM" }); }
  finally { fs.rename = original; }
  assert.deepEqual(await fs.readFile(f.file), before);
  assert.deepEqual((await f.schedule.plan(f.options)).changedDirectories, [path.join(f.root, "Changed")]);
});

test("preview subdirectory deltas revalidate their owning asset despite unchanged metadata timestamps", async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, "Asset");
  const preview = path.join(directory, "Preview");
  await fs.mkdir(preview, { recursive: true });
  const metadata = path.join(directory, "asset_info.json");
  await fs.writeFile(metadata, '{"id":"a","name":"Before"}');
  await fs.writeFile(path.join(directory, "mesh.obj"), "o mesh");
  const scanMemoPath = path.join(f.directory, "memo.json.gz");
  await scanLibrary(f.root, { scanMemoPath });
  const stat = await fs.stat(metadata);
  await fs.writeFile(metadata, '{"id":"a","name":"Edited"}');
  await fs.utimes(metadata, stat.atime, stat.mtime);
  const records = await scanLibrary(f.root, { scanMemoPath, incrementalScan: true, changedDirectories: [preview] });
  assert.equal(records[0].name, "Edited");
});

test("Windows path aliases consume relative journal entries using the reader's library root", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  const baseline = await readLibraryChanges(f.root);
  await recordLibraryChanges(f.root, ["Environment/Surfaces/石材"]);
  const alias = f.root.startsWith("\\\\") ? `\\\\?\\UNC\\${f.root.slice(2)}` : `\\\\?\\${f.root}`;
  const delta = await readLibraryChanges(alias, baseline.cursor);
  assert.deepEqual(delta.directories, [path.join(alias, "Environment", "Surfaces", "石材")]);
});

test("an SMB disconnect between root probing and targeted reads cannot confirm asset deletion", async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, "Asset");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "asset_info.json"), '{"id":"a","name":"Keep"}');
  await fs.writeFile(path.join(directory, "mesh.obj"), "o mesh");
  const scanMemoPath = path.join(f.directory, "memo.json.gz");
  await scanLibrary(f.root, { scanMemoPath });
  const originals = { stat: fs.stat, readdir: fs.readdir };
  let disconnected = false;
  fs.readdir = async (file, ...args) => {
    if (path.resolve(file) === directory) {
      disconnected = true;
      throw Object.assign(new Error("share unavailable"), { code: "ENOENT" });
    }
    return originals.readdir(file, ...args);
  };
  fs.stat = async (file, ...args) => {
    if (disconnected && path.resolve(file) === f.root) throw Object.assign(new Error("offline"), { code: "EIO" });
    return originals.stat(file, ...args);
  };
  const warnings = [];
  try {
    const records = await scanLibrary(f.root, { scanMemoPath, changedDirectories: [directory], onWarning: value => warnings.push(value) });
    assert.deepEqual(records.map(record => record.id), ["a"]);
    assert.equal(warnings[0]?.operation, "readdir");
  } finally { Object.assign(fs, originals); }
});

test("journal backlog exceeding four MiB requests a fresh discovery baseline", async t => {
  const f = await fixture(t);
  const baseline = await readLibraryChanges(f.root);
  const line = JSON.stringify({ version: 1, directories: ["Asset"] }) + "\n";
  await fs.appendFile(path.join(f.root, ".assethive", "changes.jsonl"), line.repeat(Math.ceil(4 * 1024 * 1024 / line.length) + 1));
  const delta = await readLibraryChanges(f.root, baseline.cursor);
  assert.ok(delta.cursor);
  assert.equal(delta.directories, null);
});

test("frequent targeted edits cannot skip the old-client discovery shards", async t => {
  const f = await fixture(t);
  const baseline = await f.schedule.plan(f.options);
  await f.schedule.complete(f.root, false, true, baseline.changeCursor);
  for (let shard = 0; shard < 6; shard++) {
    for (let i = 0; i < 3; i++) {
      await recordLibraryChanges(f.root, ["Changed"]);
      const targeted = await f.schedule.plan(f.options);
      assert.equal(targeted.pollShard, shard);
      assert.ok(targeted.changedDirectories);
      await f.schedule.complete(f.root, true, true, targeted.changeCursor, true);
    }
    f.advance(DISCOVERY_INTERVAL_MS);
    const discovery = await f.schedule.plan(f.options);
    assert.equal(discovery.pollShard, shard);
    assert.equal(discovery.changedDirectories, null);
    await f.schedule.complete(f.root, true, true, discovery.changeCursor);
  }
  assert.equal((await f.schedule.plan(f.options)).pollShard, 0);
});
