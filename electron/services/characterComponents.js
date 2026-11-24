const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const sharp = require("sharp");
const { transactionalFs, withFileTransaction } = require("./assetFileTransaction");
const { updateAssetMetadataFile } = require("./assetMetadata");
const { computeContentIdentity, IDENTITY_SCHEMA_VERSION } = require("./assetIdentity");
const { libraryRoot, safePath, withRecycleLock } = require("./libraryRecycle");
const { characterModelPreviewComponents: listCharacterComponents, activeCharacterFiles, needsCharacterComponentPreview, characterComponentLabel, applyCharacterRigUpdateState, characterMeshPreviewRevision, needsCharacterMeshPreview, characterSuitPendingPreviewViews, characterGroomPendingPreviewViews } = require("../../shared/characterComponents.mjs");
const { normalizeMonsterSourceStem } = require("../../shared/monsterPackageAudit.mjs");
const { characterStatus } = require("../../shared/characterFilters.mjs");
const { CHARACTER_MODEL_EXTENSIONS, isAllowedCharacterPackageFile } = require("../../shared/characterFilePolicy.mjs");
const { refreshCharacterTriangleMetrics } = require("./characterModelMetrics");
const { appendCharacterUpdateHistory } = require("./characterUpdateHistory");
const { analyzeFbxInWorker } = require("./modelAnalysis");
const { characterGalleryRevision } = require('../../shared/characterPreviewRevision.mjs');

async function updateCharacterStatus(options) {
  if (!["wip", "needs_rig", "rigged", "approved"].includes(options.maturity)) throw new Error("制作状态无效");
  const { root, parent } = await loadParent(options.root, options.asset, ["suit", "monster", "npc", "weapon", "item"]);
  return withRecycleLock(root, () => withFileTransaction({ root, owner: "character-components", key: parent.metaPath }, async () => {
    await updateAssetMetadataFile(parent.metaPath, meta => {
      if (String(meta.assetID || meta.id) !== parent.id) throw new Error("主体 ID 已变化，请刷新");
      const current = characterStatus(meta.character?.maturity || meta.characterManifest?.maturity).value;
      if (current !== options.expectedStatus) throw new Error("制作状态已被其他人修改，请刷新后重试");
      const at = new Date().toISOString();
      meta.character = { ...meta.character, maturity: options.maturity };
      if (meta.characterManifest) {
        meta.characterManifest.maturity = options.maturity;
        if (meta.characterManifest.fields) meta.characterManifest.fields.maturity = options.maturity;
      }
      appendCharacterUpdateHistory(meta, { at, label: `制作状态：${characterStatus(current).zh} → ${characterStatus(options.maturity).zh}`,
        changes: [{ name: "制作状态", status: "changed", before: current, after: options.maturity }] });
      meta.updatedAt = at;
      return meta;
    });
    return { ok: true, parentId: parent.id };
  }));
}

const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stem = file => path.basename(file, path.extname(file));
const normalized = file => normalizeMonsterSourceStem(stem(file));
const modelExtension = /\.(fbx|obj|abc|gltf|glb|uasset)$/i;
const textureExtension = /\.(png|jpg|jpeg|tga|tif|tiff|dds|exr)$/i;
const sourceExtension = /\.(ma|mb|blend|spp|sbsar|sbs|max|ztl|zpr|swatches)$/i;
const previewView = item => (item?.tags || []).find(tag => String(tag).startsWith("view:"))?.slice(5) || "";
const isAutomaticPreview = item => Boolean(previewView(item)) && !(item?.tags || []).includes("origin:manual");
function markCharacterAutomaticPreviewsReloading(meta, state) {
  const pending = [...new Set((meta.previews?.images || []).filter(isAutomaticPreview).map(previewView).filter(Boolean))];
  if (pending.length) state.autoPreviewPendingViews = pending;
  else delete state.autoPreviewPendingViews;
  return pending;
}
async function fileHash(file) {
  return (await require('./characterFileInspection').inspectCharacterFile(file)).sourceHash;
}

