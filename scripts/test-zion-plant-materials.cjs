const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const sharp = require("sharp");
const { createAssetMetadata } = require("../electron/services/assetMetadata");
const { normalizeNativePlantWind, detectNativePlantWind } = require("../electron/services/nativePlantWind");
const { serializeFbxDocument } = require("../electron/services/fbxCompactLayers");
const { groupDroppedAssets } = require("../electron/services/dropAssetGroups");
const { resolveNativePlantGroups } = require("../electron/services/nativePlantGroups");
const { namedPlantTextureMetadata, namedMaterialCatalog, prepareNamedMaterialBatch } = require("../electron/services/zion3dMaterials");
const { buildExportAssets } = require("../electron/services/unrealExporter");

function materialFbx(slots) {
  function property(value) {
    if (typeof value === "bigint") {
      const bytes = Buffer.alloc(9);
      bytes.write("L");
      bytes.writeBigInt64LE(value, 1);
      return { code: "L", bytes };
    }
    const text = Buffer.from(value);
    const bytes = Buffer.alloc(5 + text.length);
    bytes.write("S");
    bytes.writeUInt32LE(text.length, 1);
    text.copy(bytes, 5);
    return { code: "S", bytes };
  }
  const node = (name, values = [], children = []) => ({ name, props: values.map(property), children, nullTerminated: true });
  const model = 9007199254740992n;
  const objects = [node("Model", [model, "Mesh\0\x01Model", "Mesh"])];
  const connections = [];
  for (const [index, slot] of slots.entries()) {
    const material = model + 1n + BigInt(index) * 2n;
    const texture = material + 1n;
    objects.push(node("Material", [material, slot.name + "\0\x01Material", ""]));
    objects.push(node("Texture", [texture, "Texture", ""], [node("RelativeFilename", [slot.file])]));
    if (slot.assigned !== false) connections.push(node("C", ["OO", material, model]));
    connections.push(node("C", ["OP", texture, material, slot.input || "DiffuseColor"]));
  }
  const header = Buffer.alloc(27);
  header.write("Kaydara FBX Binary  \0\x1a\0", "latin1");
  header.writeUInt32LE(7400, 23);
  return serializeFbxDocument({ header, wide: false, HS: 4, NULL_SIZE: 13, footer: Buffer.alloc(13),
    nodes: [node("Objects", [], objects), node("Connections", [], connections)] });
}

async function variantDrop(t, options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-plant-variants-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = path.join(temp, "Plant");
  const files = [];
  const jsonFiles = [];
  for (const number of [10, 2, 1]) {
    const name = `Plant_${String(number).padStart(2, "0")}`;
    const directory = path.join(root, name);
    await fs.mkdir(path.join(directory, "Textures"), { recursive: true });
    const model = path.join(directory, name + ".fbx");
    await fs.writeFile(model, `variant ${number} unchanged UV3 geometry`);
    files.push(model);
    const textures = [];
    for (const suffix of ["D", "N", "ORM"]) {
      const file = path.join(directory, "Textures", `Plant_${suffix}.png`);
      await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: number === options.differentTextureVariant ? 180 : 40, g: 128, b: 128 } } }).png().toFile(file);
      files.push(file);
      textures.push(`Textures/Plant_${suffix}.png`);
    }
    const sidecar = path.join(directory, name + "_Wind.json");
    const raw = { fbx: name + ".fbx", useRemappedUV3: true,
      scalarParameters: { "UV3 Remap Bounds Mode": 2, xMin: 1, xMax: 2, yMin: 3, yMax: 4, wMin: 5, wMax: 6, RippleFlexibility: number },
      uv3: { encoding: { version: 2, word_bits: 14 } },
      materials: [{ name: "Plant_Mat", textures, scalarParameters: { xMin: number === options.differentDecoderVariant ? 9 : 1 } }] };
    if (number === options.missingDecoderVariant) delete raw.scalarParameters.wMax;
    await fs.writeFile(sidecar, JSON.stringify(raw));
    if (number !== options.missingWindVariant) jsonFiles.push(sidecar);
    else await fs.rm(sidecar);
    if (options.lods) {
      const lod = path.join(directory, name + "_LOD1.fbx");
      await fs.copyFile(model, lod);
      files.push(lod);
    }
  }
  return { root, files, jsonFiles };
}

