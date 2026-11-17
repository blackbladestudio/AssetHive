const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { parseFbxDocument, childNode, scalarValue, arrayValues } = require("../electron/services/fbxCompactLayers");
const { createAssetMetadata } = require("../electron/services/assetMetadata");
const { detectNativePlantWind } = require("../electron/services/nativePlantWind");
const { groupDroppedAssets } = require("../electron/services/dropAssetGroups");
const { resolveNativePlantGroups } = require("../electron/services/nativePlantGroups");
const { namedPlantTextureMetadata, namedMaterialCatalog, materialKey } = require("../electron/services/zion3dMaterials");
const { buildExportAssets } = require("../electron/services/unrealExporter");

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const stable = (value) => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;

function effectiveWind(wind, material) {
  const scalars = {};
  const switches = {};
  let declared = typeof wind.useRemappedUV3 === "boolean";
  let wanted = wind.useRemappedUV3 === true;
  const disabled = declared && !wanted;
  for (const source of [wind, material]) {
    for (const [name, value] of Object.entries(source?.scalarParameters || {})) scalars[name.toLowerCase()] = Math.fround(value);
    for (const [name, value] of Object.entries(source?.staticSwitchParameters || {})) switches[name.toLowerCase()] = value;
    if (typeof source?.staticSwitchParameters?.["Use Remapped UV3"] === "boolean") {
      declared = true;
      if (!disabled) wanted = source.staticSwitchParameters["Use Remapped UV3"];
    }
  }
  switches["use remapped uv3"] = declared && wanted;
  if (declared) {
    switches.branch2enable = wanted;
    switches.hasbranch2data_internal = wanted;
  }
  return { scalars, switches };
}

async function filesUnder(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const lists = await Promise.all(entries.map((entry) => entry.isDirectory() ? filesUnder(path.join(root, entry.name)) : [path.join(root, entry.name)]));
  return lists.flat();
}

// 源顶点指纹仅用于报告；复用检查解码参数，UE 内还会检查全部源 LOD 的 UV3 有效性。
function sourceUV3(buffer) {
  const document = parseFbxDocument(buffer);
  const objects = document.nodes.find((node) => node.name === "Objects");
  const geometries = objects?.children.filter((node) => node.name === "Geometry") || [];
  if (!geometries.length) return null;
  const parts = [];
  let corners = 0;
  for (const geometry of geometries) {
    const layer = geometry.children.find((node) => node.name === "LayerElementUV" && node.props[0]?.code === "I" && node.props[0].bytes.readInt32LE(1) === 3);
    const mapping = layer ? scalarValue(layer, "MappingInformationType") : "";
    if (!layer || !["ByPolygonVertex", "ByVertice", "ByVertex"].includes(mapping)) return null;
    const values = arrayValues(childNode(layer, "UV")?.props[0], Float64Array);
    const polygonVertices = arrayValues(childNode(geometry, "PolygonVertexIndex")?.props[0], Int32Array);
    const reference = scalarValue(layer, "ReferenceInformationType");
    const indices = reference === "IndexToDirect" ? arrayValues(childNode(layer, "UVIndex")?.props[0], Int32Array) : null;
    if (!values || !polygonVertices || !["Direct", "IndexToDirect"].includes(reference) || reference === "IndexToDirect" && !indices) return null;
    const packed = Buffer.alloc(polygonVertices.length * 8 + 4);
    packed.writeUInt32LE(polygonVertices.length);
    let hasData = false;
    for (let index = 0; index < polygonVertices.length; index += 1) {
      const vertex = polygonVertices[index] < 0 ? -polygonVertices[index] - 1 : polygonVertices[index];
      const mapped = mapping === "ByPolygonVertex" ? index : vertex;
      const direct = indices ? indices[mapped] : mapped;
      const u = Math.fround(values[direct * 2]);
      const v = Math.fround(1 - values[direct * 2 + 1]);
      if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
      hasData ||= u !== 0 || v !== 0;
      packed.writeFloatLE(u, 4 + index * 8);
      packed.writeFloatLE(v, 8 + index * 8);
    }
    if (!hasData) return null;
    parts.push(packed);
    corners += polygonVertices.length;
  }
  const materialNames = objects.children.filter((node) => node.name === "Material").map((node) => {
    const property = node.props[1];
    if (property?.code !== "S") return "";
    return property.bytes.toString("utf8", 5, 5 + property.bytes.readUInt32LE(1)).split("\0")[0].replace(/^Material::/, "");
  }).filter(Boolean);
  return { fingerprint: hash(Buffer.concat(parts)), corners, geometryCount: geometries.length, materialNames };
}

