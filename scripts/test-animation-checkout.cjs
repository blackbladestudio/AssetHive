const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { checkoutAnimationTargets, existingAnimationTargets, perforceSettings } = require('../electron/services/animationCheckout');
const { unrealFolderFromDirectory } = require('../electron/services/animationUnrealFolders');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'animation-checkout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'P.uproject');
  const folder = path.join(root, 'Content', 'Characters', 'Monster', 'Animation', 'Loco');
  await fs.mkdir(folder, { recursive: true });
  const filename = path.join(folder, 'AS_Walk.uasset');
  await fs.writeFile(filename, 'existing animation');
  return { project, filename, folder, entries: [{ key: 'walk', targetPath: '/Game/Characters/Monster/Animation/Loco/AS_Walk' }], state: { depotFile: '//Depot/P/AS_Walk.uasset', clientFile: filename, isMapped: '', haveRev: '3', headRev: '3' } };
}

test('native directory selection converts only this project Content folders to /Game', async t => {
  const f = await fixture(t);
  assert.equal(await unrealFolderFromDirectory(f.project, f.folder), '/Game/Characters/Monster/Animation/Loco');
  await assert.rejects(unrealFolderFromDirectory(f.project, path.dirname(f.project)), /Content/);
  assert.deepEqual((await existingAnimationTargets(f.project, f.entries)).map(row => row.exists), [true]);
});

test('checkout reads UE Perforce settings without reading authentication secrets', async t => {
  const f = await fixture(t);
  const config = path.join(path.dirname(f.project), 'Saved', 'Config', 'WindowsEditor');
  await fs.mkdir(config, { recursive: true });
  const filename = path.join(config, 'SourceControlSettings.ini');
  await fs.writeFile(filename, '[PerforceSourceControl.PerforceSourceControlSettings]\nPort=server:1666\nUserName=artist\nWorkspace=workspace\nPassword=secret\n[SourceControl.SourceControlSettings]\nProvider=Perforce');
  assert.deepEqual(await perforceSettings(f.project), ['-p', 'server:1666', '-u', 'artist', '-c', 'workspace']);
});

test('an existing mapped animation is checked out with only its exact filename before import', async t => {
  const f = await fixture(t);
  const commands = [];
  const notes = await checkoutAnimationTargets(f.project, f.entries, null, { settings: async () => [], runP4: async args => {
    commands.push(args);
    return [args.includes('fstat') ? f.state : { clientFile: f.filename, action: 'edit' }];
  } });
  assert.deepEqual(commands.map(args => args.at(-2)), ['fstat', 'edit']);
  assert.ok(commands.every(args => args.at(-1) === f.filename));
  assert.match(notes.get('walk'), /已自动.*迁出/);
  assert.equal(await fs.readFile(f.filename, 'utf8'), 'existing animation');
});

test('new assets need no checkout and already-open assets preserve their changelist', async t => {
  const f = await fixture(t);
  let commands = 0;
  const dependencies = { settings: async () => [], runP4: async args => { commands++; assert.ok(args.includes('fstat')); return [{ ...f.state, action: 'edit', change: '1234' }]; } };
  await checkoutAnimationTargets(f.project, [{ key: 'new', targetPath: '/Game/New/AS_New' }], null, dependencies);
  assert.equal(commands, 0);
  const notes = await checkoutAnimationTargets(f.project, f.entries, null, dependencies);
  assert.equal(commands, 1);
  assert.match(notes.get('walk'), /已在当前/);
});

test('other owners, unresolved files, wrong mappings and stale revisions cannot trigger edit', async t => {
  const f = await fixture(t);
  for (const state of [{ ...f.state, otherOpen: '1' }, { ...f.state, unresolved: '1' }, { ...f.state, clientFile: 'D:/Other/AS_Walk.uasset' }, { ...f.state, haveRev: '2' }]) {
    await assert.rejects(checkoutAnimationTargets(f.project, f.entries, null, { settings: async () => [], runP4: async args => {
      assert.ok(args.includes('fstat'), 'No edits allowed after failed validation'); return [state];
    } }));
  }
});

test('a later invalid target prevents checkouts for the entire batch', async t => {
  const f = await fixture(t);
  const second = path.join(f.folder, 'AS_Stop.uasset');
  await fs.writeFile(second, 'stop');
  await assert.rejects(checkoutAnimationTargets(f.project, [...f.entries, { key: 'stop', targetPath: '/Game/Characters/Monster/Animation/Loco/AS_Stop' }], null, {
    settings: async () => [], runP4: async args => {
      assert.ok(args.includes('fstat')); return [{ ...f.state, clientFile: args.at(-1), ...(args.at(-1) === second ? { otherOpen0: 'someone@workspace' } : {}) }];
    }
  }), /他人/);
});

test('checkout failure is reported rather than changing read-only attributes or submitting', async t => {
  const f = await fixture(t);
  const commands = [];
  await assert.rejects(checkoutAnimationTargets(f.project, f.entries, null, { settings: async () => [], runP4: async args => {
    commands.push(args.at(-2));
    return args.includes('fstat') ? [f.state] : [{ code: 'error', data: 'Checkout rejected' }];
  } }), /迁出失败/);
  assert.deepEqual(commands, ['fstat', 'edit']);
  assert.equal(await fs.readFile(f.filename, 'utf8'), 'existing animation');
});