test("drop resolver merges sibling native variants with one texture set and variant 1 wind defaults", async (t) => {
  const { root, files, jsonFiles } = await variantDrop(t);
  const initial = groupDroppedAssets(files);
  assert.equal(initial.length, 3);
  const [merged, ...others] = await resolveNativePlantGroups(initial.reverse(), { jsonFiles });
  assert.equal(others.length, 0);
  assert.equal(merged.folderName, path.basename(root));
  assert.deepEqual(merged.metadata.modelVariants.map((model) => model.variantKey), ["01", "02", "10"]);
  assert.equal(merged.metadata.modelFiles.length, 3);
  assert.equal(merged.metadata.textureSlots.length, 3);
  assert.equal(merged.files.filter((file) => /\.png$/i.test(file)).length, 3);
  assert.equal(merged.metadata.nativePlantWind.scalarParameters.RippleFlexibility, 1);
  assert.equal(merged.metadata.nativePlantWind.scalarParameters.wMax, 6);
  assert.equal(await fs.readFile(merged.metadata.modelFiles[2], "utf8"), "variant 10 unchanged UV3 geometry");
  const asset = { id: "merged", name: merged.preferredName, path: root, source: "custom", assetType: "3dplant", zionTags: ["Zion"],
    standardAssetTags: ["Grass"], modelFiles: merged.metadata.modelFiles,
    textureFiles: merged.metadata.textureSlots.map((slot) => slot.filePath),
    meta: createAssetMetadata({ ...merged.metadata, id: "merged", name: merged.preferredName, assetType: "3dplant", zionTags: ["Zion"], standardAssetTags: ["Grass"],
      textureEntries: merged.metadata.textureSlots.map((slot) => ({ uri: path.relative(root, slot.filePath), textureType: slot.textureType, areaIndex: slot.areaId })) }) };
  const [job] = await buildExportAssets([asset], null, "2k", "decal", "lod", "none");
  assert.equal(job.modelFiles.length, 3);
  assert.deepEqual(job.modelVariants.map((model) => model.variantKey), ["01", "02", "10"]);
  assert.equal(job.materialGroups.length, 1);
  assert.equal(job.nativePlantWind.scalarParameters.RippleFlexibility, 1);
});

test("variant merging retains every variant's LOD association", async (t) => {
  const { files, jsonFiles } = await variantDrop(t, { lods: true });
  const [merged, ...others] = await resolveNativePlantGroups(groupDroppedAssets(files), { jsonFiles });
  assert.equal(others.length, 0);
  assert.equal(merged.metadata.modelFiles.length, 3);
  assert.equal(merged.metadata.modelLods.length, 6);
  for (const key of ["01", "02", "10"]) assert.deepEqual(merged.metadata.modelLods.filter((lod) => lod.variantKey === key).map((lod) => lod.lod), [0, 1]);
});

test("renamed FBX slots group variants using their explicit diffuse connections and leave source files intact", async (t) => {
  const { root, files, jsonFiles } = await variantDrop(t);
  for (const file of jsonFiles) {
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    const folder = path.dirname(file);
    const textures = raw.materials[0].textures;
    if (!file.endsWith("_01_Wind.json")) {
      raw.materials[0].name = "Material_Mat";
      for (const [i, original] of textures.entries()) {
        const renamed = original.replace("Plant_", "Material_");
        await fs.rename(path.join(folder, original), path.join(folder, renamed));
        files[files.indexOf(path.join(folder, original))] = path.join(folder, renamed);
        textures[i] = renamed;
      }
      await fs.writeFile(file, JSON.stringify(raw));
    }
    await fs.writeFile(path.join(folder, raw.fbx), materialFbx([
      { name: "Plant_Mat", file: textures[0] }, { name: "Unused_Mat", file: textures[0], assigned: false }
    ]));
  }
  const before = await Promise.all([...files, ...jsonFiles].map((file) => fs.readFile(file)));
  const [asset, ...others] = await resolveNativePlantGroups(groupDroppedAssets(files), { jsonFiles });
  assert.equal(others.length, 0);
  assert.equal(asset.preferredName, path.basename(root));
  assert.deepEqual(asset.metadata.modelVariants.map((model) => model.variantKey), ["01", "02", "10"]);
  assert.deepEqual(asset.metadata.materialNames, { 1: "Plant_Mat" });
  assert.equal(asset.metadata.textureSlots.length, 3);
  assert.equal(asset.metadata.nativePlantWind.materials[0].name, "Plant_Mat");
  assert.equal(asset.metadata.nativePlantWind.scalarParameters.RippleFlexibility, 1);
  assert.deepEqual(await Promise.all([...files, ...jsonFiles].map((file) => fs.readFile(file))), before);
});

