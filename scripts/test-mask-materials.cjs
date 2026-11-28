const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const sharp = require("sharp");
const { defaultMaskGroup, normalizeMaskGroups, maskParentSuffix, isMaskAsset, hasMaskFolderLayout } = require("../shared/maskMaterials.mjs");
const { normalizeStandardAssetTag } = require("../electron/services/assetTags");
const { runImageTask } = require("../electron/services/imageTasks");
const { buildMaskMaterial } = require("../electron/services/maskMaterials");
const { groupDroppedAssets } = require("../electron/services/dropAssetGroups");
const { createAssetMetadata } = require("../electron/services/assetMetadata");
const { buildExportAssets } = require("../electron/services/unrealExporter");
const { prepareNamedMaterialBatch } = require("../electron/services/zion3dMaterials");
const { AssetHiveTCPClient } = require("../electron/services/tcpClient");
const { buildDrafts, buildScope } = require("./import-draft-harness.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-mask-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
}

test("Channel mode replaces legacy MEGA tags and validates UV indices and project references", () => {
  assert.equal(normalizeStandardAssetTag("MEGA"), "");
  assert.equal(normalizeStandardAssetTag("mask"), "");
  assert.equal(isMaskAsset({ assetType: "3d", textureGroupMode: "channel", standardAssetTags: ["Kits"] }), true);
  assert.equal(isMaskAsset({ assetType: "3dplant", textureGroupMode: "channel" }), false);
  assert.equal(hasMaskFolderLayout(["D:/Kit_Wall/base/Wall_D.png"]), true);
  assert.equal(hasMaskFolderLayout(["D:/Mask_Wall/Wall_D.png"]), false);
  assert.equal(isMaskAsset({ assetType: "3d", textureGroupMode: "texture", standardAssetTags: ["MEGA"] }), false);
  const groups = normalizeMaskGroups({ 1: {} });
  assert.equal(groups[1].baseUvSet, 0);
  assert.equal(groups[1].maskUvSet, 1);
  assert.equal(groups[1].channels.R.uvSet, 1);
  assert.equal(groups[1].channels.R.metallicEnabled, false);
  assert.throws(() => normalizeMaskGroups({ 1: { baseUvSet: 1.5 } }), /UV/);
  assert.throws(() => normalizeMaskGroups({ 1: { channels: { R: { bcr: "C:/Texture.png" } } } }), /项目内/);
  assert.equal(normalizeMaskGroups({ 1: { channels: { G: { bcr: "Texture2D'/Game/Tile/T_BCR.T_BCR'" } } } })[1].channels.G.bcr, "/Game/Tile/T_BCR.T_BCR");
});

test("parent selection preserves sparse channels", () => {
  for (const [channels, suffix] of [[[], "Base"], [["R"], "R"], [["G"], "RG"], [["R", "B"], "RGB"], [["A"], "RGBA"]]) {
    assert.equal(maskParentSuffix(channels), suffix);
  }
});

test("all 3D classifications support channel mode without a Mask standard tag", async () => {
  for (const tag of ["Kits", "Props", "Destructible", "Dressing", "ThirdParty"]) {
    const root = path.join(os.tmpdir(), `${tag}_Wall`);
    const files = ["SM_Wall.fbx", "base/Wall_D.png", "mask/Wall_Mask.png"].map(file => path.join(root, file));
    const resolvedAssets = groupDroppedAssets(files);
    const { drafts } = await buildDrafts(files, { resolvedAssets });
    assert.equal(drafts[0].form.textureGroupMode, "channel", tag);
    assert(!/\b(?:Mask|MEGA)\b/i.test(drafts[0].form.tagsText));
    const scope = buildScope([]);
    const form = { ...drafts[0].form, textureGroupMode: "texture" };
    assert.equal(scope.buildImportPayload(form).textureGroupMode, "texture");
  }
});

test("pixel analysis detects any nonzero value, black alpha and absent alpha", async t => {
  const root = await fixture(t);
  for (const [name, channels, pixels, expected] of [
    ["black", 4, [0, 0, 0, 0], []],
    ["sparse", 4, [0, 1, 0, 0], ["G"]],
    ["alpha", 4, [0, 0, 0, 1], ["A"]],
    ["rgb", 3, [1, 0, 0], ["R"]]
  ]) {
    const file = path.join(root, name + ".png");
    await sharp(Buffer.from(pixels), { raw: { width: 1, height: 1, channels } }).png().toFile(file);
    assert.deepEqual((await runImageTask("detectMaskChannels", [file])).channels, expected);
  }
});

test("24-bit TGA synthetic alpha is excluded from Mask channel detection", async t => {
  const root = await fixture(t);
  const header = Buffer.alloc(18);
  header[2] = 2; header[12] = 1; header[14] = 1; header[16] = 24; header[17] = 32;
  const file = path.join(root, "mask.tga");
  await fs.writeFile(file, Buffer.concat([header, Buffer.from([0, 255, 0])]));
  assert.deepEqual((await runImageTask("detectMaskChannels", [file])).channels, ["G"]);
});

