const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { prepareAssetDeletion, recycleAsset, listRecycledAssets, restoreRecycledAsset } = require("../electron/services/libraryRecycle");

async function fixture(t, flat = false) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-recycle-test-"));
  const root = path.join(temp, "Library");
  const directory = path.join(root, flat ? "Animation/Monster" : "Character/Monster/3_Elite/test_fixture");
  await fs.mkdir(directory, { recursive: true });
  const model = path.join(directory, flat ? "AS_Test.fbx" : "SK_Test_01.fbx");
  await fs.writeFile(model, "model-contents");
  const metaPath = flat ? model : path.join(directory, "asset_info.json");
  if (!flat) await fs.writeFile(metaPath, JSON.stringify({ assetID: "fixture", name: "SK_Test_01" }));
  const source = path.join(temp, "source.fbx");
  await fs.writeFile(source, "source-must-survive");
  const asset = { id: "fixture", source: "custom", name: "SK_Test_01", assetType: flat ? "animation" : "monster", path: directory, metaPath, modelFiles: [model], textureFiles: [] };
  t.after(async () => {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.match(path.basename(temp), /^assethive-recycle-test-/);
    await fs.rm(temp, { recursive: true, force: true });
  });
  return { temp, root, directory, model, source, asset };
}
async function remove(f, extra = {}) {
  const plan = await prepareAssetDeletion({ ...f, records: [f.asset] });
  return recycleAsset({ ...f, records: [f.asset], token: plan.token, ...extra });
}

test('bounded character recycle reads retain the same validated records and reject invalid journals', async t => {
  const f = await fixture(t);
  const result = await remove(f);
  assert.deepEqual(await listRecycledAssets(f.root, { concurrency: 8 }), await listRecycledAssets(f.root));
  const journal = path.join(result.recoveryPath, 'record.json');
  const original = JSON.parse(await fs.readFile(journal, 'utf8'));
  await fs.writeFile(journal, JSON.stringify({ ...original, assetId: 'wrong-owner' }));
  await assert.rejects(listRecycledAssets(f.root, { concurrency: 8 }), /恢复日志无效/);
});

test("parts cannot be deleted directly; owner deletion includes all its part versions, not other forms", async t => {
  const f = await fixture(t);
  await assert.rejects(prepareAssetDeletion({ ...f, asset: { ...f.asset, id: "fixture::part::weapon" } }), /部件不能单独删除/);
  await assert.rejects(prepareAssetDeletion({ ...f, asset: { ...f.asset, meta: { componentView: { parentId: f.asset.id } } } }), /部件不能单独删除/);
  const partFile = path.join(f.directory, "Parts", "weapon", "v2", "SK_Test_01_WP.fbx");
  await fs.mkdir(path.dirname(partFile), { recursive: true });
  await fs.writeFile(partFile, "updated-weapon");
  const otherFolder = path.join(f.root, "other-form");
  await fs.mkdir(otherFolder);
  const otherModel = path.join(otherFolder, "SK_Test_02.fbx");
  await fs.writeFile(otherModel, "other-form");
  const other = { ...f.asset, id: "second-form", path: otherFolder, metaPath: path.join(otherFolder, "asset_info.json"), modelFiles: [otherModel] };
  const plan = await prepareAssetDeletion({ ...f, records: [f.asset, other] });
  const result = await recycleAsset({ ...f, records: [f.asset, other], token: plan.token });
  assert.equal(await fs.stat(partFile).catch(() => null), null);
  assert.equal(await fs.readFile(otherModel, "utf8"), "other-form");
  await restoreRecycledAsset({ root: f.root, transactionId: result.transactionId });
  assert.equal(await fs.readFile(partFile, "utf8"), "updated-weapon");
});

test("preflight is read-only; recycle and restore retain contents, source and asset ID", async t => {
  const f = await fixture(t);
  const plan = await prepareAssetDeletion({ ...f, records: [f.asset] });
  assert.equal(plan.fileCount, 2);
  assert.equal(await fs.stat(path.join(f.root, ".assethive")).catch(() => null), null);
  const result = await remove(f);
  assert.equal(await fs.stat(f.directory).catch(() => null), null);
  assert.equal(await fs.readFile(f.source, "utf8"), "source-must-survive");
  const rows = await listRecycledAssets(f.root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "deleted");
  const restored = await restoreRecycledAsset({ root: f.root, transactionId: result.transactionId });
  assert.equal(restored.asset.id, f.asset.id);
  assert.equal(await fs.readFile(f.model, "utf8"), "model-contents");
  assert.deepEqual(await listRecycledAssets(f.root), []);
});

test("reject root, outside, missing, relative and wrong-ID targets", async t => {
  const f = await fixture(t);
  for (const target of [f.root, f.temp, "", "relative", path.join(f.root, "missing")]) {
    await assert.rejects(prepareAssetDeletion({ ...f, asset: { ...f.asset, path: target } }));
  }
  await assert.rejects(prepareAssetDeletion({ ...f, asset: { ...f.asset, id: "wrong" } }), /ID/);
  assert.equal(await fs.readFile(f.model, "utf8"), "model-contents");
});

test("reject directory junctions in an asset tree", async t => {
  const f = await fixture(t);
  const outside = path.join(f.temp, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.directory, "linked"), "junction");
  await assert.rejects(prepareAssetDeletion(f), /链接|联接/);
});

