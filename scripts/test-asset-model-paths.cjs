const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const { resolveAssetModelPath, normalizeAssetModelPaths } = require("../electron/services/assetModelPaths");
const { getAssetDetailsByMetaPath } = require("../electron/services/assetScanner");
const { loadApplicationServices } = require("./application-service-harness.cjs");

const folder = "3d_rock_abc1234";
const unc = `\\\\fileshare\\share\\Artist\\AssetLibrary\\Environment\\3D Assets\\${folder}`;
const mapped = `Z:\\Artist\\AssetLibrary\\Environment\\3D Assets\\${folder}`;
const slash = value => value.replace(/\\/g, "/");

test("model references follow the current asset path in both UNC/drive directions", () => {
  for (const [current, stored] of [[unc, mapped], [mapped, unc]]) {
    assert.equal(resolveAssetModelPath(current, `${stored}\\Models\\Rock_01.fbx`), `${slash(current)}/Models/Rock_01.fbx`);
    assert.equal(resolveAssetModelPath(current, "Models/Rock_01.fbx"), `${slash(current)}/Models/Rock_01.fbx`);
    assert.equal(resolveAssetModelPath(current, ""), "");
  }
  assert.equal(resolveAssetModelPath(unc, "Z:/Other/another_asset/Rock_01.fbx"), "Z:/Other/another_asset/Rock_01.fbx");
  assert.equal(resolveAssetModelPath(unc, `${mapped}_other/Rock_01.fbx`), `${slash(mapped)}_other/Rock_01.fbx`);
});

test("normalization deduplicates aliases while preserving variants, LODs and texture fields", () => {
  const texture = { type: "texture", uri: "Tex/Diffuse.png", materialRole: "atlas" };
  const meta = {
    modelFiles: [`${mapped}/Models/Rock_01.fbx`, `${unc}/Models/Rock_01.fbx`, "Models/Rock_02.fbx"],
    modelSlots: { Mesh: `${mapped}/Models/Rock_01.fbx`, Mesh02: "Models/Rock_01.fbx", Mesh03: "Models/Rock_02.fbx" },
    modelVariants: [{ file: `${mapped}/Models/Rock_01.fbx`, variantKey: "A" }],
    modelLods: [{ slot: "Mesh02", file: `${mapped}/Models/Rock_01_LOD1.fbx`, variantKey: "A", lod: 1 }],
    components: [{ type: "model", uri: "Models/Rock_01.fbx", variantKey: "A" }, texture]
  };
  const before = globalThis.structuredClone(meta);
  const normalized = normalizeAssetModelPaths(meta, unc);
  const first = `${slash(unc)}/Models/Rock_01.fbx`;
  assert.deepEqual(normalized.modelFiles, [first, `${slash(unc)}/Models/Rock_02.fbx`]);
  assert.deepEqual(normalized.modelSlots, { Mesh: first, Mesh03: `${slash(unc)}/Models/Rock_02.fbx` });
  assert.deepEqual(normalized.modelVariants, [{ file: first, variantKey: "A" }]);
  assert.deepEqual(normalized.modelLods, [{ slot: "Mesh", file: `${slash(unc)}/Models/Rock_01_LOD1.fbx`, variantKey: "A", lod: 1 }]);
  assert.equal(normalized.components[1], texture);
  assert.deepEqual(meta, before, "reading must not mutate the stored metadata");
  assert.equal(new Set(["A/model.fbx", "B/model.fbx"].map(file => resolveAssetModelPath(unc, file))).size, 2);
});

async function editSlotBuilder() {
  const source = await fs.readFile(path.join(__dirname, "../src/ui/App.tsx"), "utf8");
  const ast = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ["buildEditSlots", "normalizeLocalPath", "formatMeshSlotKey", "isMeshSlotKey", "normalizeImportModelVariantKey",
    "parseImportModelVariantKey", "getFileStemFromPath", "stripImportModelLodKey", "isModelLodPath", "getTextureAreaIdList",
    "parseTextureSlotToken", "normalizeOpacityTextureType", "normalizeTextureMaterialRole", "makeTextureEntry",
    "inferTextureTypeFromPath", "inferTextureAreaIdFromPath"];
  const constants = ["textureTypeOptions"];
  const pieces = [];
  (function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) pieces.push(node.getText(ast));
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => constants.includes(item.name?.getText(ast)))) {
      pieces.push(node.getText(ast));
    }
    ts.forEachChild(node, visit);
  })(ast);
  assert.equal(pieces.length, names.length + constants.length);
  const js = ts.transpileModule(pieces.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(`const meshSlotBaseName = "Mesh"; ${js}; return buildEditSlots;`)();
}

