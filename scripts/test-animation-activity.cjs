const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { recordAnimationExport, persistAnimationExport, animationExportReceipt, compareAnimationVersion, getAnimationUnrealStatus } = require('../electron/services/animationActivity');
const { writeAnimationIdentitySidecar, readAnimationIdentitySidecar, applyAnimationIdentityMetadata, animationIdentityDiffersFromRecord } = require('../electron/services/animationIdentity');

const row = { status: 'success', path: '/Game/Animation/Monster/AS_Walk.AS_Walk', sourceHash: 'abc', savedHash: 'def' };
test('full detail and lightweight card records agree on sent/pending status per project', () => {
  const ts = require('typescript');
  const source = require('node:fs').readFileSync(path.join(__dirname, '../src/ui/animationSendState.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const output = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(require, output, output.exports);
  const { animationHasBeenSent, animationIndicatorState } = output.exports;
  const { toAssetListRecord } = require('../electron/services/assetListRecord');
  const meta = recordAnimationExport({ identity: { contentFingerprint: 'original' } }, { ...row, contentFingerprint: 'original' }, 'D:/P/P.uproject');
  const asset = { id: 'walk', assetType: 'animation', meta };
  for (const record of [asset, toAssetListRecord(asset)]) {
    assert.equal(animationHasBeenSent(record, 'd:\\p\\p.uproject'), true);
    assert.equal(animationHasBeenSent(record, 'D:/Other/P.uproject'), false);
  }
  const updated = { ...asset, meta: { ...meta, identity: { contentFingerprint: 'updated' } } };
  assert.equal(animationHasBeenSent(updated), false);
  assert.equal(animationHasBeenSent(toAssetListRecord(updated)), false);
  assert.equal(animationHasBeenSent({ ...asset, meta: {} }), false);
  assert.equal(animationIndicatorState(asset).current, false, 'a receipt alone cannot confirm the current UE asset');
  assert.match(animationIndicatorState(asset).zh, /尚未核验/);
  assert.equal(animationIndicatorState(asset, 'D:/P/P.uproject', { state: 'current', projectPath: 'd:\\p\\p.uproject' }).current, true);
  assert.equal(animationIndicatorState(asset, 'D:/Other/P.uproject', { state: 'current', projectPath: 'D:/P/P.uproject' }).current, false);
  for (const state of ['libraryUpdated', 'engineUpdated', 'bothUpdated', 'missing', 'unverified', 'error']) {
    assert.equal(animationIndicatorState(asset, '', { state }).current, false, state);
  }
});
test('a send from a lightweight cached record persists history and preserves disk identity', async t => {
  const { getAssetDetailsByMetaPath } = require('../electron/services/assetScanner');
  const { toAssetListRecord } = require('../electron/services/assetListRecord');
  const { mergeAnimationMetadata } = require('../electron/services/animationIdentity');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'anim-send-record-'));
  // Windows may still be releasing sidecar handles after the final history read.
  t.after(() => fs.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = path.join(folder, 'Animation', 'Monster', 'AS_Walk.fbx');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'fbx');
  const imported = { assetID: 'walk', name: 'AS_Walk', identity: { contentFingerprint: 'fingerprint' }, importQueueId: 'queue',
    createdAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T01:00:00Z', importHistory: [{ action: 'import', at: '2026-11-18T00:00:00Z' }] };
  await writeAnimationIdentitySidecar(file, imported);
  const full = await getAssetDetailsByMetaPath(file);
  const list = toAssetListRecord(full);
  assert.equal(list.meta.identity.contentFingerprint, undefined);
  const refreshed = { ...full, meta: mergeAnimationMetadata(list.meta, full.meta, full.id) };
  assert.equal(refreshed.meta.identity.contentFingerprint, 'fingerprint');
  const meta = await persistAnimationExport(refreshed, row, 'D:/P/P.uproject');
  const reloaded = await getAssetDetailsByMetaPath(file);
  assert.equal(animationExportReceipt(reloaded.meta, 'D:/P/P.uproject').targetPath, row.path);
  assert.equal(reloaded.meta.animationOperationHistory.length, 1);
  assert.equal(meta.importQueueId, 'queue');
  assert.equal(reloaded.meta.updatedAt, imported.updatedAt);
  assert.equal(reloaded.createdAt, imported.createdAt);
  // A stale renderer/list object also must not erase already persisted history.
  await persistAnimationExport(list, { status: 'failed' }, 'D:/P/P.uproject');
  const persisted = await readAnimationIdentitySidecar(file);
  assert.equal(persisted.animationOperationHistory.length, 2);
  assert.equal(persisted.animationUEExports.length, 1);
});

test('legacy flat animations without a sidecar can persist successful sends', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'anim-legacy-record-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'AS_Walk.fbx');
  await fs.writeFile(file, 'fbx');
  await persistAnimationExport({ id: 'legacy-walk', modelFiles: [file], meta: { name: 'AS_Walk' } }, row, 'D:/P/P.uproject');
  const persisted = await readAnimationIdentitySidecar(file);
  assert.equal(persisted.asset.assetID, 'legacy-walk');
  assert.ok(persisted.identity.contentFingerprint);
  assert.equal(persisted.animationUEExports[0].status, 'success');
});

