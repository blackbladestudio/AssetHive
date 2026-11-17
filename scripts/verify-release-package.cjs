const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

const directory = path.resolve(process.argv[2] || '.cache/AssetHivePackOut/AssetHive-win32-x64');
const archive = path.join(directory, 'resources/app.asar');
assert.ok(fs.statSync(path.join(directory, 'AssetHiveUpdater.exe')).size > 0);
const probe = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.argv[2];
const expected = process.argv[3];
assert.equal(require(path.join(root, 'package.json')).version, expected);
for (const relative of ['dist/index.html','shared/characterComponents.mjs','electron/scripts/render_groom_preview.py']) {
  assert.ok(fs.statSync(path.join(root,relative)).size > 0, relative);
}
for (const relative of ['.tmp','.agents','.git','Output','src']) assert.equal(fs.existsSync(path.join(root,relative)),false,relative);
assert.equal(typeof require(path.join(root,'electron/services/groomPreview.js')).renderGroomPreview,'function');
console.log('Packaged version, character resources and temporary-file exclusions OK');
`;
const result = spawnSync(path.join(directory, 'AssetHive.exe'), ['-', archive, require('../package.json').version], {
  input: probe, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30000, windowsHide: true
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error) throw result.error;
assert.equal(result.status, 0, 'Packaged runtime validation failed');
