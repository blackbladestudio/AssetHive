const { hasMaskFolderLayout } = require("../../shared/maskMaterials.mjs");
const path = require("node:path");
const { parseModelVariantKey, stripModelVariantKey } = require("./modelVariants");
const { buildModelLodPlan } = require("./modelLods");
const { isThumbsFolderPath } = require("./textureMaterialRole");
const { namedTextureMetadata } = require("./zion3dMaterials");

const supportFolder = /^(tex|textures?|maps?|base|mask|models?|mesh(?:es)?|source|sourcefiles|previews?|renders?|thumbs?|thumbnails?|fbx|obj|[124816]+k)$/i;
// Autodesk FBX keeps its referenced textures in a sibling "<model>.fbm" folder
// (Tripo and other FBX exporters use this layout). Treat it like a support
// subfolder so the textures stay grouped with their model instead of splitting
// into a separate surface draft.
const fbxEmbeddedMediaFolder = /\.fbm$/i;
const roleToken = /^(albedo|albedoopacitymasked|basecolor|basecolour|basecolorroughness|basecoloropacitymasked|base|diffuse|diffuseopacitymasked|color|col|normal|nrm|nor|roughness|rough|rgh|metalness|metallic|metal|ao|ambient|occlusion|ambientocclusion|height|displacement|disp|dis|specular|spec|opacitymasked|opacitymask|opacity|alpha|gloss|glossiness|cavity|mask|fuzz|emissive|detailpack|translucency|translucent|subsurfacecolor|subsurface|orm|ort|alo|bco|bcr|do|al|bc|dp|ss|ssc|n|d|e|h|m|o|t|hdr|preview|thumb|thumbnail|render|beauty|dx|ogl|opengl|directx|[124816]+k|\d{3,4}x\d{3,4}|1\d{3}|\d{3}|lod\d*|var\d*|mesh|fbx|obj)$/i;
const internalModelPrefix = /^SM[_-]/i;
const internalCompanionPrefix = /^(?:(?:8|16|32)bit[_-])?(?:T|Thumb)[_-]/i;
const internalModelExts = new Set([".fbx", ".obj", ".abc", ".gltf", ".glb", ".st9", ".usda"]);
const internalFolderPrefix = /^(?:Props|Destructible|Dressing|Megascans|PBRMAX|Kits|Mask|MEGA|Tree|Bush|Grass|Micro(?:Foliage)?|HeroFoliage)(?:[_-]|$)/i;
const zionSurfaceFolderPrefix = /^(?:Surface|Tile)(?:[_-]|$)/i;

function isLodFile(file) {
  return /(?:^|[_.-])lod(?:[_-]?\d+)?(?:$|[_.-])/i.test(path.basename(file));
}

function isModelLodFile(file) {
  return internalModelExts.has(path.extname(file).toLowerCase()) && isLodFile(file);
}

function isModelFile(file) {
  return internalModelExts.has(path.extname(file).toLowerCase()) && !isLodFile(file);
}

function modelBaseStem(file) {
  const stem = path.basename(file, path.extname(file));
  const withoutLod = stem.replace(/(?:[_\-. ]+lod[_\-. ]*\d*)(?:[_\-. ].*)?$/i, "");
  return stripModelVariantKey(withoutLod) || withoutLod || stem;
}

function modelVariantKey(file) {
  return modelBaseStem(file).toLowerCase().replace(/[_.\s-]+/g, "");
}

function singleInternalAssetModel(members, root) {
  const models = members.filter(isModelFile);
  if (models.length === 0) return "";
  const variantKeys = new Set(models.map(modelVariantKey));
  if (variantKeys.size !== 1) return "";
  const hasInternalModel = models.some((file) => internalModelPrefix.test(path.basename(file)));
  const hasCompanion = members.some((file) => internalCompanionPrefix.test(path.basename(file)));
  const hasOtherFiles = members.some((file) => !isModelFile(file) && !path.basename(file).toLowerCase().endsWith(".ztl"));
  const hasTaggedFolder = internalFolderPrefix.test(path.basename(root));
  return (hasInternalModel || hasTaggedFolder || hasCompanion || hasOtherFiles) ? models[0] : "";
}

