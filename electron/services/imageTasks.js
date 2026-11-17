const path = require("node:path");
const os = require("node:os");
const { Worker } = require("node:worker_threads");
const { setTimeout, clearTimeout } = require("node:timers");

// 有界并发池：批量导入时 --jobs 只并发解压，所有贴图处理此前仍被串行排队，
// 成为吞吐瓶颈。改为按 CPU 核数限制同时运行的 worker 数。
// 每个 worker 内部 libvips 仍保持单线程（imageWorker.js 的 sharp.concurrency(1)），
// 因此总并行度精确等于池大小，避免 libvips 线程 × worker 的乘法爆炸与内存峰值失控。
function resolveConcurrency() {
  const configured = Number(process.env.ASSETHIVE_IMAGE_CONCURRENCY);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.floor(configured));
  }
  const cpuCount = Array.isArray(os.cpus?.()) ? os.cpus().length : 0;
  if (cpuCount <= 0) return 2;
  return Math.max(1, Math.min(4, Math.floor(cpuCount / 2)));
}

const limit = resolveConcurrency();
let active = 0;
const queue = [];
const pending = new Map();

function acquire() {
  if (active < limit) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

function release() {
  const next = queue.shift();
  if (next) next();
  else active -= 1;
}

function spawnWorker(operation, args) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "imageWorker.js"), {
      workerData: { operation, args }
    });
    // 图像 worker 不阻塞应用退出，避免退出时残留进程。
    worker.unref();
    let result;
    let failure;
    const timer = setTimeout(() => {
      failure = new Error(`图像处理超时：${operation}`);
      void worker.terminate();
    }, 5 * 60 * 1000);
    worker.on("message", (message) => {
      if (message.error) failure = new Error(message.error);
      else result = message.result;
    });
    worker.on("error", (error) => { failure = error; });
    worker.on("exit", (code) => {
      clearTimeout(timer);
      if (failure || code !== 0 || result === undefined) {
        reject(failure || new Error(`图像处理任务异常退出 (${code})：${operation}`));
      } else resolve(result);
    });
  });
}

function runImageTask(operation, args) {
  const key = JSON.stringify([operation, args]);
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    await acquire();
    try {
      return await spawnWorker(operation, args);
    } finally {
      release();
    }
  })();
  pending.set(key, task);
  void task.finally(() => pending.delete(key)).catch(() => {});
  return task;
}

module.exports = { runImageTask };
