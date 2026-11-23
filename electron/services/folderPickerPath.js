const fs = require('node:fs/promises');
const path = require('node:path');

async function folderPickerPath(value, stat = fs.stat, paths = path) {
  if (!String(value || '').trim()) return undefined;
  let current = paths.resolve(String(value).trim());
  for (;;) {
    const entry = await stat(current).catch(() => null);
    // A trailing separator tells the native picker to enter the folder.
    if (entry?.isDirectory()) return current.endsWith(paths.sep) ? current : current + paths.sep;
    const parent = paths.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
module.exports = { folderPickerPath };