function internalPreferredName(file) {
  const base = path.basename(file, path.extname(file));
  const cleaned = modelBaseStem(file)
    .replace(/^SM[_-]/i, "")
    .replace(/(?:[_-]lod[_-]?\d*)+$/i, "");
  return cleaned.replace(/[_-]+/g, " ").trim() || base;
}

function assetStem(file) {
  const source = (isModelFile(file) || isModelLodFile(file))
    ? modelBaseStem(file)
    : path.basename(file, path.extname(file)).replace(/_wind$/i, path.extname(file).toLowerCase() === ".json" ? "" : "$&");
  return source.replace(/^(?:(?:8|16|32)bit[_-])?(?:T[_-])?/i, "")
    .replace(/(?:^|[_-])scatter(?=[_.-]|$)/gi, "")
    .replace(/(?:lod|var)[_-]?[a-z0-9]+/gi, "")
    .split(/[_.\s-]+/).filter(token => token && !roleToken.test(token)).join(" ");
}

function isPathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveGroupingRoot(filePath) {
  let root = path.dirname(filePath);
  while ((supportFolder.test(path.basename(root)) || fbxEmbeddedMediaFolder.test(path.basename(root))) && path.dirname(root) !== root) {
    root = path.dirname(root);
  }
  return root;
}