test("base and mask folders form one asset and UV2AO keeps its own slot", () => {
  const root = path.join(os.tmpdir(), "Kit_Wall");
  const files = ["SM_Env_Mask_Wall.fbx", "base/Wall_D.png", "base/Wall_N.png", "base/Wall_ORM.png", "base/Wall_uv2ao.png", "mask/Wall_Mask.png"].map(file => path.join(root, file));
  const groups = groupDroppedAssets(files);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].metadata.textureGroupMode, "channel");
  assert.deepEqual(groups[0].metadata.materialNames, { 1: "Wall" });
  assert.deepEqual(groups[0].metadata.textureSlots.map(slot => slot.textureType).sort(), ["Diffuse", "Mask", "Normal", "ORM", "UV2AO"].sort());
  const fromMetadata = mode => groupDroppedAssets(files, [{ root, metadata: { assetType: "3d", textureGroupMode: mode } }])[0];
  assert.equal(fromMetadata(undefined).metadata.textureGroupMode, "channel");
  assert.equal(fromMetadata("texture").metadata.textureGroupMode, "texture");
});

test("Mask configuration survives metadata normalization and export with material-name matching", async t => {
  const root = await fixture(t);
  const model = path.join(root, "SM_Env_Mask_Wall.fbx");
  await fs.writeFile(model, "export-plan-only FBX fixture");
  const entries = [];
  for (const [textureType, rgba] of [["Diffuse", [160, 80, 20, 255]], ["Normal", [128, 128, 255, 255]], ["ORM", [255, 128, 0, 255]], ["Mask", [0, 255, 0, 0]], ["UV2AO", [200, 200, 200, 255]]]) {
    const file = path.join(root, `Wall_${textureType}.png`);
    await sharp(Buffer.from(rgba), { raw: { width: 1, height: 1, channels: 4 } }).png().toFile(file);
    entries.push({ textureType, areaIndex: 1, uri: path.basename(file) });
  }
  const config = defaultMaskGroup();
  config.baseUvSet = 2;
  config.channels.G = { uvSet: 2, bcr: "/Game/Tiling/T_Wall_BCR", normal: "/Game/Tiling/T_Wall_N", metallicEnabled: true, metallic: "/Game/Tiling/T_Wall_M" };
  const meta = createAssetMetadata({ id: "mask-wall", name: "Wall", assetType: "3d", standardAssetTags: ["Kits"], textureGroupMode: "channel", zionTags: ["Zion"], materialNames: { 1: "Wall" }, modelFiles: [model], textureEntries: entries, maskGroups: { 1: config } });
  const asset = { id: "mask-wall", name: "Wall", assetType: "3d", source: "custom", path: root, meta, standardAssetTags: ["Kits"], textureGroupMode: "channel", zionTags: ["Zion"], modelFiles: [model], textureFiles: entries.map(entry => path.join(root, entry.uri)) };
  const [job] = await buildExportAssets([asset]);
  assert.equal(job.materialMatching, "name");
  assert.equal(job.materialGroups.length, 1);
  assert.equal(job.materialGroups[0].materialName, "Wall");
  const result = job.materialGroups[0].maskMaterial;
  assert.equal(job.textureGroupMode, "channel");
  assert.equal(result.parentSuffix, "RG");
  assert.deepEqual(result.activeChannels, ["G"]);
  assert.equal(result.baseUvSet, 2);
  assert.equal(result.maskUvSet, 1);
  assert.equal(result.fullUv2Ao, true);
  assert.deepEqual(result.channels.G, config.channels.G);
  assert(job.textureSlots.some(slot => slot.slot === "UV2AO"));
  const other = globalThis.structuredClone(job);
  other.id = "other";
  other.materialGroups[0].maskMaterial.channels.G.uvSet = 0;
  assert.equal((await prepareNamedMaterialBatch([job, other])).size, 2);
});

test("base-only group and disabled Metallic produce explicit reset state", async () => {
  const config = defaultMaskGroup();
  config.channels.R.metallic = "/Game/Tiling/T_M";
  const result = await buildMaskMaterial({ bySlot: new Map() }, config);
  assert.equal(result.parentSuffix, "Base");
  assert.equal(result.fullUv2Ao, false);
  assert.deepEqual(result.channels, {});
});

test("an older plugin is rejected before dispatching a Mask import", async () => {
  const client = new AssetHiveTCPClient();
  client.getEditorInfo = async () => ({ capabilities: ["zion3dMaterialNames", "selectiveOverwrite"] });
  await assert.rejects(client.importAssets({ assets: [{ materialGroups: [{ maskMaterial: {} }] }] }), /不支持 Mask/);
});
