const fs = require('node:fs/promises');

// SMB readers can briefly observe an empty/partial JSON during replacement.
// Retry bounded reads, never overwrite the document or accept invalid data.
async function readJson(file, { readFile = fs.readFile, sleep = ms => new Promise(resolve => globalThis.setTimeout(resolve, ms)), attempts = 4 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (attempt + 1 === attempts) throw Object.assign(new Error(`JSON 文件读取不完整或格式错误：${file}`, { cause: error }), { code: 'MEGASCANS_JSON', file });
      await sleep(100 * 2 ** attempt);
    }
  }
}

module.exports = { readJson };