async function syncActiveCharacterMetadata(meta, parent) {
  const files = activeCharacterFiles({ ...parent, meta });
  meta.characterMetrics = await refreshCharacterTriangleMetrics(files, parent.path);
  if (meta.characterManifest) meta.characterManifest.metrics = meta.characterMetrics;
  const models = files.filter(file => ["model", "skeletalMesh", "staticMesh"].includes(file.role)
      && CHARACTER_MODEL_EXTENSIONS.has(path.extname(file.normalizedName || file.storedPath).toLowerCase()))
    .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName, "en", { numeric: true }));
  const textures = files.filter(file => file.role === "texture");
  const groupOf = file => file.materialName || file.normalizedName.replace(/\.[^.]+$/, "").replace(/_(?:D|N|ORM|A|E|Emissive)$/i, "").replace(/^T_/i, "MI_");
  const groups = [...new Set(textures.map(groupOf))].sort();
  const textureType = file => file.textureType || ({ d: "Diffuse", n: "Normal", orm: "ORM", a: "Opacity", e: "Emissive", emissive: "Emissive" })[file.normalizedName.replace(/\.[^.]+$/, "").split("_").pop().toLowerCase()] || "MAP";
  meta.modelFiles = models.filter(file => !require('../../shared/characterLods.cjs').level(file.normalizedName)).map(file => path.join(parent.path, file.storedPath));
  const primaryModels = models.filter(file => !require('../../shared/characterLods.cjs').level(file.normalizedName));
  const modelSlotKey = file => `${file.role === 'skeletalMesh' ? 'SK' : 'SM'}:${require('../../shared/characterLods.cjs').identity(file.normalizedName).replace(/^(?:sk|sm)_/i, '')}`;
  const slotOf = new Map(primaryModels.map((file, i) => [modelSlotKey(file), i ? `Mesh${String(i + 1).padStart(2, "0")}` : "Mesh"]));
  meta.modelSlots = Object.fromEntries(primaryModels.map(file => [slotOf.get(modelSlotKey(file)), path.join(parent.path, file.storedPath)]));
  meta.modelLods = models.filter(file => require('../../shared/characterLods.cjs').level(file.normalizedName)).map(file => ({
    slot: slotOf.get(modelSlotKey(file)), lod: require('../../shared/characterLods.cjs').level(file.normalizedName), file: path.join(parent.path, file.storedPath)
  }));
  if (meta.modelLods.some(file => !file.slot)) throw new Error("LOD 缺少对应主体模型，请整理后重新导入");
  meta.textureFiles = textures.map(file => path.join(parent.path, file.storedPath));
  meta.textureEntries = textures.map(file => ({ textureType: textureType(file), areaIndex: groups.indexOf(groupOf(file)) + 1, uri: file.storedPath, materialName: groupOf(file) }));
  meta.textureSlots = {};
  for (const file of textures) meta.textureSlots[textureType(file)] ||= path.join(parent.path, file.storedPath);
  meta.components = [...models.map(file => ({ type: "model", slot: slotOf.get(modelSlotKey(file)), uri: file.storedPath,
    ...(/_LOD\d+(?=\.[^.]+$)/i.test(file.normalizedName) ? { lod: Number(file.normalizedName.match(/_LOD(\d+)(?=\.[^.]+$)/i)[1]) } : {}) })),
    ...meta.textureEntries.map(file => ({ type: "texture", ...file }))];
  const modelLodFiles = {};
  for (const file of meta.modelLods) (modelLodFiles[file.slot] ||= []).push({ source: file.file, lod: file.lod });
  const identity = await computeContentIdentity({ modelSlots: meta.modelSlots, modelLodFiles,
    textureSlots: meta.textureEntries.map(file => ({ source: path.join(parent.path, file.uri),
      suffix: file.areaIndex > 1 ? `${String(file.areaIndex).padStart(3, "0")}_${file.textureType}` : file.textureType,
      areaIndex: file.areaIndex, materialRole: file.materialRole || "" })) });
  const previousFingerprint = meta.identity?.contentFingerprint || "";
  meta.identity = { schemaVersion: IDENTITY_SCHEMA_VERSION, ...meta.identity, ...identity };
  meta.revision = Math.max(1, Math.floor(Number(meta.revision) || 1)) + 1;
  meta.importHistory = [...(meta.importHistory || []).slice(-49), { at: new Date().toISOString(),
    action: "character-update", previousFingerprint, nextFingerprint: identity.contentFingerprint }];
}

async function loadParent(rootValue, asset, allowedTypes = ["monster", "suit", "npc", "weapon", "item"]) {
  const root = await libraryRoot(rootValue);
  if (!asset || asset.source !== "custom" || !allowedTypes.includes(asset.assetType)) throw new Error("不支持此资产类型的角色操作");
  await safePath(root, asset.path);
  await safePath(root, asset.metaPath);
  if (path.dirname(path.resolve(asset.metaPath)).toLowerCase() !== path.resolve(asset.path).toLowerCase()) throw new Error("主体元数据路径异常");
  const meta = JSON.parse(await fs.readFile(asset.metaPath, "utf8"));
  if (String(meta.assetID || meta.id) !== asset.id) throw new Error("主体 ID 已变化，请刷新");
  return { root, parent: { ...asset, meta } };
}

async function resolveCharacterFile({ root: rootValue, asset, storedPath }, roles, label) {
  const { root, parent } = await loadParent(rootValue, asset, ["monster", "suit", "npc", "weapon", "item"]);
  const file = activeCharacterFiles(parent).find(item => item.storedPath === storedPath && roles.includes(item.role));
  if (!file) throw new Error(`该${label}不在当前版本中，请刷新资产详情后重试`);
  const location = path.resolve(parent.path, file.storedPath);
  const relative = path.relative(parent.path, location);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error(`${label}路径不属于此资产目录`);
  await safePath(root, location);
  if (!(await fs.lstat(location)).isFile()) throw new Error(`${label}文件不存在或不是普通文件`);
  return location;
}

const resolveCharacterModelFile = options => resolveCharacterFile(options, ["model", "skeletalMesh", "staticMesh"], "模型");
const resolveCharacterTextureFile = options => resolveCharacterFile(options, ["texture"], "贴图");

async function readSourcePackage(folder) {
  const inputs = Array.isArray(folder) ? folder : [folder];
  if (!inputs.length || inputs.some(value => typeof value !== "string" || !path.isAbsolute(value))) throw new Error("请选择更新文件或源文件夹");
  const files = [];
  const visited = new Set();
  async function visit(file) {
    const key = path.resolve(file).toLowerCase();
    if (visited.has(key)) return;
    visited.add(key);
    const info = await fs.lstat(file);
    if (info.isSymbolicLink()) throw new Error("部件源包含目录链接，请整理后重试：" + file);
    if (info.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name));
    } else if (info.isFile()) files.push({ sourcePath: file, size: info.size, mtimeMs: info.mtimeMs });
    else throw new Error("不支持的源文件：" + file);
    if (files.length > 10000) throw new Error("文件过多，请仅选择单个部件包");
  }
  for (const input of inputs) await visit(input);
  return files;
}

