const path = require("node:path");

function resolveAssetModelPath(assetDir, value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const paths = /^[a-z]:[\\/]|^[\\/]{2}/i.test(assetDir) ? path.win32 : path;
  const root = paths.resolve(assetDir);
  const foreignWindowsPath = paths !== path.win32 && /^[a-z]:[\\/]|^[\\/]{2}/i.test(raw);
  const resolved = foreignWindowsPath ? path.win32.resolve(raw) : paths.resolve(root, raw);
  const relative = foreignWindowsPath ? null : paths.relative(root, resolved);
  if (relative && !relative.startsWith(`..${paths.sep}`) && relative !== ".." && !paths.isAbsolute(relative)) {
    return resolved.replace(/\\/g, "/");
  }

  // The metadata belongs to this asset folder. Keep the path below that folder
  // when another client saved it through a mapped drive or a different UNC root.
  // Matching the whole folder (which includes the asset ID) avoids merging files
  // just because their basenames happen to match, and preserves nested LOD paths.
  const segments = resolved.replace(/\\/g, "/").split("/");
  const folder = paths.basename(root).toLowerCase();
  const anchor = segments.findLastIndex(segment => segment.toLowerCase() === folder);
  if (anchor >= 0 && anchor < segments.length - 1) {
    return paths.resolve(root, ...segments.slice(anchor + 1)).replace(/\\/g, "/");
  }
  return resolved.replace(/\\/g, "/");
}

function normalizeAssetModelPaths(meta, assetDir) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return meta;
  const resolve = value => resolveAssetModelPath(assetDir, value);
  const unique = values => {
    const seen = new Set();
    return values.filter(value => {
      const key = value.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const next = { ...meta };
  const slotAliases = new Map();
  if (Array.isArray(meta.modelFiles)) next.modelFiles = unique(meta.modelFiles.map(resolve));
  if (meta.modelSlots && typeof meta.modelSlots === "object" && !Array.isArray(meta.modelSlots)) {
    const slotByPath = new Map();
    next.modelSlots = Object.fromEntries(Object.entries(meta.modelSlots).flatMap(([slot, value]) => {
      const file = resolve(value);
      const key = file.toLowerCase();
      if (!file) return [];
      const owner = slotByPath.get(key);
      slotAliases.set(slot.toLowerCase(), owner || slot);
      if (owner) return [];
      slotByPath.set(key, slot);
      return [[slot, file]];
    }));
  }
  const normalizeEntry = entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const nextEntry = { ...entry };
    for (const field of ["file", "path", "uri"]) {
      if (typeof entry[field] === "string" && entry[field].trim()) nextEntry[field] = resolve(entry[field]);
    }
    if (typeof entry.slot === "string") nextEntry.slot = slotAliases.get(entry.slot.toLowerCase()) || entry.slot;
    return nextEntry;
  };
  for (const field of ["modelVariants", "modelLods"]) {
    if (Array.isArray(meta[field])) next[field] = meta[field].map(normalizeEntry);
  }
  if (Array.isArray(meta.components)) {
    next.components = meta.components.map(entry => String(entry?.type || "").toLowerCase() === "model" ? normalizeEntry(entry) : entry);
  }
  return next;
}

module.exports = { resolveAssetModelPath, normalizeAssetModelPaths };
