const crypto = require('node:crypto');
const lod = require('../../shared/characterLods.cjs');
const model = file => ['model', 'staticMesh', 'skeletalMesh'].includes(file.role);
const name = file => file.normalizedName || file.storedPath;
const identity = file => lod.identity(name(file)).replace(/^(?:sk|sm)_/, '');

// Only replacing an existing base invalidates its paired chain. First-time SK
// uploads must still be able to use an SM LOD1 which arrived earlier.
function invalidateReplacedBaseLods(incoming, retained, changes, previous) {
  for (const file of incoming) {
    const old = previous.find(item => item.storedPath === file.replacesStoredPath
      || name(item).toLowerCase() === name(file).toLowerCase());
    if (old?.lodReset) file.lodReset = old.lodReset;
    if (old?.ignoreEmbeddedLods) file.ignoreEmbeddedLods = true;
  }
  const replaced = incoming.filter(file => model(file) && !lod.level(name(file))
    && changes.some(change => change.name === name(file) && change.status === 'changed'));
  for (const key of new Set(replaced.map(identity))) {
    const token = crypto.createHash('sha256').update(JSON.stringify(replaced.filter(file => identity(file) === key)
      .map(file => [name(file), file.sha256, file.lodReset || '']).sort())).digest('hex');
    for (const [keyName, file] of retained) {
      if (!model(file) || identity(file) !== key) continue;
      if (lod.level(name(file))) {
        retained.delete(keyName);
        changes.push({ name: name(file), status: 'removed' });
      } else retained.set(keyName, { ...file, lodReset: token, ignoreEmbeddedLods: true, lodCount: 1 });
    }
    for (const file of incoming.filter(file => model(file) && identity(file) === key && !lod.level(name(file)))) {
      file.lodReset = token;
      // Explicitly supplied base files may contain a fresh embedded LOD chain.
      if (replaced.includes(file)) delete file.ignoreEmbeddedLods;
      else { file.ignoreEmbeddedLods = true; file.lodCount = 1; }
    }
  }
}
module.exports = { invalidateReplacedBaseLods };