async function prepareComponentReplacement({ root: rootValue, asset, slot, sourceFolder, sourcePaths, analyzeModel }) {
  const { parent } = await loadParent(rootValue, asset);
  const part = listCharacterComponents(parent).find(item => item.slot === slot);
  if (!part) throw new Error("目标部件不存在，请刷新后选择");
  const scannedFiles = await readSourcePackage(sourcePaths || sourceFolder);
  const excludedFiles = scannedFiles.filter(file => !isAllowedCharacterPackageFile(file.sourcePath)).map(file => file.sourcePath);
  const files = scannedFiles.filter(file => isAllowedCharacterPackageFile(file.sourcePath));
  if (!files.length) throw new Error("更新内容为空");
  const models = files.filter(item => CHARACTER_MODEL_EXTENSIONS.has(path.extname(item.sourcePath).toLowerCase()) && !/_Physics$/i.test(normalized(item.sourcePath)));
  const modelAnalyses = new Map();
  for (const model of models) {
    const ext = path.extname(model.sourcePath).toLowerCase();
    const analysis = ext === ".fbx" ? await (analyzeModel || analyzeFbxInWorker)(model.sourcePath) : { meshKind: "staticMesh", hasSkeleton: false, hasSkin: false, boneCount: 0, skinnedMeshCount: 0 };
    if (analysis.error || !["staticMesh", "skeletalMesh"].includes(analysis.meshKind)) {
      throw new Error(`模型骨骼检查失败，未执行更新：${model.sourcePath}\n${analysis.error || "无法判断模型类型"}`);
    }
    modelAnalyses.set(path.resolve(model.sourcePath).toLowerCase(), analysis);
  }
  const primary = models.filter(item => !/_LOD[1-9]\d*$/i.test(normalized(item.sourcePath)));
  const primaryKinds = primary.map(item => modelAnalyses.get(path.resolve(item.sourcePath).toLowerCase())?.meshKind);
  if (new Set(primaryKinds).size !== primaryKinds.length) {
    throw new Error("同一部件的静态模型或骨骼模型各只能提供一个主版本；请移除重复文件后重试：\n" + primary.map(item => item.sourcePath).join("\n"));
  }
  const modelName = part.name;
  const subject = part.name.replace(/^(?:SK|SM)_/i, "");
  const destinations = new Set();
  const replacedModelPaths = new Set();
  const planned = files.map(file => {
    const ext = path.extname(file.sourcePath).toLowerCase();
    const token = normalized(file.sourcePath);
    const body = token.replace(/^(?:SK|SM|SKEL|MI|T)_/i, "").toLowerCase();
    if (!models.includes(file) && body !== subject.toLowerCase() && !body.startsWith(subject.toLowerCase() + "_") && !body.startsWith(subject.toLowerCase() + ".")) {
      throw new Error("无法归属到本次部件，请整理：" + file.sourcePath);
    }
    let role, folder;
    if (textureExtension.test(ext) && /^T_/i.test(token) && /_(?:D|N|ORM|A|E|Emissive)$/i.test(token)) { role = "texture"; folder = "Texture"; }
    else if (models.includes(file)) { role = modelAnalyses.get(path.resolve(file.sourcePath).toLowerCase()).meshKind; folder = role === "staticMesh" ? "Mesh/StaticMesh" : "Mesh/SkeletalMesh"; }
    else if (ext === ".uasset" && /^MI_/i.test(token)) { role = "material"; folder = "Material"; }
    else if (ext === ".uasset" && (/^SKEL_/i.test(token) || /_Physics$/i.test(token))) { role = /^SKEL_/i.test(token) ? "skeleton" : "physicsAsset"; folder = "Mesh/SkeletalMesh"; }
    else if (sourceExtension.test(ext)) { role = "other"; folder = "OtherFiles"; }
    else throw new Error("无法识别用途或版本的文件，请整理：" + file.sourcePath);
    const lod = require('../../shared/characterLods.cjs').suffix(token);
    const normalizedName = models.includes(file) ? `${role === "skeletalMesh" ? "SK" : "SM"}_${subject}${lod}${ext}` : token + ext;
    const relativePath = `${folder}/${normalizedName}`;
    if (destinations.has(relativePath.toLowerCase())) throw new Error("发现同用途的重复资源：" + normalizedName);
    destinations.add(relativePath.toLowerCase());
    const analysis = modelAnalyses.get(path.resolve(file.sourcePath).toLowerCase());
    const previousModel = analysis && part.files.find(item => !replacedModelPaths.has(item.storedPath)
      && require('../../shared/characterLods.cjs').level(item.normalizedName) === require('../../shared/characterLods.cjs').level(file.sourcePath)
      && (item.role === "skeletalMesh" ? "skeletalMesh" : ["model", "staticMesh"].includes(item.role) ? "staticMesh" : "") === role);
    if (previousModel) replacedModelPaths.add(previousModel.storedPath);
    return { ...file, normalizedName, role, ...(previousModel ? { replacesStoredPath: previousModel.storedPath } : {}), ...(analysis || {}), relativePath };
  });
  const previous = new Map(part.files.map(file => [file.normalizedName.toLowerCase(), file]));
  const changes = [];
  for (const file of planned) {
    file.sha256 = await fileHash(file.sourcePath);
    const before = file.replacesStoredPath ? part.files.find(item => item.storedPath === file.replacesStoredPath) : previous.get(file.normalizedName.toLowerCase());
    let beforeHash = "";
    if (before) {
      const stored = path.resolve(parent.path, before.storedPath);
      await safePath(path.resolve(rootValue), stored);
      beforeHash = await fileHash(stored);
    }
    changes.push({ name: file.normalizedName, status: !before ? "added" : file.sha256 === beforeHash ? "unchanged" : "changed" });
    if (beforeHash === file.sha256) file.reuseStoredPath = before.storedPath;
    if (before) previous.delete(before.normalizedName.toLowerCase());
  }
  require('./characterLodInvalidation').invalidateReplacedBaseLods(planned, previous, changes, part.files);
  for (const file of previous.values()) changes.push({ name: file.normalizedName, status: "retained" });
  require('../../shared/characterLods.cjs').validate([...planned, ...previous.values()]);
  const plan = { parentId: parent.id, slot, componentRole: part.role, sharedAcrossForms: part.sharedAcrossForms, formId: part.sharedAcrossForms ? "" : parent.meta.character?.formIds?.[0] || "", expectedRevision: part.currentRevision, parentRevision: parent.meta.characterComponents?.contentRevision || "initial", sourceFolder, sourcePaths, name: modelName, files: planned, excludedFiles, retainedFiles: [...previous.values()], changes, unchanged: changes.every(item => ["unchanged", "retained"].includes(item.status)) };
  return { ...plan, token: digest(plan) };
}

