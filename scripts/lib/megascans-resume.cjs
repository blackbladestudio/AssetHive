const fs = require('node:fs/promises');
const path = require('node:path');
const { verifyReceipt } = require('./megascans-transfer.cjs');
const { encodedKey, receiptPath } = require('./megascans-paths.cjs');

async function checkCompletedReceipts({ ids, library, resolution, mode, full = false, shouldStop = async () => false, onProgress = async () => {} }) {
  const root = path.join(library, '.megascans', 'receipts');
  let names;
  try { names = new Set(await fs.readdir(root)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; names = new Set(); }
  const candidates = ids.filter(id => names.has(`${id}.json`) || names.has(`${encodedKey(id)}.json`));
  const completedIds = new Set();
  let checked = 0, lastUpdate = 0;
  const report = async (fields = {}, force = false) => {
    if (force || Date.now() - lastUpdate >= 2000) {
      lastUpdate = Date.now();
      await onProgress({ stage: 'checking', checkingDone: checked, checkingTotal: candidates.length,
        checkingMode: full ? 'full' : 'quick', completed: completedIds.size, skipped: completedIds.size,
        pending: ids.length - completedIds.size, ...fields });
    }
  };
  const pause = Object.assign(new Error('已请求暂停校验'), { code: 'MEGASCANS_PAUSED' });
  await report({}, true);
  try {
    for (const id of candidates) {
      if (await shouldStop()) throw pause;
      const receipt = JSON.parse(await fs.readFile(await receiptPath(library, id), 'utf8'));
      if (receipt.resolution !== resolution) throw new Error('共享库已有另一分辨率的归档记录，请使用独立目标库');
      if (receipt.mode === mode || mode === 'archive') {
        await verifyReceipt(library, receipt, id, { content: full, onFile: async item => {
          if (await shouldStop()) throw pause;
          await report({ checkingId: id, checkingFile: item.file });
        } });
        completedIds.add(id);
      }
      checked++;
      await report({ checkingId: id, checkingFile: '' });
    }
  } catch (error) {
    if (error !== pause) throw error;
    await report({ checkingFile: '' }, true);
    return { completedIds, paused: true };
  }
  await report({ checkingId: null, checkingFile: '' }, true);
  return { completedIds, paused: false };
}

module.exports = { checkCompletedReceipts };
