const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const sharp = require("sharp");
const { materialKey, textureMaterial, namedTextureMetadata, namedMaterialCatalog, normalizeMaterialNames, prepareNamedMaterialBatch } = require("../electron/services/zion3dMaterials");
const { groupDroppedAssets } = require("../electron/services/dropAssetGroups");
const { createAssetMetadata, writeAssetMetadata } = require("../electron/services/assetMetadata");
const { scanLibrary } = require("../electron/services/assetScanner");
const { buildExportAssets, collectTextureGroupsForExport } = require("../electron/services/unrealExporter");

test("Zion material identity removes only type prefixes and a terminal resolution", () => {
  for (const name of ["Rope_01", "MI_Rope_01", "M_Rope_01_4K", "T_Rope_01_2k"]) assert.equal(materialKey(name), "rope_01");
  for (const name of ["Rope_02", "Rope_01A", "Rope_01_4K1", "Rope_01_4K_gaotai"]) assert.notEqual(materialKey(name), "rope_01");
  assert.notEqual(materialKey("MI_Env_Kit_Wuding_01"), materialKey("M_Env_Wuding_01"));
  assert.equal(textureMaterial("T_Env_Kit_Wuding_01_4k_ORM.tga").key, "env_kit_wuding_01");
  assert.equal(textureMaterial("Rope_01_Normal_2K.png").key, "rope_01");
  assert.equal(textureMaterial("Rope_01_thumb.png"), null);
  assert.throws(() => normalizeMaterialNames({ 1: "Rope/01" }), /材质名称无效/);
});

test("modular Mesh and Tex directories retain all model families and distinct named sets", () => {
  const root = path.join(os.tmpdir(), "Kit_Bridge");
  const files = ["Mesh/AssetA.fbx", "Mesh/AssetB.fbx", "Tex/Rope_01_D.png", "Tex/Rope_01_N.png",
    "Tex/Rope_02_D.png", "Tex/Wood_01_D.png", "Thumb_Bridge_thumb.png"].map((file) => path.join(root, file));
  const assets = groupDroppedAssets(files);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].metadata.assetType, "3d");
  assert.deepEqual(assets[0].metadata.materialNames, { 1: "Rope_01", 2: "Rope_02", 3: "Wood_01" });
  assert.equal(assets[0].metadata.textureSlots.length, 4);
  assert.equal(assets[0].files.filter((file) => file.endsWith(".fbx")).length, 2);
});

test("explicit third-party metadata keeps its own import boundary and rules", () => {
  const root = path.join(os.tmpdir(), "Kit_ThirdParty");
  const metadata = { name: "Supplier", standardAssetTags: ["ThirdParty"], tags: ["Megascans"], assetType: "3d" };
  const files = [path.join(root, "SM_Env_Kit_A.fbx"), path.join(root, "Tex/T_Env_Kit_Wood_01_D.png")];
  const [group] = groupDroppedAssets(files, [{ root, metadata }]);
  assert.deepEqual(group.metadata, metadata);
});

