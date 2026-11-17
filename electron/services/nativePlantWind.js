const fs = require("node:fs/promises");
const path = require("node:path");
const { resolveFbxWindMaterials } = require("./fbxPlantMaterialSlots");

const isObject = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const UV3_SWITCHES = ["Use Remapped UV3", "Branch2Enable", "HasBranch2Data_Internal"];

function parameterMap(value, kind) {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([name, entry]) =>
    name.trim() && name.length <= 256 && !["__proto__", "constructor", "prototype"].includes(name)
    && (kind === "number" ? typeof entry === "number" && Number.isFinite(entry) && Math.abs(entry) <= 3.402823466e38 : typeof entry === "boolean")
  ).slice(0, 256).map(([name, entry]) => [name.trim(), entry]));
}

function normalizeNativePlantWind(value, sourceFile = "") {
  if (!isObject(value)) return null;
  const scalarParameters = {
    ...parameterMap(value.material_scalar_parameters, "number"),
    ...parameterMap(value.scalarParameters, "number"),
    ...parameterMap(value.uv3?.material_scalar_parameters, "number")
  };
  const staticSwitchParameters = {
    ...parameterMap(value.material_static_switches, "boolean"),
    ...parameterMap(value.staticSwitchParameters, "boolean"),
    ...parameterMap(value.uv3?.material_static_switches, "boolean")
  };
  const uv3Candidates = [value.useRemappedUV3, value.uv3?.branch2_detection?.applied,
    value.branch2_remap?.applied, staticSwitchParameters["Use Remapped UV3"]];
  const useRemappedUV3 = uv3Candidates.find((entry) => typeof entry === "boolean")
    ?? (value.uv3?.status === "remapped_branch2" ? true : undefined);
  if (typeof useRemappedUV3 === "boolean") {
    for (const name of UV3_SWITCHES) staticSwitchParameters[name] = useRemappedUV3;
  }
  const materials = (Array.isArray(value.materials) ? value.materials : []).slice(0, 128).flatMap((material) => {
    if (!isObject(material) || typeof material.name !== "string" || !material.name.trim() || material.name.length > 256) return [];
    const parameters = material.ue_material_parameters || material;
    const scalars = parameterMap(parameters.scalar_parameters || parameters.scalarParameters, "number");
    const switches = parameterMap(parameters.static_switch_parameters || parameters.staticSwitchParameters, "boolean");
    if (!Object.keys(scalars).length && !Object.keys(switches).length) return [];
    const textureFiles = [...new Set((Array.isArray(material.textureFiles) ? material.textureFiles
      : Array.isArray(material.textures) ? material.textures : []).filter((file) => typeof file === "string" && file.trim())
      .map((file) => file.trim().replaceAll("\\", "/")))];
    const materialRole = ["atlas", "billboard"].includes(material.materialRole) ? material.materialRole
      : typeof material.billboard === "boolean" ? (material.billboard ? "billboard" : "atlas") : "";
    return [{ name: material.name.trim(), scalarParameters: scalars, staticSwitchParameters: switches,
      ...(materialRole ? { materialRole } : {}),
      ...(textureFiles.length ? { textureFiles } : {}) }];
  });
  if (!Object.keys(scalarParameters).length && !Object.keys(staticSwitchParameters).length && !materials.length) return null;
  const rawEncoding = value.uv3Encoding || value.uv3?.encoding;
  const uv3Encoding = isObject(rawEncoding) ? Object.fromEntries(Object.entries(rawEncoding).filter(([name, entry]) =>
    name.trim() && name.length <= 128 && (typeof entry === "number" && Number.isFinite(entry)
      || typeof entry === "boolean" || typeof entry === "string" && entry.length <= 1024))) : {};
  return {
    schemaVersion: 1,
    sourceFile: path.basename(String(sourceFile || value.sourceFile || "")),
    scalarParameters,
    staticSwitchParameters,
    ...(typeof useRemappedUV3 === "boolean" ? { useRemappedUV3 } : {}),
    ...(Object.keys(uv3Encoding).length ? { uv3Encoding } : {}),
    ...(materials.length ? { materials } : {})
  };
}

// 只读取当前资产分组及源模型旁的 sidecar，不向父目录或相邻资产递归猜测。
async function detectNativePlantWind({ files = [], modelFiles = [], rootDir = "" } = {}) {
  const models = [...new Set(modelFiles.filter((file) => /\.(fbx|st9)$/i.test(String(file))))];
  if (!models.length) return { profile: null, warnings: [] };
  const candidates = new Map();
  const addCandidate = (file) => candidates.set(path.resolve(file).toLowerCase(), path.resolve(file));
  files.filter((file) => /_wind\.json$/i.test(String(file))).forEach(addCandidate);
  const directories = new Set(models.map((file) => path.dirname(path.resolve(file))));
  if (rootDir) directories.add(path.resolve(rootDir));
  for (const directory of directories) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && /_wind\.json$/i.test(entry.name)) addCandidate(path.join(directory, entry.name));
    }
  }
  const stems = new Set(models.map((file) => path.basename(file, path.extname(file)).replace(/[_-]lod\d+$/i, "").toLowerCase()));
  const matching = [...candidates.values()].filter((file) => stems.has(path.basename(file).replace(/_wind\.json$/i, "").toLowerCase()));
  const selected = matching.length ? matching : [...candidates.values()];
  if (!selected.length) return { profile: null, warnings: [] };
  if (selected.length !== 1) return { profile: null, warnings: ["存在多份 _Wind.json，无法唯一匹配当前植被，未自动套用风参数"] };
  const file = selected[0];
  try {
    const stat = await fs.stat(file);
    if (stat.size > 2 * 1024 * 1024) throw new Error("文件超过 2 MB");
    const raw = JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
    if (typeof raw?.fbx === "string" && raw.fbx.trim()) {
      const modelName = path.basename(raw.fbx.replace(/\\/g, "/"));
      const modelStem = modelName.slice(0, -path.extname(modelName).length).replace(/[_-]lod\d+$/i, "").toLowerCase();
      const modelExtension = path.extname(modelName).toLowerCase();
      if (!stems.has(modelStem) || !models.some((model) => path.extname(model).toLowerCase() === modelExtension)) {
        return { profile: null, warnings: [] };
      }
      if (models.some((model) => path.extname(model).toLowerCase() !== modelExtension)) {
        return { profile: null, warnings: ["Wind JSON 对应 FBX 原生风，当前模型格式混合；请仅保留对应格式的模型后重试"] };
      }
    }
    const profile = normalizeNativePlantWind(raw, file);
    if (!profile) throw new Error("没有有效的材质风参数");
    return resolveFbxWindMaterials(profile, models, file);
  } catch (error) {
    return { profile: null, warnings: [`${path.basename(file)} 风参数读取失败：${error.message}`] };
  }
}

module.exports = { normalizeNativePlantWind, detectNativePlantWind };
