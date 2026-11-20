const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { loadParent } = require("./characterComponents");
const { updateAssetMetadataFile } = require("./assetMetadata");
const { withRecycleLock } = require("./libraryRecycle");
const { transactionalFs, withFileTransaction } = require("./assetFileTransaction");
const { normalizeCharacterNames, validCharacterChineseName, hasCharacterEnginePath } = require("../../shared/characterNames.mjs");
const { buildCharacterAssetName } = require("./characterImport");
const { gameplayIdentity, gameplayPrefix } = require('../../shared/gameplayNaming.mjs');
const { appendCharacterUpdateHistory } = require("./characterUpdateHistory");

const sourceIdentityKeys = new Set(["originalName", "originalPath", "sourcePath", "sourcePaths", "assetID", "id", "entityKey", "relatedAssetIds", "enginePath", "characterUnrealExports", "characterUEIntake"]);
const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizeRelative = value => String(value || "").replace(/\\/g, "/");

async function collectManagedRenames(parent, oldName, newName) {
  const renames = [];
  const matcher = new RegExp(escapeRegExp(oldName), "ig");
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);
      const info = await fs.lstat(source);
      if (info.isSymbolicLink()) throw new Error("资产目录包含链接，不能安全改名：" + source);
      if (info.isDirectory()) await visit(source);
      else if (info.isFile() && entry.name !== "asset_info.json" && matcher.test(entry.name)) {
        matcher.lastIndex = 0;
        const destination = path.join(directory, entry.name.replace(matcher, newName));
        matcher.lastIndex = 0;
        if (source.toLowerCase() !== destination.toLowerCase()) renames.push({ source, destination });
      }
      matcher.lastIndex = 0;
    }
  }
  await visit(parent.path);
  const sources = new Set(renames.map(item => path.resolve(item.source).toLowerCase()));
  const destinations = new Set();
  for (const item of renames) {
    const key = path.resolve(item.destination).toLowerCase();
    if (destinations.has(key)) throw new Error("改名后出现重复文件：" + item.destination);
    destinations.add(key);
    const existing = await fs.lstat(item.destination).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
    if (existing && !sources.has(key)) throw new Error("改名目标已存在：" + item.destination);
  }
  return renames;
}

function remapManagedMetadata(value, key, oldName, newName, parentPath, relativeRenames, absoluteRenames) {
  if (sourceIdentityKeys.has(key)) return value;
  if (Array.isArray(value)) return value.map(item => remapManagedMetadata(item, key, oldName, newName, parentPath, relativeRenames, absoluteRenames));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
    // Preview/revision slots use the lower-case model name as their dictionary key.
    // Keep the saved state attached to the renamed model; its contents did not change.
    key === "slots" ? childKey.replace(new RegExp(escapeRegExp(oldName), "ig"), newName.toLowerCase()) : childKey,
    remapManagedMetadata(child, childKey, oldName, newName, parentPath, relativeRenames, absoluteRenames)
  ]));
  if (typeof value !== "string") return value;
  const normalized = normalizeRelative(value);
  const absolute = absoluteRenames.get(path.resolve(value).toLowerCase());
  if (absolute) return absolute;
  const relative = relativeRenames.get(normalized.toLowerCase());
  if (relative) return value.includes("\\") ? relative.replace(/\//g, "\\") : relative;
  return value.replace(new RegExp(escapeRegExp(oldName), "ig"), newName);
}

