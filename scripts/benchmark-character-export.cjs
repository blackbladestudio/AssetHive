// Read-only manifest benchmark. Use ELECTRON_RUN_AS_NODE=1 with the installed
// executable to measure the shipped implementation, and an isolated inspection
// cache so artist caches and the managed library are never cleared or changed.
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

async function main() {
  const [implementation, assetDirectory] = process.argv.slice(2);
  if (!implementation || !assetDirectory || !process.env.ASSETHIVE_CHARACTER_INSPECTION_CACHE) {
    throw new Error('Usage: <implementation root> <managed asset directory>; set ASSETHIVE_CHARACTER_INSPECTION_CACHE to an isolated directory');
  }
  const { buildSuitExport } = require(path.join(path.resolve(implementation), 'electron/services/characterSuitExport.js'));
  const metaPath = path.join(assetDirectory, 'asset_info.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  const asset = { id: meta.id || meta.identity?.assetId, assetType: meta.assetType,
    name: meta.name, path: assetDirectory, metaPath, meta };
  const samples = [];
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    const manifest = await buildSuitExport(asset, { includeStaticMeshes: true, normalFormat: 'dx' });
    samples.push({ run, durationMs: Math.round(performance.now() - start), entries: manifest.entries.length,
      models: manifest.entries.filter(entry => /Mesh$/.test(entry.kind)).length,
      blocked: manifest.entries.filter(entry => entry.validationError || entry.unresolvedMaterials?.length).length });
  }
  console.log(JSON.stringify({ implementation, assetId: asset.id, assetType: asset.assetType,
    cache: process.env.ASSETHIVE_CHARACTER_INSPECTION_CACHE, samples }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
