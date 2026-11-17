const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

// One worker belongs to one runner/cache lock. Jobs remain strictly sequential.
class ImportWorker {
  constructor({ cacheRoot, executable, entry = path.resolve(__dirname, '../../electron/main.js'), readyTimeoutMs = 30000, closeTimeoutMs = 5000 }) {
    Object.assign(this, { cacheRoot, executable, entry, readyTimeoutMs, closeTimeoutMs });
    this.proc = null;
    this.starting = null;
    this.pending = null;
    this.busy = false;
    this.closing = false;
    this.sequence = 0;
  }
  async start() {
    if (this.closing) throw new Error('入库工作进程已关闭');
    if (this.starting) return this.starting;
    this.starting = this.launch();
    return this.starting;
  }
  async launch() {
    const workerRoot = path.join(this.cacheRoot, 'worker-runtime');
    await fs.mkdir(workerRoot, { recursive: true });
    const env = { ...process.env, ASSETHIVE_MEGASCANS_IMPORT_WORKER: '1',
      ASSETHIVE_PREVIEW_USER_DATA: workerRoot, ASSETHIVE_PREVIEW_SHARED: workerRoot, ASSETHIVE_DISABLE_GPU: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ASSETHIVE_MEGASCANS_IMPORT_JOB;
    const proc = this.proc = spawn(this.executable || require('electron'), [this.entry], {
      // 安装版模块位于 ASAR 虚拟目录，子进程必须使用实际存在的专属缓存目录。
      cwd: workerRoot, env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    this.exited = new Promise(resolve => proc.once('close', resolve));
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        reject(new Error('入库工作进程启动超时'));
        proc.kill();
      }, this.readyTimeoutMs);
      const fail = message => {
        globalThis.clearTimeout(timer);
        const error = new Error(message);
        reject(error);
        if (this.pending) { this.pending.reject(error); this.pending = null; }
      };
      proc.on('error', () => fail('无法启动或连接入库工作进程'));
      proc.on('exit', code => fail(`入库工作进程已退出（退出码 ${code}）`));
      proc.on('disconnect', () => fail('入库工作进程连接已断开'));
      proc.on('message', message => {
        if (message?.type === 'ready') { globalThis.clearTimeout(timer); resolve(); }
        else if (message?.type === 'result' && this.pending?.requestId === message.requestId) {
          const pending = this.pending;
          this.pending = null;
          if (message.result?.ok) pending.resolve(message.result);
          else pending.reject(new Error(message.result?.message || 'AssetHive 入库进程失败'));
        }
      });
    });
  }
  async run(job) {
    if (this.busy) throw new Error('入库工作进程已有任务');
    this.busy = true;
    try {
      await this.start();
      if (!this.proc.connected) throw new Error('入库工作进程连接已断开');
      return await new Promise((resolve, reject) => {
        const requestId = String(++this.sequence);
        this.pending = { requestId, resolve, reject };
        this.proc.send({ type: 'import', requestId, job }, error => {
          if (error && this.pending?.requestId === requestId) {
            this.pending = null;
            reject(new Error('无法发送入库任务'));
          }
        });
      });
    } finally { this.busy = false; }
  }
  async close() {
    this.closing = true;
    // A launch may still be creating its runtime directory.
    if (this.starting) await this.starting.catch(() => {});
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    const timer = globalThis.setTimeout(() => proc.kill(), this.closeTimeoutMs);
    try {
      if (proc.connected) proc.send({ type: 'shutdown' }, () => {});
      else proc.kill();
      await this.exited;
    } finally { globalThis.clearTimeout(timer); }
  }
}

function serveImportWorker({ run, shutdown, channel = process }) {
  let busy = false, stopping = false;
  const send = message => {
    if (channel.connected) channel.send(message, error => { if (error) shutdown(1); });
  };
  channel.on('disconnect', () => { stopping = true; shutdown(1); });
  channel.on('message', async message => {
    if (message?.type === 'shutdown') {
      stopping = true;
      if (!busy) shutdown(0);
      return;
    }
    if (message?.type !== 'import' || stopping) return;
    const { requestId, job } = message;
    if (busy) { send({ type: 'result', requestId, result: { ok: false, message: '入库工作进程已有任务' } }); return; }
    busy = true;
    try {
      const result = await run(job);
      send({ type: 'result', requestId, result });
    } catch (error) {
      send({ type: 'result', requestId, result: { ok: false, message: error.message } });
    } finally {
      busy = false;
      if (stopping) shutdown(0);
    }
  });
  send({ type: 'ready' });
}

module.exports = { ImportWorker, serveImportWorker };
