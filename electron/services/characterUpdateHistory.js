const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { updateAssetMetadataFile } = require("./assetMetadata");

function appendCharacterUpdateHistory(meta, input = {}) {
  const at = input.at || new Date().toISOString();
  const label = String(input.label || "资产更新").trim() || "资产更新";
  const entry = {
    id: input.id || crypto.randomUUID(), at, label,
    ...(String(input.note || "").trim() ? { note: String(input.note).trim() } : {}),
    changes: Array.isArray(input.changes) ? input.changes : [],
    sourcePaths: Array.isArray(input.sourcePaths) ? input.sourcePaths : [],
    files: Array.isArray(input.files) ? input.files : [],
    ...(input.slot ? { slot: input.slot } : {}),
    ...(input.details ? { details: input.details } : {})
  };
  meta.characterUpdateHistory = [...(Array.isArray(meta.characterUpdateHistory) ? meta.characterUpdateHistory : []), entry];
  if (meta.characterManifest) meta.characterManifest = { ...meta.characterManifest, contentUpdatedAt: at, lastUpdateSummary: label };
  return entry;
}

// Identity is scoped: Hair001 for M01 is not Hair001 for F01 or Face001.
function characterIdentity(type, fields = {}, name = "") {
  const token = value => String(value || "").trim().toLowerCase();
  if (type === "suit") {
    const variant = fields.variant || "outfit";
    const values = [fields.gender, fields.bodyCode, variant, fields.serial];
    if (!/^(Hair|Face)$/.test(variant)) values.push(fields.suitClass);
    return values.every(Boolean) ? [type, ...values.map(token)].join(":") : "";
  }
  if (type === 'npc') {
    if (fields.category && fields.name && fields.formIds?.length === 1) {
      return [type, token(fields.category), token(fields.name), token(fields.formIds[0])].join(':');
    }
    // Existing NPC records keep their legacy category + serial identity until
    // they are explicitly re-imported under the form-based rule.
    return fields.category && fields.serial ? [type, token(fields.category), token(fields.serial)].join(':') : (name ? `${type}:${token(name)}` : '');
  }
  if (type === "weapon") {
    const category = fields.weaponType || fields.category;
    return category && fields.serial ? [type, token(category), token(fields.serial)].join(":") : (name ? `${type}:${token(name)}` : "");
  }
  if (type === "monster") return fields.name && fields.formIds?.length ? [type, token(fields.name), ...fields.formIds.map(token)].join(":") : "";
  return "";
}

async function resolveHistorySource(parent, root, historyId, sourceIndex) {
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0) throw new Error("来源记录不存在");
  const entry = (parent.meta.characterUpdateHistory || []).find(item => item.id === historyId);
  const legacyFile = historyId === "legacy-current" ? parent.meta.characterManifest?.files?.[sourceIndex] : null;
  if (!entry && !legacyFile) throw new Error("来源记录不存在");
  const source = entry?.sourcePaths?.[sourceIndex] || legacyFile?.originalPath || legacyFile?.sourcePath;
  if (!source || !path.isAbsolute(source)) throw new Error("没有记录原始来源位置");
  const relative = path.relative(path.resolve(root), path.resolve(source));
  if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("此记录指向库内副本，不是原始素材");
  const info = await fs.lstat(source).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink()) throw new Error("原始文件已移动、删除或不可访问；历史路径仍保留：" + source);
  return source;
}

async function relinkHistorySource({ root, asset, historyId, sourceIndex, sourcePath }) {
  const { parent } = await require("./characterComponents").loadParent(root, asset, ["suit", "monster", "npc", "weapon"]);
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0) throw new Error("来源记录不存在");
  const nextSource = path.resolve(String(sourcePath || ""));
  const info = await fs.lstat(nextSource).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error("请选择可访问的原始文件");
  const relative = path.relative(path.resolve(root), nextSource);
  if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("历史来源不能重定向到 AssetHive 管理副本");
  await updateAssetMetadataFile(parent.metaPath, meta => {
    const history = Array.isArray(meta.characterUpdateHistory) ? meta.characterUpdateHistory : [];
    let entryIndex = history.findIndex(item => item.id === historyId);
    let entry = entryIndex >= 0 ? history[entryIndex] : null;
    if (!entry && historyId === "legacy-current") {
      const manifestFiles = Array.isArray(meta.characterManifest?.files) ? meta.characterManifest.files : [];
      if (sourceIndex >= manifestFiles.length) throw new Error("来源记录不存在");
      const sourcePaths = manifestFiles.map(file => String(file.originalPath || file.sourcePath || ""));
      entry = {
        id: "legacy-current",
        at: meta.characterManifest?.contentUpdatedAt || meta.characterManifest?.confirmedAt || meta.updatedAt || meta.createdAt || new Date().toISOString(),
        label: "当前版本（历史功能启用前入库）",
        legacy: true,
        sourcePaths,
        files: manifestFiles.map((file, index) => ({
          name: String(file.normalizedName || file.originalName || path.basename(file.storedPath || "") || `文件 ${index + 1}`),
          status: "current",
          sourcePath: sourcePaths[index],
          sourceIndex: index,
          storedPath: file.storedPath
        }))
      };
      entryIndex = history.length;
    }
    if (!entry || !Array.isArray(entry.sourcePaths) || sourceIndex >= entry.sourcePaths.length) throw new Error("来源记录不存在");
    const previous = String(entry.sourcePaths[sourceIndex] || "");
    const expectedName = entry.files?.find(file => Number(file.sourceIndex) === sourceIndex)?.name || "";
    const expectedExtension = path.extname(previous || expectedName);
    if (expectedExtension && expectedExtension.toLowerCase() !== path.extname(nextSource).toLowerCase()) throw new Error("重新定位的文件格式与历史记录不一致");
    const sourcePaths = [...entry.sourcePaths];
    sourcePaths[sourceIndex] = nextSource;
    const nextHistory = [...history];
    const files = Array.isArray(entry.files) ? entry.files.map(file => Number(file.sourceIndex) === sourceIndex ? { ...file, sourcePath: nextSource } : file) : entry.files;
    nextHistory[entryIndex] = { ...entry, sourcePaths, ...(files ? { files } : {}), sourceRelinkedAt: new Date().toISOString() };
    meta.characterUpdateHistory = nextHistory;
    appendCharacterUpdateHistory(meta, { label: "历史来源重新定位", details: { historyId, sourceIndex, previous, next: nextSource } });
    meta.updatedAt = new Date().toISOString();
    return meta;
  });
  return { ok: true, parentId: parent.id, message: "历史来源已重新定位" };
}

module.exports = { appendCharacterUpdateHistory, characterIdentity, resolveHistorySource, relinkHistorySource };