test("wind aliases follow unique mesh bindings across slots and reject ambiguous or conflicting LOD connections", async (t) => {
  const { jsonFiles } = await variantDrop(t);
  const sidecar = jsonFiles[0];
  const raw = JSON.parse(await fs.readFile(sidecar, "utf8"));
  const model = path.join(path.dirname(sidecar), raw.fbx);
  const leaf = { name: "Leaf", file: "Textures/Leaf_D.png" };
  const stem = { name: "Stem", file: "Textures/Stem_D.png" };
  raw.materials = [
    { name: "OldStem", textures: [stem.file], scalarParameters: { Bend: 2 } },
    { name: "OldLeaf", textures: [leaf.file], scalarParameters: { Bend: 7 } }
  ];
  await fs.writeFile(sidecar, JSON.stringify(raw));
  await fs.writeFile(model, materialFbx([leaf, stem]));
  const detect = (modelFiles) => detectNativePlantWind({ files: [sidecar], modelFiles });
  const resolved = await detect([model]);
  assert.deepEqual(resolved.warnings, []);
  assert.deepEqual(resolved.profile.materials.map((row) => [row.name, row.scalarParameters.Bend]), [["Stem", 2], ["Leaf", 7]]);

  for (const slots of [
    [leaf, { ...stem, file: leaf.file }],
    [{ ...leaf, file: "Elsewhere/Leaf_D.png" }, stem],
    [{ ...leaf, input: "NormalMap" }, stem]
  ]) {
    await fs.writeFile(model, materialFbx(slots));
    const result = await detect([model]);
    assert.match(result.warnings[0], /无法与 FBX 材质槽一一对应/);
    assert.deepEqual(result.profile.materials.map((row) => row.name), ["OldStem", "OldLeaf"]);
  }
  await fs.writeFile(model, materialFbx([leaf, stem]));
  const lod = model.replace(/\.fbx$/, "_LOD1.fbx");
  await fs.writeFile(lod, materialFbx([{ ...leaf, file: "Other/Leaf_D.png" }, stem]));
  assert.match((await detect([model, lod])).warnings[0], /OldLeaf/);
});

test("different or incomplete UV3 decoders and different textures retain original draft boundaries", async (t) => {
  for (const options of [{ differentDecoderVariant: 2 }, { missingDecoderVariant: 2 }, { differentTextureVariant: 2 }]) {
    const { files, jsonFiles } = await variantDrop(t, options);
    const groups = await resolveNativePlantGroups(groupDroppedAssets(files), { jsonFiles });
    assert.equal(groups.length, 3);
  }
});

test("metadata boundaries and incomplete sidecars cannot collapse separate assets", async (t) => {
  const { root, files, jsonFiles } = await variantDrop(t, { missingWindVariant: 2 });
  const metadataGroups = [1, 2, 10].map((number) => ({ root: path.join(root, `Plant_${String(number).padStart(2, "0")}`), metadata: { name: `Official ${number}` } }));
  assert.equal((await resolveNativePlantGroups(groupDroppedAssets(files, metadataGroups), { jsonFiles, metadataGroups })).length, 3);
  const groups = await resolveNativePlantGroups(groupDroppedAssets(files), { jsonFiles });
  assert.equal(groups.flatMap((group) => group.metadata?.modelFiles || group.files.filter((file) => /\.fbx$/i.test(file))).length, 3);
  assert.ok(groups.some((group) => group.files.some((file) => /Plant_02\.fbx$/.test(file)) && !group.metadata?.nativePlantWind));
  assert.deepEqual(await resolveNativePlantGroups(groupDroppedAssets(files), { jsonFiles, shouldAbort: () => true }), []);
});

async function fixture(t, id = "plant-a", red = 80) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-zion-plant-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await fs.mkdir(path.join(root, "Textures"));
  const model = path.join(root, `${id}.fbx`);
  await fs.writeFile(model, "export plan fixture; native UE tests validate mesh slots");
  const files = [];
  const materials = [];
  for (const name of ["Leaf", "Stem"]) {
    const textures = [];
    for (const [type, suffix] of [["Diffuse", "D"], ["Normal", "N"], ["ORM", "ORM"]]) {
      const relative = `Textures/${name}_${suffix}.png`;
      const file = path.join(root, relative);
      await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: red, g: 128, b: 200 } } }).png().toFile(file);
      files.push(file);
      textures.push(relative);
      assert.ok(type);
    }
    materials.push({ name: `${name}_Mat`, textures, scalarParameters: { SharedBend: 2 } });
  }
  const wind = normalizeNativePlantWind({ useRemappedUV3: true,
    scalarParameters: { "UV3 Remap Bounds Mode": 2, xMin: 1, xMax: 2, yMin: 3, yMax: 4, wMin: 5, wMax: 6 },
    uv3: { encoding: { version: 2, word_bits: 14, mantissa_divisor: 16384, layout: "shared bounds" } }, materials });
  const named = namedPlantTextureMetadata(files, wind);
  const meta = createAssetMetadata({ id, name: id, assetType: "3dplant", category: "Grass", standardAssetTags: ["Grass"], zionTags: ["Zion"],
    nativePlantWind: wind, materialNames: named.materialNames, modelFiles: [model],
    textureEntries: named.textureSlots.map((entry) => ({ uri: path.relative(root, entry.filePath), textureType: entry.textureType, areaIndex: entry.areaId })) });
  return { root, files, wind, named, asset: { id, name: id, assetType: "3dplant", source: "custom", path: root,
    standardAssetTags: ["Grass"], zionTags: ["Zion"], modelFiles: [model], textureFiles: files, meta } };
}

