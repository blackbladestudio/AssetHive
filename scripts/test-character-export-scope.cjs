const { test } = require('node:test');
const assert = require('node:assert/strict');
const { characterExportScope, skipUnreadyCharacterEntries } = require('../shared/characterExportScope.mjs');

test('optional static meshes exclude only their exclusive dependencies', () => {
  const rows = [
    { key: 'sm', kind: 'staticMesh', dependencies: ['shared', 'staticOnly'] },
    { key: 'sk', kind: 'skeletalMesh', dependencies: ['shared'] },
    { key: 'shared', kind: 'material', dependencies: ['commonTexture'] },
    { key: 'staticOnly', kind: 'material', dependencies: ['commonTexture', 'staticTexture'] },
    { key: 'commonTexture', kind: 'texture' },
    { key: 'staticTexture', kind: 'texture' },
    { key: 'unbound', kind: 'material', dependencies: ['unboundTexture'] },
    { key: 'unboundTexture', kind: 'texture' }
  ];
  assert.deepEqual(characterExportScope(rows).map(row => row.key), ['sk', 'shared', 'commonTexture', 'unbound', 'unboundTexture']);
  assert.equal(characterExportScope(rows, true), rows);
  assert.equal(rows.length, 8);
});

test('legacy rows without dependencies remain usable and cyclic references terminate', () => {
  assert.deepEqual(characterExportScope([{ key: 'sm', kind: 'staticMesh' }, { key: 't', kind: 'texture' }]), [{ key: 't', kind: 'texture' }]);
  const rows = [{ key: 'sm', kind: 'staticMesh', dependencies: ['a'] },
    { key: 'a', kind: 'material', dependencies: ['b'] }, { key: 'b', kind: 'material', dependencies: ['a'] }];
  assert.deepEqual(characterExportScope(rows).map(row => row.key), ['a', 'b']);
});

test('an unresolved branch can be deferred without sending its dependents or splitting a shared resource', () => {
  const rows = [
    { key: 'one:D', status: 'blocked', sharedEntryKey: 'shared:D' },
    { key: 'two:D', status: 'ready', sharedEntryKey: 'shared:D' },
    { key: 'one:MI', status: 'ready', dependencies: ['one:D'] },
    { key: 'two:MI', status: 'ready', dependencies: ['two:D'] },
    { key: 'SK', status: 'ready', dependencies: ['two:MI'] },
    { key: 'other:D', status: 'ready' },
    { key: 'other:MI', status: 'ready', dependencies: ['other:D'] }
  ];
  const decisions = skipUnreadyCharacterEntries(rows, { 'other:MI': 'keepUE' });
  assert.deepEqual(Object.keys(decisions).filter(key => decisions[key] === 'skip').sort(), ['one:D', 'two:D', 'one:MI', 'two:MI', 'SK'].sort());
  assert.equal(decisions['other:MI'], 'keepUE');
  assert.equal(decisions['other:D'], undefined);
  assert.deepEqual(skipUnreadyCharacterEntries(rows, decisions), decisions);
  const summary = require('../shared/characterSendSummary.mjs').characterSendSummary(rows.map(row => ({ ...row, action: 'added', kind: row.key.endsWith(':D') ? 'texture' : 'material' })), decisions);
  assert.equal(summary.total, 2);
  assert.equal(summary.pending, 5);
});
