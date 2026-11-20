const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { ImportWorker } = require('./lib/megascans-import-worker.cjs');

async function main() {
  const root = path.resolve('.tmp/character-family-acceptance');
  process.env.ASSETHIVE_VERIFY_ROOT = root;
  process.env.ASSETHIVE_VERIFY_IMPLEMENTATION = path.resolve('.');
  process.env.ASSETHIVE_CHARACTER_INSPECTION_CACHE = path.join(root, 'inspection-cache');
  await fs.mkdir(root, { recursive: true });
  const worker = new ImportWorker({ cacheRoot: path.join(root, 'worker'), entry: path.resolve('scripts/character-import-verification-bootstrap.cjs') });
  const report = [];
  const cases = [
    { family: 'weapon', category: 'Bow', name: 'Bow999_VerifyWeapon', identity: 'VerifyWeapon',
      files: ['SK_Bow999_VerifyWeapon_Bow_ArtistNote.fbx', 'SK_Bow999_VerifyWeapon_Arrow.fbx', 'SK_Bow999_VerifyWeapon_Arrowbag.fbx'], texture: 'T_Bow999_VerifyWeapon_D.png', extra: { serial: '999', weaponType: 'Bow', weaponAssembly: 'combined', weaponLayout: 'bow' } },
    { family: 'monster', category: '3_Elite', name: 'SK_AcceptanceMonster_01', identity: 'AcceptanceMonster', files: ['SK_AcceptanceMonster_01.fbx', 'SK_WP_AcceptanceMonster_GreatSword.fbx'], texture: 'T_AcceptanceMonster_01_Body_D.png', extra: { formIds: ['01'] } },
    { family: 'npc', category: 'Merchant', name: 'SK_AcceptanceNpc_01', identity: 'AcceptanceNpc', files: ['SK_AcceptanceNpc_01.fbx', 'SK_WP_AcceptanceNpc_Torch.fbx'], texture: 'T_AcceptanceNpc_01_Body_D.png', extra: { formIds: ['01'] } },
    { family: 'item', category: 'Consumable', name: 'AcceptanceHerb', identity: 'AcceptanceHerb', files: ['SK_AcceptanceHerb.fbx'], texture: 'T_AcceptanceHerb_D.png', extra: {} }
  ];
  try {
    for (const sample of cases) {
      const source = path.join(root, 'source', sample.family);
      const library = path.join(root, 'library', sample.family);
      await fs.mkdir(source, { recursive: true });
      await fs.mkdir(library, { recursive: true });
      for (const name of sample.files) await fs.copyFile('.tmp/upgrade-skeleton-fixture.fbx', path.join(source, name));
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#887766' } }).png().toFile(path.join(source, sample.texture));
      const result = await worker.run({ library, payload: { assetType: sample.family, assetName: sample.name, category: sample.category,
        character: { ...sample.extra, name: sample.identity, displayNameEn: sample.identity, displayNameZh: '验收素材', confirmed: true, nameConfirmed: true },
        characterPackageFiles: [...sample.files, sample.texture].map(name => path.join(source, name)), normalMapFormat: 'dx', dedupeAction: 'new' } });
      const meta = JSON.parse(await fs.readFile(result.metaPath, 'utf8'));
      const files = meta.characterManifest.files;
      assert.equal(files.filter(file => file.role === 'skeletalMesh').length, sample.files.length);
      assert.equal(files.filter(file => file.role === 'texture').length, 1);
      assert(files.every(file => !file.normalizedName.includes('ArtistNote')));
      for (const file of files) await fs.stat(path.join(result.assetPath, file.storedPath));
      report.push({ family: sample.family, assetPath: result.assetPath, metaPath: result.metaPath, files: files.map(file => ({ name: file.normalizedName, role: file.role })) });
      await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
      console.log(sample.family + ': actual import verified');
    }
  } finally { await worker.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
