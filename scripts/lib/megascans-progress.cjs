const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { atomicJson, assetId } = require('./megascans-transfer.cjs');
const { recordPath } = require('./megascans-paths.cjs');

function safeError(error) {
  return String(error?.message || error || '未知错误')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [已隐藏]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[凭证已隐藏]')
    .slice(0, 1500);
}

class Progress {
  constructor({ cacheRoot, library, resolution, mode, total = null, writeJson = atomicJson, byteFlushMs = 1000 }) {
    this.roots = [cacheRoot, path.join(library, '.megascans')];
    this.writeJson = writeJson;
    this.byteFlushMs = byteFlushMs;
    this.writes = Promise.resolve();
    this.writeError = null;
    this.byteTimer = null;
    this.pendingByte = false;
    this.writingByte = false;
    this.state = { version: 1, runId: crypto.randomUUID(), host: os.hostname(), pid: process.pid,
      library, resolution, mode, startedAt: new Date().toISOString(), status: 'running',
      stage: 'authenticating', total, completed: 0, skipped: 0, processedThisRun: 0, pending: total, current: null };
  }
  persist({ event = true, item = false } = {}) {
    const entry = globalThis.structuredClone(this.state);
    const operation = this.writes.then(async () => {
      if (this.writeError) throw this.writeError;
      for (const root of this.roots) {
        if (item && entry.current) await this.writeJson(await recordPath(path.join(root, 'items'), entry.current.id), entry.current);
        if (item && entry.prefetch) await this.writeJson(await recordPath(path.join(root, 'items'), entry.prefetch.id), entry.prefetch);
        await this.writeJson(path.join(root, 'progress.json'), entry);
        if (event) await fs.appendFile(path.join(root, 'events.jsonl'), `${JSON.stringify(entry)}\n`);
      }
      return entry;
    });
    // Observe background errors immediately, and surface them at the next
    // durable boundary. Never accumulate an unbounded queue of byte updates.
    this.writes = operation.catch(error => { this.writeError ||= error; });
    return operation;
  }
  clearByteTimer() {
    if (this.byteTimer) globalThis.clearTimeout(this.byteTimer);
    this.byteTimer = null;
    this.pendingByte = false;
  }
  scheduleBytes() {
    this.pendingByte = true;
    if (this.byteTimer || this.writingByte) return;
    this.byteTimer = globalThis.setTimeout(() => {
      this.byteTimer = null;
      this.pendingByte = false;
      this.writingByte = true;
      this.persist({ event: false, item: true }).catch(() => {}).finally(() => {
        this.writingByte = false;
        if (this.pendingByte && !this.writeError) this.scheduleBytes();
      });
    }, this.byteFlushMs);
  }
  async flush() {
    const pending = this.pendingByte;
    this.clearByteTimer();
    if (pending) await this.persist({ event: false, item: true });
    await this.writes;
    if (this.writeError) throw this.writeError;
  }
  async update(fields = {}, { event = true } = {}) {
    Object.assign(this.state, fields, { updatedAt: new Date().toISOString() });
    const pending = this.pendingByte;
    this.clearByteTimer();
    return this.persist({ event, item: pending });
  }
  async asset(id, details) {
    assetId(id);
    const current = { ...(this.state.current?.id === id ? this.state.current : {}), ...details, id, updatedAt: new Date().toISOString() };
    delete current.byteUpdate;
    this.state.current = current;
    Object.assign(this.state, { stage: current.stage, updatedAt: current.updatedAt });
    if (details.byteUpdate) {
      if (this.writeError) throw this.writeError;
      this.scheduleBytes();
      return;
    }
    this.clearByteTimer();
    return this.persist({ item: true });
  }
  async prefetch(id, details) {
    assetId(id);
    this.state.prefetch = { ...(this.state.prefetch?.id === id ? this.state.prefetch : {}), ...details, id, updatedAt: new Date().toISOString() };
    delete this.state.prefetch.byteUpdate;
    this.state.updatedAt = this.state.prefetch.updatedAt;
    if (details.byteUpdate) {
      if (this.writeError) throw this.writeError;
      this.scheduleBytes();
      return;
    }
    this.clearByteTimer();
    return this.persist({ item: true });
  }
  async failed(error) {
    const message = safeError(error);
    if (this.state.current) await this.asset(this.state.current.id, { status: 'failed', error: message });
    return this.update({ status: 'failed', error: message });
  }
}

async function readProgress({ cacheRoot, library }) {
  for (const root of [cacheRoot, path.join(library, '.megascans')]) {
    let state;
    try { state = JSON.parse(await fs.readFile(path.join(root, 'progress.json'), 'utf8')); }
    catch (error) { if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) continue; throw error; }
    if (path.resolve(state.library).toLowerCase() !== path.resolve(library).toLowerCase()) continue;
    if (state.status === 'running' && state.host === os.hostname()) {
      try { process.kill(state.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') state.status = 'interrupted'; }
    }
    return state;
  }
  return null;
}

module.exports = { Progress, readProgress, safeError };
