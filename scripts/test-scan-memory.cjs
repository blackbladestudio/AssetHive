const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Buffer } = require("node:buffer");
const { gzipSync, gunzipSync } = require("node:zlib");
const { getResidentMemoPath } = require("../electron/services/residentScanMemo");
const { test } = require("node:test");
const { scanLibraryInWorker, stopLibraryScans } = require("../electron/services/assetScanner");

test("resident worker results reuse streamed objects without changing source metadata or full-detail callers", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-scan-memory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const meta = { assetID: "memory-fixture", name: "Rock", assetType: "surface",
    textureFiles: ["Diffuse.png"], identity: { sourceKind: "megascans", sourceKey: "test:rock", contentFingerprint: "sha256" },
    importHistory: [{ data: "x".repeat(10000) }], components: [{ type: "texture", uri: "Diffuse.png" }] };
  const metaPath = path.join(root, "asset_info.json");
  const original = JSON.stringify(meta);
  await fs.writeFile(metaPath, original);
  await fs.writeFile(path.join(root, "Diffuse.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/v8/AwAJoAP+2GZ4WQAAAABJRU5ErkJggg==", "base64"));
  const streamed = [];
  const compact = await scanLibraryInWorker(root, { residentIndex: true, onRecord: record => streamed.push(record) });
  assert.equal(compact.length, 1);
  assert.equal(compact[0], streamed[0], "completion must reuse the streamed object");
  assert.equal(compact[0].meta.components, undefined);
  assert.equal(compact[0].meta.importHistory, undefined);
  assert.equal(compact[0].textureFiles.length, 1);
  compact[0].favorite = true;
  const repeated = [];
  const reused = await scanLibraryInWorker(root, { residentIndex: true, residentBase: compact, onRecord: record => repeated.push(record) });
  assert.equal(reused[0], compact[0], "unchanged scans must reuse the parent's existing record");
  assert.equal(reused[0].favorite, true, "personal favorites do not invalidate scanned content");
  assert.equal(repeated.length, 0, "unchanged records must not be cloned or incrementally republished");
  await fs.writeFile(metaPath, JSON.stringify({ ...meta, name: "Edited Rock" }));
  const changed = [];
  const edited = await scanLibraryInWorker(root, { residentIndex: true, residentBase: compact, onRecord: record => changed.push(record) });
  assert.equal(changed.length, 1);
  assert.equal(edited[0], changed[0]);
  assert.equal(edited[0].name, "Edited Rock");
  assert.notEqual(edited[0], compact[0]);
  await fs.writeFile(metaPath, original);
  const full = await scanLibraryInWorker(root);
  assert.equal(full[0].meta.importHistory.length, 1, "default scanner API remains complete");
  assert.equal(await fs.readFile(metaPath, "utf8"), original);
});

test("stopping scans also cancels asynchronous signature preparation before a worker can start", async () => {
  const residentBase = Array.from({ length: 256 }, (_, i) => ({ id: String(i), name: "fixture" }));
  const pending = scanLibraryInWorker("unused", { residentIndex: true, residentBase });
  stopLibraryScans();
  await assert.rejects(pending, /Scan canceled during preparation/);
});

