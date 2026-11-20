const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { buildSuitExport } = require('../electron/services/characterSuitExport');

async function main() {
  const previous = JSON.parse(await fs.readFile('.tmp/item-job-template.json', 'utf8'));
  const source = previous.entries.find(row => row.kind === 'skeletalMesh').sourcePath;
  const root = path.resolve('.tmp/item-material-fixture');
  await fs.mkdir(root, { recursive: true });
  const name = 'ItemMaterialAcceptance';
  const mesh = `SK_${name}.fbx`;
  await fs.copyFile(source, path.join(root, mesh));
  const files = [{ role: 'skeletalMesh', storedPath: mesh, normalizedName: mesh }];
  for (const [channel, color] of Object.entries({ D: '#708040', N: '#8080ff', ORM: '#ff8000', E: '#004020' })) {
    const file = `T_${name}_${channel}.png`;
    await sharp({ create: { width: 128, height: 128, channels: 3, background: color } }).png().toFile(path.join(root, file));
    files.push({ role: 'texture', storedPath: file, normalizedName: file });
  }
  const manifest = await buildSuitExport({ id: 'item-material-acceptance', name, path: root, assetType: 'item',
    meta: { name, category: 'Interactable', normalMapFormat: 'directx', characterManifest: { files } } }, { normalFormat: 'directx' });
  await fs.writeFile('.tmp/item-material-template.json', JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest.entries.map(e => ({ kind: e.kind, channel: e.channel, materials: e.materials, parent: e.config.parentPath }))));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
