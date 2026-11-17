"use strict";

const fs = require("node:fs");
const path = require("node:path");

const WORKER_NAME = "foliageOpaqueWorker.js";

function resolveFoliageRuntime() {
  const workerPath = path.join(__dirname, WORKER_NAME);
  let message = "";
  if (!fs.existsSync(workerPath)) {
    message = "未找到不透明裁切处理器";
  } else {
    try {
      require.resolve("sharp");
      require.resolve("three");
      const exporterPath = path.join(__dirname, "..", "..", "node_modules", "@comfyorg", "fbx-exporter-three", "dist", "index.js");
      if (!fs.existsSync(exporterPath)) throw new Error("缺少 FBX 写出组件");
    } catch (error) {
      message = `不透明裁切组件不完整：${error?.message || String(error)}`;
    }
  }
  return { available: !message, workerPath, message };
}

module.exports = { WORKER_NAME, resolveFoliageRuntime };