async function updateCharacterNames(options) {
  if (!validCharacterChineseName(options.displayNameZh)) throw new Error("中文名必须包含汉字，且不超过32字");
  const names = normalizeCharacterNames(options);
  if (options.nameConfirmed !== true) throw new Error('请核对中文名和英文名并勾选确认');
  const { root, parent } = await loadParent(options.root, options.asset, ["suit", "monster", "npc", "weapon", "item"]);
  const modernItem = parent.assetType === 'item' && Boolean(gameplayPrefix(parent.meta.category));
  const itemIdentity = modernItem ? gameplayIdentity(parent.meta.category, names.displayNameEn) : null;
  if (modernItem ? !itemIdentity.assetName : !require('../../shared/characterNames.mjs').validCharacterEnglishName(names.displayNameEn)) throw new Error('请填写有效的英文名或数字资源 ID');
  if (itemIdentity) names.displayNameEn = itemIdentity.name;
  const previousFields = parent.meta.character || {};
  const independentPart = parent.assetType === 'suit' && ['Hair', 'Face'].includes(previousFields.variant);
  const namingFields = independentPart ? names : { ...names, [parent.assetType === 'suit' ? 'suitName' : 'name']: names.displayNameEn };
  const nextFields = { ...previousFields, ...namingFields };
  const oldAssetName = String(parent.meta.name || parent.name || "").trim();
  if (!oldAssetName) throw new Error("当前角色资产缺少规范资产名，请刷新或先修复元数据");
  // Hair/Face keep their independent numbered identity. Other families keep
  // their category/serial/form identity while changing only the name token.
  const oldToken = parent.assetType === 'suit' || modernItem ? oldAssetName : String(previousFields.name || '').trim();
  if (!oldToken) throw new Error('缺少原名称字段，无法确定改名范围');
  const newToken = parent.assetType === 'suit' ? buildCharacterAssetName('suit', nextFields) : modernItem ? itemIdentity.assetName : names.displayNameEn;
  const newAssetName = parent.assetType === 'suit' ? newToken : oldAssetName.replace(new RegExp(escapeRegExp(oldToken), 'ig'), newToken);
  if (!newAssetName) throw new Error("英文名无法生成有效的规范资产名称");
  if (options.expectedAssetName && oldAssetName !== options.expectedAssetName) throw new Error("资产名称已变化，请刷新后重试");
  return withRecycleLock(root, () => withFileTransaction({ root, owner: "character-names", key: parent.metaPath }, async () => {
    const renames = await collectManagedRenames(parent, oldToken, newToken);
    const relativeRenames = new Map(renames.map(item => [normalizeRelative(path.relative(parent.path, item.source)).toLowerCase(), normalizeRelative(path.relative(parent.path, item.destination))]));
    const absoluteRenames = new Map(renames.map(item => [path.resolve(item.source).toLowerCase(), path.resolve(item.destination)]));
    for (const item of renames) await transactionalFs.rename(item.source, item.destination);
    await updateAssetMetadataFile(parent.metaPath, meta => {
      if (String(meta.assetID || meta.id) !== parent.id) throw new Error("资产 ID 已变化");
      if (String(meta.character?.displayNameZh || "") !== String(options.expectedName || "")) throw new Error("中文名已变更，请刷新后重试");
      if (options.expectedEnglishName !== undefined && String(meta.character?.displayNameEn || '') !== options.expectedEnglishName) throw new Error('英文名已变更，请刷新后重试');
      const previousHistory = Array.isArray(meta.characterUpdateHistory) ? meta.characterUpdateHistory : [];
      const remapped = remapManagedMetadata({ ...meta, characterUpdateHistory: undefined }, "", oldToken, newToken, parent.path, relativeRenames, absoluteRenames);
      remapped.name = newAssetName;
      remapped.character = { ...remapped.character, ...namingFields };
      if (!hasCharacterEnginePath(meta)) {
        delete remapped.character.ueNameSyncPending;
      } else if (names.displayNameEn !== String(meta.character?.displayNameEn ?? meta.character?.suitName ?? meta.character?.name ?? "")) {
        remapped.character.ueNameSyncPending = randomUUID();
      }
      if (remapped.characterManifest) remapped.characterManifest = { ...remapped.characterManifest, fields: { ...remapped.characterManifest.fields, ...namingFields } };
      remapped.characterPackageHistory = Array.isArray(remapped.characterPackageHistory) ? remapped.characterPackageHistory.map(entry => {
        const snapshot = { ...(entry.snapshot || {}) };
        snapshot.name = newAssetName;
        if (snapshot.character) snapshot.character = { ...snapshot.character, ...namingFields };
        if (snapshot.characterManifest) snapshot.characterManifest = { ...snapshot.characterManifest, fields: { ...snapshot.characterManifest.fields, ...namingFields } };
        return { ...entry, snapshot };
      }) : remapped.characterPackageHistory;
      remapped.characterUpdateHistory = previousHistory.map(entry => ({ ...entry, files: Array.isArray(entry.files) ? entry.files.map(file => ({ ...file,
        storedPath: relativeRenames.get(normalizeRelative(file.storedPath).toLowerCase()) || file.storedPath })) : entry.files }));
      const at = new Date().toISOString();
      const changes = [{ name: "中文名", status: "changed", before: String(meta.character?.displayNameZh || ""), after: names.displayNameZh },
        { name: "英文名", status: "changed", before: String(meta.character?.displayNameEn || ""), after: names.displayNameEn },
        { name: "规范资产名", status: "changed", before: oldAssetName, after: newAssetName },
        ...renames.map(item => ({ name: path.basename(item.destination), status: "changed", before: path.basename(item.source), after: path.basename(item.destination) }))];
      appendCharacterUpdateHistory(remapped, { at, label: `名称更新：${names.displayNameZh} / ${names.displayNameEn}`, changes,
        files: renames.map(item => ({ name: path.basename(item.destination), status: "changed", sourcePath: "", sourceIndex: -1, storedPath: normalizeRelative(path.relative(parent.path, item.destination)), previousName: path.basename(item.source) })),
        details: { previousDisplayNameZh: String(meta.character?.displayNameZh || ""), displayNameZh: names.displayNameZh, previousAssetName: oldAssetName, assetName: newAssetName } });
      remapped.updatedAt = at;
      return remapped;
    });
    return { ok: true, parentId: parent.id, assetName: newAssetName, renamedFiles: renames.length, ...names, message: `中英文名已更新，${renames.length} 个管理文件已按英文名重命名` };
  }));
}
module.exports = { updateCharacterNames };
