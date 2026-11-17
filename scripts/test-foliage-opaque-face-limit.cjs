"use strict";

// 生成面片数上限的回归测试。
//
// 背景：生成面片数直接决定裁切 worker 的内存峰值（实测约 1.1KB/面片，含对象开销）：
//   step 6 → 489 万面片 → heap 3.1GB / RSS 5.7GB
//   step 4 → 780 万面片 → heap 9.2GB / RSS 10.8GB
// Node worker 默认堆上限 4GB，所以不设上限时高密度档会直接
// "Allocation failed - JavaScript heap out of memory"（实测踩过）。
// 这里锁住"上限确实生效、且撞上限时有明确标记"。

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { traceMeshFromMask } = require("../electron/services/foliageOpaqueTrace");

// 造一个"遮罩全实心、源网格足够大"的场景，让它天然想生成很多面片
function makeCase() {
  const size = 256;
  const values = new Float32Array(size * size).fill(1);
  const mask = { width: size, height: size, values, texelSize: 1 / size };

  // 源网格：一块矩形铺满 UV，用细三角形保证细分后数量够多
  const corners = [];
  const N = 12;
  for (let i = 0; i <= N; i += 1) {
    for (let j = 0; j <= N; j += 1) {
      corners.push({ u: i / N, v: j / N });
    }
  }
  const triangles = [];
  const at = (i, j) => corners[j * (N + 1) + i];
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      for (const [p, q, r] of [[a, b, c], [a, c, d]]) {
        triangles.push({
          corners: [p, q, r].map((s) => ({
            position: [s.u * 10, 0, s.v * 10],
            normal: [0, 1, 0],
            color: [1, 1, 1],
            uv: [s.u, s.v],
            uv1: [s.u, s.v],
          })),
        });
      }
    }
  }
  const source = { triangles, attributeNames: ["position", "normal", "color", "uv", "uv1"] };
  return { source, mask };
}

test("generated face count respects the limit and flags the cap", () => {
  const { source, mask } = makeCase();
  // 该合成场景 step=8 自然生成 4,608 面，把上限压到 4,000 就能撞上
  const limit = 4000;
  const result = traceMeshFromMask(source, mask, { threshold: 0.5, stepTexels: 8, maxFaces: limit });
  assert.ok(result.faces.length > 0, "应生成面片");
  assert.ok(result.faces.length <= limit, `面片数 ${result.faces.length} 不应超过上限 ${limit}`);
  assert.equal(result.stats.faceLimit, limit);
  assert.equal(result.stats.cappedByFaceLimit, true, "撞上限时必须打标记，否则会静默降级");
});

test("a loose limit is not reported as capped", () => {
  const { source, mask } = makeCase();
  const result = traceMeshFromMask(source, mask, { threshold: 0.5, stepTexels: 64, maxFaces: 100000000 });
  assert.ok(result.faces.length > 0);
  assert.equal(result.stats.cappedByFaceLimit, false, "没撞上限时不应打标记");
});

test("no limit means the cap flag stays false", () => {
  const { source, mask } = makeCase();
  const result = traceMeshFromMask(source, mask, { threshold: 0.5, stepTexels: 64 });
  assert.ok(result.faces.length > 0);
  assert.equal(result.stats.faceLimit, 0);
  assert.equal(result.stats.cappedByFaceLimit, false);
});

test("hit and miss produce the same geometry when the limit is not reached", () => {
  const { source, mask } = makeCase();
  const tight = traceMeshFromMask(source, mask, { threshold: 0.5, stepTexels: 32, maxFaces: 100000000 });
  const none = traceMeshFromMask(source, mask, { threshold: 0.5, stepTexels: 32 });
  assert.equal(tight.faces.length, none.faces.length, "上限宽松时结果应与不设上限一致");
});

