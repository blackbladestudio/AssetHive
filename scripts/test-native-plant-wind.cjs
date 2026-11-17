const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { setTimeout, clearTimeout, setInterval, clearInterval } = require("node:timers");
const { test } = require("node:test");
const { normalizeNativePlantWind, detectNativePlantWind } = require("../electron/services/nativePlantWind");
const { createAssetMetadata, writeAssetMetadata } = require("../electron/services/assetMetadata");
const { groupDroppedAssets } = require("../electron/services/dropAssetGroups");
const { getAssetDetailsByMetaPath, scanLibrary } = require("../electron/services/assetScanner");
const { buildExportAssets } = require("../electron/services/unrealExporter");
const { buildDrafts } = require("./import-draft-harness.cjs");

const windJson = () => ({
  schema_version: 4, mode: "speedtree_game_wind_fbx", fbx: "Conifer.fbx",
  material_scalar_parameters: { SharedBend: 35.82697677612305, Branch1Bend: 17.5, RippleFlexibility: 0 },
  material_static_switches: { SharedEnable: true, RippleEnable: false },
  branch2_remap: { applied: true, weighted_vertex_count: 20990 },
  uv3: { status: "remapped_branch2", material_scalar_parameters: { "UV3 Remap Bounds Mode": 1, xMin: 0.0546875, xMax: 0.92578125 },
    material_static_switches: { "Use Remapped UV3": true, Branch2Enable: true, HasBranch2Data_Internal: true } },
  materials: [{ name: "Conifer_Mat", ue_material_parameters: {
    scalar_parameters: { Branch1Bend: 8 }, static_switch_parameters: { RippleEnable: true }
  } }]
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-native-wind-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const model = path.join(directory, "Conifer.fbx");
  const sidecar = path.join(directory, "Conifer_Wind.json");
  await fs.writeFile(model, "test-fbx");
  await fs.writeFile(sidecar, JSON.stringify(windJson()));
  return { directory, model, sidecar };
}

test("native wind reads exact named values, material overrides and UV3 state without converting ranges", () => {
  const normalized = normalizeNativePlantWind(windJson(), "Conifer_Wind.json");
  assert.equal(normalized.scalarParameters.SharedBend, 35.82697677612305);
  assert.equal(normalized.scalarParameters.RippleFlexibility, 0);
  assert.equal(normalized.scalarParameters.xMax, 0.92578125);
  assert.equal(normalized.staticSwitchParameters.RippleEnable, false);
  assert.equal(normalized.useRemappedUV3, true);
  for (const name of ["Use Remapped UV3", "Branch2Enable", "HasBranch2Data_Internal"]) assert.equal(normalized.staticSwitchParameters[name], true);
  assert.equal(normalized.materials[0].scalarParameters.Branch1Bend, 8);
  assert.deepEqual(normalizeNativePlantWind(normalized), normalized, "canonical metadata survives normalization");
  const disabled = normalizeNativePlantWind({ ...windJson(), branch2_remap: { applied: false } });
  assert.equal(disabled.useRemappedUV3, false, "explicit disabled remap wins over stale switches");
  assert.equal(disabled.staticSwitchParameters.Branch2Enable, false);
  assert.equal(normalizeNativePlantWind({ material_scalar_parameters: { bad: "2", infinity: Infinity, overflow: 1e100 } }), null);
});

test("drop groups keep Wind JSON with its model and drafts detect native FBX plants", async (t) => {
  const { directory, model, sidecar } = await fixture(t);
  const groups = groupDroppedAssets([model, sidecar]);
  assert.equal(groups.length, 1);
  const detected = await detectNativePlantWind({ files: groups[0].files, modelFiles: [model] });
  assert.equal(detected.profile.sourceFile, "Conifer_Wind.json");
  const { drafts } = await buildDrafts([model, sidecar], { folderName: path.basename(directory), metadata: { nativePlantWind: detected.profile } });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].form.assetType, "3dplant");
  assert.deepEqual(drafts[0].form.nativePlantWind, detected.profile);
});

