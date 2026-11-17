const test = require('node:test');
const { Buffer } = require('node:buffer');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readCharacterFbxAxes } = require('../shared/characterFbxAxes.mjs');

test('character copy hashes the copied bytes and invalidates the fingerprint after a later update', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'character-copy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'artist.fbx'), destination = path.join(dir, 'SM_Head.fbx');
  const { copyCharacterFile, inspectCharacterFile } = require('../electron/services/characterFileInspection');
  await fs.writeFile(source, 'first model');
  const copied = await copyCharacterFile(source, destination);
  assert.equal(copied.sourceHash, (await inspectCharacterFile(source)).sourceHash);
  assert.deepEqual(await fs.readFile(source), await fs.readFile(destination));
  assert.equal((await inspectCharacterFile(destination)).sourceHash, copied.sourceHash);
  await fs.writeFile(destination, 'new model revision');
  assert.notEqual((await inspectCharacterFile(destination)).sourceHash, copied.sourceHash);
  await assert.rejects(copyCharacterFile(source, source), /不能相同/);
  assert.equal(await fs.readFile(source, 'utf8'), 'first model');
});
const { inspectCharacterFile, inspectCharacterModel } = require('../electron/services/characterFileInspection');

test('character FBX axes support ASCII, binary, signed axes and incomplete headers', () => {
  assert.deepEqual(readCharacterFbxAxes(Buffer.from('GlobalSettings: {\nP: "UpAxis", "int", "Integer", "", 2\nP: "UpAxisSign", "int", "Integer", "", -1\n}')), { upAxis: 2, upSign: -1 });
  const string = s => { const n = Buffer.alloc(5); n[0] = 83; n.writeUInt32LE(s.length, 1); return Buffer.concat([n, Buffer.from(s)]); };
  const int = n => { const b = Buffer.alloc(5); b[0] = 73; b.writeInt32LE(n, 1); return b; };
  const b = Buffer.concat([Buffer.from('Kaydara FBX Binary\0GlobalSettings'), string('UpAxis'), string('int'), string('Integer'), string(''), int(0), string('UpAxisSign'), string('int'), string('Integer'), string(''), int(1)]);
  assert.deepEqual(readCharacterFbxAxes(b), { upAxis: 0, upSign: 1 });
  assert.equal(readCharacterFbxAxes(b.subarray(0, 57)).upAxis, null);
});

test('unchanged character files reuse parsing, modified bytes invalidate hashes and inspection', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'character-inspect-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'model.fbx');
  await fs.writeFile(file, 'first');
  let calls = 0;
  const analyze = async () => { calls++; return { meshKind: 'staticMesh' }; };
  const before = await inspectCharacterFile(file);
  await inspectCharacterModel(file, analyze);
  await inspectCharacterModel(file, analyze);
  assert.equal(calls, 1);
  await fs.writeFile(file, 'second revision');
  assert.notEqual((await inspectCharacterFile(file)).sourceHash, before.sourceHash);
  await inspectCharacterModel(file, analyze);
  assert.equal(calls, 2);
});

test('model inspection survives process restart and managed rename; changed bytes are inspected again', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'character-inspect-persist-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'artist.fbx');
  const managed = path.join(dir, 'SK_F01_Head.fbx');
  await fs.writeFile(source, 'rigged model version one');
  const run = file => execFileSync(process.execPath, ['-e', `
    require('./electron/services/modelAnalysis').analyzeFbxInWorker = async () => {
      console.log('PARSED'); return { meshKind: 'skeletalMesh', hasSkin: true, bones: [{name:'root'}] };
    };
    require('./electron/services/characterFileInspection').inspectCharacterModel(process.argv[1])
      .then(async result => {
        if (result.bones[0].name !== 'root') throw new Error('Incomplete cached result');
        const inspection = require('./electron/services/characterFileInspection');
        const source = await inspection.inspectCharacterFile(process.argv[1]);
        const alpha = await inspection.inspectCharacterNormalAlpha(source, async () => { console.log('DECODED'); return false; }, true);
        if (alpha !== false) throw new Error('Lost cached false result');
      });
  `, file], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, ASSETHIVE_CHARACTER_INSPECTION_CACHE: path.join(dir, 'cache') }, encoding: 'utf8' });
  assert.match(run(source), /PARSED[\s\S]*DECODED/);
  assert.doesNotMatch(run(source), /PARSED|DECODED/);
  await fs.copyFile(source, managed);
  assert.doesNotMatch(run(managed), /PARSED|DECODED/);
  await fs.writeFile(managed, 'updated model version two');
  assert.match(run(managed), /PARSED[\s\S]*DECODED/);
});
