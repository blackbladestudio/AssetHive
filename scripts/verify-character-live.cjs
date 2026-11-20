// Explicit live acceptance: creates only a separately named AHVerification owner.
// Never write library metadata or replace the real asset's UE resources.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function main() {
  const [implementation, assetDirectory, label, reportPath, mode = 'inspect'] = process.argv.slice(2);
  if (!/^[A-Za-z0-9_]+$/.test(label || '') || !reportPath || !process.env.ASSETHIVE_CHARACTER_INSPECTION_CACHE) throw new Error('Explicit label, report and isolated cache required');
  const base = path.resolve(implementation);
  const { buildSuitExport } = require(path.join(base, 'electron/services/characterSuitExport.js'));
  const { AssetHiveTCPClient } = require(path.join(base, 'electron/services/tcpClient.js'));
  const meta = JSON.parse(await fs.readFile(path.join(assetDirectory, 'asset_info.json'), 'utf8'));
  const asset = { id: meta.id || meta.assetID || meta.identity?.assetId, assetType: meta.assetType, name: meta.name, path: assetDirectory, meta };
  const prepareStart = performance.now();
  const manifest = await buildSuitExport(asset, { includeStaticMeshes: true, normalFormat: 'dx' });
  const preparationMs = Math.round(performance.now() - prepareStart);
  const oldRoot = manifest.targetRoot;
  const targetRoot = oldRoot + '_AHVerification_' + label;
  const owner = 'AHVerification_' + label;
  function remap(value) {
    if (typeof value === 'string') return value.startsWith(oldRoot) ? value.replace(oldRoot, targetRoot)
      : value.startsWith(asset.id + ':') ? owner + value.slice(String(asset.id).length) : value;
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]));
    return value;
  }
  const suit = { ...remap(manifest), assetId: owner, targetRoot };
  for (const entry of suit.entries) {
    entry.name += '_AHVerification_' + label;
    entry.targetPath = entry.targetPath.slice(0, entry.targetPath.lastIndexOf('/') + 1) + entry.name;
  }
  if (!suit.entries.every(entry => entry.targetPath.startsWith(targetRoot + '/'))) throw new Error('Unsafe target');
  const client = new AssetHiveTCPClient();
  const report = { implementation, label, targetRoot, preparationMs, runs: [] };
  try {
    const start = performance.now();
    const editor = await client.getEditorInfo(10000);
    if (!editor || !/\/Project\/ZionGame\.uproject$/i.test(editor.projectPath.replaceAll('\\', '/'))) throw new Error('Expected the explicitly selected ZionGame editor');
    report.connectionMs = Math.round(performance.now() - start);
    async function run(name, apply) {
      const checkStart = performance.now();
      const request = { version: 1, phase: 'inspect', suits: [suit], deletedOwnerIds: [] };
      const inspected = (await client.importAssets({ characterSuit: request }, { projectPath: editor.projectPath })).suitResult;
      const row = { name, inspectMs: Math.round(performance.now() - checkStart), inspection: inspected };
      report.runs.push(row);
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
      if (!apply) return;
      if (inspected.error || inspected.entries.some(entry => ['blocked', 'conflict', 'missing'].includes(entry.status))) throw new Error('Acceptance inspection needs review; see report');
      const applyStart = performance.now();
      row.result = (await client.importAssets({ characterSuit: { ...request, phase: 'apply', inspectToken: inspected.inspectToken } }, { projectPath: editor.projectPath })).suitResult;
      row.applyMs = Math.round(performance.now() - applyStart);
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
      if (row.result.error || row.result.entries.some(entry => !['success', 'unchanged'].includes(entry.status))) throw new Error('Acceptance apply needs review; see report');
      console.log(JSON.stringify({ name, inspectMs: row.inspectMs, applyMs: row.applyMs, timings: row.result.timings }));
      return row.result;
    }
    await run('first', mode === 'apply');
    if (mode !== 'apply') return;
    await run('unchanged', true);
    const texture = suit.entries.find(entry => entry.kind === 'texture' && entry.channel === 'D' && /\.tga$/i.test(entry.sourcePath));
    if (!texture) throw new Error('A TGA diffuse sample is required for incremental verification');
    const image = await fs.readFile(texture.sourcePath);
    if (image[1] !== 0 || image[2] !== 2) throw new Error('Incremental sample must be uncompressed true-color TGA');
    const pixelOffset = 18 + image[0];
    image[pixelOffset] = (image[pixelOffset] + 1) % 256;
    const scratch = path.resolve('.tmp/character-live-inputs', label);
    await fs.mkdir(scratch, { recursive: true });
    texture.sourcePath = path.join(scratch, path.basename(texture.sourcePath));
    await fs.writeFile(texture.sourcePath, image);
    texture.sourceHash = crypto.createHash('sha256').update(image).digest('hex');
    texture.fingerprint = hash({ sourceHash: texture.sourceHash, config: texture.config, skeletonPath: texture.skeletonPath,
      materials: texture.materials, externalMaterials: texture.externalMaterials, textures: texture.textures });
    suit.manifestHash = hash(suit.entries);
    const updated = await run('one-texture-update', true);
    const changed = updated.entries.filter(entry => entry.status === 'success');
    if (changed.length !== 1 || changed[0].key !== texture.key) throw new Error('Single-texture update unexpectedly changed other resources');
    await run('updated-unchanged', true);
    // Rename paths only. Identity and content remain the same.
    suit.targetRoot = targetRoot + '_Renamed';
    for (const entry of suit.entries) {
      entry.targetPath = entry.targetPath.replace(targetRoot, suit.targetRoot);
      if (entry.skeletonPath?.startsWith(targetRoot)) entry.skeletonPath = entry.skeletonPath.replace(targetRoot, suit.targetRoot);
      if (entry.config.physicsAssetPath?.startsWith(targetRoot)) entry.config.physicsAssetPath = entry.config.physicsAssetPath.replace(targetRoot, suit.targetRoot);
    }
    suit.manifestHash = hash(suit.entries);
    await run('rename', true);
    await run('renamed-unchanged', true);
  } finally { client.disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
