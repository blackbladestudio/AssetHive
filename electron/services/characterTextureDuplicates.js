const path = require('node:path');
const { isAllowedCharacterTextureFile } = require('../../shared/characterFilePolicy.mjs');
const { inspectCharacterFile } = require('./characterFileInspection');

// Compare only same-name textures. Different material groups must remain distinct,
// and different content with the same name must still reach collision validation.
async function deduplicateCharacterTextures(files, inspect = inspectCharacterFile) {
  files = [...new Set(files)];
  const groups = new Map();
  for (const file of files) {
    if (!isAllowedCharacterTextureFile(file)) continue;
    const key = path.basename(file.replaceAll('\\', '/')).toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }
  const duplicates = [];
  for (const candidates of groups.values()) {
    if (candidates.length < 2) continue;
    const hashes = new Map();
    for (const file of candidates) {
      const { sourceHash } = await inspect(file);
      if (!sourceHash) throw new Error(`无法核对重复贴图：${file}`);
      if (hashes.has(sourceHash)) duplicates.push({ sourcePath: file, keptPath: hashes.get(sourceHash) });
      else hashes.set(sourceHash, file);
    }
  }
  const skipped = new Set(duplicates.map(item => item.sourcePath));
  return { files: files.filter(file => !skipped.has(file)), duplicates };
}

module.exports = { deduplicateCharacterTextures };
