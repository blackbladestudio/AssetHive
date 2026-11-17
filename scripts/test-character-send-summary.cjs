const test = require('node:test');
const assert = require('node:assert/strict');
const { characterSendSummary } = require('../shared/characterSendSummary.mjs');
test('send summary respects actual decisions, groups and successful results', () => {
  const row = (key, kind, status = 'ready', action = 'added') => ({ key, kind, status, action, name: key, groupName: 'Head', partSlot: 'Head' });
  const rows = [row('a:staticMesh:head', 'staticMesh'), row('a:skeletalMesh:head', 'skeletalMesh', 'blocked'),
    row('a:texture:head:D', 'texture'), row('a:texture:head:N', 'texture'), row('a:texture:head:ORM', 'texture', 'missing', 'restore'),
    row('a:texture:arm:D', 'texture', 'unchanged', 'unchanged'), row('a:material:head', 'material', 'conflict', 'adopt')];
  let summary = characterSendSummary(rows);
  assert.equal(summary.total, 4); assert.equal(summary.skeletalMesh.count, 0);
  assert.deepEqual(summary.textures, { count: 3, groupCount: 1, groups: ['Head'] });
  assert.equal(summary.materials.count, 0); assert.equal(summary.pending, 2);
  summary = characterSendSummary(rows, { 'a:material:head': 'adopt' });
  assert.equal(summary.materials.count, 1);
  summary = characterSendSummary([row('ok', 'staticMesh', 'success'), row('bad', 'texture', 'failed')], {}, true);
  assert.equal(summary.total, 1); assert.equal(summary.textures.count, 0);
});