async function copyPreview(parent, source, revision) {
  if (!source) return "";
  if (!path.isAbsolute(source) || !/\.(png|jpg|jpeg|webp)$/i.test(source)) throw new Error("请选择 PNG / JPG / WebP 预览图");
  const info = await sharp(source).metadata();
  if (!info.width || !info.height) throw new Error("预览图无法解码");
  const relative = `Preview/component_${revision}${path.extname(source).toLowerCase()}`;
  await transactionalFs.mkdir(path.join(parent.path, "Preview"), { recursive: true });
  await transactionalFs.copyFile(source, path.join(parent.path, relative));
  return relative;
}

async function replaceCharacterComponent(options) {
  const note = String(options.note || "").trim();
  if (!note) throw new Error("请填写更新备注");
  const { root, parent } = await loadParent(options.root, options.asset);
  return withRecycleLock(root, () => withFileTransaction({ root, owner: "character-components", key: parent.metaPath }, async () => {
    const plan = await prepareComponentReplacement(options);
    if (!options.token || options.token !== plan.token) throw new Error("部件文件或关联版本已变化，请重新预检");
    if (plan.unchanged) return { ok: true, parentId: parent.id, unchanged: true, message: "文件内容没有变化，未创建版本；修改图片请使用更新预览" };
    const revision = crypto.randomUUID();
    const prefix = `Parts/${digest(plan.slot).slice(0, 16)}/${revision}`;
    const files = [...plan.retainedFiles];
    let completed = 0;
    for (const file of plan.files) {
      options.onProgress?.(10 + completed / plan.files.length * 60, `正在写入更新文件 ${completed + 1}/${plan.files.length}`);
      const storedPath = file.reuseStoredPath || `${prefix}/${file.relativePath}`;
      const destination = path.join(parent.path, storedPath);
      await safePath(root, destination, { missing: true });
      if (!file.reuseStoredPath) {
        await transactionalFs.mkdir(path.dirname(destination), { recursive: true });
        await transactionalFs.copyFile(file.sourcePath, destination);
      }
      if (await fileHash(destination) !== file.sha256) throw new Error("源文件在更新过程中变化，未发布：" + file.sourcePath);
      files.push({ sourcePath: file.sourcePath, originalName: path.basename(file.sourcePath), normalizedName: file.normalizedName, storedPath, role: file.role, size: file.size, sha256: file.sha256,
        rigNeedsUpdate: file.reuseStoredPath ? activeCharacterFiles(parent).find(item => item.storedPath === file.reuseStoredPath)?.rigNeedsUpdate : undefined,
        lodReset: file.lodReset, ignoreEmbeddedLods: file.ignoreEmbeddedLods,
        componentRole: plan.componentRole, sharedAcrossForms: plan.sharedAcrossForms, formId: plan.formId });
      completed++;
    }
    options.onProgress?.(75, '正在保存更新记录…');
    await safePath(root, path.join(parent.path, "Preview"), { missing: true });
    const previewUri = await copyPreview(parent, options.previewPath, revision);
    await updateAssetMetadataFile(parent.metaPath, async meta => {
      const state = meta.characterComponents || { schemaVersion: 1, slots: {} };
      const saved = state.slots?.[plan.slot] || {};
      if ((saved.activeRevision || state.baseRevision || "initial") !== plan.expectedRevision || (state.contentRevision || "initial") !== plan.parentRevision) throw new Error("主体已被其他操作更新，请重新预检");
      const at = new Date().toISOString();
      state.slots = { ...state.slots, [plan.slot]: { ...saved, activeRevision: revision, updatedAt: at,
        meshPreviews: listCharacterComponents({ ...parent, meta }).find(item => item.slot === plan.slot)?.meshPreviews || saved.meshPreviews,
        ...(previewUri ? { previewUri, previewRevision: revision, previewOrigin: "manual" } : {}),
        previewReloading: !previewUri && saved.previewOrigin === "rendered-front",
        revisions: [...(saved.revisions || []), { id: revision, name: plan.name, files: applyCharacterRigUpdateState(files, plan.changes), createdAt: new Date().toISOString() }] } };
      state.contentRevision = revision;
      if (parent.assetType === 'suit' && plan.files.some(file => ['model', 'staticMesh', 'texture'].includes(file.role)
        && plan.changes.some(change => change.name === file.normalizedName && ['added', 'changed'].includes(change.status)))) state.suitPreviewNeedsUpdate = true;
      if (parent.assetType !== 'suit') markCharacterAutomaticPreviewsReloading(meta, state);
      else delete state.autoPreviewPendingViews;
      meta.characterComponents = state;
      const part = listCharacterComponents(parent).find(item => item.slot === plan.slot);
      const label = require("../../shared/characterComponents.mjs").characterComponentLabel(part);
      const changeKind = plan.files.filter(file => plan.changes.some(change => change.name === file.normalizedName && ["added", "changed"].includes(change.status))).every(file => file.role === "texture") ? "贴图更新" : "资源更新";
      meta.characterManifest = { ...meta.characterManifest, contentUpdatedAt: at, lastUpdateSummary: `${label}${changeKind}` };
      const sourcePaths = plan.files.map(file => file.sourcePath);
      const historyFiles = plan.files.map((file, sourceIndex) => ({ name: file.normalizedName, status: plan.changes.find(change => change.name === file.normalizedName)?.status || "changed", sourcePath: file.sourcePath, sourceIndex, storedPath: file.storedPath }));
      meta.characterUpdateHistory = [...(meta.characterUpdateHistory || []), { id: revision, at, slot: plan.slot, label: `${label}${changeKind}`, note, changes: plan.changes, sourcePaths, files: historyFiles }];
      await syncActiveCharacterMetadata(meta, parent);
      meta.updatedAt = new Date().toISOString();
      return meta;
    });
    return { ok: true, parentId: parent.id, message: "部件已替换，旧版本保留；主体预览需要更新" };
  }));
}

