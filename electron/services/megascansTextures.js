const { normalizeTextureType } = require("./textureTypes");

const TEXTURE_HINT_KEYS = ["type", "name", "slot", "map", "mapType", "textureType", "semantic", "resolution", "format"];

function collectMegascansTextureHints(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const hints = [];
  const hasTextureReference = Array.isArray(value.uris) || typeof value.uri === "string";
  for (const key of TEXTURE_HINT_KEYS) {
    const hint = value[key];
    if (typeof hint !== "string") continue;
    // Asset / pack names can contain words such as "Metal", but they are not
    // texture types. Only component / map objects that own a URI may use name.
    if (key === "name" && !hasTextureReference) continue;
    hints.push(hint);
  }
  return hints;
}

function normalizeAssetTypeToken(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function normalizeMegascansTextureType(value, assetType = "", options = {}) {
  const raw = String(value || "").trim().toLowerCase();
  const tokens = raw.split(/[^a-z0-9]+/g).filter(Boolean);
  const candidates = new Set([raw.replace(/[\s_-]+/g, ""), ...tokens]);
  const has = (aliases) => aliases.some((alias) => candidates.has(alias));
  if (!tokens.length) return "";

  if (raw === "t" || has(["translucency", "translucent", "transmission", "sss"])) {
    return "Translucency";
  }
  if (has(["opacity", "alpha", "transparency"]) && !has(["opacitymasked", "opacitymask"])) {
    return "Opacity";
  }

  const abbreviatedType = normalizeTextureType(raw);
  if (abbreviatedType) {
    return abbreviatedType;
  }

  if (has(["albedo", "basecolor", "basecolour", "diffuse", "color", "colour", "col"])) return "Albedo";
  if (has(["ao", "ambientocclusion", "occlusion"])) return "AO";
  if (has(["normal", "normalbump", "normalmap", "nrm", "nor"])) return "Normal";
  if (has(["roughness", "rough", "rgh"])) return "Roughness";
  if (has(["metalness", "metallic", "metal"])) return "Metalness";
  if (has(["height", "displacement", "disp", "dis"])) return "Displacement";
  if (has(["specular", "spec"])) return "Specular";
  if (has(["subsurfacecolor"])) return "SubsurfaceColor";
  if (has(["subsurface"])) return "Subsurface";
  if (has(["translucency", "translucent", "transmission", "sss"])) {
    return "Translucency";
  }
  if (has(["opacitymasked", "opacitymask", "opacity", "alpha", "transparency"])) return "Opacity";
  if (has(["gloss", "glossiness"])) return "Gloss";
  if (has(["cavity"])) return "Cavity";
  if (has(["mask"])) return "Mask";
  if (has(["bump"])) return "Bump";
  if (has(["fuzz"])) return "Fuzz";
  if (has(["hdr", "hdri"])) return "HDR";
  return "";
}

module.exports = {
  collectMegascansTextureHints,
  normalizeMegascansTextureType
};
