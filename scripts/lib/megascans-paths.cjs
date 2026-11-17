const fs = require('node:fs/promises');
const path = require('node:path');
const { Buffer } = require('node:buffer');
const { readJson } = require('./megascans-json.cjs');

function assetId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('无效的 Quixel 资产 ID');
  return value;
}

// Quixel IDs are case-sensitive; Windows/SMB paths are not. The reserved '~'
// prefix cannot occur in a source ID, and hex preserves every original byte.
const encodedKey = id => `~${Buffer.from(assetId(id)).toString('hex')}`;
function storageId(key) {
  if (!key.startsWith('~')) return assetId(key);
  const id = Buffer.from(key.slice(1), 'hex').toString();
  if (encodedKey(id) !== key) throw new Error('资产存储路径编码无效');
  return id;
}
async function present(file) {
  try { await fs.stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function ownedPath(root, id, suffix, ownerFile) {
  assetId(id);
  const encoded = path.join(root, encodedKey(id) + suffix);
  if (await present(encoded)) {
    const record = await readJson(ownerFile ? path.join(encoded, ownerFile) : encoded);
    if (record.id !== id) throw new Error('资产编码路径所有权不匹配，拒绝清理或复用');
    return encoded;
  }
  const legacy = path.join(root, id + suffix);
  if (await present(legacy)) {
    const record = await readJson(ownerFile ? path.join(legacy, ownerFile) : legacy);
    if (record.id === id) return legacy;
    // Only a confirmed case sibling may use the alternate namespace. Other
    // identity mismatches remain integrity errors, never silently bypassed.
    if (typeof record.id !== 'string' || record.id.toLowerCase() !== id.toLowerCase()) throw new Error('资产路径所有权不匹配，拒绝清理或复用');
    return encoded;
  }
  return /[A-Z]/.test(id) ? encoded : legacy;
}
const recordPath = (root, id) => ownedPath(root, id, '.json');
const receiptPath = (library, id) => recordPath(path.join(library, '.megascans', 'receipts'), id);
const cachePath = (cacheRoot, id) => ownedPath(path.join(cacheRoot, 'assets'), id, '', '.transfer-owner.json');

module.exports = { assetId, encodedKey, storageId, recordPath, receiptPath, cachePath };