test("HDRI edit slots reuse the stored HDR/EXR without adding an empty row", async () => {
  const buildEditSlots = await editSlotBuilder();
  for (const extension of ["hdr", "exr"]) {
    const file = `aarfontein_dawn_2_4k.${extension}`;
    const assetDir = "Z:\\Artist\\AssetLibrary\\Environment\\HDRI\\hdri_aarfontein_dawn_2_b8267ce4";
    const record = {
      id: "b8267ce4", assetType: "hdri", path: assetDir,
      textureFiles: [`${assetDir}\\${file}`],
      meta: { components: [{ type: "texture", slot: "HDR", uri: file, areaIndex: 1 }] }
    };
    const before = globalThis.structuredClone(record);
    const entries = buildEditSlots(record).textureEntries;
    assert.equal(entries.length, 1, `${extension}: opening an existing HDRI must show one row`);
    assert.equal(entries[0].textureType, "HDR");
    assert.equal(entries[0].filePath, `${assetDir}\\${file}`);
    assert.deepEqual(record, before, "opening the editor must not mutate metadata");
  }
  const fromFiles = buildEditSlots({ assetType: "hdri", textureFiles: ["Z:\\Sky_HDR.hdr"] });
  assert.equal(fromFiles.textureEntries.length, 1);
  assert.equal(fromFiles.textureEntries[0].filePath, "Z:\\Sky_HDR.hdr");
  const withRole = buildEditSlots({
    assetType: "hdri", meta: { components: [{ type: "texture", slot: "HDR", uri: "Z:\\Sky.hdr", materialRole: "atlas" }] }
  });
  assert.equal(withRole.textureEntries.length, 1, "an existing material role must not trigger an empty HDR row");
});

test("HDRI without a stored texture does not recreate a cleaned empty edit slot", async () => {
  const entries = (await editSlotBuilder())({ assetType: "hdri", textureFiles: [] }).textureEntries;
  assert.equal(entries.length, 0);
});

test("the editor detects stored blank slots and keeps missing paths visible", async () => {
  const buildEditSlots = await editSlotBuilder();
  const form = buildEditSlots({ assetType: "3d", path: "Z:\\Library\\Asset",
    meta: { modelSlots: { Mesh: "Z:\\Library\\Asset\\missing.fbx", Mesh02: " " },
      components: [{ type: "texture", slot: "Normal", uri: "missing.png" }, { type: "texture", slot: "Diffuse", uri: " " }] } });
  assert.equal(form.hasEmptySlots, true);
  assert.deepEqual(Object.values(form.modelSlots), ["Z:\\Library\\Asset\\missing.fbx"]);
  assert.equal(form.textureEntries.length, 1);
  assert.equal(form.textureEntries[0].filePath, "Z:\\Library\\Asset\\missing.png");
});

