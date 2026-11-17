const path = require("node:path");

const ID_PATTERNS = [
  /^8bit[_-]?t[_-](\d{3,8})(?:[_-]|$)/i,
  /^t[_-](\d{3,8})(?:[_-]|$)/i,
  /^pbrmax[_-](\d{3,8})(?:[_-]|$)/i,
  /^(\d{3,8})(?:[_-]|[a-z])/i
];
const FOLDER_PATTERNS = [
  /^pbrmax[_-](\d{3,8})(?:[_-]|$)/i,
  /^(\d{3,8})(?:[_-][a-z]|$)/i
];

function normalizeLookupText(value) {
  return String(value || "").trim().replace(/[\s_-]+/g, "").toLowerCase();
}

function isPbrMaxSource(standardAssetTags, tags) {
  return [...(Array.isArray(standardAssetTags) ? standardAssetTags : []), ...(Array.isArray(tags) ? tags : [])]
    .some((value) => normalizeLookupText(value) === "pbrmax");
}

function normalizeSourceAssetId(value) {
  const token = String(value || "").trim();
  if (!/^\d{3,8}$/.test(token)) return "";
  const numeric = Number(token);
  if (Number.isFinite(numeric) && numeric >= 1001 && numeric <= 1999) {
    return "";
  }
  return token;
}

function matchSourceAssetId(value, patterns) {
  const text = String(value || "").trim();
  if (!text) return "";
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const normalized = normalizeSourceAssetId(match?.[1]);
    if (normalized) return normalized;
  }
  return "";
}

function fileStem(filePath) {
  const normalized = String(filePath || "").trim();
  if (!normalized) return "";
  return path.basename(normalized, path.extname(normalized));
}

function resolvePbrMaxSourceAssetId(input = {}) {
  if (!isPbrMaxSource(input.standardAssetTags, input.tags)) {
    return "";
  }
  const counts = new Map();
  const firstOrder = new Map();
  let order = 0;
  const record = (sourceAssetId) => {
    if (!sourceAssetId) return;
    if (!counts.has(sourceAssetId)) {
      counts.set(sourceAssetId, 0);
      firstOrder.set(sourceAssetId, order++);
    }
    counts.set(sourceAssetId, counts.get(sourceAssetId) + 1);
  };

  for (const filePath of Array.isArray(input.filePaths) ? input.filePaths : []) {
    record(matchSourceAssetId(fileStem(filePath), ID_PATTERNS));
  }
  for (const folderName of Array.isArray(input.folderNames) ? input.folderNames : []) {
    record(matchSourceAssetId(String(folderName || "").trim(), FOLDER_PATTERNS));
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || firstOrder.get(left[0]) - firstOrder.get(right[0]))[0]?.[0] || "";
}

module.exports = {
  resolvePbrMaxSourceAssetId
};
