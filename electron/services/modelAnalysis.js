"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { setTimeout, clearTimeout } = require("node:timers");

const WORKER_PATH = path.join(__dirname, "modelAnalysisWorker.js");
const DEFAULT_TIMEOUT_MS = 90000;
// worker 的 V8 堆上限。撞顶时 V8 会以 "Reached heap limit" 直接 abort 整个
// Electron 进程（不是只结束 worker，见 2026-10-13 的 134 崩溃），所以大的 FBX
// 需要足够的余量：默认 8192，可用 ASSETHIVE_FBX_WORKER_HEAP_MB 覆盖。
const WORKER_HEAP_MB = Math.max(256, Number(process.env.ASSETHIVE_FBX_WORKER_HEAP_MB) || 8192);
let pending = Promise.resolve();

function analyzeFbxOnce(filePath, timeoutMs, measurePlant, geometryOnlyTextures) {
  return new Promise((resolve) => {
    let worker;
    let settled = false;
    let timer;
    const finish = async (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (worker) await worker.terminate().catch(() => {});
      resolve(result);
    };
    try {
      worker = new Worker(WORKER_PATH, {
        workerData: { filePath, measurePlant, geometryOnlyTextures },
        resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB }
      });
      worker.unref();
    } catch (error) {
      void finish({ bounds: null, collision: null, error: error?.message || String(error) });
      return;
    }
    timer = setTimeout(() => {
      void finish({ bounds: null, collision: null, error: `FBX analysis timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    worker.on("message", (message) => {
      void finish(message?.ok ? message.result : {
        bounds: null,
        collision: null,
        error: message?.error || "FBX analysis failed"
      });
    });
    worker.on("error", (error) => {
      void finish({ bounds: null, collision: null, error: error?.message || String(error) });
    });
    worker.on("exit", (code) => {
      void finish({ bounds: null, collision: null, error: `FBX analysis worker exited with code ${code}` });
    });
  });
}

function analyzeFbxInWorker(filePath, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const task = pending.then(() => analyzeFbxOnce(filePath, timeoutMs, options.measurePlant === true, options.geometryOnlyTextures === true));
  pending = task.catch(() => {});
  return task;
}

module.exports = { analyzeFbxInWorker };
