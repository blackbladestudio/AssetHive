"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { setTimeout, clearTimeout } = require("node:timers");
const { normalizeTextureType } = require("./textureTypes");
const { resolveFoliageRuntime } = require("./foliageOpaqueRuntime");
// 遮罩来源解析要读贴图的真实尺寸与 alpha 通道（见 resolveFoliageMaskSource）。
const sharp = require("sharp");

const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_FACE_BUDGET = 200000;
// 细碎面片清理默认关闭（0 = 不清理）；开启时由导入界面传入「区域大小比率阈值」（%）。
const DEFAULT_CLEANUP_PERCENT = 0;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
// 裁切 worker 的堆上限。见下方 new Worker 处的实测内存数据。
// 6GB 够 500 万面片的生成档；更高会显著推高 RSS 并拖慢整机。
const WORKER_HEAP_MB = 6144;
// 生成阶段的面片数上限：直接决定内存峰值（实测约 1.1KB/面片，含对象开销）。
//
// 实测（beech fern，源网格 5,853 面，6GB 堆）：
//   上限 200 万 → heap 2.8GB / RSS 5.0GB，但 step 6 及以下**全部撞顶**，档位失去意义
//   上限 500 万 → heap 3.1GB / RSS 5.7GB，step 6 可完整展开（489 万面片，不撞顶）
//   不设上限（step 4）→ 780 万面片 → heap 9.2GB / RSS 10.8GB → 必 OOM
//
// 取 500 万：档位仍能体现差异，同时峰值留在 6GB 堆以内。
//
// 注意：这个 6GB 只在普通 Node 下成立。**应用实际跑在 Electron 里，JS 堆硬顶约
// 3.78GB**，Node 的 resourceLimits/execArgv/NODE_OPTIONS 在 Electron 下全部无效
// （实测），而 worker OOM 会终止整个应用进程。因此 trace 路线已改用
// DEFAULT_TRACE_MAX_FACES（默认 100 万面）作为真正的闸门；本常量只作为旧 plan
// 文件里字段的兼容回退保留，新代码不要再用它当作生成上限。
const DEFAULT_DENSE_FACE_LIMIT = 5000000;

// trace 路线的面数上限（外部可调，默认 100 万面）。这是该路线唯一的面数闸门，
// 也就直接决定了内存峰值 —— 实测约 1.1KB/面片，100 万面 ≈ 1.1GB 堆。
//
// 为什么默认值必须压在这里：**Electron 下 JS 堆硬顶约 3.78GB**（Chromium 给每个
// isolate 的上限，Node 的 resourceLimits / execArgv / NODE_OPTIONS / --js-flags
// 在 Electron 里逐一实测均无效），而 worker 线程 OOM 会**终止整个进程** ——
// 表现就是"点导入后软件直接闪退"，连日志都来不及写。100 万面留出足够余量，
// 同时仍然是对最终面数档（10~30 万）的 3~10 倍过采样，边界精度不受影响。
// 需要更密的边界时由调用方显式调大（代价是内存峰值上升）。
const DEFAULT_TRACE_MAX_FACES = 1000000;

// 遮罩来源优先级（2026-10-15 口径）：只认两种来源，而且必须**真的能用**。
//   1) Opacity（兼容旧 OpacityMask/OpacityMasked，Atlas、非 billboard、area 1）—— 同一档里取**分辨率最高**的那张；
//   2) 退而求其次：Albedo / Diffuse / Basecolor（含 *OpacityMasked 变体）的 **alpha 通道**，
//      且贴图必须真的有 alpha：JPG 这类没有 alpha 的当遮罩用会得到"全不透明"，
//      等于把整株切成实心块，比不用更糟。
// 两级都没有 ⇒ 不透明裁切不可用（requiresAlpha 标记第二档的校验要求）。
const MASK_SOURCE_PRIORITY = Object.freeze([
  { textureType: "Opacity", rank: 10, channel: "auto", requiresAlpha: false },
  { textureType: "AlbedoOpacityMasked", rank: 20, channel: "alpha", requiresAlpha: true },
  { textureType: "DiffuseOpacityMasked", rank: 20, channel: "alpha", requiresAlpha: true },
  { textureType: "BasecolorOpacityMasked", rank: 20, channel: "alpha", requiresAlpha: true },
  { textureType: "Albedo", rank: 20, channel: "alpha", requiresAlpha: true },
  { textureType: "Diffuse", rank: 20, channel: "alpha", requiresAlpha: true },
  { textureType: "Basecolor", rank: 20, channel: "alpha", requiresAlpha: true }
]);
const MASK_PRIORITY_BY_TYPE = new Map(MASK_SOURCE_PRIORITY.map((item) => [item.textureType, item]));
const MASK_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".tga", ".tif", ".tiff", ".exr", ".webp", ".bmp"]);

