const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { organizeCharacterFolders } = require('../electron/services/characterFolders');

test('organizing managed files keeps source history, hashes and version identity intact', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'character-folders-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'Character', 'suit');
  const files = [{ storedPath: 'SM_Test.fbx', role: 'staticMesh' }, { storedPath: 'T_Test_D.png', role: 'texture' },
    { storedPath: 'Versions/revision1/Files/SK_Test.fbx', role: 'skeletalMesh' }];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(dir, file.storedPath)), { recursive: true });
    await fs.writeFile(path.join(dir, file.storedPath), file.role);
  }
  const meta = { assetType: 'suit', characterManifest: { files: files.map(file => ({ ...file, sha256: 'unchanged', normalizedName: path.basename(file.storedPath), originalPath: 'Z:/source/' + path.basename(file.storedPath) })) },
    modelFiles: [path.join(dir, files[0].storedPath)], textureEntries: [{ uri: files[1].storedPath }],
    characterUpdateHistory: [{ sourcePaths: ['Z:/source/SM_Test.fbx'] }] };
  await fs.writeFile(path.join(dir, 'asset_info.json'), JSON.stringify(meta));
  assert.equal((await organizeCharacterFolders(root, dir)).moves.length, 3);
  await organizeCharacterFolders(root, dir, false);
  const actual = JSON.parse(await fs.readFile(path.join(dir, 'asset_info.json'), 'utf8'));
  assert.deepEqual(actual.characterManifest.files.map(file => file.storedPath), ['Mesh/StaticMesh/SM_Test.fbx', 'Texture/T_Test_D.png', 'Versions/revision1/Mesh/SkeletalMesh/SK_Test.fbx']);
  assert.equal(actual.textureEntries[0].uri, 'Texture/T_Test_D.png');
  assert.equal(actual.modelFiles[0], path.join(dir, 'Mesh', 'StaticMesh', 'SM_Test.fbx'));
  assert.deepEqual(actual.characterUpdateHistory, meta.characterUpdateHistory);
  for (const file of actual.characterManifest.files) {
    assert.equal(file.sha256, 'unchanged');
    assert(file.originalPath.startsWith('Z:/source/'));
    assert.equal(await fs.readFile(path.join(dir, file.storedPath), 'utf8'), file.role);
  }
  assert.equal((await organizeCharacterFolders(root, dir, false)).moves.length, 0);
});
