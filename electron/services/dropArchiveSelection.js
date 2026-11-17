const path = require("node:path");
const { isThumbsFolderPath } = require("./textureMaterialRole");

const modelExts = new Set([".fbx", ".st9", ".obj", ".abc", ".gltf", ".glb", ".ztl"]);
const textureExts = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".exr", ".hdr", ".tga", ".webp", ".bmp"]);
const metadataExts = new Set([".json", ".jason"]);
const archiveExts = new Set([".zip", ".7z"]);

function hasDropLodToken(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const base = path.posix.basename(normalized, path.posix.extname(normalized)).toLowerCase();
  return /(?:^|[_.-])lod(?:[_-]?\d+)?(?:$|[_.-])/.test(base);
}

function isDropCandidateFile(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  if (isThumbsFolderPath(normalized)) return false;
  const ext = path.posix.extname(normalized).toLowerCase();
  if (archiveExts.has(ext) || metadataExts.has(ext)) return true;
  if (modelExts.has(ext)) return ext === ".st9" || ext === ".fbx" || !hasDropLodToken(normalized);
  return textureExts.has(ext) && !hasDropLodToken(normalized);
}

function parse7zTechnicalListing(output) {
  const lines = String(output || "").split(/\r?\n/);
  const divider = lines.findIndex((line) => /^-{8,}\s*$/.test(line));
  if (divider < 0) return null;
  const entries = [];
  let current = null;
  const finish = () => {
    if (current?.path && current.folder === "-") entries.push(current);
    current = null;
  };
  for (const line of lines.slice(divider + 1)) {
    if (!line.trim()) {
      finish();
      continue;
    }
    const match = line.match(/^([^=]+?) = (.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2];
    if (key === "Path") {
      finish();
      current = { path: value, folder: "", packedSize: 0 };
    } else if (current && key === "Folder") {
      current.folder = value;
    } else if (current && key === "Packed Size") {
      current.packedSize = Number(value) || 0;
    }
  }
  finish();
  return entries;
}

function selectDropArchiveEntries(entries) {
  const files = Array.isArray(entries) ? entries : [];
  const selected = files.filter((entry) => isDropCandidateFile(entry.path));
  const skippedPackedBytes = files.reduce((sum, entry) =>
    sum + (isDropCandidateFile(entry.path) ? 0 : Math.max(0, Number(entry.packedSize) || 0)), 0);
  return { selected, skippedCount: files.length - selected.length, skippedPackedBytes };
}

module.exports = { isDropCandidateFile, parse7zTechnicalListing, selectDropArchiveEntries };
