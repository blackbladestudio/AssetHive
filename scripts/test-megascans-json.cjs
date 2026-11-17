const test = require('node:test');
const assert = require('node:assert/strict');
const { readJson } = require('./lib/megascans-json.cjs');

test('transient incomplete JSON is reread without changing the file', async () => {
  const values = ['', '{"id":', '{"id":"AbC"}']; let reads = 0;
  const value = await readJson('shared/asset_info.json', { readFile: async () => values[reads++], sleep: async () => {} });
  assert.equal(value.id, 'AbC'); assert.equal(reads, 3);
});
test('permanently invalid JSON stops with the exact document path', async () => {
  await assert.rejects(readJson('shared/broken.json', { readFile: async () => '', sleep: async () => {} }),
    error => error.code === 'MEGASCANS_JSON' && error.file === 'shared/broken.json' && error.message.includes('shared/broken.json'));
});
test('filesystem permission failures are not treated as incomplete JSON', async () => {
  let reads = 0;
  await assert.rejects(readJson('shared/private.json', { readFile: async () => { reads++; throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, sleep: async () => {} }), error => error.code === 'EACCES');
  assert.equal(reads, 1);
});