test("periodic and manual scans keep a newer local animation cover than the memo", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-scan-animation-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "library");
  const archive = path.join(root, "Animation", "Hero");
  const modelPath = path.join(archive, "AS_Walk.fbx");
  const legacyPreview = path.join(archive, "Preview", "AS_Walk.png");
  const legacyMeta = path.join(archive, "AS_Walk.asset_info.json");
  await fs.mkdir(path.dirname(legacyPreview), { recursive: true });
  await fs.writeFile(legacyPreview, "legacy preview");
  await fs.writeFile(legacyMeta, "legacy sidecar");
  await fs.writeFile(modelPath, "animation fixture");

  const scanMemoPath = path.join(temp, "local", "library.memo.json.gz");
  const options = { scanMemoPath, residentIndex: true };
  const [before] = await scanLibraryInWorker(root, options);
  assert.equal(before.assetType, "animation");
  assert.equal(before.previewImage, null);
  const cover = path.join(temp, "local", "AS_Walk_preview.webm");
  await fs.writeFile(cover, "new local cover");
  const residentBase = [{ ...before, preview: cover, previewImage: cover }];
  for (const mode of [{ incrementalScan: true, changedDirectories: [archive] }, { refreshMetadata: true }]) {
    const streamed = [];
    const [after] = await scanLibraryInWorker(root, { ...options, ...mode, residentBase, onRecord: record => streamed.push(record) });
    assert.equal(after.previewImage, cover);
    assert.equal(after.detailImage, cover);
    assert.equal(after, streamed[0]);
  }
  assert.equal(await fs.readFile(legacyPreview, "utf8"), "legacy preview");
  assert.equal(await fs.readFile(legacyMeta, "utf8"), "legacy sidecar");
  assert.equal(await fs.readFile(modelPath, "utf8"), "animation fixture");
});

test("private resident memos stay small, preserve source/legacy bytes and invalidate after a full-memo update", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-resident-memo-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(temp, "library"), local = path.join(temp, "local");
  await fs.mkdir(root); await fs.mkdir(local);
  const meta = { assetID: "resident", name: "Rock", assetType: "surface", textureFiles: ["Diffuse.png"],
    identity: { contentFingerprint: "saved" }, sourceClassification: { label: "keep-classification" },
    importHistory: [{ data: "x".repeat(10000) }], components: [{ type: "texture", uri: "Diffuse.png", data: "x".repeat(10000) }] };
  const original = JSON.stringify(meta);
  await fs.writeFile(path.join(root, "asset_info.json"), original);
  await fs.writeFile(path.join(root, "Diffuse.png"), "fixture");
  const scanMemoPath = path.join(local, "library.memo.json.gz");
  await scanLibraryInWorker(root, { scanMemoPath });
  // Historical imported records can contain raw classification hints that the
  // cold scanner's light metadata does not otherwise persist.
  const historical = JSON.parse(gunzipSync(await fs.readFile(scanMemoPath)));
  historical.assets[0].record.meta.sourceClassification = meta.sourceClassification;
  await fs.writeFile(scanMemoPath, gzipSync(JSON.stringify(historical)));
  const legacy = await fs.readFile(scanMemoPath);
  const first = await scanLibraryInWorker(root, { scanMemoPath, residentIndex: true });
  const residentPath = getResidentMemoPath(scanMemoPath);
  const residentBytes = await fs.readFile(residentPath);
  const resident = JSON.parse(gunzipSync(residentBytes));
  assert.equal(resident.projection, "resident-v1");
  assert.equal(resident.assets[0].record.meta.components, undefined);
  assert.equal(resident.assets[0].record.meta.importHistory, undefined);
  assert.deepEqual(resident.assets[0].record.meta.sourceClassification, meta.sourceClassification);
  assert.deepEqual(await fs.readFile(scanMemoPath), legacy, "GUI scanning must not replace the old full memo");
  const timing = [];
  const second = await scanLibraryInWorker(root, { scanMemoPath, residentIndex: true, residentBase: first, onTiming: value => timing.push(value) });
  assert.equal(second[0], first[0]);
  assert.equal(timing[0].memoWritten, false);
  assert.deepEqual(await fs.readFile(residentPath), residentBytes, "unchanged polls must not rewrite the private projection");
  const updated = JSON.parse(gunzipSync(legacy));
  updated.assets[0].record.name = "Name from maintenance";
  await fs.writeFile(scanMemoPath, gzipSync(JSON.stringify(updated)));
  const refreshed = await scanLibraryInWorker(root, { scanMemoPath, residentIndex: true, residentBase: second });
  assert.equal(refreshed[0].name, "Name from maintenance");
  assert.equal(await fs.readFile(path.join(root, "asset_info.json"), "utf8"), original);
});