test("a Zion kit keeps legacy mesh names in the same material package", () => {
  const root = path.join(os.tmpdir(), "woodbridge");
  const files = ["Mesh/SM_Env_Kit_diaoqiao_01.fbx", "Mesh/SM_Env_muban_01.fbx",
    "Mesh/SM_SM_Env_Kit_extra_01.fbx", "Tex/T_Env_Kit_woodbridge_01_D.png"].map((file) => path.join(root, file));
  const [asset, ...others] = groupDroppedAssets(files);
  assert.equal(others.length, 0);
  assert.equal(asset.files.filter((file) => file.endsWith(".fbx")).length, 3);
  assert.deepEqual(asset.metadata.materialNames, { 1: "Env_Kit_woodbridge_01" });
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-zion-materials-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const model = path.join(root, "AssetA.fbx");
  await fs.writeFile(model, "export-plan fixture; UE integration uses authored FBX separately");
  const entries = [];
  for (const [areaIndex, name, red] of [[1, "Rope_01", 40], [2, "Rope_02", 100], [3, "Wood_01", 200]]) {
    for (const [textureType, suffix] of [["Diffuse", "D"], ["Normal", "N"], ["ORM", "ORM"]]) {
      const file = path.join(root, `${name}_4K_${suffix}.png`);
      await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: red, g: 128, b: 255 } } }).png().toFile(file);
      entries.push({ textureType, areaIndex, uri: path.basename(file) });
    }
  }
  const meta = createAssetMetadata({ id: "module-a", name: "BridgeA", assetType: "3d", standardAssetTags: ["Kits"],
    materialNames: { 1: "Rope_01", 2: "Rope_02", 3: "Wood_01" }, modelFiles: [model], textureEntries: entries });
  const asset = { id: "module-a", name: "BridgeA", assetType: "3d", source: "custom", path: root,
    standardAssetTags: ["Kits"], meta, modelFiles: [model], textureFiles: entries.map((entry) => path.join(root, entry.uri)) };
  return { root, asset, meta };
}

test("named material groups never borrow same-slot resolution candidates from another material", async (t) => {
  const { asset, meta } = await fixture(t);
  const groups = collectTextureGroupsForExport(asset, "3d", meta);
  assert.equal(groups.length, 3);
  for (const group of groups) {
    assert.equal(group.bySlot.size, 3);
    assert.ok([...group.bySlot.values()].every((file) => path.basename(file).startsWith(group.materialName + "_")));
  }
});

test("material names survive canonical write, scan, and metadata rewrite", async (t) => {
  const { root, meta } = await fixture(t);
  await writeAssetMetadata(path.join(root, "asset_info.json"), meta);
  const scanned = await scanLibrary(root);
  assert.equal(scanned.length, 1);
  assert.deepEqual(scanned[0].meta.materialNames, meta.materialNames);
  const updated = createAssetMetadata({ ...scanned[0].meta, name: "Renamed" });
  assert.deepEqual(updated.materialNames, meta.materialNames);
});

test("export contains named MI groups and content signatures while keeping the Kits classification", async (t) => {
  const { asset } = await fixture(t);
  const [job] = await buildExportAssets([asset]);
  assert.equal(job.materialMatching, "name");
  assert.equal(job.categoryFolder, "");
  assert.deepEqual(job.standardAssetTags, ["Kits"]);
  assert.deepEqual(job.materialGroups.map((group) => group.materialName), ["Rope_01", "Rope_02", "Wood_01"]);
  for (const group of job.materialGroups) assert.match(group.textureSignature, /^[a-f0-9]{64}$/);
  assert.equal(job.materialGroups[0].textureSlots.find((slot) => slot.slot === "Albedo").objectName, "T_Rope_01_D");
});

test("Zion named material jobs retain category tags and subfolders across all 3D categories", async (t) => {
  const { asset } = await fixture(t);
  for (const tag of ["Kit", "Kits", "Destructible", "Props", "Dressing", "MEGA"]) {
    const [job] = await buildExportAssets([{
      ...asset, standardAssetTags: [tag], zionTags: ["Zion"], zionExportSubfolder: "Wall/wudingzujian"
    }]);
    assert.equal(job.categoryFolder, "", `${tag}: 分类目录交给插件推导`);
    assert.deepEqual(job.standardAssetTags, [tag]);
    assert.equal(job.zionSubfolder, "Wall/wudingzujian");
    assert.equal(job.materialMatching, "name");
  }
});

test("named color textures retain the source Diffuse, Albedo and Basecolor abbreviations", async (t) => {
  const { asset } = await fixture(t);
  const textureEntries = asset.meta.textureEntries.map((entry) => entry.textureType === "Diffuse"
    ? { ...entry, textureType: ["Diffuse", "Albedo", "Basecolor"][entry.areaIndex - 1] } : entry);
  const [job] = await buildExportAssets([{ ...asset, meta: { ...asset.meta, textureEntries } }]);
  assert.deepEqual(job.materialGroups.map((group) => group.textureSlots.find((slot) => slot.slot === "Albedo").objectName),
    ["T_Rope_01_D", "T_Rope_02_AL", "T_Wood_01_BC"]);
});