test("multiple material wind records keep separate names, zero/false values and UV3 switches through export", async (t) => {
  const { directory, model } = await fixture(t);
  const raw = windJson();
  raw.uv3.material_scalar_parameters["UV3 Remap Bounds Mode"] = 2;
  raw.materials = [
    { name: "Oak_TrunkBranchTilingPOM", ue_material_parameters: {
      scalar_parameters: { SharedBend: 1.25, Branch1Bend: 0 },
      static_switch_parameters: { "Use Remapped UV3": false, Branch2Enable: false }
    } },
    { name: "Oak.Leaf", ue_material_parameters: { scalar_parameters: { SharedBend: 77, "UV3 Remap Bounds Mode": 2 },
      static_switch_parameters: { "Use Remapped UV3": true } } },
    { name: "Oak_Leaf", ue_material_parameters: { scalar_parameters: { SharedBend: 88 },
      static_switch_parameters: { "Use Remapped UV3": false } } }
  ];
  const profile = normalizeNativePlantWind(raw, "Oak_Wind.json");
  const asset = { id: "oak-wind", name: "Oak", source: "custom", assetType: "3dplant", path: directory,
    modelFiles: [model], zionTags: ["Zion"], standardAssetTags: ["Tree"], meta: { nativePlantWind: profile } };
  for (const tag of ["Tree", "HeroFoliage"]) {
    const [job] = await buildExportAssets([{ ...asset, standardAssetTags: [tag] }]);
    assert.deepEqual(job.nativePlantWind.materials, profile.materials);
    assert.equal(job.nativePlantWind.materials[0].scalarParameters.Branch1Bend, 0);
    assert.equal(job.nativePlantWind.materials[0].staticSwitchParameters["Use Remapped UV3"], false);
    assert.equal(job.nativePlantWind.scalarParameters["UV3 Remap Bounds Mode"], 2);
    assert.equal(job.nativePlantWind.materials[1].scalarParameters["UV3 Remap Bounds Mode"], 2);
    assert.equal(job.nativePlantWind.materials[1].scalarParameters.SharedBend, 77);
    assert.equal(job.nativePlantWind.materials[2].scalarParameters.SharedBend, 88);
    assert.deepEqual(job.standardAssetTags, [tag]);
  }
});

test("sidecar discovery supports model-only drops, BOM and case while rejecting ambiguity or wrong ownership", async (t) => {
  const { directory, model, sidecar } = await fixture(t);
  await fs.rename(sidecar, path.join(directory, "Conifer_wIND.JSON"));
  await fs.writeFile(path.join(directory, "Conifer_wIND.JSON"), "\uFEFF" + JSON.stringify(windJson()));
  assert.equal((await detectNativePlantWind({ modelFiles: [model] })).profile.useRemappedUV3, true);
  assert.equal((await detectNativePlantWind({ modelFiles: [path.join(directory, "Conifer.st9")] })).profile, null,
    "a converted FBX sidecar must not enable remapped UV3 on the original ST9");
  const oak = path.join(directory, "Oak.fbx");
  await fs.writeFile(oak, "test-oak");
  assert.equal((await detectNativePlantWind({ modelFiles: [oak] })).profile, null);
  await fs.writeFile(path.join(directory, "Oak_Wind.json"), JSON.stringify({ ...windJson(), fbx: "Oak.fbx" }));
  assert.match((await detectNativePlantWind({ modelFiles: [model, oak] })).warnings[0], /多份/);
  await fs.writeFile(path.join(directory, "Conifer_wIND.JSON"), "{broken");
  assert.match((await detectNativePlantWind({ modelFiles: [model] })).warnings[0], /读取失败/);
  await fs.rm(path.join(directory, "Conifer_wIND.JSON"));
  const config = path.join(directory, "Config");
  await fs.mkdir(config);
  const nested = path.join(config, "Conifer_Wind.json");
  await fs.writeFile(nested, JSON.stringify(windJson()));
  assert.equal((await detectNativePlantWind({ modelFiles: [model], files: [nested] })).profile.sourceFile, "Conifer_Wind.json");
});