function textureTypeOf(entry) {
  const raw = entry?.textureType || entry?.slot || entry?.suffix || "";
  return normalizeTextureType(raw) || String(raw || "").trim();
}

function filePathOf(entry) {
  return String(entry?.path || entry?.filePath || entry?.file || entry?.source || "").trim();
}

// 读贴图的真实尺寸与是否有 alpha。读不出来（损坏/不支持的格式）按不可用处理，
// 不能退回文件名猜测 —— 猜错会把没有 alpha 的图当遮罩，切出实心块。
async function probeMaskCandidate(filePath) {
  try {
    const meta = await sharp(filePath).metadata();
    const width = Number(meta?.width) || 0;
    const height = Number(meta?.height) || 0;
    if (!width || !height) return null;
    return {
      width,
      height,
      pixels: width * height,
      hasAlpha: meta?.hasAlpha === true || Number(meta?.channels) === 4
    };
  } catch {
    return null;
  }
}

// 解析可用的遮罩来源。返回 null = 不可用（调用方据此禁用入口并给出原因）。
// 同档多份候选取分辨率最高者；某档全部不可用（无 alpha / 读不出）时继续往下一档找。
async function resolveFoliageMaskSource(textureEntries) {
  const entries = Array.isArray(textureEntries) ? textureEntries : [];
  const skipped = [];
  const candidates = [];
  for (const entry of entries) {
    const priority = MASK_PRIORITY_BY_TYPE.get(textureTypeOf(entry));
    if (!priority) continue;
    const filePath = filePathOf(entry);
    if (!filePath) continue;
    if (String(entry?.materialRole || "").trim().toLowerCase() === "billboard") {
      skipped.push(`${textureTypeOf(entry)}:billboard`);
      continue;
    }
    const areaIndex = Math.max(1, Number(entry?.areaIndex ?? entry?.areaId) || 1);
    if (areaIndex !== 1) {
      skipped.push(`${textureTypeOf(entry)}:area${areaIndex}`);
      continue;
    }
    const ext = path.extname(filePath).toLowerCase();
    if (!MASK_IMAGE_EXTENSIONS.has(ext)) {
      skipped.push(`${textureTypeOf(entry)}:${ext || "unknown"}`);
      continue;
    }
    candidates.push({ ...priority, filePath, textureType: priority.textureType });
  }
  if (!candidates.length) {
    return null;
  }
  const ranks = [...new Set(candidates.map((item) => item.rank))].sort((a, b) => a - b);
  for (const rank of ranks) {
    let best = null;
    let unprobedFallback = null;
    for (const candidate of candidates.filter((item) => item.rank === rank)) {
      const probe = await probeMaskCandidate(candidate.filePath);
      if (!probe) {
        // 读不出来（损坏 / 不支持的格式 / 测试替身）：不能参与分辨率与 alpha 判定。
        // 记录为兜底候选 —— 只有当这一档**没有任何**可读文件时才用它，避免"文件坏了
        // 就直接判不可用"把整个入库流程打断。
        skipped.push(`${candidate.textureType}:unreadable`);
        if (!unprobedFallback) {
          unprobedFallback = {
            filePath: candidate.filePath,
            textureType: candidate.textureType,
            channel: candidate.channel,
            rank: candidate.rank,
            width: 0,
            height: 0,
            requiresAlpha: candidate.requiresAlpha,
            probed: false
          };
        }
        continue;
      }
      if (candidate.requiresAlpha && !probe.hasAlpha) {
        skipped.push(`${candidate.textureType}:no-alpha`);
        continue;
      }
      if (!best || probe.pixels > best.pixels) {
        best = {
          filePath: candidate.filePath,
          textureType: candidate.textureType,
          channel: candidate.channel,
          rank: candidate.rank,
          width: probe.width,
          height: probe.height,
          // pixels 必须一起记下来：同档比较下一份候选时要拿它当基准，
          // 漏掉就会让"取分辨率最高"永远退化成"取第一份"。
          pixels: probe.pixels,
          requiresAlpha: candidate.requiresAlpha,
          probed: true
        };
      }
    }
    if (best) {
      return { ...best, skipped };
    }
    if (unprobedFallback) {
      return { ...unprobedFallback, skipped };
    }
  }
  return null;
}