async function updateCharacterComponentPreview(options) {
  if (options.automatic && options.meshKind) return updateCharacterMeshPreviews(options);
  const { root, parent } = await loadParent(options.root, options.asset);
  return withRecycleLock(root, () => withFileTransaction({ root, owner: "character-components", key: parent.metaPath }, async () => {
    const part = options.slot ? listCharacterComponents(parent).find(item => item.slot === options.slot) : null;
    if (options.slot && !part) throw new Error("目标部件不存在");
    if (options.automatic && (!part || !needsCharacterComponentPreview(part))) throw new Error("部件预览已由其他操作更新，自动拍摄不覆盖现有图片");
    const currentRevision = part?.currentRevision || parent.meta.characterComponents?.contentRevision || "initial";
    if (options.expectedRevision !== currentRevision) throw new Error("版本已变化，请重新选择预览");
    await safePath(root, path.join(parent.path, "Preview"), { missing: true });
    const previewUri = await copyPreview(parent, options.previewPath, crypto.randomUUID());
    if (!previewUri) throw new Error("请选择预览图");
    await updateAssetMetadataFile(parent.metaPath, async meta => {
      const state = meta.characterComponents || { schemaVersion: 1, slots: {} };
      const actualRevision = options.slot ? (state.slots?.[options.slot]?.activeRevision || state.baseRevision || "initial") : (state.contentRevision || "initial");
      if (actualRevision !== currentRevision) throw new Error("版本已变化，预览未覆盖");
      const latestPart = part ? listCharacterComponents({ ...parent, meta }).find(item => item.slot === part.slot) : null;
      if (options.automatic && (!latestPart || !needsCharacterComponentPreview(latestPart) || latestPart.previewUri !== options.expectedPreviewUri)) throw new Error("预览在拍摄期间已变化，请刷新后重试");
      if (part) state.slots = { ...state.slots, [part.slot]: { ...state.slots?.[part.slot], previewUri, previewRevision: currentRevision, previewOrigin: options.automatic ? "rendered-front" : "manual", previewReloading: false } };
      else {
        state.previewRevision = currentRevision;
        meta.previewImage = previewUri;
        meta.detailImage = previewUri;
        meta.previews = { ...meta.previews, images: [{ uri: previewUri, tags: ["preview", "cover"] }, ...(meta.previews?.images || []).map(item => ({ ...item, tags: (item.tags || []).filter(tag => tag !== "cover") }))] };
      }
      meta.characterComponents = state;
      const at = new Date().toISOString();
      appendCharacterUpdateHistory(meta, { at, slot: part?.slot, label: `${part ? characterComponentLabel(part) : ''}${options.automatic ? '自动' : ''}预览图更新`,
        changes: [{ name: "预览图", status: "changed", after: previewUri }], files: [{ name: path.basename(previewUri), status: "changed", sourcePath: options.previewPath || "", sourceIndex: options.previewPath ? 0 : -1, storedPath: previewUri }], sourcePaths: options.previewPath ? [options.previewPath] : [] });
      meta.updatedAt = at;
      return meta;
    });
    return { ok: true, parentId: parent.id, message: "预览已更新" };
  }));
}

async function updateCharacterMeshPreviews(options) {
  const { root, parent } = await loadParent(options.root, options.asset);
  const kind = options.meshKind;
  if (!['staticMesh', 'skeletalMesh'].includes(kind)) throw new Error('无效的模型预览类型');
  return withRecycleLock(root, () => withFileTransaction({ root, owner: 'character-components', key: parent.metaPath }, async () => {
    const part = listCharacterComponents(parent).find(item => item.slot === options.slot);
    const check = current => {
      if (current && characterMeshPreviewRevision(current.previewFiles || current.files, kind) === options.expectedRevision
        && !needsCharacterMeshPreview(current, kind)) return false;
      if (!current || characterMeshPreviewRevision(current.previewFiles || current.files, kind) !== options.expectedRevision
        || current.meshPreviews[kind].previewUri !== options.expectedPreviewUri) throw new Error('模型或预览已变化，请重新生成');
      return true;
    };
    if (!check(part)) return { ok: true, parentId: parent.id, message: '模型预览已是最新' };
    const views = ['front', 'left', 'right', 'back'];
    if (options.images?.length !== 4 || views.some(view => options.images.filter(image => image.view === view && image.sourcePath).length !== 1)) throw new Error('需要完整的四张模型预览');
    await safePath(root, path.join(parent.path, 'Preview'), { missing: true });
    const images = [];
    for (const view of views) images.push({ uri: await copyPreview(parent, options.images.find(image => image.view === view).sourcePath, `${kind}_${view}_${crypto.randomUUID()}`),
      tags: ['preview', `view:${view}`, 'origin:auto', ...(view === 'front' ? ['cover'] : [])] });
    await updateAssetMetadataFile(parent.metaPath, meta => {
      if (!check(listCharacterComponents({ ...parent, meta }).find(item => item.slot === options.slot))) return meta;
      const state = meta.characterComponents || { schemaVersion: 1, slots: {} };
      const slot = state.slots?.[options.slot] || {};
      const previous = listCharacterComponents({ ...parent, meta }).find(item => item.slot === options.slot)?.meshPreviews[kind];
      const previousImages = previous?.previewImages || [];
      const merged = previousImages.map(image => {
        if (!isAutomaticPreview(image)) return image;
        const replacement = images.find(item => previewView(item) === previewView(image));
        return replacement ? { ...image, uri: replacement.uri } : image;
      });
      for (const image of images) if (!merged.some(item => previewView(item) === previewView(image))) {
        merged.push({ ...image, tags: image.tags.filter(tag => tag !== 'cover') });
      }
      if (!merged.some(image => image.tags?.includes('cover'))) merged[0].tags.push('cover');
      const cover = merged.find(image => image.tags?.includes('cover'));
      const preview = { previewUri: cover.uri, previewImages: merged, previewRevision: options.expectedRevision, previewOrigin: previous?.previewOrigin === 'manual' ? 'manual' : 'rendered' };
      state.slots = { ...state.slots, [options.slot]: { ...slot, meshPreviews: { ...slot.meshPreviews, [kind]: preview } } };
      meta.characterComponents = state;
      appendCharacterUpdateHistory(meta, { slot: part.slot, label: `${characterComponentLabel(part)} ${kind === 'skeletalMesh' ? 'SK' : 'SM'} 四视图更新`,
        files: images.map(image => ({ name: path.basename(image.uri), storedPath: image.uri })) });
      return meta;
    });
    return { ok: true, parentId: parent.id, message: '模型四视图已更新' };
  }));
}