test("native wind persists through metadata, library scan and export after the source folder is gone", async (t) => {
  const { directory, model, sidecar } = await fixture(t);
  const library = path.join(directory, "Library");
  await fs.mkdir(library);
  const storedModel = path.join(library, "SM_Conifer_id_01.fbx");
  await fs.copyFile(model, storedModel);
  const profile = (await detectNativePlantWind({ modelFiles: [model] })).profile;
  const meta = createAssetMetadata({ id: "conifer-wind", name: "Conifer", assetType: "3dplant", standardAssetTags: ["Bush"], zionTags: ["Zion"],
    modelFiles: [storedModel], modelSlots: { Mesh: storedModel }, nativePlantWind: profile });
  const { metaPath } = await writeAssetMetadata(library, meta);
  await fs.rm(sidecar);
  await fs.rm(model);
  const details = await getAssetDetailsByMetaPath(metaPath, "custom");
  assert.equal(details.meta.nativePlantWind.scalarParameters.SharedBend, profile.scalarParameters.SharedBend);
  const records = await scanLibrary(library);
  assert.equal(records[0].meta.nativePlantWind.useRemappedUV3, true);
  const [job] = await buildExportAssets(records, null, "4k", "decal", "opaque", "bush");
  assert.deepEqual(job.nativePlantWind, profile);
  assert.equal(job.plantSyntheticWind, undefined, "native wind prevents synthetic UV rewriting");
  const [thirdParty] = await buildExportAssets([{ ...records[0], zionTags: [], standardAssetTags: ["ThirdParty"],
    meta: { ...records[0].meta, zionTags: [], standardAssetTags: ["ThirdParty"] }, metaPath: "" }]);
  assert.equal(thirdParty.nativePlantWind, undefined);
});

async function loadImporter(directory) {
  const file = path.resolve(__dirname, "../electron/main.js");
  const localRequire = createRequire(file);
  const electronStub = { app: { setName() {}, setAppUserModelId() {}, getPath: () => directory,
    commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }) },
  BrowserWindow: { getAllWindows: () => [] }, nativeImage: { createFromPath: () => ({ isEmpty: () => true }) } };
  const context = vm.createContext({ process, console, __dirname: path.dirname(file), module: { exports: {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    require: (name) => name === "electron" ? electronStub : name === "./logManager" ? { writeLog() {}, setupLogger() {}, onLogLine() {} } : localRequire(name) });
  vm.runInContext(await fs.readFile(file, "utf8") + `
settings.customLibraryPath = ${JSON.stringify(path.join(directory, "Library"))};
markInternalLibraryMutation = () => {};
scheduleIndexSnapshotSave = () => {};
applyLibrarySqlCacheChanges = async () => {};
inferColorTagsSafely = async () => [];
module.exports = { importCustomAsset, updateCustomAsset };
`, context, { filename: file });
  return context.module.exports;
}

test("the real importer automatically saves Wind JSON and duplicate updates refresh its parameters", async (t) => {
  const { directory, model, sidecar } = await fixture(t);
  const importer = await loadImporter(directory);
  const payload = { assetName: "Conifer", assetType: "3dplant", category: "Grass", standardAssetTags: ["Grass"], zionTags: ["Zion"],
    modelSlots: { Mesh: model }, skipDuplicateCheck: true };
  const result = await importer.importCustomAsset(payload, null);
  assert.equal(result.ok, true, result.message);
  let stored = JSON.parse(await fs.readFile(result.metaPath, "utf8"));
  assert.equal(stored.nativePlantWind.scalarParameters.SharedBend, 35.82697677612305);
  await fs.writeFile(sidecar, JSON.stringify({ ...windJson(), material_scalar_parameters: { SharedBend: 99 } }));
  const updated = await importer.updateCustomAsset({ ...payload, assetId: result.assetId }, null);
  assert.equal(updated.ok, true, updated.message);
  stored = JSON.parse(await fs.readFile(updated.asset.metaPath, "utf8"));
  assert.equal(stored.nativePlantWind.scalarParameters.SharedBend, 99);
});

test("managed ThirdParty keeps the shared MI capabilities and verifies the indexed original LOD0", async (t) => {
  const { resolvePlantLayerSource } = require("../electron/services/plantWindLayers");
  const { createHash } = require("node:crypto");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-layer-index-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  t.after(() => {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
  });
  const bridge = path.join(root, "Bridge");
  const library = path.join(root, "managed");
  const registry = path.join(root, "AssetHive", "plant-wind-layers");
  for (const dir of [bridge, library, registry]) await fs.mkdir(dir, { recursive: true });
  const original = path.join(bridge, "Var01_LOD0.fbx");
  const copy = path.join(library, "mesh.fbx");
  const contents = Buffer.from("source geometry");
  await fs.writeFile(original, contents);
  await fs.writeFile(copy, contents);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const file = path.join(bridge, "_layer.json");
  const entry = { source: path.basename(original), sha256, bindings: [{ primary: 0, secondary: -1, terminal: false }] };
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, assetId: "BridgeId", variants: {
    Var1: entry, Var2: { ...entry, bindings: [{ secondary: 0, terminal: true }] }
  } }));
  await fs.writeFile(path.join(registry, "index.json"), JSON.stringify({ assets: { bridgeid: file } }));
  const resolve = () => resolvePlantLayerSource({ path: library, id: "hive-uuid" },
    { identity: { sourceAssetId: "BridgeId" } }, [{ file: copy, variantNumber: 1, variantKey: "01" }]);
  const result = await resolve();
  assert.deepEqual(result, { file, sourceByVariant: { "01": { name: "Var1", original } }, hasSecondary: true, hasTerminal: true });
  await fs.appendFile(original, "changed");
  await assert.rejects(resolve(), /网格已变化/);
});

