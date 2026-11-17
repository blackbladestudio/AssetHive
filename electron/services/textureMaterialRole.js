const VALID_TEXTURE_MATERIAL_ROLES = new Set(["atlas", "billboard"]);

function normalizeTextureMaterialRole(value, filePath = "", fallback = "") {
  const explicit = String(value || "").trim().toLowerCase();
  if (VALID_TEXTURE_MATERIAL_ROLES.has(explicit)) {
    return explicit;
  }

  const normalizedPath = String(filePath || "").trim().replace(/\\/g, "/").toLowerCase();
  if (normalizedPath) {
    const segments = normalizedPath.split("/").filter(Boolean);
    if (segments.some((segment) => /^billboards?$/i.test(segment))
      || /(?:^|[_.-])billboard(?:[_.-]|$)/i.test(normalizedPath)) {
      return "billboard";
    }
    if (segments.some((segment) => /^atlases?$/i.test(segment))
      || /(?:^|[_.-])atlas(?:[_.-]|$)/i.test(normalizedPath)) {
      return "atlas";
    }
  }

  const normalizedFallback = String(fallback || "").trim().toLowerCase();
  return VALID_TEXTURE_MATERIAL_ROLES.has(normalizedFallback) ? normalizedFallback : "";
}

function isThumbsDirectoryName(value) {
  return /^(?:thumb|thumbs|thumbnail|thumbnails)$/i.test(String(value || "").trim());
}

function isThumbsFolderPath(value) {
  const normalized = String(value || "").trim().replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).some((segment) => isThumbsDirectoryName(segment));
}

module.exports = {
  VALID_TEXTURE_MATERIAL_ROLES,
  normalizeTextureMaterialRole,
  isThumbsDirectoryName,
  isThumbsFolderPath
};