async function updateCharacterPreviewGallery(options) {
  const { root, parent } = await loadParent(options.root, options.asset, ["suit", "monster", "npc", "weapon", "item"]);
  const requested = Array.isArray(options.images) ? options.images.slice(0, 32) : [];
  if (requested.length !== (options.images || []).length) throw new Error("预览图数量超过 32 张");
  return withRecycleLock(root, () => withFileTransaction({ root, owner: "character-components", key: parent.metaPath }, async () => {
    const initialState = parent.meta?.characterComponents || { schemaVersion: 1, slots: {} };
    const initialPart = options.slot ? listCharacterComponents(parent).find(item => item.slot === options.slot) : null;
    const meshKind = options.meshKind;
    if (meshKind && (!initialPart || !['staticMesh', 'skeletalMesh'].includes(meshKind))) throw new Error('无效的模型预览类型');
    const initialSlot = meshKind ? initialPart.meshPreviews[meshKind] : options.slot ? (initialState.slots?.[options.slot] || (initialPart ? {
      activeRevision: initialPart.currentRevision,
      previewUri: initialPart.previewUri,
      previewImages: initialPart.previewImages,
      previewGalleryRevision: initialPart.previewGalleryRevision
    } : null)) : null;
    if (options.slot && !initialSlot) throw new Error("目标部件不存在");
    const currentImages = options.slot
      ? (Array.isArray(initialSlot?.previewImages) && initialSlot.previewImages.length
        ? initialSlot.previewImages
        : [initialSlot?.previewUri].filter(Boolean).map(uri => ({ uri, tags: ["preview", "view:front", "cover"] })))
      : (Array.isArray(parent.meta?.previews?.images) && parent.meta.previews.images.length
        ? parent.meta.previews.images
        : [parent.meta?.previewImage || parent.meta?.detailImage].filter(Boolean).map(uri => ({ uri, tags: ["preview", "view:front", "cover"] })));
    const requiredViews = ["front", "left", "right", "back"];
    for (const view of requiredViews) {
      const matches = requested.filter(item => Array.isArray(item?.tags) && item.tags.includes(`view:${view}`) && (String(item?.sourcePath || "").trim() || String(item?.uri || "").trim()));
      if (matches.length !== 1) throw new Error(`正／左／右／后四个预览槽位必须各保留一张图片（缺少或重复：${view}）`);
    }
    const currentByUri = new Map(currentImages.map(item => [String(item?.uri || "").trim(), item]).filter(([uri]) => uri));
    const seenExisting = new Set();
    const nextImages = [];
    for (const item of requested) {
      const oldUri = String(item?.uri || "").trim();
      const sourcePath = String(item?.sourcePath || "").trim();
      if (!sourcePath && (!oldUri || !currentByUri.has(oldUri) || seenExisting.has(oldUri))) throw new Error("预览图库已变化，请刷新后重试");
      if (oldUri) seenExisting.add(oldUri);
      const previous = currentByUri.get(oldUri) || {};
      const uri = sourcePath ? await copyPreview(parent, sourcePath, `gallery_${crypto.randomUUID()}`) : oldUri;
      const tags = [...new Set((Array.isArray(item?.tags) ? item.tags : previous.tags || []).map(tag => String(tag || "").trim()).filter(Boolean))]
        .filter(tag => tag !== "cover");
      if (sourcePath) {
        const autoIndex = tags.indexOf("origin:auto");
        if (autoIndex >= 0) tags.splice(autoIndex, 1);
        if (!tags.includes("origin:manual")) tags.push("origin:manual");
      }
      if (!tags.includes("preview")) tags.unshift("preview");
      const destination = path.resolve(parent.path, uri);
      const info = await fs.stat(destination).catch(() => null);
      nextImages.push({ ...previous, uri, tags, contentLength: info?.size || previous.contentLength || 0, resolution: previous.resolution || "unknown" });
    }
    const requestedCover = requested.findIndex(item => Array.isArray(item?.tags) && item.tags.includes("cover"));
    const coverIndex = nextImages.length ? (requestedCover >= 0 ? requestedCover : 0) : -1;
    if (coverIndex >= 0) nextImages[coverIndex].tags = [...new Set([...nextImages[coverIndex].tags, "cover"])];
    const finalUris = new Set(nextImages.map(item => item.uri));
    const referencedElsewhere = new Set();
    if (options.slot) {
      for (const item of parent.meta?.previews?.images || []) referencedElsewhere.add(String(item?.uri || "").trim());
    }
    for (const [slot, state] of Object.entries(initialState.slots || {})) {
      for (const [kind, preview] of Object.entries(state.meshPreviews || {})) {
        if (slot === options.slot && kind === meshKind) continue;
        for (const item of preview.previewImages || []) referencedElsewhere.add(item.uri);
        if (preview.previewUri) referencedElsewhere.add(preview.previewUri);
      }
      if (slot === options.slot && !meshKind) continue;
      for (const item of state?.previewImages || []) referencedElsewhere.add(String(item?.uri || "").trim());
      if (state?.previewUri) referencedElsewhere.add(String(state.previewUri).trim());
    }
    for (const current of currentImages) {
      const uri = String(current?.uri || "").trim();
      if (!uri || finalUris.has(uri) || referencedElsewhere.has(uri) || path.isAbsolute(uri)) continue;
      const normalizedUri = path.normalize(uri);
      if (normalizedUri.startsWith(`..${path.sep}`) || normalizedUri === ".." || normalizedUri.split(path.sep)[0].toLowerCase() !== "preview") continue;
      const target = path.resolve(parent.path, normalizedUri);
      await safePath(root, target);
      await transactionalFs.rm(target, { force: true });
    }
    await updateAssetMetadataFile(parent.metaPath, meta => {
      const state = meta.characterComponents || { schemaVersion: 1, slots: {} };
      const latestPart = options.slot ? listCharacterComponents({ ...parent, meta }).find(item => item.slot === options.slot) : null;
      const slot = options.slot ? (state.slots?.[options.slot] || (latestPart ? {
        activeRevision: latestPart.currentRevision,
        previewUri: latestPart.previewUri,
        previewImages: latestPart.previewImages,
        previewGalleryRevision: latestPart.previewGalleryRevision
      } : null)) : null;
      if (options.slot && !slot) throw new Error("目标部件不存在");
      const latestMesh = meshKind ? latestPart.meshPreviews[meshKind] : null;
      const actualRevision = latestMesh ? (latestMesh.previewGalleryRevision || latestMesh.previewRevision || latestPart.currentRevision) : options.slot
        ? (slot.previewGalleryRevision || slot.activeRevision || state.baseRevision || "initial")
        : characterGalleryRevision(meta);
      if (actualRevision !== options.expectedRevision) throw new Error("预览图库已变化，请刷新后重试");
      if (options.suitPreviewRevision && (options.slot || state.contentRevision !== options.suitPreviewRevision)) throw new Error('模型在拍摄期间已更新，请重新生成四视图');
      if (meshKind) {
        state.slots = { ...state.slots, [options.slot]: { ...slot, meshPreviews: { ...latestPart.meshPreviews, [meshKind]: {
          ...latestMesh, previewImages: nextImages, previewUri: nextImages[coverIndex].uri,
          previewRevision: characterMeshPreviewRevision(latestPart.previewFiles || latestPart.files, meshKind), previewGalleryRevision: crypto.randomUUID(), previewOrigin: 'manual'
        } } } };
      } else if (options.slot) {
        const currentRevision = slot.activeRevision || state.baseRevision || "initial";
        state.slots = { ...state.slots, [options.slot]: { ...slot, previewImages: nextImages,
          previewUri: nextImages[coverIndex].uri, previewRevision: currentRevision,
          previewGalleryRevision: crypto.randomUUID(), previewOrigin: "manual", previewReloading: false } };
      } else {
        meta.previews = { ...meta.previews, images: nextImages };
        meta.previewImage = nextImages[coverIndex].uri;
        meta.detailImage = nextImages[coverIndex].uri;
        state.previewRevision = state.contentRevision || "initial";
        state.previewGalleryRevision = crypto.randomUUID();
        delete state.autoPreviewPendingViews;
        if (options.suitPreviewRevision) state.suitPreviewNeedsUpdate = false;
      }
      meta.characterComponents = state;
      const at = new Date().toISOString();
      const coverOnly = !requested.some(item => item.sourcePath) && currentImages.length === nextImages.length
        && currentImages.every((item, index) => item.uri === nextImages[index].uri
          && JSON.stringify((item.tags || []).filter(tag => tag !== 'cover').sort()) === JSON.stringify(nextImages[index].tags.filter(tag => tag !== 'cover').sort()));
      const galleryAction = coverOnly ? '更换主图' : '预览图库更新';
      const galleryLabel = options.slot ? `${characterComponentLabel(latestPart)}${galleryAction}` : galleryAction;
      appendCharacterUpdateHistory(meta, { at, slot: options.slot, label: galleryLabel,
        changes: [{ name: "预览图库", status: "changed", after: `${nextImages.length} 张` }],
        sourcePaths: requested.map(item => String(item?.sourcePath || "")).filter(Boolean),
        files: nextImages.map(item => ({ name: path.basename(item.uri), status: "changed", sourcePath: "", sourceIndex: -1, storedPath: item.uri })) });
      meta.updatedAt = at;
      return meta;
    });
    return { ok: true, parentId: parent.id, message: options.slot ? "部件预览图库已更新" : "预览图库已更新" };
  }));
}

