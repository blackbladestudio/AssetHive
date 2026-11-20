const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { buildFamilyPackagePlan } = require('../electron/services/characterFamilyRules');
const { analyzeFbxInWorker } = require('../electron/services/modelAnalysis');
const { buildSuitExport } = require('../electron/services/characterSuitExport');
async function main() {
  const root = path.resolve('.tmp/paired-weapon-fixtures');
  const results = [];
  for (const folder of await fs.readdir(root)) {
    const source = path.join(root, folder);
    if (!(await fs.stat(source)).isDirectory()) continue;
    const name = folder.split('_').slice(0, 2).join('_');
    const category = name.startsWith('DualHands') ? 'DualHands' : 'PairedSwords';
    const files = (await fs.readdir(source, { recursive: true })).map(file => path.join(source, file));
    const inputs = [];
    const analyses = new Map();
    for (const file of files) {
      if (!(await fs.stat(file)).isFile()) continue;
      inputs.push(file);
      if (/\.fbx$/i.test(file)) {
        const analysis = await analyzeFbxInWorker(file);
        assert.equal(analysis.meshKind, path.basename(file).startsWith('SK_') ? 'skeletalMesh' : 'staticMesh');
        analyses.set(path.resolve(file).toLowerCase(), analysis);
      }
    }
    const plan = buildFamilyPackagePlan('weapon', source, inputs, { assetName: name, category, modelAnalyses: analyses });
    assert.equal(plan.ok, true, plan.errors.join(';'));
    const managed = path.resolve('.tmp/paired-weapon-managed', name);
    const manifest = [];
    for (const file of plan.files.filter(file => /\.(fbx|tga)$/i.test(file.sourcePath))) {
      const target = path.join(managed, file.relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(file.sourcePath, target);
      manifest.push({ ...file, storedPath: file.relativePath });
    }
    const job = await buildSuitExport({ id: name, name, path: managed, assetType: 'weapon', meta: { name, category,
      character: { weaponType: category }, characterManifest: { files: manifest } } }, { includeStaticMeshes: true });
    const meshes = job.entries.filter(e => ['staticMesh', 'skeletalMesh'].includes(e.kind));
    assert.equal(meshes.length, name.includes('SharedAxe') ? 2 : 4);
    assert.equal(job.entries.filter(e => e.kind === 'material').length, 1);
    assert.equal(job.entries.filter(e => e.kind === 'texture').length, 3);
    assert(meshes.every(e => !e.unresolvedMaterials.length && Object.keys(e.materials).length));
    assert.equal(new Set(meshes.map(e => e.name)).size, meshes.length);
    if (!name.includes('SharedAxe')) assert(meshes.every(e => /^(SM|SK)_[A-Za-z]+\d{3}_[LR]$/.test(e.name)));
    assert(meshes.every(e => !/左|RightAxe|Hammer$/.test(e.name)));
    results.push({ name, models: meshes.map(e => e.name), sharedMaterials: 1, sharedTextures: 3 });
  }
  await fs.writeFile('.tmp/paired-weapons-verification.json', JSON.stringify(results, null, 2));
  console.log(results);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
