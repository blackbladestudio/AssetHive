const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const shared = require('../electron/services/characterSharedResources');
const { transactionalFs } = require('../electron/services/assetFileTransaction');

const texture = (hash = 'a', config = {}) => ({ kind: 'texture', sourceHash: hash.repeat(64), channel: 'D', config: { virtualTexture: true, ...config } });
const request = (assetId, evidence = texture(), scopeId = 'villager-batch') => ({
  reference: { assetId, localKey: `${assetId}:texture:body:D`, metadataPath: `${assetId}/asset_info.json` },
  evidence, scopeId, ueTarget: { key: `${assetId}:texture:body:D`, path: `/Game/Test/T_${assetId}_D` }
});

test('shared export emits one texture and rewrites dependencies without losing receipt owners', () => {
  const first = shared.registerResource(shared.empty(), request('one'));
  const second = shared.registerResource(first.state, request('two'));
  const suits = ['one', 'two'].map(assetId => ({ assetId, entries: [
    { key: `${assetId}:texture:body:D`, ...texture(), name: assetId, partSlot: assetId, groupName: assetId, fingerprint: assetId, sourcePath: `/${assetId}/D.tga`, targetPath: `/Game/Test/T_${assetId}_D` },
    { key: `${assetId}:material:body`, kind: 'material', textures: { D: `${assetId}:texture:body:D` } }
  ] }));
  const result = shared.projectSharedEntries(second.state, suits);
  assert.equal(result.suits.flatMap(suit => suit.entries).filter(entry => entry.kind === 'texture').length, 1);
  assert.equal(result.suits[1].entries[0].textures.D, 'one:texture:body:D');
  assert.deepEqual(result.aliases['one:texture:body:D'].map(ref => ref.assetId), ['one', 'two']);
  assert.equal(suits[1].entries[1].textures.D, 'two:texture:body:D');
  for (const suit of suits) suit.entries[0].associationNames = [`T_${suit.assetId}_Previous_D`];
  const association = shared.projectSharedEntries(second.state, suits).suits[0].entries[0];
  assert.deepEqual(association.associationNames, ['T_one_Previous_D', 'T_two_Previous_D']);
  assert.deepEqual(association.associationReferenceKeys, ['one:texture:body:D', 'two:texture:body:D']);
  suits[1].entries[0].sourceHash = 'b'.repeat(64);
  assert.throws(() => shared.projectSharedEntries(second.state, suits), /内容或设置不一致/);
});

test('a single shared entry must match registered channel and complete settings', () => {
  const initial = shared.registerResource(shared.empty(), request('one'));
  for (const change of [{ channel: 'N' }, { config: { virtualTexture: false } }, { config: {} }]) {
    const suits = [{ assetId: 'one', entries: [{ key: request('one').reference.localKey, ...texture(), ...change }] }];
    assert.throws(() => shared.projectSharedEntries(initial.state, suits), /内容或设置不一致/);
  }
});

test('hash case does not split resource identity or create a content update', () => {
  const first = shared.registerResource(shared.empty(), request('one', texture('A')));
  const second = shared.registerResource(first.state, request('two', texture('a')));
  assert.equal(second.resource.id, first.resource.id);
  assert.equal(shared.planResourceUpdate(second.state, first.resource.id, texture('A')).unchanged, true);
});

test('shared materials validate parent, settings and texture identity even without duplicate entries', () => {
  const first = shared.registerResource(shared.empty(), request('one'));
  const config = { parentPath: '/Game/Test/M_Parent', virtualTexture: true };
  const evidence = { kind: 'material', parentPath: config.parentPath, config, textures: { D: first.resource.id } };
  const reference = { assetId: 'one', localKey: 'one:material:body', metadataPath: 'one/asset_info.json' };
  const state = shared.registerResource(first.state, { ...request('one', evidence), reference,
    ueTarget: { key: reference.localKey, path: '/Game/Test/MI_Body' } }).state;
  const entry = { key: reference.localKey, kind: 'material', config, textures: { D: request('one').reference.localKey } };
  assert.equal(shared.projectSharedEntries(state, [{ assetId: 'one', entries: [entry] }]).suits[0].entries.length, 1);
  for (const change of [{ config: { ...config, parentPath: '/Game/Other' } }, { textures: {} }, { textures: { D: 'missing' } }]) {
    assert.throws(() => shared.projectSharedEntries(state, [{ assetId: 'one', entries: [{ ...entry, ...change }] }]), /不一致|尚未登记/);
  }
});

test('same batch and complete proof share a stable resource; names do not decide identity', () => {
  const first = shared.registerResource(shared.empty(), request('one'));
  const next = shared.registerResource(first.state, request('two'));
  assert.equal(next.resource.id, first.resource.id);
  assert.equal(Object.keys(next.state.resources).length, 1);
  assert.deepEqual(next.resource.ueTarget, first.resource.ueTarget);
  assert.equal(next.resource.references.length, 2);
  const repeat = shared.registerResource(next.state, request('two'));
  assert.equal(repeat.changed, false);
  assert.equal(repeat.state.revision, next.state.revision);
});

test('renaming and deleting an owner preserve the shared UE object for other owners', () => {
  const first = shared.registerResource(shared.empty(), { ...request('one'),
    reference: { ...request('one').reference, localKey: 'one:texture:oldnamebody:D', sourceName: 'T_OldName_D.tga' } });
  const second = shared.registerResource(first.state, request('two'));
  const renamed = shared.renameOwnerReferences(second.state, 'one', 'OldName', 'NewName', new Map([['t_oldname_d.tga', 'T_NewName_D.tga']]));
  const resource = renamed.resources[first.resource.id];
  assert.equal(resource.references[0].localKey, 'one:texture:newnamebody:D');
  assert.equal(resource.references[0].sourceName, 'T_NewName_D.tga');
  assert.deepEqual(resource.ueTarget, first.resource.ueTarget);
  const deleted = shared.removeOwnerReferences(renamed, 'one');
  assert.deepEqual(deleted.resources[first.resource.id].references.map(ref => ref.assetId), ['two']);
  assert.deepEqual(deleted.resources[first.resource.id].ueTarget, first.resource.ueTarget);
  assert.equal(shared.removeOwnerReferences(deleted, 'one'), deleted);
});