async function updateCharacterAutomaticPreviews(options) {
  const { root, parent } = await loadParent(options.root, options.asset, ["suit", "monster", "npc", "weapon", "item"]);
  const requested = Array.isArray(options.images) ? options.images : [];
  const requestedByView = new Map(requested.map(item => [String(item?.view || ""), String(item?.sourcePath || "")]).filter(([view, source]) => view && source));
  return withRecycleLock(root, () => withFileTransaction({ root, owner: "character-components", key: parent.metaPath }, async () => {
    const initialState = parent.meta.characterComponents || { schemaVersion: 1, slots: {} };
    const pending = characterGroomPendingPreviewViews(parent).length ? characterGroomPendingPreviewViews(parent) : parent.assetType === 'suit' && !parent.meta.character?.variant ? characterSuitPendingPreviewViews(parent)
      : Array.isArray(initialState.autoPreviewPendingViews) ? initialState.autoPreviewPendingViews : [];
    if (!pending.length || (initialState.contentRevision || "initial") !== options.expectedRevision) throw new Error("自动预览任务已过期，请刷新");
    for (const view of pending) if (!requestedByView.has(view)) throw new Error(`缺少 ${view} 自动预览`);
    const copied = new Map();
    for (const view of pending) copied.set(view, await copyPreview(parent, requestedByView.get(view), `auto_${view}_${crypto.randomUUID()}`));
    await updateAssetMetadataFile(parent.metaPath, meta => {
      const state = meta.characterComponents || { schemaVersion: 1, slots: {} };
      const latestPending = characterGroomPendingPreviewViews({ ...parent, meta }).length ? characterGroomPendingPreviewViews({ ...parent, meta }) : parent.assetType === 'suit' && !parent.meta.character?.variant ? characterSuitPendingPreviewViews({ ...parent, meta })
        : Array.isArray(state.autoPreviewPendingViews) ? state.autoPreviewPendingViews : [];
      if ((state.contentRevision || "initial") !== options.expectedRevision || latestPending.join("|") !== pending.join("|")) throw new Error("预览在拍摄期间已变化，请刷新后重试");
      const current = Array.isArray(meta.previews?.images) ? meta.previews.images : [];
      const replaced = new Set();
      const images = current.map(item => {
        const view = previewView(item);
        if (!pending.includes(view) || !isAutomaticPreview(item)) return item;
        replaced.add(view);
        return { ...item, uri: copied.get(view), tags: [...new Set([...(item.tags || []).filter(tag => tag !== "origin:manual"), "origin:auto"])] };
      });
      for (const view of pending) if (!replaced.has(view)) images.push({ uri: copied.get(view), tags: ["preview", `view:${view}`, "origin:auto"] });
      if (images.length && !images.some(item => (item.tags || []).includes("cover"))) images[0].tags = [...new Set([...(images[0].tags || []), "cover"])];
      const cover = images.find(item => (item.tags || []).includes("cover")) || images[0];
      meta.previews = { ...meta.previews, images };
      if (cover?.uri) { meta.previewImage = cover.uri; meta.detailImage = cover.uri; }
      state.previewRevision = state.contentRevision || "initial";
      state.previewGalleryRevision = crypto.randomUUID();
      delete state.autoPreviewPendingViews;
      if (parent.assetType === 'suit') {
        state.suitPreviewNeedsUpdate = false;
        state.suitMaterialPreviewRevision = characterMeshPreviewRevision(activeCharacterFiles({ ...parent, meta }), 'staticMesh');
      }
      meta.characterComponents = state;
      const at = new Date().toISOString();
      appendCharacterUpdateHistory(meta, { at, label: "自动预览图更新", changes: pending.map(view => ({ name: view, status: "changed", after: copied.get(view) })),
        files: pending.map(view => ({ name: path.basename(copied.get(view)), status: "changed", sourcePath: requestedByView.get(view), sourceIndex: -1, storedPath: copied.get(view) })) });
      meta.updatedAt = at;
      return meta;
    });
    return { ok: true, parentId: parent.id, message: "自动预览已重新拍摄" };
  }));
}