test("Wind material references preserve exact _Mat identities and group textures without guessing names", async (t) => {
  const { named, files, wind, asset } = await fixture(t);
  assert.deepEqual(named.materialNames, { 1: "Leaf_Mat", 2: "Stem_Mat" });
  assert.equal(named.textureSlots.length, 6);
  assert.deepEqual(normalizeNativePlantWind(wind), wind);
  assert.deepEqual(asset.meta.nativePlantWind, wind);
  assert.throws(() => namedPlantTextureMetadata([...files, path.join("other", "Textures", path.basename(files[0]))], wind), /引用不唯一/);
});

test("Zion plants share named texture sets while retaining each owner's UV3 decoding parameters", async (t) => {
  const a = await fixture(t, "plant-a");
  const b = await fixture(t, "plant-b");
  b.asset.meta.nativePlantWind.scalarParameters.xMin = 9;
  const jobs = await buildExportAssets([a.asset, b.asset], null, "2k", "decal", "lod", "none");
  assert.ok(jobs.every((job) => job.materialMatching === "name"));
  assert.deepEqual(jobs.map((job) => job.nativePlantWind.scalarParameters.xMin), [1, 9]);
  assert.ok(jobs.every((job) => job.nativePlantWind.useRemappedUV3));
  assert.deepEqual(jobs.map((job) => job.nativePlantWind.uv3Encoding), [a.wind.uv3Encoding, b.wind.uv3Encoding]);
  assert.ok(jobs.every((job) => job.materialGroups.length === 2));
  assert.equal((await prepareNamedMaterialBatch(jobs)).size, 0);
  const catalog = namedMaterialCatalog(jobs);
  assert.equal(catalog.failures.size, 0);
  assert.equal(catalog.groups.length, 2);
  assert.equal(jobs[0].materialScope, jobs[1].materialScope);
  assert.deepEqual(jobs[0].materialGroups.map((group) => group.textureSignature), jobs[1].materialGroups.map((group) => group.textureSignature));
});

test("model-only Zion plants can borrow a named set from a later owner", async (t) => {
  const { asset } = await fixture(t);
  const borrower = { ...asset, id: "borrower", meta: { nativePlantWind: asset.meta.nativePlantWind }, textureFiles: [] };
  const jobs = await buildExportAssets([borrower, asset]);
  assert.equal(jobs[0].materialGroups.length, 0);
  const catalog = namedMaterialCatalog(jobs);
  assert.equal(catalog.groups.length, 2);
  assert.equal(jobs[0].materialScope, jobs[1].materialScope);
  const alone = namedMaterialCatalog([jobs[0]]);
  assert.equal(alone.failures.size, 0);
  assert.equal(jobs[0].materialMatching, undefined, "legacy model-only imports retain the existing parent defaults");
});

test("named Zion plant keeps Diffuse RGBA and omits its ID even with legacy third-party tags", async (t) => {
  const { asset } = await fixture(t, "library42");
  const file = asset.textureFiles.find((name) => /Leaf_D\.png$/i.test(name));
  const pixels = Buffer.from([23, 41, 59, 0, 13, 31, 53, 127, 17, 35, 47, 255]);
  await sharp(pixels, { raw: { width: 1, height: 3, channels: 4 } }).png().toFile(file);
  const [job] = await buildExportAssets([{ ...asset, name: "Env_Reed_library42", standardAssetTags: ["Grass", "ThirdParty"] }]);
  assert.equal(job.assetFolderName, "Reed");
  assert.equal(job.plantExportVersion, 2);
  const group = job.materialGroups.find((entry) => entry.materialName === "Leaf_Mat");
  assert.equal(group.opacityInDiffuseAlpha, true);
  assert.ok(!job.textureSlots.some((entry) => entry.slot === "Opacity"));
  const rgba = await fs.readFile(group.textureSlots.find((entry) => ["D", "AL"].includes(entry.slot)).file);
  assert.equal(rgba[16], 32);
  assert.equal(rgba[17], 0x28);
  assert.deepEqual([...rgba.subarray(18)], [59, 41, 23, 0, 53, 31, 13, 127, 47, 35, 17, 255]);
  assert.equal(namedMaterialCatalog([job]).groups.find((g) => g.materialName === "Leaf_Mat").opacityInDiffuseAlpha, true);
});

