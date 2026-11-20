const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { ImportWorker } = require('./lib/megascans-import-worker.cjs');

async function main() {
  const [implementation, assetDirectory, label] = process.argv.slice(2);
  if (!/^[A-Za-z0-9_]+$/.test(label || '')) throw new Error('Explicit benchmark label required');
  const root = path.resolve('.tmp/character-import-verification', label);
  await fs.mkdir(root, { recursive: true });
  process.env.ASSETHIVE_VERIFY_ROOT = root;
  process.env.ASSETHIVE_VERIFY_IMPLEMENTATION = path.resolve(implementation);
  process.env.ASSETHIVE_CHARACTER_INSPECTION_CACHE = path.join(root, 'inspection-cache');
  const meta = JSON.parse(await fs.readFile(path.join(assetDirectory, 'asset_info.json'), 'utf8'));
  const files = meta.characterManifest.files.filter(file => ['texture', 'staticMesh', 'skeletalMesh', 'model'].includes(file.role));
  const modelSlots = Object.fromEntries(files.filter(file => file.role !== 'texture').map((file, index) =>
    [index ? 'Mesh' + String(index + 1).padStart(2, '0') : 'Mesh', path.join(assetDirectory, file.storedPath)]));
  const groups = new Map();
  const textureEntries = files.filter(file => file.role === 'texture').map(file => {
    const match = file.normalizedName.match(/^(.*)_(D|N|ORM|A|E)\.[^.]+$/i);
    if (!match) throw new Error('Unexpected sample texture name');
    if (!groups.has(match[1])) groups.set(match[1], groups.size + 1);
    return { filePath: path.join(assetDirectory, file.storedPath), areaId: groups.get(match[1]),
      textureType: { D: 'Diffuse', N: 'Normal', ORM: 'ORM', A: 'Opacity', E: 'Emissive' }[match[2].toUpperCase()] };
  });
  const previews = Object.fromEntries(['front', 'left', 'right', 'back'].map(view => {
    const entry = meta.previews.images.find(image => image.tags?.includes('view:' + view));
    if (!entry) throw new Error('Sample lacks ' + view + ' preview');
    return [view, path.join(assetDirectory, entry.uri)];
  }));
  const worker = new ImportWorker({ cacheRoot: path.join(root, 'worker'), entry: path.resolve('scripts/character-import-verification-bootstrap.cjs') });
  const report = { implementation, sample: meta.name, inputFiles: files.length, samples: [] };
  try {
    await worker.start();
    for (let run = 0; run < 2; run++) {
      const library = path.join(root, 'library-' + run);
      await fs.mkdir(library, { recursive: true });
      const start = performance.now();
      const result = await worker.run({ library, payload: { assetType: 'suit', assetName: meta.name, category: meta.category,
        character: { ...meta.character, confirmed: true, nameConfirmed: true },
        modelSlots, textureEntries,
        characterPackageFiles: files.map(file => path.join(assetDirectory, file.storedPath)),
        characterPreviewPaths: previews, normalMapFormat: 'dx', dedupeAction: 'new' } });
      report.samples.push({ run, durationMs: Math.round(performance.now() - start), result });
      await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ run, durationMs: report.samples.at(-1).durationMs, ok: result.ok }));
    }
  } finally { await worker.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