async function main() {
  const [source, tag, output = ".cache/zion-plant-reuse-sample"] = process.argv.slice(2);
  if (!source || !["Grass", "Bush", "Tree", "HeroFoliage", "Micro"].includes(tag)) {
    throw new Error("Usage: node scripts/check-zion-plant-material-reuse.cjs <source-folder> <explicit-standard-plant-tag> [output-folder]");
  }
  const root = path.resolve(source);
  const allFiles = await filesUnder(root);
  const directories = [...new Set(allFiles.filter((file) => /\.fbx$/i.test(file)).map((file) => path.dirname(file)))]
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const samples = [];
  const rawHashes = new Map();
  for (const directory of directories) {
    const files = allFiles.filter((file) => file.startsWith(directory + path.sep));
    const models = files.filter((file) => /\.fbx$/i.test(file) && path.dirname(file) === directory);
    const detected = await detectNativePlantWind({ files, modelFiles: models });
    assert.ok(detected.profile, `${directory}: ${detected.warnings.join("; ") || "missing Wind JSON"}`);
    const named = namedPlantTextureMetadata(files, detected.profile);
    assert.ok(Object.keys(named.materialNames).length, `${directory}: no unambiguous material texture references`);
    const textures = [];
    for (const entry of named.textureSlots) {
      if (!rawHashes.has(entry.filePath)) rawHashes.set(entry.filePath, hash(await fs.readFile(entry.filePath)));
      textures.push({ material: named.materialNames[entry.areaId], type: entry.textureType, SHA256: rawHashes.get(entry.filePath) });
    }
    const uv3 = [];
    for (const model of models) uv3.push({ model: path.basename(model), ...sourceUV3(await fs.readFile(model)) });
    for (const model of uv3) {
      assert.ok(model.fingerprint, `${model.model}: unsupported or invalid UV3 data`);
      const sourceNames = new Set(model.materialNames.map(materialKey));
      assert.ok(Object.values(named.materialNames).every((name) => sourceNames.has(materialKey(name))), `${model.model}: Wind material names differ from FBX materials`);
    }
    const wind = detected.profile;
    const windSignature = hash(JSON.stringify(stable({ scalarParameters: wind.scalarParameters,
      staticSwitchParameters: wind.staticSwitchParameters, useRemappedUV3: wind.useRemappedUV3,
      uv3Encoding: wind.uv3Encoding,
      materials: wind.materials?.map(({ name, scalarParameters, staticSwitchParameters }) => ({ name, scalarParameters, staticSwitchParameters })) })));
    samples.push({ variant: path.basename(directory), materialNames: named.materialNames,
      useRemappedUV3: wind.useRemappedUV3 === true, windSignature, uv3, sourceTextures: textures,
      decoding: Object.fromEntries(["UV3 Remap Bounds Mode", "xMin", "xMax", "yMin", "yMax", "wMin", "wMax"]
        .map((name) => [name, wind.scalarParameters[name]])) });
  }
  const drafts = await resolveNativePlantGroups(groupDroppedAssets(allFiles.filter((file) => !/\.json$/i.test(file))),
    { jsonFiles: allFiles.filter((file) => /\.json$/i.test(file)) });
  const assets = drafts.map((draft) => {
    const id = "sample-" + hash(draft.files.join("|")).slice(0, 12);
    const data = draft.metadata;
    const modelFiles = data.modelFiles || draft.files.filter((file) => /\.fbx$/i.test(file));
    const meta = createAssetMetadata({ ...data, id, name: draft.preferredName, assetType: "3dplant", category: tag,
      standardAssetTags: [tag], zionTags: ["Zion"], modelFiles,
      textureEntries: data.textureSlots.map((entry) => ({ uri: path.relative(root, entry.filePath), textureType: entry.textureType, areaIndex: entry.areaId })) });
    return { id, name: meta.name, assetType: "3dplant", source: "custom", path: root, meta,
      standardAssetTags: [tag], zionTags: ["Zion"], modelFiles, textureFiles: data.textureSlots.map((entry) => entry.filePath) };
  });
  const jobs = await buildExportAssets(assets, null, "2k", "decal", "lod", "none");
  assert.equal(jobs.length, assets.length);
  assert.ok(jobs.every((job) => job.materialMatching === "name"));
  const catalog = namedMaterialCatalog(jobs);
  assert.equal(catalog.failures.size, 0);
  const instanceIdentities = new Map();
  for (const sample of samples) for (const material of Object.values(sample.materialNames)) {
    const job = jobs.find((entry) => entry.modelFiles.some((file) => sample.uv3.some((model) => model.model === path.basename(file))));
    assert.ok(job, `${sample.variant}: model lost during grouping`);
    const wind = job.nativePlantWind || {};
    const row = wind.materials?.find((entry) => materialKey(entry.name) === materialKey(material));
    const effective = effectiveWind(wind, row);
    const remapped = effective.switches["use remapped uv3"];
    const decoderNames = ["uv3 remap bounds mode", "xmin", "xmax", "ymin", "ymax", "wmin", "wmax"];
    const decoder = Object.fromEntries(decoderNames.map((name) => [name, effective.scalars[name]]));
    const complete = sample.uv3.every((entry) => entry.fingerprint)
      && decoderNames.every((name) => Number.isFinite(decoder[name]))
      && [1, 2].includes(effective.scalars["uv3 remap bounds mode"]);
    const proof = !remapped ? "compatible" : complete
      ? hash(JSON.stringify(stable({ parameters: decoder, encoding: wind.uv3Encoding }))) : sample.variant;
    const identity = `${materialKey(material)}|${proof}`;
    if (!instanceIdentities.has(identity)) instanceIdentities.set(identity, {
      material, defaultWindVariant: sample.variant, decoder, variants: []
    });
    instanceIdentities.get(identity).variants.push(sample.variant);
  }
  const report = { source: root, explicitStandardAssetTag: tag, modelCount: jobs.reduce((count, job) => count + job.modelFiles.length, 0),
    assetCount: jobs.length, sourceVariantCount: samples.length, sharedTextureSetCount: catalog.groups.length,
    sharedExportTextureCount: catalog.groups.reduce((count, group) => count + group.textureSlots.length, 0),
    expectedMaterialInstanceCount: instanceIdentities.size, distinctSourceUV3Fingerprints: new Set(samples.flatMap((sample) => sample.uv3.map((entry) => entry.fingerprint).filter(Boolean))).size,
    distinctWindSignatures: new Set(samples.map((sample) => sample.windSignature)).size,
    windPolicy: "first variant by natural name order; only UV3 decoder/encoding affects native wind reuse",
    materialInstances: [...instanceIdentities.values()],
    scope: "real drop resolver, source files and export Job; UI and UE runtime import not executed", samples };
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(output, "job.json"), JSON.stringify({ resolution: "2k", assets: jobs, namedMaterialGroups: catalog.groups }, null, 2));
  console.log(JSON.stringify({ ...report, samples: undefined, report: path.resolve(output, "report.json") }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