// Metadata defines authoritative asset boundaries. For ordinary files, keep
// sibling asset directories separate while joining model/texture subfolders.
function groupDroppedAssets(files, metadataGroups = [], archiveSources = []) {
  files = (Array.isArray(files) ? files : []).filter((file) => !isThumbsFolderPath(file));
  const result = metadataGroups.map(group => ({ ...group, files: [], folderName: path.basename(group.root) }));
  const directories = new Map();
  const st9Directories = new Map();
  const st9Roots = [...new Set(
    files
      .filter((file) => path.extname(file).toLowerCase() === ".st9")
      .filter((file) => !result.some((group) => isPathWithin(group.root, file)))
      .map((file) => resolveGroupingRoot(file))
  )].sort((a, b) => b.length - a.length);
  for (const file of [...new Set(files)]) {
    const owner = result.filter(group => {
      const relative = path.relative(group.root, file);
      return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
    }).sort((a, b) => b.root.length - a.root.length)[0];
    if (owner) { owner.files.push(file); continue; }
    const st9Root = st9Roots.find((root) => isPathWithin(root, file));
    if (st9Root) {
      if (!st9Directories.has(st9Root)) st9Directories.set(st9Root, []);
      st9Directories.get(st9Root).push(file);
      continue;
    }
    const root = resolveGroupingRoot(file);
    if (!directories.has(root)) directories.set(root, []);
    directories.get(root).push(file);
  }
  for (const [root, members] of st9Directories) {
    const st9File = members.find((file) => path.extname(file).toLowerCase() === ".st9");
    result.push({
      files: members,
      folderName: path.basename(root),
      preferredName: st9File
        ? (assetStem(st9File) || path.basename(st9File, path.extname(st9File)) || path.basename(root))
        : path.basename(root)
    });
  }
  for (const [root, members] of directories) {
    // A Zion modular kit can contain different model families that share
    // named materials. Keep Mesh + Tex in one reviewable 3D asset package.
    const namedModels = members.filter(isModelFile);
    const channelLayout = hasMaskFolderLayout(members)
      && !/^(?:Tree|Bush|Grass|Micro(?:Foliage)?|HeroFoliage)[_-]/i.test(path.basename(root))
      && !namedModels.some(file => /^SM_Env_(?:Foliage|Tree|Bush|Grass)_/i.test(path.basename(file)));
    const zion3d = namedModels.length > 0 && (channelLayout || /^(?:Kit|Kits|Props|Dressing|Destructible|Mask|MEGA)_/i.test(path.basename(root)) || namedModels.some((file) =>
      /^SM_Env_(?:Kit|Kits|Props?|Dressing|Destructible|Mask|MEGA)_/i.test(path.basename(file))))
      && !members.some((file) => /\.st9$/i.test(file));
    if (zion3d) {
      const isMask = channelLayout;
      const named = isMask ? require("./maskMaterials").maskTextureMetadata(members) : namedTextureMetadata(members);
      if (isMask || Object.keys(named.materialNames).length) {
        const primary = singleInternalAssetModel(members, root);
        result.push({ files: members, folderName: path.basename(root), preferredName: primary ? internalPreferredName(primary) : path.basename(root),
          metadata: { assetType: "3d", ...named, ...(isMask ? { textureGroupMode: "channel" } : {}) } });
        continue;
      }
    }
    // Internal environment assets use SM_/T_/Thumb_ prefixes and a shared
    // folder prefix (for example Props_ZG_Ding). Keep this package as one
    // asset instead of splitting each texture role into its own draft.
    const internalModel = singleInternalAssetModel(members, root);
    if (internalModel) {
      result.push({ files: members, folderName: path.basename(root), preferredName: internalPreferredName(internalModel) });
      continue;
    }
    const folderName = path.basename(root);
    if (zionSurfaceFolderPrefix.test(folderName)) {
      const preferredName = folderName.replace(/^(?:Surface|Tile)[_-]+/i, "").trim() || folderName;
      result.push({ files: members, folderName, preferredName });
      continue;
    }
    const groups = new Map();
    const unnamed = [];
    for (const file of members) {
      const stem = assetStem(file);
      if (!stem) { unnamed.push(file); continue; }
      const key = stem.toLowerCase();
      if (!groups.has(key)) groups.set(key, { files: [], folderName: path.basename(root), preferredName: stem });
      groups.get(key).files.push(file);
    }
    if (groups.size <= 1) {
      result.push({ files: members, folderName: path.basename(root), preferredName: groups.values().next().value?.preferredName || path.basename(root) });
    } else {
      result.push(...groups.values());
      // Unnamed files cannot safely be assigned to one of several assets.
      // Keep them reviewable instead of silently attaching them to every asset.
      if (unnamed.length) result.push({ files: unnamed, folderName: path.basename(root), preferredName: path.basename(root) });
    }
  }
  let assets = result.filter(group => group.files.length || group.metadata?.modelFiles?.length || group.metadata?.textureSlots?.length)
    .map(({ files, preferredName, metadata, folderName }) => ({
      files,
      preferredName,
      metadata,
      folderName: String(folderName || "").trim()
    }));
  assets = assets.map((asset) => {
    if (asset.metadata?.assetType === "3d" && !asset.metadata.textureGroupMode && hasMaskFolderLayout(asset.files)) {
      asset = { ...asset, metadata: { ...asset.metadata, textureGroupMode: "channel" } };
    }
    const existingLods = Array.isArray(asset.metadata?.modelLods) ? asset.metadata.modelLods : [];
    if (existingLods.length > 0) return asset;
    const modelFiles = (asset.files || []).filter((file) => internalModelExts.has(path.extname(file).toLowerCase()));
    if (!modelFiles.some(isLodFile)) return asset;
    const lodPlan = buildModelLodPlan(modelFiles);
    if (lodPlan.modelLods.length === 0) return asset;
    return {
      ...asset,
      metadata: {
        ...(asset.metadata && typeof asset.metadata === "object" ? asset.metadata : {}),
        modelFiles: lodPlan.primaryFiles,
        modelVariants: lodPlan.modelVariants,
        modelLods: lodPlan.modelLods
      }
    };
  });
  for (const source of archiveSources) {
    const owned = assets.filter(asset => asset.files.length && asset.files.every(file => {
      const relative = path.relative(source.root, file);
      return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    }));
    if (owned.length === 1 && !owned[0].metadata?.name?.trim()) {
      owned[0].preferredName = source.name;
    }
    if (source.archivePath) {
      for (const asset of owned) {
        if (!asset.sourceArchivePath) asset.sourceArchivePath = source.archivePath;
      }
    }
  }
  return assets.sort((a, b) => (a.metadata?.name || a.preferredName || "").localeCompare(b.metadata?.name || b.preferredName || "", undefined, { numeric: true, sensitivity: "base" }));
}

module.exports = { groupDroppedAssets, resolveGroupingRoot };