test("long culm profiles survive managed layer import and reject unknown curves", async (t) => {
  const { inspectPlantLayerSource, importPlantLayers } = require("../electron/services/plantWindLayers");
  const { createHash } = require("node:crypto");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-culm-profile-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bridge = path.join(root, "bridge"), managed = path.join(root, "managed");
  await fs.mkdir(bridge); await fs.mkdir(managed);
  const source = path.join(bridge, "Var1_LOD0.fbx"), copy = path.join(managed, "culm.fbx");
  const bytes = Buffer.from("original long culm");
  await fs.writeFile(source, bytes); await fs.writeFile(copy, bytes);
  const entry = { source: path.basename(source), sha256: createHash("sha256").update(bytes).digest("hex"),
    primaryAxes: [{ id: 0, base: [0, 0, 0], tip: [0, 0, 1], weightProfile: "cantilever" }],
    bindings: [{ primary: 0, secondary: -1, terminal: false }] };
  const doc = { schemaVersion: 1, assetId: "culm", form: "grass", variants: { Var1: entry } };
  await fs.writeFile(path.join(bridge, "_layer.json"), JSON.stringify(doc));
  await importPlantLayers("culm", [{ source, path: copy, variantNumber: 1, variantKey: "01" }], managed);
  const inspect = () => inspectPlantLayerSource({ path: managed, id: "managed" },
    { identity: { sourceAssetId: "culm" } }, [{ file: copy, variantNumber: 1, variantKey: "01" }]);
  assert.equal((await inspect()).layers.hasCantileverWeights, true);
  const installed = JSON.parse(await fs.readFile(path.join(managed, "_layer.json"), "utf8"));
  assert.equal(installed.variants.Var1.primaryAxes[0].weightProfile, "cantilever");
  installed.variants.Var1.primaryAxes[0].weightProfile = "unknown";
  await fs.writeFile(path.join(managed, "_layer.json"), JSON.stringify(installed));
  await assert.rejects(inspect(), /一级枝权重曲线/);
});

