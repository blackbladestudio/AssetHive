const path = require("node:path");

const TEXTURE_TYPES = Object.freeze([
  "Albedo",
  "Diffuse",
  "Basecolor",
  "AlbedoOpacityMasked",
  "DiffuseOpacityMasked",
  "BasecolorOpacityMasked",
  "Normal",
  "ORM",
  "Displacement",
  "Height",
  "Emissive",
  "Metalness",
  "Opacity",
  "Subsurface",
  "SubsurfaceColor",
  "DetailPack",
  "Mask",
  "BasecolorRoughness",
  "OpacityMaskRoughnessTranslucency",
  "Translucency",
  "AO",
  "Brush",
  "Bump",
  "Cavity",
  "Fuzz",
  "Gloss",
  "Roughness",
  "Specular",
  "HDR"
]);

// Display / import abbreviations from the material texture naming convention.
const TEXTURE_TYPE_ABBREVIATIONS = Object.freeze({
  Albedo: "AL",
  Diffuse: "D",
  Basecolor: "BC",
  AlbedoOpacityMasked: "ALO",
  DiffuseOpacityMasked: "DO",
  BasecolorOpacityMasked: "BCO",
  Normal: "N",
  ORM: "ORM",
  Displacement: "Dis",
  Height: "H",
  Emissive: "E",
  Metalness: "M",
  Opacity: "O",
  Roughness: "R",
  Subsurface: "SS",
  SubsurfaceColor: "SSC",
  DetailPack: "DP",
  Mask: "Mask",
  BasecolorRoughness: "BCR",
  OpacityMaskRoughnessTranslucency: "ORT",
  Translucency: "T"
});

const TEXTURE_TYPE_BY_ABBREVIATION = Object.freeze(
  Object.fromEntries(
    Object.entries(TEXTURE_TYPE_ABBREVIATIONS)
      .map(([textureType, abbreviation]) => [abbreviation.toLowerCase(), textureType])
      .sort(([left], [right]) => right.length - left.length)
  )
);

const TEXTURE_TYPE_COMPACT_ALIASES = Object.freeze({
  albedo: "Albedo",
  diffuse: "Diffuse",
  basecolor: "Basecolor",
  basecolour: "Basecolor",
  color: "Albedo",
  colour: "Albedo",
  col: "Albedo",
  albedoopacity: "AlbedoOpacityMasked",
  albedoopacitymask: "AlbedoOpacityMasked",
  albedoopacitymasked: "AlbedoOpacityMasked",
  diffuseopacity: "DiffuseOpacityMasked",
  diffuseopacitymask: "DiffuseOpacityMasked",
  diffuseopacitymasked: "DiffuseOpacityMasked",
  basecoloropacity: "BasecolorOpacityMasked",
  basecoloropacitymask: "BasecolorOpacityMasked",
  basecoloropacitymasked: "BasecolorOpacityMasked",
  basecolouropacity: "BasecolorOpacityMasked",
  basecolouropacitymask: "BasecolorOpacityMasked",
  basecolouropacitymasked: "BasecolorOpacityMasked",
  normal: "Normal",
  normalbump: "Normal",
  normalmap: "Normal",
  normalgl: "Normal",
  normaldx: "Normal",
  nrm: "Normal",
  nor: "Normal",
  orm: "ORM",
  ormh: "ORM",
  displacement: "Displacement",
  disp: "Displacement",
  dis: "Displacement",
  height: "Height",
  emissive: "Emissive",
  emission: "Emissive",
  emit: "Emissive",
  metalness: "Metalness",
  metallic: "Metalness",
  metal: "Metalness",
  opacitymasked: "Opacity",
  opacitymask: "Opacity",
  opacitymaskedroughnesstranslucency: "OpacityMaskRoughnessTranslucency",
  opacitymaskroughnesstranslucency: "OpacityMaskRoughnessTranslucency",
  opacityroughnesstranslucency: "OpacityMaskRoughnessTranslucency",
  ort: "OpacityMaskRoughnessTranslucency",
  subsurfacecolor: "SubsurfaceColor",
  subsurface: "Subsurface",
  translucency: "Translucency",
  translucent: "Translucency",
  transmission: "Translucency",
  sss: "Translucency",
  detailpack: "DetailPack",
  detail: "DetailPack",
  mask: "Mask",
  basecolorroughness: "BasecolorRoughness",
  basecolourroughness: "BasecolorRoughness",
  bcr: "BasecolorRoughness",
  opacity: "Opacity",
  alpha: "Opacity",
  transparency: "Opacity",
  roughness: "Roughness",
  rough: "Roughness",
  rgh: "Roughness",
  gloss: "Gloss",
  glossiness: "Gloss",
  cavity: "Cavity",
  ao: "AO",
  ambientocclusion: "AO",
  occlusion: "AO",
  specular: "Specular",
  spec: "Specular",
  bump: "Bump",
  fuzz: "Fuzz",
  brush: "Brush",
  hdr: "HDR",
  hdri: "HDR"
});

