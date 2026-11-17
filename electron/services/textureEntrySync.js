const { normalizeTextureMaterialRole } = require("./textureMaterialRole");

// 3D Plant 在库内会同时保留 Atlas 与 Billboard 两套贴图，只能靠 materialRole 区分；
// Megascans 素材的非 Billboard 贴图一律视为 Atlas（与导入侧扫描规则一致）。
function resolveSyncedTextureMaterialRole(value, filePath, options = {}) {
  const fallback = options?.megascansSource === true ? "atlas" : "";
  return normalizeTextureMaterialRole(value, filePath, fallback);
}

// textureEntries 的槽位 token 形如 Albedo、001_Albedo、Albedo|atlas、Albedo|billboard。
function buildSyncedTextureToken(textureType, areaIndex, materialRole = "") {
  const normalizedType = String(textureType || "").trim();
  if (!normalizedType) {
    return "";
  }
  const normalizedArea = Math.max(1, Number(areaIndex) || 1);
  const baseToken = normalizedArea > 1
    ? `${String(normalizedArea).padStart(3, "0")}_${normalizedType}`
    : normalizedType;
  const normalizedRole = normalizeTextureMaterialRole(materialRole);
  return normalizedRole ? `${baseToken}|${normalizedRole}` : baseToken;
}

function splitSyncedTextureToken(value) {
  const raw = String(value || "").trim();
  const separator = raw.lastIndexOf("|");
  if (separator < 0) {
    return { token: raw, materialRole: "" };
  }
  return {
    token: raw.slice(0, separator),
    materialRole: normalizeTextureMaterialRole(raw.slice(separator + 1))
  };
}

module.exports = {
  resolveSyncedTextureMaterialRole,
  buildSyncedTextureToken,
  splitSyncedTextureToken
};
