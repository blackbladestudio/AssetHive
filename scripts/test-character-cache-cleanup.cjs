const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepareCharacterCacheCleanup, clearCharacterCacheFiles, clearCharacterScanMemos } = require('../electron/services/characterCacheCleanup');
const { gzipJsonArray, readGzipJsonArray } = require('../electron/services/jsonArrayStream');

test('deletion removes only related thumbnails and memo records, preserving sources and other assets', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'character-cleanup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const library = path.join(root, 'library'), managed = path.join(library, 'suit');
  await fs.mkdir(managed, { recursive: true });
  const source = path.join(root, 'artist.fbx');
  await fs.writeFile(source, 'original model');
  const model = path.join(managed, 'SM_Head.fbx');
  await fs.copyFile(source, model);
  const metaPath = path.join(managed, 'asset_info.json');
  await fs.writeFile(metaPath, JSON.stringify({ assetID: 'suit-id', characterManifest: { files: [{ role: 'staticMesh', originalPath: source }] } }));
  const scope = await prepareCharacterCacheCleanup({ id: 'suit-id', path: managed, metaPath }, library, path.join(root, 'cache'));
  for (const file of scope.files) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'derived'); }
  const other = path.join(scope.cacheRoots[0], 'other.png');
  await fs.writeFile(other, 'keep');
  await clearCharacterCacheFiles(scope);
  for (const file of scope.files) await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.equal(await fs.readFile(source, 'utf8'), 'original model');
  assert.equal(await fs.readFile(model, 'utf8'), 'original model');
  assert.equal(await fs.readFile(other, 'utf8'), 'keep');
  const memo = path.join(root, 'memo.json.gz');
  await fs.writeFile(memo, await gzipJsonArray({ version: 2, root: library }, [{ record: { id: 'suit-id' } }, { record: { id: 'suit-id::part::head' } }, { record: { id: 'keep' } }]));
  await clearCharacterScanMemos(scope, library, [memo]);
  assert.deepEqual((await readGzipJsonArray(memo)).assets, [{ record: { id: 'keep' } }]);
});

test('live inspection purge waits for old work and reanalyzes identical files without process restart', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'character-inspection-cleanup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'model.fbx');
  await fs.writeFile(file, 'model bytes');
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs/promises');
    const service = require('./electron/services/characterFileInspection');
    (async () => {
      let finish, calls = 0;
      const analyze = async () => { calls++; if (calls === 1) await new Promise(resolve => finish = resolve); return { meshKind: 'staticMesh' }; };
      const pending = service.inspectCharacterModel(process.argv[1], analyze);
      while (!finish) await new Promise(resolve => setImmediate(resolve));
      const clean = service.clearCharacterInspection({ paths: [process.argv[1]], assetPath: process.argv[1] + '-managed' });
      finish(); await pending; await clean;
      assert.equal((await fs.readdir(process.env.ASSETHIVE_CHARACTER_INSPECTION_CACHE)).length, 0);
      await service.inspectCharacterModel(process.argv[1], analyze);
      assert.equal(calls, 2);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, file], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, ASSETHIVE_CHARACTER_INSPECTION_CACHE: path.join(root, 'inspection') }, stdio: 'pipe' });
});
