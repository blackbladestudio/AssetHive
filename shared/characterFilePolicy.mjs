const extension = filePath => {
  const name = String(filePath || "").replace(/\\/g, "/").split("/").pop()?.toLowerCase() || "";
  return name.match(/(\.[^.]+)$/)?.[1] || "";
};
const fileStem = filePath => String(filePath || "").replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") || "";
const CHARACTER_TEXTURE_MAP_SUFFIX = /_(?:ORM|D|N|A|Emissive|Emission|E|OpacityMask|Opacity|Alpha|Root|ID|Height|Depth|Tangent|Flow)$/i;

// Character packages use an explicit allowlist. ZBrush working files and
// application caches stay in the source package and never enter AssetHive.
export const CHARACTER_MODEL_EXTENSIONS = new Set([".fbx", ".obj", ".abc", ".gltf", ".glb"]);
export const CHARACTER_TEXTURE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".tga", ".webp", ".bmp", ".exr", ".hdr", ".dds"]);
// Maya scenes may be read for metrics, but are never copied into the library.
export const CHARACTER_SOURCE_EXTENSIONS = new Set([".blend", ".max", ".spp", ".sbsar", ".sbs", ".psd"]);
export const CHARACTER_DATA_EXTENSIONS = new Set([".json", ".txt", ".md", ".csv", ".pdf", ".uasset"]);

export function characterPackageExtension(filePath) { return extension(filePath); }

export function isAllowedCharacterTextureFile(filePath) {
  const stem = fileStem(filePath);
  return CHARACTER_TEXTURE_EXTENSIONS.has(extension(filePath))
    && /^T_/i.test(stem)
    && CHARACTER_TEXTURE_MAP_SUFFIX.test(stem);
}

export function isAllowedCharacterPackageFile(filePath) {
  const ext = extension(filePath);
  return CHARACTER_MODEL_EXTENSIONS.has(ext)
    || isAllowedCharacterTextureFile(filePath)
    || CHARACTER_SOURCE_EXTENSIONS.has(ext)
    || CHARACTER_DATA_EXTENSIONS.has(ext);
}

export function characterRoleAllowsFile(role, filePath) {
  const ext = extension(filePath);
  // Explicitly selected previews are not package textures and therefore do
  // not use the T_* map naming contract.
  if (role === "preview") return CHARACTER_TEXTURE_EXTENSIONS.has(ext);
  if (!isAllowedCharacterPackageFile(filePath)) return false;
  if (["model", "skeletalMesh", "staticMesh", "skeleton", "physicsAsset"].includes(role)) {
    return CHARACTER_MODEL_EXTENSIONS.has(ext) || ext === ".uasset";
  }
  if (role === "texture") return isAllowedCharacterTextureFile(filePath) || ext === ".uasset";
  if (["material", "animationBlueprint", "blueprint"].includes(role)) return ext === ".uasset";
  if (role === "animation") return CHARACTER_MODEL_EXTENSIONS.has(ext) || ext === ".uasset";
  return true;
}

export function partitionCharacterPackageFiles(filePaths) {
  const accepted = [], excluded = [];
  for (const filePath of [...new Set((filePaths || []).map(value => String(value || "").trim()).filter(Boolean))]) {
    (isAllowedCharacterPackageFile(filePath) ? accepted : excluded).push(filePath);
  }
  return { accepted, excluded };
}
