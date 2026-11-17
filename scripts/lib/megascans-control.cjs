const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { atomicJson } = require('./megascans-transfer.cjs');

async function activeRunner(cacheRoot) {
  let owner;
  try { owner = JSON.parse(await fs.readFile(path.join(cacheRoot, 'runner.lock'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (owner.host !== os.hostname()) return true;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function pauseRequested(cacheRoot, runId) {
  try { return JSON.parse(await fs.readFile(path.join(cacheRoot, 'pause-request.json'), 'utf8')).runId === runId; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function requestPause(cacheRoot, runId) {
  if (!runId || !await activeRunner(cacheRoot)) throw new Error('当前没有运行中的任务');
  await atomicJson(path.join(cacheRoot, 'pause-request.json'), { runId, requestedAt: new Date().toISOString() });
}
module.exports = { activeRunner, pauseRequested, requestPause };