const TEXTURE_TYPE_NAME_TOKENS = Object.freeze([
  ...TEXTURE_TYPES,
  ...Object.keys(TEXTURE_TYPE_COMPACT_ALIASES),
  ...Object.keys(TEXTURE_TYPE_BY_ABBREVIATION)
].map((value) => String(value).toLowerCase()).filter((value, index, values) => values.indexOf(value) === index));

const TRAILING_TEXTURE_QUALIFIER = /^(?:(?:1|2|4|8|16)k|\d{3,4}x\d{3,4}|1\d{3}|\d{3}|lod\d*|var\d+|udim\d*|dx|gl|ogl|opengl|directx|normalgl|normaldx)$/i;

function compactTextureName(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function splitTextureNameTokens(value) {
  const normalized = String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return normalized.split(/[^a-z0-9]+/g).filter(Boolean);
}

function normalizeTextureType(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const canonicalType = TEXTURE_TYPES.find((textureType) => textureType.toLowerCase() === raw.toLowerCase());
  if (canonicalType) return canonicalType;

  const abbreviationType = TEXTURE_TYPE_BY_ABBREVIATION[raw.toLowerCase()];
  if (abbreviationType) return abbreviationType;

  const compact = compactTextureName(raw);
  return TEXTURE_TYPE_COMPACT_ALIASES[compact] || "";
}

function normalizeOpacityTextureSlot(value) {
  const raw = String(value || "").trim();
  const matched = raw.match(/^(\d{3}[_-])?(opacity(?:[\s_-]*mask(?:ed)?)?|alpha|transparency|o)(\|[^|]+)?$/i);
  return matched ? `${matched[1] || ""}Opacity${matched[3] || ""}` : raw;
}

function normalizePbrMaxDecalTextureType(value) {
  return normalizeTextureType(value);
}

function stripTrailingTextureQualifiers(tokens) {
  const result = [...tokens];
  while (result.length > 0) {
    const last = result[result.length - 1];
    const previous = result[result.length - 2];
    if (last === "k" && /^(?:1|2|4|8|16)$/.test(previous || "")) {
      result.pop();
      result.pop();
      continue;
    }
    if (!TRAILING_TEXTURE_QUALIFIER.test(last)) break;
    result.pop();
  }
  return result;
}

function detectTextureTypeFromFileName(filePath) {
  const base = path.basename(String(filePath || ""), path.extname(String(filePath || "")));
  const tokens = stripTrailingTextureQualifiers(splitTextureNameTokens(base));
  if (tokens.length === 0) return "";

  // Prefer the longest compound suffix before a single abbreviation. This
  // prevents O / T / D from winning over ORM / ORT / DO / BCR.
  for (let length = Math.min(4, tokens.length); length >= 2; length -= 1) {
    const compactSuffix = tokens.slice(-length).join("");
    const compoundType = TEXTURE_TYPE_COMPACT_ALIASES[compactSuffix];
    if (compoundType) {
      return compoundType;
    }
  }

  const suffix = tokens[tokens.length - 1];
  const suffixType = normalizeTextureType(suffix);
  if (suffixType) return suffixType;

  return "";
}

function isTextureTypeName(filePath) {
  return Boolean(detectTextureTypeFromFileName(filePath));
}

module.exports = {
  TEXTURE_TYPES,
  TEXTURE_TYPE_ABBREVIATIONS,
  TEXTURE_TYPE_BY_ABBREVIATION,
  TEXTURE_TYPE_COMPACT_ALIASES,
  TEXTURE_TYPE_NAME_TOKENS,
  detectTextureTypeFromFileName,
  isTextureTypeName,
  normalizeTextureType,
  normalizeOpacityTextureSlot,
  normalizePbrMaxDecalTextureType,
  splitTextureNameTokens
};
