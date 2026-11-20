const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout } = require('node:timers');
const { boundedMap } = require('../electron/services/boundedMap');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test('bounded file I/O overlaps latency, preserves result order and respects its cap', async () => {
  let active = 0, peak = 0;
  const output = await boundedMap([30, 5, 10, 2, 4], 3, async (delay, index) => {
    peak = Math.max(peak, ++active); await wait(delay); active--; return index;
  });
  assert.deepEqual(output, [0, 1, 2, 3, 4]); assert.equal(peak, 3); assert.equal(active, 0);
});
test('failure drains active writes and stops dispatching new work before rejecting', async () => {
  const started = [], completed = [];
  await assert.rejects(boundedMap([0,1,2,3,4], 2, async value => {
    started.push(value);
    if (!value) { await wait(1); throw new Error('copy failed'); }
    await wait(20); completed.push(value);
  }), /copy failed/);
  assert.deepEqual(started, [0,1]); assert.deepEqual(completed, [1]);
});