test("a batch reuses named textures after library copies have been renamed", async (t) => {
  const { asset, root } = await fixture(t);
  const [jobA] = await buildExportAssets([asset]);
  const copied = [];
  for (const entry of asset.meta.textureEntries) {
    const file = path.join(root, `library-copy-${copied.length}.png`);
    await fs.copyFile(path.join(root, entry.uri), file);
    copied.push({ ...entry, uri: path.basename(file) });
  }
  const [jobB] = await buildExportAssets([{ ...asset, id: "module-b", name: "BridgeB",
    textureFiles: copied.map((entry) => path.join(root, entry.uri)), meta: { ...asset.meta, textureEntries: copied } }]);
  assert.equal((await prepareNamedMaterialBatch([jobA, jobB])).size, 0);
  assert.deepEqual(jobA.materialGroups.map((group) => group.textureSignature), jobB.materialGroups.map((group) => group.textureSignature));
});

test("the batch catalog lets a texture-less model precede its texture owner", async (t) => {
  const { asset } = await fixture(t);
  const jobs = await buildExportAssets([{ ...asset, id: "borrower", standardAssetTags: [" KITS "], meta: {}, textureFiles: [] }, asset]);
  assert.equal(jobs[0].materialMatching, "name");
  assert.equal(jobs[0].materialGroups.length, 0);
  const catalog = namedMaterialCatalog(jobs);
  assert.equal(catalog.groups.length, 3);
  assert.equal(catalog.failures.size, 0);
  assert.equal(jobs[0].materialScope, jobs[1].materialScope);
  assert.ok(catalog.groups.every((group) => group.scope === jobs[0].materialScope && group.textureSlots.length === 3));
  const empty = namedMaterialCatalog([jobs[0]]);
  assert.match(empty.failures.get("borrower"), /没有可对应/);
});

test("same named material with conflicting texture sets fails every conflicting batch owner", async (t) => {
  const { root } = await fixture(t);
  const slotA = { slot: "Diffuse", file: path.join(root, "Rope_01_4K_D.png") };
  const slotB = { slot: "Diffuse", file: path.join(root, "Wood_01_4K_D.png") };
  const make = (id, slot) => ({ id, materialMatching: "name", standardAssetTags: ["Kits"], materialGroups: [{ materialName: "Rope_01", textureSlots: [slot] }] });
  const failures = await prepareNamedMaterialBatch([make("a", slotA), make("b", slotB), make("c", slotA)]);
  assert.deepEqual([...failures.keys()].sort(), ["a", "b", "c"]);
});

test("incomplete named groups fail instead of falling back to group order", async (t) => {
  const { asset } = await fixture(t);
  await assert.rejects(buildExportAssets([{ ...asset, meta: { ...asset.meta, materialNames: { 1: "Rope_01" } } }]), /缺少材质名称/);
});

test("blank material names use default matching for existing and newly imported Zion assets", async (t) => {
  const { asset } = await fixture(t);
  for (const materialNames of [undefined, {}, { 1: "", 2: "  ", 3: "\t" }]) {
    const [job] = await buildExportAssets([{ ...asset, standardAssetTags: ["Dressing"],
      meta: { ...asset.meta, materialNames } }]);
    assert.equal(job.materialMatching, undefined);
    assert.equal(job.materialGroups.length, 3);
    assert.ok(job.materialGroups.every((group) => !group.materialName && group.textureSlots.length > 0));
    assert.equal(namedMaterialCatalog([job]).failures.size, 0);
  }
});

test("duplicate named groups are rejected", async (t) => {
  const { asset } = await fixture(t);
  await assert.rejects(buildExportAssets([{ ...asset, meta: { ...asset.meta,
    materialNames: { 1: "Rope_01", 2: "MI_Rope_01_4K", 3: "Wood_01" } } }]), /重名贴图组/);
});