test('folder suggestions list the actual Content tree without changing files', async t => {
  const { listAnimationUnrealFolders } = require('../electron/services/animationUnrealFolders');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'anim-ue-folders-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const target = path.join(folder, 'Content', 'Characters', 'Monster', '3_Elite', 'ShangExecutor', 'Animation', 'Loco');
  await fs.mkdir(target, { recursive: true });
  const assetFile = path.join(target, 'AS_Walk.uasset');
  await fs.writeFile(assetFile, 'unchanged');
  const result = await listAnimationUnrealFolders(path.join(folder, 'P.uproject'));
  assert.ok(result.folders.includes('/Game/Characters/Monster/3_Elite/ShangExecutor/Animation/Loco'));
  assert.equal(await fs.readFile(assetFile, 'utf8'), 'unchanged');
  assert.equal(result.truncated, false);
});
test('successful receipts are per project; failures preserve the last successful baseline', () => {
  let meta = recordAnimationExport({}, row, 'D:\\P\\P.uproject', '2026-11-19T00:00:00Z');
  meta = recordAnimationExport(meta, { ...row, sourceHash: 'other' }, 'D:/Other/P.uproject');
  meta = recordAnimationExport(meta, { status: 'failed', message: 'Compression failed' }, 'd:/p/p.uproject');
  assert.equal(meta.animationOperationHistory.length, 3);
  assert.equal(animationExportReceipt(meta, 'D:/P/P.uproject').sourceHash, 'abc');
  assert.equal(animationExportReceipt(meta, 'D:/Other/P.uproject').sourceHash, 'other');
});

test('versions distinguish archive changes, engine edits, missing and unknown assets', () => {
  assert.equal(compareAnimationVersion(row, 'ABC', { exists: true, savedHash: 'DEF', dirty: false }), 'current');
  assert.equal(compareAnimationVersion(row, 'new', { exists: true, savedHash: 'def' }), 'libraryUpdated');
  assert.equal(compareAnimationVersion(row, 'abc', { exists: true, savedHash: 'def', dirty: true }), 'engineUpdated');
  assert.equal(compareAnimationVersion(row, 'new', { exists: true, savedHash: 'new' }), 'bothUpdated');
  assert.equal(compareAnimationVersion(row, 'abc', { exists: false }), 'missing');
  assert.equal(compareAnimationVersion({}, 'abc', { exists: true, savedHash: 'def' }), 'unverified');
  assert.equal(compareAnimationVersion(row, 'abc', null), 'unverified');
  assert.equal(compareAnimationVersion(row, 'abc', { error: 'Access denied' }), 'error');
});

test('history and receipts survive sidecar reload and invalidate cached scanner metadata', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'anim-activity-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true, maxRetries: 3 }));
  const file = path.join(folder, 'AS_Walk.fbx');
  const base = { assetID: 'walk', name: 'AS_Walk', identity: { contentFingerprint: 'source' }, importHistory: [{ action: 'import', at: '2026-11-19T00:00:00Z' }] };
  const updated = recordAnimationExport(base, row, 'D:/P/P.uproject');
  await writeAnimationIdentitySidecar(file, updated);
  const persisted = await readAnimationIdentitySidecar(file);
  const restored = applyAnimationIdentityMetadata({}, persisted);
  assert.deepEqual(restored.animationOperationHistory, updated.animationOperationHistory);
  assert.deepEqual(restored.animationUEExports, updated.animationUEExports);
  assert.equal(animationIdentityDiffersFromRecord({ id: 'walk', name: 'AS_Walk', meta: base }, persisted), true);
  assert.equal(animationIdentityDiffersFromRecord({ id: 'walk', name: 'AS_Walk', meta: restored }, persisted), false);
});

test('inspection never sends to a legacy plugin or a different project', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'anim-activity-inspect-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'AS_Walk.fbx');
  await fs.writeFile(file, 'fbx');
  const asset = { id: 'walk', modelFiles: [file], meta: recordAnimationExport({}, row, 'D:/P/P.uproject') };
  const client = { getEditorInfo: async () => ({ projectPath: 'D:/P/P.uproject', capabilities: ['characterAnimationV1'] }), importAssets: async () => { assert.fail('Legacy plugin must never receive an inspect job'); } };
  assert.equal((await getAnimationUnrealStatus(asset, {}, client)).state, 'unverified');
  assert.equal((await getAnimationUnrealStatus(asset, { unrealProjectPath: 'D:/Other.uproject' }, client)).state, 'error');
  client.getEditorInfo = async () => { throw new Error('Offline'); };
  assert.equal((await getAnimationUnrealStatus(asset, {}, client)).state, 'unverified');
});

test('capable plugin receives only a read-only inspect job', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'anim-activity-live-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'AS_Walk.fbx');
  await fs.writeFile(file, 'fbx');
  const { fileHash } = require('../electron/services/animationActivity');
  const sourceHash = await fileHash(file);
  const asset = { id: 'walk', modelFiles: [file], meta: recordAnimationExport({}, { ...row, sourceHash }, 'D:/P/P.uproject') };
  const result = await getAnimationUnrealStatus(asset, {}, {
    getEditorInfo: async () => ({ projectPath: 'D:/P/P.uproject', capabilities: ['characterAnimationInspectV1'] }),
    importAssets: async job => {
      assert.equal(job.characterAnimation.inspectOnly, true);
      assert.deepEqual(job.characterAnimation.animations, [{ key: 'walk', targetPath: '/Game/Animation/Monster/AS_Walk' }]);
      return { animationResult: { entries: [{ key: 'walk', exists: true, savedHash: 'def', dirty: false }] } };
    }
  });
  assert.equal(result.state, 'current');
});