// 给界面用的一句话说明：为什么不可用 / 用的是哪张。
function describeFoliageMaskSource(source) {
  if (!source) {
    return "未找到可用的透明度来源（透贴）：既没有 Opacity 贴图，也没有带 alpha 通道的 Albedo/Diffuse/Basecolor";
  }
  const size = source.width && source.height ? ` ${source.width}×${source.height}` : "";
  const how = source.channel === "alpha"
    ? `${source.textureType} 的 alpha 通道${size}`
    : `${source.textureType}${size}`;
  return `透明度来源：${path.basename(source.filePath)}（${how}）`;
}

// 裁切 worker 的并发上限。此前是严格串行队列（taskTail）：12 个变体在
// 一个单线程 worker 里排队跑满 6 分钟，CPU 与内存都吃不满 —— 单 worker
// 峰值实测约 5.7GB RSS（step 4，生成 4.7M 面片），125GB 内存的机器上
// 4 个并行 worker 也只占约 23GB。并发度按物理内存推导，
// ASSETHIVE_FOLIAGE_WORKERS 可覆盖（1..8）。
function resolveWorkerConcurrency() {
  const configured = Number(process.env.ASSETHIVE_FOLIAGE_WORKERS);
  if (Number.isFinite(configured) && configured >= 1) {
    return Math.min(8, Math.floor(configured));
  }
  const totalGb = os.totalmem() / (1024 ** 3);
  if (totalGb >= 48) return 4;
  if (totalGb >= 24) return 2;
  return 1;
}
const MAX_WORKER_CONCURRENCY = Math.max(1, resolveWorkerConcurrency());

// 全局信号量：同一时刻最多 MAX_WORKER_CONCURRENCY 个裁切 worker 在跑。
// 仍要全局限量而不是按调用方各自并行 —— 两个资产同时入库时，各自的并发
// 申请必须合起来受同一个上限约束，否则峰值内存会随调用方数量翻倍。
let activeWorkers = 0;
const workerSlotQueue = [];
function pumpWorkerSlots() {
  while (activeWorkers < MAX_WORKER_CONCURRENCY && workerSlotQueue.length > 0) {
    const release = workerSlotQueue.shift();
    activeWorkers += 1;
    release();
  }
}
function acquireWorkerSlot() {
  return new Promise((resolve) => {
    workerSlotQueue.push(resolve);
    pumpWorkerSlots();
  });
}
function releaseWorkerSlot() {
  activeWorkers = Math.max(0, activeWorkers - 1);
  pumpWorkerSlots();
}