async function selectCharacterComponentRevision(options) {
  const { root, parent } = await loadParent(options.root, options.asset);
  return withRecycleLock(root, async () => {
    const part = listCharacterComponents(parent).find(item => item.slot === options.slot);
    if (!part || part.currentRevision !== options.expectedRevision) throw new Error("部件版本已变化，请刷新");
    const revision = part.revisions.find(item => item.id === options.revisionId);
    if (!revision) throw new Error("旧版本不存在");
    for (const file of revision.files) await safePath(root, path.join(parent.path, file.storedPath));
    await updateAssetMetadataFile(parent.metaPath, async meta => {
      const state = meta.characterComponents || { schemaVersion: 1, slots: {} };
      if ((state.slots?.[part.slot]?.activeRevision || state.baseRevision || "initial") !== options.expectedRevision) throw new Error("部件已被其他操作更新");
      state.slots = { ...state.slots, [part.slot]: { ...state.slots?.[part.slot], activeRevision: revision.id } };
      state.contentRevision = crypto.randomUUID();
      if (parent.assetType === 'suit') state.suitPreviewNeedsUpdate = true;
      meta.characterComponents = state;
      await syncActiveCharacterMetadata(meta, parent);
      const at = new Date().toISOString();
      appendCharacterUpdateHistory(meta, { at, slot: part.slot, label: `${characterComponentLabel(part)}版本切换`,
        changes: [{ name: part.name, status: "changed", before: options.expectedRevision, after: revision.id }] });
      meta.updatedAt = at;
      return meta;
    });
    return { ok: true, parentId: parent.id, message: "部件关联已切换，主体预览需要更新" };
  });
}

async function updateCharacterPreviewBatch(options) {
  if (!['suit', 'monster', 'npc', 'weapon', 'item'].includes(options.asset?.assetType) || !Array.isArray(options.previewBatch) || !options.previewBatch.length || options.previewBatch.length > 128) throw new Error('无效的角色预览任务');
  const previewErrors = [];
  for (let i = 0; i < options.previewBatch.length; i++) {
    const item = options.previewBatch[i];
    options.onProgress?.(10 + i / options.previewBatch.length * 65, `正在保存预览 ${i + 1}/${options.previewBatch.length}`);
    try {
      const args = { root: options.root, asset: options.asset, slot: item.slot, meshKind: item.meshKind,
        expectedRevision: item.expectedRevision, expectedPreviewUri: item.expectedPreviewUri, images: item.images, automatic: true };
      if (item.slot) await updateCharacterMeshPreviews(args);
      else await updateCharacterAutomaticPreviews(args);
    } catch (error) { previewErrors.push(String(error.message || error)); }
  }
  // Partial successes are refreshed too; failed views remain pending for retry.
  return { ok: true, parentId: options.asset.id, previewErrors };
}
module.exports = { updateCharacterPreviewBatch, updateCharacterStatus, prepareComponentReplacement, replaceCharacterComponent, updateCharacterComponentPreview, updateCharacterPreviewGallery, updateCharacterAutomaticPreviews, markCharacterAutomaticPreviewsReloading, selectCharacterComponentRevision, loadParent, readSourcePackage, copyPreview, fileHash, syncActiveCharacterMetadata, resolveCharacterModelFile, resolveCharacterTextureFile };
