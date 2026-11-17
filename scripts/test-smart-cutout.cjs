// 端到端验证 smartCutout：生成「浅蓝背景 + 红色主体」测试图，经 worker 跑智能去背景。
const path = require("node:path");
const { Buffer } = require("node:buffer");
const { Worker } = require("node:worker_threads");
const sharp = require("sharp");

(async () => {
  const cacheDir = path.join(process.cwd(), ".cache");
  const src = path.join(cacheDir, "test-cutout-src.png");
  const out = path.join(cacheDir, "test-cutout-out.png");
  const W = 800, H = 600;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`
    + `<rect width="100%" height="100%" fill="#b4c8dc"/>`
    + `<circle cx="400" cy="300" r="150" fill="#c0392b"/>`
    + `<rect x="120" y="120" width="120" height="120" fill="#27ae60"/>`
    + `</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(src);
  console.log("test source:", src);

  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "..", "electron", "services", "imageWorker.js"), {
      workerData: { operation: "smartCutout", args: [src, out, {}] }
    });
    let settled = false;
    worker.on("message", (m) => { settled = true; resolve(m); });
    worker.on("error", (e) => { settled = true; reject(e); });
    worker.on("exit", (c) => { if (!settled) reject(new Error("worker exit " + c)); });
  });

  console.log("worker message:", JSON.stringify(result, null, 2));
  if (result?.result?.ok && result.result.path) {
    const meta = await sharp(result.result.path).metadata();
    console.log("output:", result.result.path, "| size:", meta.width + "x" + meta.height, "| hasAlpha:", meta.hasAlpha);
    console.log("PASS");
  } else {
    console.error("FAILED");
    process.exitCode = 1;
  }
})().catch((e) => { console.error("ERROR:", e?.message || e); process.exit(1); });