function runWorker(runtime, planPath, reportPath, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const onLog = typeof options.onLog === "function" ? options.onLog : () => {};
  return new Promise((resolve) => {
    let worker;
    let settled = false;
    let timedOut = false;
    let errorMessage = "";
    let timer;
    const finish = (ok, message = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, timedOut, message });
    };
    try {
      // worker 的内存峰值由"生成面片数"决定，实测（beech fern，源网格 5,853 面）：
      //   step 8 → 207 万面片 → 堆峰值 2.4GB / RSS 3.0GB
      //   step 6 → 489 万面片 → 堆峰值 6.2GB / RSS 7.2GB
      //   step 4 → 780 万面片 → 堆峰值 9.2GB / RSS 10.8GB
      // Node worker 默认堆上限只有 4GB，所以高密度档必须有更大堆，否则直接
      // "Allocation failed - JavaScript heap out of memory"（实测踩过）。
      // 这里给 6GB：够 step 6 档，同时不会让机器因为 10GB+ 的 RSS 开始换页。
      // 密度更高时由 resolveDenseTriangleBudget 限制生成量（见 worker）。
      worker = new Worker(runtime.workerPath, {
        workerData: { planPath, reportPath },
        resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
      });
      // 裁切 worker 不阻塞应用退出，避免退出时残留进程。
      worker.unref();
    } catch (error) {
      finish(false, error?.message || String(error));
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      void worker.terminate();
      finish(false, `不透明裁切处理超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }, timeoutMs);
    worker.on("message", (message) => {
      if (message?.type === "log") onLog(message.message);
      else if (message?.type === "progress") {
        if (typeof options.onProgress === "function") options.onProgress(message);
      }
      else if (message?.type === "error") errorMessage = message.message;
      else if (message?.type === "done") finish(true);
    });
    worker.on("error", (error) => finish(false, error?.message || String(error)));
    worker.on("exit", (code) => finish(false, errorMessage || `不透明裁切处理器退出码 ${code}`));
  });
}

async function readReportJson(reportPath) {
  try { return JSON.parse(await fsp.readFile(reportPath, "utf8")); }
  catch { return null; }
}

async function runPlanOnce(jobs, options, runtime, attempt) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "assethive-foliage-"));
  const planPath = path.join(tempDir, "plan.json");
  const reportPath = path.join(tempDir, "report.json");
  const startedAt = Date.now();
  try {
    const plan = {
      mask: String(options.mask || "").trim(),
      maskChannel: String(options.maskChannel || "auto"),
      threshold: Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : DEFAULT_THRESHOLD,
      contourPrecisionTexels: Number.isFinite(Number(options.contourPrecisionTexels)) ? Number(options.contourPrecisionTexels) : undefined,
      maskErodeTexels: Number.isFinite(Number(options.maskErodeTexels)) ? Number(options.maskErodeTexels) : undefined,
      // 孔洞填充：把白色区域内含的黑色孔洞填成白色，边界只留外轮廓（见 worker 的
      // fillMaskHoles）。默认关闭 —— 是否该填取决于资产（有些白区内部本来就该镂空），
      // 由调用方显式下发 true 才生效；缺省不写该字段时处理器按关闭走。
      fillHoles: typeof options.fillHoles === "boolean" ? options.fillHoles : undefined,
      // 只填面积不超过该值（平方纹素）的孔洞；0 = 不限。缺省 = 不限。
      holeMaxAreaTexels: Number.isFinite(Number(options.holeMaxAreaTexels)) ? Number(options.holeMaxAreaTexels) : undefined,
      contourMinAreaTexels: Number.isFinite(Number(options.contourMinAreaTexels)) ? Number(options.contourMinAreaTexels) : undefined,
      faceBudget: Number.isFinite(Number(options.faceBudget)) ? Number(options.faceBudget) : DEFAULT_FACE_BUDGET,
      // 自动档的浮动区间（plantOpaqueBudget 的档位表）：上限 > 0 时处理器在生成后
      // 按复杂度把目标定在 下限..上限 之间；否则按上面的固定 faceBudget 走
      // （操作者显式填值的路径，固定不浮动）。
      faceBudgetFloor: Number.isFinite(Number(options.faceBudgetFloor)) ? Number(options.faceBudgetFloor) : undefined,
      faceBudgetCeiling: Number.isFinite(Number(options.faceBudgetCeiling)) ? Number(options.faceBudgetCeiling) : undefined,
      cleanupPercent: Number.isFinite(Number(options.cleanupPercent)) ? Number(options.cleanupPercent) : undefined,
      // 遮罩尺寸上限交给处理器自行取默认值（4K 原图解析）。
      // 曾经这里回退到 undefined、处理器再回退到 2048，导致 4K 遮罩被降采样后
      // 二值化产生假边缘，叶缘破面；现在两处默认一致，不再隐性降采样。
      maskMaxSize: Number.isFinite(Number(options.maskMaxSize)) ? Number(options.maskMaxSize) : undefined,
      // 细分目标（纹素）：让边界切得准。导出不再自动减面（生成多少面导出多少面），
      // 因此 simplifyTarget 现在只作为显式减面请求保留 —— 缺省 0 = 不减面。
      subdivideTexels: Number.isFinite(Number(options.subdivideTexels)) ? Number(options.subdivideTexels) : undefined,
      simplifyTarget: Number.isFinite(Number(options.simplifyTarget)) ? Number(options.simplifyTarget) : undefined,
      // Trace 路线：面片间距（纹素）。> 0 时按遮罩直接生成面片，边界精度与源网格密度无关。
      traceStepTexels: Number.isFinite(Number(options.traceStepTexels)) ? Number(options.traceStepTexels) : undefined,
      // Trace 路线的面数上限（外部可调）：控制这一步的内存峰值，见 DEFAULT_TRACE_MAX_FACES。
      traceMaxFaces: Number.isFinite(Number(options.traceMaxFaces)) && Number(options.traceMaxFaces) > 0
        ? Number(options.traceMaxFaces) : DEFAULT_TRACE_MAX_FACES,
      // 生成阶段面片数上限。与 simplifyTarget（减面目标）不同：这是**生成**的上限，
      // 用来兜住内存峰值 —— 超过它就会在减面之前 OOM。
      denseFaceLimit: Number.isFinite(Number(options.denseFaceLimit)) ? Number(options.denseFaceLimit) : DEFAULT_DENSE_FACE_LIMIT,
      jobs
    };
    await fsp.writeFile(planPath, JSON.stringify(plan), "utf8");
    // 并发由全局信号量约束（见 MAX_WORKER_CONCURRENCY）：同一批任务切成分片
    // 并行跑，跨调用方仍共用同一个上限。
    await acquireWorkerSlot();
    let outcome;
    try {
      outcome = await runWorker(runtime, planPath, reportPath, options);
    } finally {
      releaseWorkerSlot();
    }
    const report = await readReportJson(reportPath);
    const results = jobs.map((job, index) => {
      const entry = report?.jobs?.[index] || {};
      const produced = entry.ok === true && fs.existsSync(job.output);
      return { ...job, ok: produced,
        message: produced ? "" : (entry.error || report?.error || outcome.message || "未生成不透明变体文件"),
        warnings: Array.isArray(entry.warnings) ? entry.warnings : [],
        objects: Array.isArray(entry.objects) ? entry.objects : [], bounds: entry.bounds || null };
    });
    return { ok: results.some((item) => item.ok),
      message: results.every((item) => !item.ok) ? (report?.error || outcome.message || results[0]?.message || "不透明裁切处理失败") : "",
      timedOut: outcome.timedOut, durationMs: Date.now() - startedAt, results, report,
      warnings: Array.isArray(report?.warnings) ? report.warnings : [], attempt };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// 合并并行分片的报告：jobs 按完成顺序拼接。mask / 阈值等字段所有分片共享，
// 保留后写的值即可；report.ok 只反映单片，判定成功与否一律以 results 为准。
function mergeReportJobs(accumulated, incoming) {
  if (!accumulated) return incoming;
  const jobs = [
    ...(Array.isArray(accumulated.jobs) ? accumulated.jobs : []),
    ...(Array.isArray(incoming.jobs) ? incoming.jobs : [])
  ];
  return { ...accumulated, ...incoming, jobs };
}

async function generateFoliageOpaqueTasks(jobs, options = {}) {
  const list = (Array.isArray(jobs) ? jobs : []).map((job) => ({
    input: String(job?.input || "").trim(), output: String(job?.output || "").trim()
  })).filter((job) => job.input && job.output);
  if (!list.length) return { ok: false, message: "没有需要处理的不透明变体任务", results: [], warnings: [] };
  const runtime = options.runtime || resolveFoliageRuntime();
  if (!runtime.available) return { ok: false, message: runtime.message || "不透明裁切处理器不可用", results: [], warnings: [] };
  if (!String(options.mask || "").trim()) return { ok: false, message: "缺少可用于裁切的透贴贴图", results: [], warnings: [] };
  const attempts = Number.isFinite(Number(options.attempts)) ? Math.max(1, Math.floor(Number(options.attempts))) : 2;
  const settled = new Array(list.length);
  let pending = list.map((job, index) => ({ job, index }));
  let warnings = [], report = null, durationMs = 0, lastMessage = "", timedOut = false;
  // 逐任务进度跨分片与重试累计：按输出路径去重（重试会再次上报同一输出），
  // 对外只报总体 done/total，调用方不必感知分片。
  const progressSeen = new Set();
  const progressTotal = list.length;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const notifyJobProgress = (message) => {
    const output = String(message?.output || "");
    if (!output || progressSeen.has(output)) return;
    progressSeen.add(output);
    if (onProgress) {
      onProgress({ done: progressSeen.size, total: progressTotal, output, ok: message?.ok === true });
    }
  };
  for (let attempt = 0; attempt < attempts && pending.length; attempt += 1) {
    // 分片并行：片数受全局并发上限与剩余任务数约束。
    const chunkCount = Math.max(1, Math.min(MAX_WORKER_CONCURRENCY, pending.length));
    // 按源文件大小做 LPT（最长处理时间优先）装箱后再分片，而不是按原始顺序切
    // 连续段：实测 12 变体里 _10/_11/_12 是秒级小任务，连续分片把它们聚在同一片，
    // 该 worker 几秒就闲置，墙钟被最重的一片拖死（连续分片 3.6 分钟 vs LPT 约一半）。
    // 源文件大小与裁切耗时强相关（面数随源网格规模走），拿它当成本估计，
    // 避免为分片本身引入一次预分析。
    const costByIndex = new Map();
    await Promise.all(pending.map(async (item) => {
      const stat = await fsp.stat(item.job.input).catch(() => null);
      costByIndex.set(item.index, Number(stat?.size) || 0);
    }));
    const ordered = [...pending].sort((a, b) =>
      (costByIndex.get(b.index) || 0) - (costByIndex.get(a.index) || 0));
    const bins = Array.from({ length: chunkCount }, () => []);
    const binLoad = new Array(chunkCount).fill(0);
    for (const item of ordered) {
      let lightest = 0;
      for (let bin = 1; bin < chunkCount; bin += 1) {
        if (binLoad[bin] < binLoad[lightest]) lightest = bin;
      }
      bins[lightest].push(item);
      binLoad[lightest] += costByIndex.get(item.index) || 0;
    }
    const chunks = bins.filter((bin) => bin.length > 0);
    const attemptStartedAt = Date.now();
    const outcomes = await Promise.all(chunks.map((chunk) => runPlanOnce(
      chunk.map((item) => item.job),
      onProgress ? { ...options, onProgress: notifyJobProgress } : options,
      runtime,
      attempt
    )));
    // 并行后耗时按墙钟计；沿用旧的逐片累加会把并行省下的时间又记回总耗时。
    durationMs += Date.now() - attemptStartedAt;
    for (const outcome of outcomes) {
      warnings = warnings.concat(outcome.warnings || []);
      if (outcome.report) report = mergeReportJobs(report, outcome.report);
      if (outcome.message) lastMessage = outcome.message;
      timedOut = timedOut || Boolean(outcome.timedOut);
    }
    // 分片结果按各片内部顺序映射回原始任务下标。
    chunks.forEach((chunk, chunkIndex) => {
      const outcome = outcomes[chunkIndex];
      chunk.forEach((item, position) => {
        settled[item.index] = outcome.results[position] || { ...item.job, ok: false,
          message: outcome.message || "处理器未返回结果", warnings: [] };
      });
    });
    pending = pending.filter((item) => !settled[item.index]?.ok);
    if (timedOut) break;
  }
  const results = settled.filter(Boolean);
  const succeeded = results.filter((item) => item.ok).length;
  return { ok: succeeded > 0, succeeded, failed: results.length - succeeded,
    message: succeeded ? "" : lastMessage || results[0]?.message || "不透明裁切处理失败",
    timedOut, durationMs, results, report, warnings, log: [] };
}

async function generateFoliageOpaqueVariant(options = {}) {
  const batch = await generateFoliageOpaqueTasks([{ input: options.input, output: options.output }], options);
  const first = batch.results?.[0];
  if (!first?.ok) return { ok: false, message: first?.message || batch.message || "不透明裁切处理失败",
    timedOut: batch.timedOut, durationMs: batch.durationMs, report: batch.report || null, log: [] };
  const stat = await fsp.stat(first.output).catch(() => null);
  return { ok: true, outputPath: first.output, outputSize: stat?.size || 0,
    durationMs: batch.durationMs, warnings: first.warnings || [], report: batch.report || null, log: [] };
}

function foliageOpaqueStatus() {
  const runtime = resolveFoliageRuntime();
  return { available: runtime.available, workerPath: runtime.workerPath, message: runtime.message };
}

module.exports = {
  DEFAULT_CLEANUP_PERCENT, DEFAULT_FACE_BUDGET, DEFAULT_TRACE_MAX_FACES,
  DEFAULT_THRESHOLD, DEFAULT_TIMEOUT_MS, MASK_SOURCE_PRIORITY,
  MAX_WORKER_CONCURRENCY, resolveWorkerConcurrency,
  foliageOpaqueStatus, generateFoliageOpaqueTasks, generateFoliageOpaqueVariant,
  resolveFoliageMaskSource, describeFoliageMaskSource
};
