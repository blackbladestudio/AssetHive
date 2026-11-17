const { toAssetIndexRecord } = require("./assetListRecord");

const PROJECTION = "resident-v1";

function getResidentMemoPath(file) {
  return /\.json\.gz$/i.test(file) ? file.replace(/\.json\.gz$/i, ".resident.json.gz") : `${file}.resident.json.gz`;
}

function compactScanRecord(record) {
  if (!record?.id) return record;
  const resident = toAssetIndexRecord(record);
  // The scanner also checks historical Atlas/Imperfection classification.
  // Keep this hint in its private projection, out of the UI/main index.
  const classification = record.meta?.sourceClassification;
  if (classification && resident.meta.sourceClassification !== classification) {
    return { ...resident, meta: { ...resident.meta, sourceClassification: classification } };
  }
  return resident;
}

function compactScanMemoEntry(entry) {
  return entry?.record ? { ...entry, record: compactScanRecord(entry.record) } : entry;
}

function sameSourceStamp(left, right) {
  return left == null && right == null || Boolean(left && right && left.size === right.size && left.mtimeMs === right.mtimeMs);
}

module.exports = { PROJECTION, getResidentMemoPath, compactScanRecord, compactScanMemoEntry, sameSourceStamp };
