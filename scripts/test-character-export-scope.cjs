const { test } = require('node:test');
const assert = require('node:assert/strict');
const { characterExportScope } = require('../shared/characterExportScope.mjs');

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