test("real Zion tags gate plant reuse and third-party/default plant paths remain unchanged", async (t) => {
  const { asset } = await fixture(t);
  for (const tags of [[], ["ThirdParty"]]) {
    const [job] = await buildExportAssets([{ ...asset, zionTags: [], standardAssetTags: tags,
      meta: { ...asset.meta, zionTags: [], standardAssetTags: tags } }], null, "2k", "decal", "lod", "none");
    assert.equal(job.materialMatching, undefined);
  }
});

test("different plant categories and 3D assets never share a named catalog scope", async (t) => {
  const { asset } = await fixture(t);
  const jobs = await buildExportAssets([asset,
    { ...asset, id: "bush", standardAssetTags: ["Bush"] },
    { ...asset, id: "prop", assetType: "3d", standardAssetTags: ["Props"] }], null, "2k", "decal", "lod", "none");
  const catalog = namedMaterialCatalog(jobs);
  assert.equal(catalog.groups.length, 6);
  assert.equal(new Set(jobs.map((job) => job.materialScope)).size, 3);
});

test("same named plant material with different texture bytes fails all owners before dispatch", async (t) => {
  const a = await fixture(t, "a", 20);
  const b = await fixture(t, "b", 200);
  await assert.rejects(buildExportAssets([a.asset, b.asset]), /同名材质.*不同纹理套组/);
});

test("partial or duplicated plant material names are rejected without positional fallback", async (t) => {
  const { asset } = await fixture(t);
  await assert.rejects(buildExportAssets([{ ...asset, meta: { ...asset.meta, materialNames: { 1: "Leaf_Mat" } } }]), /缺少材质名称/);
  await assert.rejects(buildExportAssets([{ ...asset, meta: { ...asset.meta, materialNames: { 1: "Leaf_Mat", 2: "Leaf_Mat" } } }]), /重名贴图组/);
});

test("shared catalog sorting preserves Billboard LOD assignments by material identity", () => {
  const asset = { id: "plant", assetType: "3dplant", standardAssetTags: ["Grass"], materialMatching: "name",
    materialGroups: [{ groupId: 1, materialName: "Z_Leaves", textureSlots: [] },
      { groupId: 2, materialName: "A_Billboard", materialRole: "billboard", textureSlots: [] }],
    modelLods: [{ lod: 2, materialGroupId: 2, materialRole: "billboard" }] };
  const catalog = namedMaterialCatalog([asset]);
  assert.equal(catalog.groups.find((group) => group.materialName === "A_Billboard").groupId, 1);
  assert.equal(asset.modelLods[0].materialGroupId, 1);
  namedMaterialCatalog([asset]);
  assert.equal(asset.modelLods[0].materialGroupId, 1, "building the catalog twice is idempotent");
  assert.equal(asset.modelLods[0].materialName, "A_Billboard");
});

test("named Nanite Masked plants retain excluded Billboard slot identities without exporting its textures", async (t) => {
  const { asset } = await fixture(t);
  asset.meta.textureEntries = asset.meta.textureEntries.map((entry) => ({ ...entry,
    materialRole: entry.areaIndex === 2 ? "billboard" : "atlas" }));
  const [job] = await buildExportAssets([asset], null, "2k", "decal", "naniteMasked", "none");
  assert.equal(job.billboardExcluded, true);
  assert.equal(job.materialMatching, "name");
  assert.deepEqual(job.excludedPlantMaterialNames, ["Stem_Mat"]);
  assert.ok(job.materialGroups.every((group) => group.materialRole !== "billboard"));
  assert.equal(job.materialGroups.length, 1);
});

test("explicit plant material names without any texture owner fail instead of silently using defaults", async (t) => {
  const { asset } = await fixture(t);
  const [job] = await buildExportAssets([{ ...asset, meta: { materialNames: { 1: "Leaf_Mat" } }, textureFiles: [] }]);
  assert.equal(job.materialMatching, "name");
  const catalog = namedMaterialCatalog([job]);
  assert.match(catalog.failures.get(asset.id), /没有可对应的命名纹理套组/);
});
