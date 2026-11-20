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
  const progress = [];
  const result = await remove({ ...f, token: plan.token, confirmPermanent: true, onProgress: value => progress.push(value), onIndexChange: async () => { changed = true; } });
  assert.equal(progress[0], 0); assert.equal(progress.at(-1), 100);
  assert.deepEqual(progress, [...progress].sort((a,b) => a-b));
  assert.ok(progress.some(value => value > 15 && value < 95));
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

test('deletion confirmation works during scanning; confirmed deletion waits and always releases its lock', async () => {
  const vm=require('node:vm');
  const source=await fs.readFile(path.resolve(__dirname,'../electron/main.js'),'utf8');
  const get=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
  const asset={id:'target',source:'custom',assetType:'suit'};
  let prepared=0, attempts=0, ticks=0;
  const context={index:[asset],settings:{customLibraryPath:'C:/library'},scanInProgress:true,recycleInProgress:false,
    hasActiveBackgroundImport:()=>false,activeExportCalls:0,foliageOpaqueRegenInFlight:new Set(),
    preparePermanentCharacterDeletion:async()=>{prepared++;return {token:'confirmed'}},Date,
    normalizeComparePath:v=>v,emitCustomSaveProgress:()=>{},
    getPersistentCacheRoot:()=>'',deletingCharacterCachePaths:new Set(),
    require:()=>({prepareCharacterCacheCleanup:async()=>{assert.equal(context.scanInProgress,false);attempts++;throw Error('stop before mutation');}}),
    setTimeout:resolve=>{ticks++; assert.equal(context.recycleInProgress,true);context.scanInProgress=false;globalThis.queueMicrotask(resolve);}
  };
  vm.createContext(context);
  vm.runInContext(get('async function waitForCharacterDeletion','async function waitForCharacterOperation')+
    get('async function previewCustomAssetDeletion','async function rewriteCustomJsonFiles'),context);
  assert.equal((await context.previewCustomAssetDeletion({assetId:'target'})).plan.token,'confirmed');
  assert.equal(prepared,1);assert.equal(context.scanInProgress,true);
  await assert.rejects(context.deleteCustomAsset({assetId:'target',token:'confirmed'}),/stop before mutation/);
  assert.equal(attempts,1);assert.equal(ticks,1);assert.equal(context.recycleInProgress,false);
  context.recycleInProgress=true;
  await assert.rejects(context.previewCustomAssetDeletion({assetId:'target'}),/正在删除/);
  context.recycleInProgress=false;context.scanInProgress=true;
  let now=0; context.Date={now:()=>now};context.setTimeout=resolve=>{now+=120001;globalThis.queueMicrotask(resolve);};
  await assert.rejects(context.deleteCustomAsset({assetId:'target',token:'confirmed'}),/本次未删除任何文件/);
  assert.equal(attempts,1);assert.equal(context.recycleInProgress,false);
});
