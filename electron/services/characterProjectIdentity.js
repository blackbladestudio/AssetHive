const crypto = require('node:crypto');
const normalize = value => String(value || '').replaceAll('\\', '/').toLowerCase();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function projectId(editor) {
  const id = String(editor?.projectId || '').replace(/[{}-]/g, '').toLowerCase();
  return /^[a-f0-9]{32}$/.test(id) && !/^0+$/.test(id) ? id : '';
}
function projectKey(editor) {
  const id = projectId(editor);
  return hash(id ? `ue-project:${id}` : normalize(editor?.projectPath));
}
function projectReceipt(meta, editor) {
  const receipts = meta?.characterUnrealExports || {};
  const current = receipts[projectKey(editor)];
  if (current) return current;
  const legacy = receipts[hash(normalize(editor?.projectPath))];
  return legacy && (!projectId(legacy) || projectId(legacy) === projectId(editor)) ? legacy : undefined;
}
module.exports = { projectId, projectKey, projectReceipt };