test("lower LODs keep fingerprinted LOD0 reuse after managed import and sparse LOD renumbering", async (t) => {
  const { inspectPlantLayerSource, importPlantLayers } = require("../electron/services/plantWindLayers");
  const { createHash } = require("node:crypto");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-lod-reuse-"));
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bridge = path.join(root, "bridge"), managed = path.join(root, "managed");
  await fs.mkdir(bridge); await fs.mkdir(managed);
  const originals = {}, copies = {}, sha = {};
  for (const lod of [0, 1, 3]) {
    const bytes = Buffer.from(`original LOD${lod}`);
    originals[lod] = path.join(bridge, `Var1_LOD${lod}.fbx`);
    copies[lod] = path.join(managed, `renamed-${lod}.fbx`);
    await fs.writeFile(originals[lod], bytes); await fs.writeFile(copies[lod], bytes);
    sha[lod] = createHash("sha256").update(bytes).digest("hex");
  }
  const entry = { source: path.basename(originals[0]), sha256: sha[0],
    frame: { up: "Z", units: "cm", sizeCm: [20, 20, 5] },
    bindings: [{ primary: 0, secondary: -1, terminal: true }],
    lodSources: Object.fromEntries([1, 3].map(lod => [`LOD${lod}`, {
      source: path.basename(originals[lod]), sha256: sha[lod], windSource: "LOD0"
    }])) };
  Object.assign(entry.lodSources.LOD3, { representation: "billboard", layers: ["Shared"] });
  await fs.writeFile(path.join(bridge, "_layer.json"), JSON.stringify({ schemaVersion: 1, assetId: "bridge-id",
    form: "herb", lodWindMode: "lod0-uv0-surface", variants: { Var1: entry,
      Var2: { ...entry, frame: { up: "Z", units: "cm", sizeCm: [20, 20, 15] } } } }));
  const models = [{ source: originals[0], path: copies[0], variantNumber: 1, variantKey: "01" }];
  const lods = [1, 3].map(lod => ({ source: originals[lod], path: copies[lod], variantKey: "01", lod }));
  await importPlantLayers("bridge-id", models, managed, lods);
  const resolve = () => inspectPlantLayerSource({ path: managed, id: "managed-id" },
    { identity: { sourceAssetId: "bridge-id" } },
    [{ file: copies[0], variantNumber: 1, variantKey: "01" }],
    [1, 3].map((lod, index) => ({ file: copies[lod], variantKey: "01", lod: index + 1 })));
  const result = await resolve();
  assert.equal(result.fitsMicroSize, false, "A managed subset retains the original asset's size classification");
  assert.equal(result.variantCount, 2);
  assert.equal(result.layers.sourceByVariant["01"].lods[2].sourceLod, 3);
  assert.equal(result.layers.sourceByVariant["01"].lods[2].windSource, "Var1");
  assert.equal(result.layers.sourceByVariant["01"].lods[2].sha256, sha[3]);
  assert.deepEqual(result.layers.sourceByVariant["01"].lods[2].layers, ["Shared"]);
  const sharp = require("sharp");
  const textureEntries = [];
  for (const role of ["atlas", "billboard"]) {
    const file = path.join(managed, `${role}_Albedo.png`);
    await sharp({ create: { width: 2, height: 2, channels: 4, background: role === "atlas" ? "green" : "red" } }).png().toFile(file);
    textureEntries.push({ file, textureType: "albedo", materialRole: role });
  }
  const asset = { id: "managed-id", name: "Static plant", source: "custom", assetType: "3dplant", path: managed,
    modelFiles: [copies[0]],
    standardAssetTags: ["ThirdParty", "Micro"], textureFiles: textureEntries.map(item => item.file),
    meta: { identity: { sourceAssetId: "bridge-id" }, textureEntries,
      modelVariants: [{ file: copies[0], variantKey: "01" }],
      modelLods: [0, 1, 3].map((lod, index) => ({ file: copies[lod], variantKey: "01", lod: index })) } };
  const [micro] = await buildExportAssets([asset], null, "2k", "decal", "lod", "micro");
  const billboardGroup = micro.materialGroups.find(group => group.materialRole === "billboard");
  assert.equal(micro.plantWindLayers, undefined, "Micro stays static");
  assert.equal(micro.modelLods[0].materialRole, undefined);
  assert.equal(micro.modelLods[1].materialRole, "billboard", "Billboard role survives without synthetic wind");
  assert.equal(micro.modelLods[1].materialGroupId, billboardGroup.groupId);
  assert(billboardGroup.textureFiles.some(file => /billboard/i.test(file)));
  const [wind] = await buildExportAssets([{ ...asset, name: "Wood Sorrel", standardAssetTags: ["ThirdParty"] }],
    null, "2k", "decal", "lod", "auto");
  assert.equal(wind.plantSyntheticWind, "herb");
  assert(!wind.standardAssetTags.includes("Micro"), "Species name and a small copied variant cannot force a non-Micro asset static");
  for (const mode of ["opaque", "naniteMasked"]) {
    const [job] = await buildExportAssets([asset], null, "2k", "decal", mode, "micro");
    assert.equal(job.plantExportMode, mode);
    assert.deepEqual(job.modelLods, []);
    assert.equal(job.billboardExcluded, true);
    assert(job.materialGroups.every(group => group.materialRole !== "billboard"));
    if (mode === "opaque") assert.equal(job.modelVariants[0].naniteMasked, true);
  }
  await fs.appendFile(copies[3], "changed");
  await assert.rejects(resolve(), /缺少匹配的低 LOD/);
});
