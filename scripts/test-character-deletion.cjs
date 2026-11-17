const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { preparePermanentCharacterDeletion: preview, deleteCharacterPermanently: remove, listPermanentlyDeletedAssets } = require("../electron/services/characterDeletion");

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-permanent-delete-"));
  const root = path.join(temp, "AssetHive");
  const folder = path.join(root, "Character/Monster/test");
  await fs.mkdir(path.join(folder, "Parts/weapon/v2"), { recursive: true });
  const metaPath = path.join(folder, "asset_info.json");
  await fs.writeFile(metaPath, JSON.stringify({ assetID: "test" }));
  await fs.writeFile(path.join(folder, "body.fbx"), "body");
  await fs.writeFile(path.join(folder, "Parts/weapon/v2/weapon.fbx"), "weapon");
  const backup = path.join(temp, "source.fbx");
  await fs.writeFile(backup, "backup");
  const ue = path.join(temp, "Game.uasset");
  await fs.writeFile(ue, "ue");
  const sibling = path.join(root, "other-form.fbx");
  await fs.writeFile(sibling, "other");
  const asset = { id: "test", source: "custom", assetType: "monster", path: folder, metaPath, modelFiles: [path.join(folder, "body.fbx")], meta: { sourcePath: backup } };
  t.after(async () => {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.match(path.basename(temp), /^assethive-permanent-delete-/);
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return { root, asset, backup, ue, sibling, temp };
}

test("permanent delete removes only owned library files, including old parts; no recovery copy", async t => {
  const f = await fixture(t), plan = await preview(f);
  assert.equal(plan.permanent, true);
  assert.equal(plan.fileCount, 3);
  let changed = false;
  const result = await remove({ ...f, token: plan.token, confirmPermanent: true, onIndexChange: async () => { changed = true; } });
  assert.equal(result.ok, true); assert.equal(changed, true);
  assert.equal(await fs.stat(f.asset.path).catch(() => null), null);
  assert.equal(await fs.readFile(f.backup, "utf8"), "backup");
  assert.equal(await fs.readFile(f.ue, "utf8"), "ue");
  assert.equal(await fs.readFile(f.sibling, "utf8"), "other");
  assert.equal((await listPermanentlyDeletedAssets(f.root))[0].assetId, f.asset.id);
  assert.deepEqual(await fs.readdir(path.join(f.root, ".assethive/RecycleBin")), []);
});

for (const family of ['suit', 'npc', 'weapon']) {
  test(`${family} deletion shares cleanup boundaries and never touches source or UE`, async t => {
    const f = await fixture(t);
    f.asset.assetType = family;
    const plan = await preview(f);
    await remove({ ...f, token: plan.token, confirmPermanent: true });
    assert.equal(await fs.stat(f.asset.path).catch(() => null), null);
    assert.equal(await fs.readFile(f.backup, 'utf8'), 'backup');
    assert.equal(await fs.readFile(f.ue, 'utf8'), 'ue');
    assert.equal(await fs.readFile(f.sibling, 'utf8'), 'other');
  });
}

test("permanent deletion requires explicit confirmation and unchanged preflight", async t => {
  const f = await fixture(t), plan = await preview(f);
  await assert.rejects(remove({ ...f, token: plan.token }), /确认/);
  await fs.writeFile(path.join(f.asset.path, "new.txt"), "new");
  await assert.rejects(remove({ ...f, token: plan.token, confirmPermanent: true }), /范围变化/);
  assert.equal(await fs.readFile(f.asset.metaPath, "utf8"), '{"assetID":"test"}');
});

test("reject part, root, outside, links, wrong ID and another asset's dependency", async t => {
  const f = await fixture(t);
  for (const asset of [{ ...f.asset, id: "test::part::weapon" }, { ...f.asset, path: f.root }, { ...f.asset, path: f.temp }, { ...f.asset, id: "wrong" }]) await assert.rejects(preview({ ...f, asset }));
  await assert.rejects(preview({ ...f, records: [{ id: "other", path: f.root, meta: { dependencies: [f.asset.id] } }] }), /引用/);
  await fs.symlink(f.temp, path.join(f.asset.path, "outside-link"), "junction");
  await assert.rejects(preview(f), /链接|联接/);
});

test("partial failure remains explicit and keeps metadata for a fresh deletion attempt", async t => {
  const f = await fixture(t), plan = await preview(f);
  let calls = 0;
  const result = await remove({ ...f, token: plan.token, confirmPermanent: true, unlink: async file => {
    if (++calls > 1) throw Object.assign(new Error("simulated lock"), { code: "EIO" });
    return fs.unlink(file);
  } });
  assert.equal(result.ok, false); assert.equal(result.partial, true);
  assert.match(result.message, /未完成/);
  assert.ok(await fs.stat(f.asset.metaPath));
  assert.equal((await listPermanentlyDeletedAssets(f.root)).length, 0);
  const fresh = await preview(f);
  assert.equal((await remove({ ...f, token: fresh.token, confirmPermanent: true })).ok, true);
});

test("index failure cannot resurrect permanently deleted files", async t => {
  const f = await fixture(t), plan = await preview(f);
  const result = await remove({ ...f, token: plan.token, confirmPermanent: true, onIndexChange: async () => { throw new Error("offline index"); } });
  assert.equal(result.ok, true); assert.equal(result.indexPending, true);
  assert.equal((await listPermanentlyDeletedAssets(f.root)).length, 1);
});