test("references from another asset block deletion, same-monster membership alone does not", async t => {
  const f = await fixture(t);
  const other = { ...f.asset, id: "other", name: "Other", path: path.join(f.root, "Elsewhere"), modelFiles: [f.model] };
  await assert.rejects(prepareAssetDeletion({ ...f, records: [f.asset, other] }), /引用/);
  await assert.rejects(prepareAssetDeletion({ ...f, records: [{ ...other, modelFiles: [], metaPath: "", meta: { dependencies: [f.asset.id] } }] }), /引用/);
  const sibling = { ...other, modelFiles: [], metaPath: "", meta: { character: { relatedAssetId: f.asset.id, entityKey: "same" } } };
  assert.ok((await prepareAssetDeletion({ ...f, records: [sibling] })).token);
});

test("confirmation token refuses changed files before any move", async t => {
  const f = await fixture(t);
  const plan = await prepareAssetDeletion(f);
  await fs.writeFile(f.model, "changed-model");
  await assert.rejects(recycleAsset({ ...f, token: plan.token }), /变化/);
  assert.equal(await fs.readFile(f.model, "utf8"), "changed-model");
});

test("flat animations never remove sibling clips or shared Preview directories", async t => {
  const f = await fixture(t, true);
  await fs.writeFile(f.model + ".assethive.identity.json", "identity");
  const other = path.join(f.directory, "AS_Other.fbx");
  const preview = path.join(f.directory, "Preview", "other.png");
  await fs.mkdir(path.dirname(preview));
  await fs.writeFile(other, "other");
  await fs.writeFile(preview, "preview");
  const result = await remove(f);
  assert.equal(await fs.readFile(other, "utf8"), "other");
  assert.equal(await fs.readFile(preview, "utf8"), "preview");
  assert.equal(await fs.stat(f.model).catch(() => null), null);
  await restoreRecycledAsset({ root: f.root, transactionId: result.transactionId });
  assert.equal(await fs.readFile(f.model + ".assethive.identity.json", "utf8"), "identity");
});

test("partial flat move rolls back when the second file is locked", async t => {
  const f = await fixture(t, true);
  await fs.writeFile(f.model + ".assethive.identity.json", "identity");
  let calls = 0;
  await assert.rejects(remove(f, { rename: async (...args) => {
    if (++calls === 2) throw Object.assign(new Error("locked"), { code: "EBUSY" });
    return fs.rename(...args);
  } }), /已回滚/);
  assert.equal(await fs.readFile(f.model, "utf8"), "model-contents");
  assert.deepEqual(await listRecycledAssets(f.root), []);
});

test("failed rollback leaves a visible recoverable journal", async t => {
  const f = await fixture(t, true);
  await fs.writeFile(f.model + ".assethive.identity.json", "identity");
  let calls = 0;
  await assert.rejects(remove(f, { rename: async (...args) => {
    if (++calls >= 2) throw new Error("network unavailable");
    return fs.rename(...args);
  } }), /删除中断/);
  const [entry] = await listRecycledAssets(f.root);
  assert.equal(entry.state, "recovery_required");
  await restoreRecycledAsset({ root: f.root, transactionId: entry.transactionId });
  assert.equal(await fs.readFile(f.model, "utf8"), "model-contents");
});

test("restore refuses overwrite and changed backup, leaving both intact", async t => {
  const f = await fixture(t);
  const deleted = await remove(f);
  await fs.mkdir(f.directory);
  await fs.writeFile(f.model, "new-asset");
  await assert.rejects(restoreRecycledAsset({ root: f.root, transactionId: deleted.transactionId }), /拒绝|覆盖/);
  assert.equal(await fs.readFile(f.model, "utf8"), "new-asset");
  assert.equal(await fs.readFile(path.join(deleted.recoveryPath, "files/0/SK_Test_01.fbx"), "utf8"), "model-contents");
});

test("index failure is explicit and the durable deletion remains recoverable", async t => {
  const f = await fixture(t);
  const deleted = await remove(f, { onIndexChange: async () => { throw new Error("sqlite unavailable"); } });
  assert.equal(deleted.indexPending, true);
  assert.equal((await listRecycledAssets(f.root))[0].assetId, "fixture");
  const result = await restoreRecycledAsset({ root: f.root, transactionId: deleted.transactionId, onIndexChange: async () => { throw new Error("cache unavailable"); } });
  assert.equal(result.indexPending, true);
  assert.equal(await fs.readFile(f.model, "utf8"), "model-contents");
});

test("active shared lock prevents a second delete without changing files", async t => {
  const f = await fixture(t);
  const lock = path.join(f.root, ".assethive/RecycleBin/operation.lock");
  await fs.mkdir(path.dirname(lock), { recursive: true });
  await fs.writeFile(lock, JSON.stringify({ host: os.hostname(), pid: process.pid }));
  await assert.rejects(remove(f), /锁/);
  assert.equal(await fs.readFile(f.model, "utf8"), "model-contents");
});

test("malformed and traversal recovery IDs are rejected", async t => {
  const f = await fixture(t);
  for (const transactionId of ["../outside", "", "C:/", "../../asset_info.json"]) {
    await assert.rejects(restoreRecycledAsset({ root: f.root, transactionId }), /ID/);
  }
});