// 契约：trace 面数上限必须"外部可调 + 默认 100 万面 + 真正成为 trace 路线的闸门"。
// 历史缺陷：worker 里该闸门写作 `denseFaceLimit > 0 ? denseFaceLimit : traceMaxFaces`，
// 于是 500 万的 denseFaceLimit 永远压过它，外部调 traceMaxFaces 完全无效；而 500 万面
// 约需 9GB 堆，超过 Electron 的 JS 堆硬顶（约 3.78GB）→ worker OOM 直接终止整个应用。
test("trace face cap is externally settable, defaults to 1,000,000, and gates the trace route", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const svc = require("../electron/services/foliageOpaque");
  assert.equal(svc.DEFAULT_TRACE_MAX_FACES, 1000000, "默认上限应为 100 万面");

  const workerSrc = fs.readFileSync(path.join(__dirname, "..", "electron", "services", "foliageOpaqueWorker.js"), "utf8");
  // 闸门：先解析出 faceCap（优先 traceMaxFaces，denseFaceLimit 只作兼容回退），再传给 trace。
  assert.match(
    workerSrc,
    /const faceCap = settings\.traceMaxFaces > 0[\s\S]{0,160}?settings\.denseFaceLimit/,
    "trace 路线的 faceCap 必须优先取 settings.traceMaxFaces（denseFaceLimit 只能做兼容回退）"
  );
  assert.match(workerSrc, /maxFaces: faceCap,/,
    "traceMeshFromMask 必须收到解析后的 faceCap");

  // 契约：超上限时**自动调粗采样步长**，而不是撞上限截断。
  // 截断会让遮罩有一块没被覆盖（成品凭空缺一片叶），调粗只让边界变粗、覆盖完整。
  // 实测 axz0tqu 在 6 纹素下需 489 万面，而 Electron 的堆天花板只允许约 100 万面。
  assert.match(workerSrc, /function estimateTraceFaces\(/, "必须有面数估算函数");
  assert.match(
    workerSrc,
    /const raised = Math\.ceil\(stepTexels \* Math\.sqrt\(estimated \/ safe\)\)/,
    "超上限时必须按 1/步长² 换算把步长抬上去"
  );
  assert.match(workerSrc, /stepTexels = raised;/, "抬升后的步长必须真正用于 trace");

  const svcSrc = fs.readFileSync(path.join(__dirname, "..", "electron", "services", "foliageOpaque.js"), "utf8");
  assert.match(
    svcSrc,
    /traceMaxFaces:[\s\S]{0,220}?DEFAULT_TRACE_MAX_FACES/,
    "plan 必须透传 traceMaxFaces，缺省时回落到默认值"
  );
});

// 契约（2026-10-15 产品口径，三条一起）：
//   1) 面数设置默认 0；0 = 按植被档位自动，填数值 = 覆盖预设；
//   2) 导出不再自动减面 —— 生成多少面导出多少面，收敛交给 UE 侧 Nanite；
//   3) 孔洞填充默认关闭（是否该填取决于资产，必须显式开启）。
// 这三条是界面语义，容易被后续改动悄悄改回去，所以在这里锁住源码契约。
test("face preset / no auto simplify / hole fill off by default", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..");
  const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

  const workerSrc = read("electron", "services", "foliageOpaqueWorker.js");
  // 1+2：浮动预算不得再写回 simplifyTarget（旧实现 simplifyTarget = floatedBudget，
  // 会把自然面数压回预设）；simplifyTarget 只能来自调用方显式下发。
  assert.doesNotMatch(workerSrc, /simplifyTarget = floatedBudget/,
    "浮动面数预算只能作闸门/提示，不能再驱动 QEM");
  assert.match(workerSrc, /const simplifyTarget = settings\.simplifyTarget;/);
  // 不减面导出时自然面数必然高于预设，不能因此刷告警：只在真正要求减面却没减到时才报。
  assert.match(workerSrc, /if \(simplifyTarget && faceBudget && finalFaces\.length > faceBudget\)/);
  // 3：孔洞填充必须显式 true 才生效。
  assert.match(workerSrc, /fillHoles: plan\.fillHoles === true/,
    "孔洞填充默认必须是关闭，plan 未下发时不得填孔");

  const mainSrc = read("electron", "main.js");
  assert.match(mainSrc, /const opaqueSimplifyTarget = 0;/,
    "导入路径不得再下发减面目标");
  assert.match(mainSrc, /opaqueBudgetRange \? opaqueBudgetRange\.ceiling/,
    "自动档面数预设取档位上限（与插件裁切档一致）");
  assert.match(mainSrc, /simplifyTarget: 0[\s\S]{0,12}\}/,
    "重切路径同样不下发减面目标");

  const appSrc = read("src", "ui", "App.tsx");
  assert.match(appSrc, /simplifyTarget: 0/, "界面构建的裁切参数不下发减面目标");
  assert.match(appSrc, /faceBudgetAuto: faceBudget <= 0/, "0 值必须被识别为自动档");
  assert.match(appSrc, /if \(!raw\) return 0;/, "面数留空按自动（0）处理");

  const typesSrc = read("src", "ui", "hooks", "types.ts");
  assert.match(typesSrc, /foliageOpaqueFaceBudget: "0"/, "面数设置默认 0");
  assert.match(typesSrc, /foliageOpaqueFillHolesEnabled: false/, "孔洞填充默认关闭");
});
