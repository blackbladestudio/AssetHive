function normalizeAssetTag(value) {
  const tag = String(value || "").replace(/\s+/gu, "");
  return /^pbrmax$/i.test(tag) ? "PBRMAX" : tag;
}

function normalizeStandardAssetTag(value) {
  const tag = String(value || "").trim();
  if (/^(mega|mask)$/i.test(tag)) return "";
  if (/^tile$/i.test(tag)) return "";
  if (/^micro(?:[\s_-]*foliage)?$/i.test(tag)) return "Micro";
  return /^(megascans|pbrmax|thirdparty)$/i.test(tag) ? "ThirdParty" : tag;
}

module.exports = { normalizeAssetTag, normalizeStandardAssetTag };
