const { deriveSourceIdentity, normalizeSourceToken } = require("./assetIdentity");

function normalizeTypeToken(value) {
  return String(value || "").trim().toLowerCase();
}

// 库内资产的身份可能来自内存索引，也可能来自 SQL 快照缓存（不保存 identity），
// 因此这里只负责「比较」，磁盘回读由调用方按需触发。
function evaluateSourceMatch({
  incomingSource,
  incomingName,
  incomingType,
  storedSource,
  targetName,
  targetType
}) {
  const normalizedTargetName = normalizeSourceToken(targetName);
  const normalizedTargetType = normalizeTypeToken(targetType);
  const normalizedIncomingName = String(incomingName || "").trim();
  const normalizedIncomingType = normalizeTypeToken(incomingType);
  const nameMatches = Boolean(normalizedTargetName && normalizedTargetName === normalizedIncomingName);
  const typeMatches = Boolean(normalizedTargetType && normalizedTargetType === normalizedIncomingType);
  const sameSourceKey = Boolean(incomingSource?.sourceKey && storedSource?.sourceKey === incomingSource.sourceKey);
  const sameSourceFamilyAndName = Boolean(
    storedSource?.sourceKind && storedSource.sourceKind === incomingSource?.sourceKind && nameMatches
  );
  return {
    nameMatches,
    typeMatches,
    sameSourceKey,
    sameSourceFamilyAndName,
    isExactSource: sameSourceKey || sameSourceFamilyAndName
  };
}

// 从磁盘 asset_info.json 还原来源身份；缺少有效 sourceKey 时返回 null，
// 调用方继续使用内存索引里的兜底身份。
function deriveStoredSourceIdentityFromMetadata(diskMeta, fallback = {}) {
  const meta = diskMeta && typeof diskMeta === "object" && !Array.isArray(diskMeta) ? diskMeta : null;
  const identity = meta?.identity && typeof meta.identity === "object" && !Array.isArray(meta.identity)
    ? meta.identity
    : null;
  if (!identity || !String(identity.sourceKey || "").trim()) {
    return null;
  }
  return deriveSourceIdentity({
    assetName: String(meta.name || fallback.name || "").trim(),
    assetType: String(meta.assetType || meta.asset_type || fallback.assetType || "3d").trim(),
    standardAssetTags: Array.isArray(meta.standardAssetTags)
      ? meta.standardAssetTags
      : fallback.standardAssetTags,
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    sourceIdentity: identity
  });
}

module.exports = { evaluateSourceMatch, deriveStoredSourceIdentityFromMetadata };