test("fresh details and the real edit form show one slot for a stored drive/UNC alias", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-model-paths-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const assetDir = path.join(root, folder);
  await fs.mkdir(path.join(assetDir, "Models"), { recursive: true });
  for (const file of ["Rock_01.fbx", "Rock_02.fbx", "Rock_01_LOD1.fbx"]) {
    await fs.writeFile(path.join(assetDir, "Models", file), "fbx");
  }
  const metaPath = path.join(assetDir, "asset_info.json");
  const meta = {
    assetID: "abc1234", name: "Rock", assetType: "3d", category: "Other",
    modelFiles: [`${mapped}/Models/Rock_01.fbx`, `${unc}/Models/Rock_02.fbx`],
    modelSlots: { Mesh: `${mapped}/Models/Rock_01.fbx`, Mesh02: `${unc}/Models/Rock_01.fbx`, Mesh03: "Models/Rock_02.fbx" },
    modelVariants: [{ file: `${mapped}/Models/Rock_01.fbx`, variantKey: "A" }, { file: `${unc}/Models/Rock_02.fbx`, variantKey: "B" }],
    modelLods: [{ file: `${mapped}/Models/Rock_01_LOD1.fbx`, variantKey: "A", lod: 1 }],
    components: [{ type: "model", uri: "Models/Rock_01.fbx", variantKey: "A" }, { type: "model", uri: "Models/Rock_02.fbx", variantKey: "B" }]
  };
  const text = JSON.stringify(meta);
  await fs.writeFile(metaPath, text);
  const record = await getAssetDetailsByMetaPath(metaPath);
  assert.ok(record, "a mapped drive from another client must not be needed to read the asset");
  assert.equal(record.modelFiles.length, 2);
  assert.ok(record.modelFiles.every(file => file.startsWith(slash(assetDir))));
  const buildEditSlots = await editSlotBuilder();
  const form = buildEditSlots(record);
  assert.deepEqual(Object.keys(form.modelSlots), ["Mesh", "Mesh02"]);
  assert.deepEqual(form.modelVariantKeys, { Mesh: "A", Mesh02: "B" });
  assert.equal(form.modelLodFiles.Mesh.filter(entry => entry.lod === 1).length, 1);
  const caseAlias = { ...record, modelFiles: record.modelFiles.map(file => file.toUpperCase()) };
  assert.equal(Object.keys(buildEditSlots(caseAlias).modelSlots).length, 2);
  assert.equal(await fs.readFile(metaPath, "utf8"), text, "opening the editor must not rewrite shared metadata");
});

for (const subdirectory of ["", "Models"]) test(`saving duplicate slots preserves the model and LOD in ${subdirectory || "the asset root"}`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-model-save-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const assetDir = path.join(root, "Library", "Environment", "3D Assets", folder);
  await fs.mkdir(path.join(assetDir, subdirectory), { recursive: true });
  const uri = [subdirectory, "Rock_01.fbx"].filter(Boolean).join("/");
  const lodUri = [subdirectory, "Rock_01_LOD1.fbx"].filter(Boolean).join("/");
  const model = path.join(assetDir, uri);
  await fs.writeFile(model, "original model");
  await fs.writeFile(path.join(assetDir, lodUri), "original LOD");
  const metaPath = path.join(assetDir, "asset_info.json");
  await fs.writeFile(metaPath, JSON.stringify({
    assetID: "abc1234", name: "Rock", assetType: "3d", category: "Other",
    createdAt: "2026-09-01T00:00:00.000Z",
    modelFiles: [`${mapped}/${uri}`, `${unc}/${uri}`],
    modelSlots: { Mesh: `${mapped}/${uri}`, Mesh02: `${unc}/${uri}` },
    modelLods: [{ slot: "Mesh02", file: `${mapped}/${lodUri}`, variantKey: "01", lod: 1 }],
    components: [{ type: "model", uri }]
  }));
  const services = await loadApplicationServices(root);
  services.getIndex().push(await getAssetDetailsByMetaPath(metaPath));
  const result = await services.updateCustomAsset({ assetId: "abc1234", tags: ["reviewed"] }, null);
  assert.equal(result.ok, true, result.message);
  const saved = JSON.parse(await fs.readFile(metaPath, "utf8"));
  assert.equal(Object.keys(saved.modelSlots).length, 1);
  assert.deepEqual(saved.modelFiles, [slash(model)]);
  assert.equal(saved.components.filter(entry => entry.type === "model").length, 1);
  assert.equal(saved.components.find(entry => entry.type === "model").uri, uri);
  assert.equal(saved.modelLods.find(entry => entry.lod === 1).file, slash(path.join(assetDir, lodUri)));
  assert.equal(saved.createdAt, "2026-09-01T00:00:00.000Z");
  assert.equal(await fs.readFile(model, "utf8"), "original model");
  assert.equal(await fs.readFile(path.join(assetDir, lodUri), "utf8"), "original LOD");
  const reopened = await getAssetDetailsByMetaPath(metaPath);
  assert.equal(Object.keys((await editSlotBuilder())(reopened).modelSlots).length, 1);
});
