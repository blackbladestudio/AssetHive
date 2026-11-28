const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const isUsda = file => /\.usda$/i.test(String(file));
const slash = file => file.replace(/\\/g, "/");
const stem = file => path.basename(file, path.extname(file));
const familyStem = file => stem(file).replace(/(?:[_-](?:var)?)?\d+$/i, "");
const within = (root, file) => { const rel = path.relative(root, file); return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`); };
function commonRoot(files) {
  let root = path.dirname(files[0]);
  while (files.some(file => !within(root, file))) {
    const parent = path.dirname(root);
    if (parent === root) throw new Error("Nanite Foliage 文件必须位于同一个磁盘");
    root = parent;
  }
  return root;
}
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fsSync.createReadStream(file).on("data", data => hash.update(data)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  });
}
// 只读取材质作用域的小块；大型顶点数组不进入 JSON，也不改写源 UV。
function materialBlocks(text) {
  const result = [];
  const re = /\bdef Material\s+"([^"]+)"\s*(?:\([^)]*\)\s*)?\{/g;
  for (let match; (match = re.exec(text));) {
    let depth = 1, quoted = false, escaped = false, end = re.lastIndex;
    for (; end < text.length && depth; end++) {
      const c = text[end];
      if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; }
      else if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    if (depth) throw new Error(`USDA 材质块不完整：${match[1]}`);
    result.push({ name: match[1], body: text.slice(re.lastIndex, end - 1) });
    re.lastIndex = end;
  }
  return result;
}
function materialRole(name, groundCover, overrides = {}) {
  if (["grass", "leaf", "trunk"].includes(overrides[name])) return overrides[name];
  if (groundCover) return "grass";
  return /leaf/i.test(name) ? "leaf" : "trunk";
}
async function findWind(file) {
  const dir = path.dirname(file), base = stem(file).toLowerCase();
  const files = await fs.readdir(dir);
  const matches = files.filter(name => new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[_-](wind|winddata)\\.json$`, "i").test(name));
  if (!matches.length && files.filter(name => /^wind\.json$/i.test(name)).length === 1) matches.push(files.find(name => /^wind\.json$/i.test(name)));
  if (matches.length !== 1) throw new Error(`${path.basename(file)} 需要唯一匹配的 Wind.json / _WindData.json`);
  const windFile = path.join(dir, matches[0]);
  const wind = JSON.parse(await fs.readFile(windFile, "utf8"));
  if (!Array.isArray(wind.Joints) || !wind.Joints.length || !Array.isArray(wind.SimulationGroups) || !wind.SimulationGroups.length
    || wind.Joints.some(j => !j.JointName || !Number.isInteger(j.SimulationGroupIndex) || j.SimulationGroupIndex < -1 || j.SimulationGroupIndex >= wind.SimulationGroups.length)) {
    throw new Error(`风数据无效：${windFile}`);
  }
  return { windFile, wind };
}
async function inspectVariant(file, roles, hashes, plantTag) {
  const text = await fs.readFile(file, "utf8");
  if (!text.startsWith("#usda") || !/NaniteAssemblyRootAPI/.test(text) || !/unreal:naniteAssembly:meshType\s*=\s*"skeletalMesh"/.test(text)) {
    throw new Error(`${path.basename(file)} 不是受支持的 Nanite Foliage 骨骼 USDA`);
  }
  const { windFile, wind } = await findWind(file);
  const references = [...new Set([...text.matchAll(/@([^@\r\n]+)@/g)].map(m => m[1]))];
  const resolveReference = ref => {
    if (path.isAbsolute(ref) || /^[a-z]+:/i.test(ref) || !/\.(png|tga|tiff?|jpe?g|exr)$/i.test(ref)) throw new Error(`USDA 包含不支持的外部引用：${ref}`);
    return path.resolve(path.dirname(file), ref);
  };
  const files = references.map(resolveReference);
  for (const ref of files) if (!(await fs.stat(ref).catch(() => null))?.isFile()) throw new Error(`USDA 引用文件不存在：${ref}`);
  const materials = [];
  for (const { name, body } of materialBlocks(text)) {
    const uvNames = [...new Set([...body.matchAll(/inputs:varname\s*=\s*"([^"]+)"/g)].map(m => m[1]))];
    if (uvNames.length !== 1 || uvNames[0] !== "st" || /UsdTransform2d/.test(body)) throw new Error(`${name} 使用了尚未支持的材质 UV 变换，不能安全复用`);
    const textures = {};
    const shaderMap = { ColorTex: "Diffuse", NormalTex: "Normal", ORMTex: "ORM" };
    for (const [shader, slot] of Object.entries(shaderMap)) {
      const match = body.match(new RegExp(`def Shader "${shader}"\\s*\\{[\\s\\S]*?inputs:file\\s*=\\s*@([^@]+)@`));
      if (match) textures[slot] = resolveReference(match[1]);
    }
    for (const [field, slot] of Object.entries({ subsurfaceTexture: "SubsurfaceColor", map_AO: "AO", map_Gloss: "Gloss" })) {
      const match = body.match(new RegExp(`speedtree:${field}\\s*=\\s*@([^@]+)@`));
      if (match) textures[slot] = resolveReference(match[1]);
    }
    if (!textures.Diffuse || !textures.Normal) throw new Error(`${name} 缺少明确的 Diffuse / Normal 引用`);
    const isGrass = plantTag ? /^grass$/i.test(plantTag) : wind.bIsGroundCover === true;
    const role = materialRole(name, isGrass, roles);
    const content = [];
    for (const [slot, texture] of Object.entries(textures).sort()) {
      if (!hashes.has(texture)) hashes.set(texture, hashFile(texture));
      content.push([slot, await hashes.get(texture)]);
    }
    // 同一图集允许不同几何 UV；只有采样坐标约定及材质输入相同才共享。
    let sampling = body.replace(/<[^>]*\/Materials\/[^/]+\/([^>]+)>/g, "<$1>");
    for (const ref of [...new Set([...body.matchAll(/@([^@\r\n]+)@/g)].map(m => m[1]))]) {
      const texture = resolveReference(ref);
      if (!hashes.has(texture)) hashes.set(texture, hashFile(texture));
      sampling = sampling.split(`@${ref}@`).join(`@${await hashes.get(texture)}@`);
    }
    sampling = sampling.replace(/\s+/g, " ").trim();
    const key = crypto.createHash("sha256").update(JSON.stringify([role, uvNames, content, sampling])).digest("hex").slice(0, 16);
    materials.push({ name, role, key, textures, uvPrimvar: "st" });
  }
  if (!materials.length) throw new Error(`${file} 没有可识别材质`);
  const instanceCount = [...text.matchAll(/int\[\]\s+protoIndices\s*=\s*\[([^\]]*)\]/g)]
    .reduce((sum, match) => sum + (match[1].match(/-?\d+/g) || []).length, 0);
  const nativeInstances = [...text.matchAll(/instanceable\s*=\s*true/g)].length;
  return { file, windFile, name: stem(file), variantKey: (stem(file).match(/(\d+)$/) || [])[1] || "01",
    assembly: instanceCount + nativeInstances > 0, instanceCount, groundCover: wind.bIsGroundCover === true, materials, files };
}
async function analyzeNaniteFoliage(modelFiles, { roles = {}, plantTag = "" } = {}) {
  if (!modelFiles.length || !modelFiles.every(isUsda)) throw new Error("Nanite Foliage 只能使用 USDA 模型及对应风数据");
  const hashes = new Map(), variants = [];
  for (const file of [...new Set(modelFiles)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) variants.push(await inspectVariant(path.resolve(file), roles, hashes, plantTag));
  if (new Set(variants.map(v => v.name.toLowerCase())).size !== variants.length) throw new Error("Nanite Foliage 变体名称重复");
  const files = [...new Set(variants.flatMap(v => [v.file, v.windFile, ...v.files]))];
  const byKey = new Map();
  for (const variant of variants) for (const material of variant.materials) if (!byKey.has(material.key)) byKey.set(material.key, { ...material, ownerVariant: variant.name });
  const groups = [...byKey.values()];
  return { version: 1, root: commonRoot(files), variants: variants.map(({ files: _files, ...v }) => v), groups, files, roles,
    warnings: [...new Set(groups.filter(g => !g.role).map(g => `请为 ${g.name} 指定 Leaf 或 Trunk 父材质`))] };
}
async function groupNaniteFoliage(files, archiveSources = [], metadataGroups = []) {
  const families = new Map(), consumed = new Set(), assets = [];
  for (const file of files.filter(isUsda)) {
    const dir = path.dirname(file);
    const parent = stem(file).toLowerCase() === path.basename(dir).toLowerCase() ? path.dirname(dir) : dir;
    const owner = metadataGroups.find(group => group.root && within(group.root, file));
    const key = owner ? owner.root.toLowerCase() : `${parent.toLowerCase()}|${familyStem(file).toLowerCase()}`;
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(file);
  }
  for (const models of families.values()) {
    const manifest = await analyzeNaniteFoliage(models);
    manifest.files.forEach(file => consumed.add(path.resolve(file).toLowerCase()));
    // 导出报告是辅助文件，不能被误识别成另一个资产。
    for (const file of files) if (within(manifest.root, file) && /(?:BindingReport|ExportReport)\.json$/i.test(file)) consumed.add(path.resolve(file).toLowerCase());
    const owner = metadataGroups.find(group => group.root && models.every(file => within(group.root, file)));
    if (owner) for (const file of files) if (within(owner.root, file)) consumed.add(path.resolve(file).toLowerCase());
    const name = owner?.metadata?.name || familyStem(models[0]);
    const groups = manifest.groups;
    assets.push({ files: manifest.files, folderName: name, preferredName: name, root: manifest.root,
      ...(archiveSources.find(a => within(a.root || a.extractedPath || "\0", models[0]))?.archivePath ? { sourceArchivePath: archiveSources.find(a => within(a.root || a.extractedPath || "\0", models[0])).archivePath } : {}),
      metadata: { ...owner?.metadata, assetType: "3dplant", plantAssetType: "naniteFoliage", naniteFoliage: manifest,
        standardAssetTags: owner?.metadata?.standardAssetTags || (manifest.variants.every(v => v.groundCover) ? ["Grass"] : []),
        modelFiles: models, modelVariants: manifest.variants.map(v => ({ file: v.file, variantKey: v.variantKey })),
        materialNames: Object.fromEntries(groups.map((g, i) => [i + 1, `${g.name}_${g.key.slice(0, 6)}`])),
        textureSlots: groups.flatMap((g, i) => Object.entries(g.textures).map(([textureType, filePath]) => ({ areaId: i + 1, textureType, filePath }))) } });
  }
  return { assets, remaining: files.filter(file => !consumed.has(path.resolve(file).toLowerCase())),
    remainingMetadata: metadataGroups.filter(group => !assets.some(asset => asset.files.some(file => within(group.root, file)))) };
}
async function archiveNaniteFoliage(models, destination, roles = {}) {
  const manifest = await analyzeNaniteFoliage(models, { roles });
  const target = path.join(destination, "NaniteFoliage");
  const map = new Map();
  const alreadyArchived = manifest.files.every(source => within(destination, source));
  for (const source of manifest.files) {
    const dest = alreadyArchived ? source : path.join(target, path.relative(manifest.root, source));
    if (!within(alreadyArchived ? destination : target, dest)) throw new Error("Nanite Foliage 归档路径越界");
    await fs.mkdir(path.dirname(dest), { recursive: true });
    if (path.resolve(source).toLowerCase() !== path.resolve(dest).toLowerCase()) await fs.copyFile(source, dest);
    map.set(source, dest);
  }
  const remap = value => typeof value === "string" ? (map.get(value) ? slash(path.relative(destination, map.get(value))) : value)
    : Array.isArray(value) ? value.map(remap) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v)])) : value;
  return { ...remap(manifest), root: "NaniteFoliage" };
}
module.exports = { isUsda, analyzeNaniteFoliage, groupNaniteFoliage, archiveNaniteFoliage, materialBlocks };