test('shared receipt fans out success and failure to every local owner without changing UE identity', () => {
  const aliases = { shared: [{ assetId: 'one', localKey: 'one:D' }, { assetId: 'two', localKey: 'two:D' }] };
  for (const status of ['success', 'failed', 'unchanged']) {
    const rows = shared.expandSharedReceipts([{ key: 'shared', assetId: 'one', status, path: '/Game/T_D' }], aliases);
    assert.deepEqual(rows.map(row => row.key), ['one:D', 'two:D']);
    assert.ok(rows.every(row => row.sharedEntryKey === 'shared' && row.status === status && row.path === '/Game/T_D'));
  }
  assert.throws(() => shared.expandSharedReceipts([{ key: 'shared' }, { key: 'shared' }], aliases), /重复/);
});

test('different texture settings, content or unrelated batches remain independent', () => {
  let state = shared.registerResource(shared.empty(), request('one')).state;
  for (const entry of [request('two', texture('b')), request('three', texture('a', { virtualTexture: false })), request('four', texture(), 'other'), request('five', texture(), '')]) {
    state = shared.registerResource(state, entry).state;
  }
  assert.equal(Object.keys(state.resources).length, 5);
});

test('texture update includes users of dependent shared material and retains UE identity', () => {
  const initial = shared.registerResource(shared.empty(), request('one'));
  const material = { kind: 'material', parentPath: '/Game/Test/M_Parent', config: { roughness: 0.8 }, textures: { D: initial.resource.id } };
  const linked = shared.registerResource(initial.state, {
    ...request('two', material), reference: { assetId: 'two', localKey: 'two:material:body', metadataPath: 'two/asset_info.json' },
    ueTarget: { key: 'two:material:body', path: '/Game/Test/MI_Two' }
  });
  const plan = shared.planResourceUpdate(linked.state, initial.resource.id, texture('b'));
  assert.deepEqual(plan.references.map(ref => ref.assetId).sort(), ['one', 'two']);
  const updated = shared.applyResourceUpdate(linked.state, plan);
  assert.deepEqual(updated.resources[initial.resource.id].ueTarget, initial.resource.ueTarget);
  assert.equal(updated.resources[initial.resource.id].revision, 2);
  assert.equal(updated.resources[linked.resource.id].evidence.textures.D, initial.resource.id);
  assert.equal(linked.state.resources[initial.resource.id].revision, 1);
});

test('different resources cannot claim one UE object and shared decisions cannot disagree', () => {
  const first = shared.registerResource(shared.empty(), request('one'));
  const collision = { ...request('two', texture('b')), ueTarget: request('one').ueTarget };
  assert.throws(() => shared.registerResource(first.state, collision), /相同引擎目标/);
  const aliases = { 'one:D': [{ assetId: 'one', localKey: 'one:D' }, { assetId: 'two', localKey: 'two:D' }] };
  assert.deepEqual(shared.projectSharedDecisions({ 'two:D': 'restore' }, aliases), { 'one:D': 'restore' });
  assert.throws(() => shared.projectSharedDecisions({ 'one:D': 'restore', 'two:D': 'skip' }, aliases), /不同处理方式/);
});

test('new user appearing after preview requires another impact check', () => {
  const initial = shared.registerResource(shared.empty(), request('one'));
  const plan = shared.planResourceUpdate(initial.state, initial.resource.id, texture('b'));
  const next = shared.registerResource(initial.state, request('two'));
  assert.throws(() => shared.applyResourceUpdate(next.state, plan), /重新检查影响范围/);
});

test('invalid metadata paths and missing material dependencies cannot be registered', () => {
  for (const metadataPath of ['../outside.json', 'C:/outside.json', '.assethive/state.json']) {
    const input = request('one'); input.reference.metadataPath = metadataPath;
    assert.throws(() => shared.registerResource(shared.empty(), input), /记录无效/);
  }
  assert.throws(() => shared.registerResource(shared.empty(), request('one', { kind: 'material', parentPath: '/Game/M', textures: { D: 'missing' }, config: {} })), /尚未登记/);
});

test('registry persists, corrupt records are not replaced, and asset writes roll back together', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assethive-shared-'));
  try {
    const first = await shared.mutateRegistry(root, state => shared.registerResource(state, request('one')));
    assert.deepEqual(await shared.readRegistry(root), first.state);
    const asset = path.join(root, 'asset.txt');
    await fs.writeFile(asset, 'before');
    await assert.rejects(shared.mutateRegistry(root, async state => {
      await transactionalFs.writeFile(asset, 'after');
      const next = shared.registerResource(state, request('two'));
      next.state.resources[next.resource.id].ueTarget.path = '/Game/../Invalid';
      return next;
    }), /目标位置/);
    assert.equal(await fs.readFile(asset, 'utf8'), 'before');
    assert.deepEqual(await shared.readRegistry(root), first.state);
    const file = path.join(root, '.assethive', 'CharacterResources.json');
    await fs.writeFile(file, '{bad');
    await assert.rejects(shared.mutateRegistry(root, state => shared.registerResource(state, request('two'))));
    assert.equal(await fs.readFile(file, 'utf8'), '{bad');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
