const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");
const { loadApplicationServices } = require("./application-service-harness.cjs");

const sidebar = fs.readFile(path.join(__dirname, "../src/ui/sidebarStatus.ts"), "utf8").then(source => {
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const exports = {};
  new Function("exports", compiled.outputText)(exports);
  return exports;
});
const zh = text => text;

test("engine import success shows only its outcome while partial failures retain asset reasons", async () => {
  const { getEngineImportFeedback } = await sidebar;
  assert.deepEqual(getEngineImportFeedback({ ok: true, jobFile: "job.json", logFile: "engine.log",
    pluginState: { copied: false, reason: "Project already has AssetHive plugin" } }, false, zh), { text: "导入完成", durationMs: 4000 });
  assert.equal(getEngineImportFeedback({ ok: true, message: "已发送到 Unreal" }, false, zh).text, "已发送到 Unreal，导入进度请在引擎内查看");
  assert.equal(getEngineImportFeedback({ ok: true }, true, zh).text, "Blender 导入完成");
  const partial = getEngineImportFeedback({ ok: true, partial: true, results: [{ name: "Sky", status: "success", message: "OK" },
    { name: "Rock", status: "failed", message: "缺少公共材质" }] }, false, zh);
  assert.equal(partial.text, "部分资产未导出");
  assert.equal(partial.detail, "Rock：缺少公共材质");
  assert.equal(getEngineImportFeedback({ ok: false, message: "AssetHive 插件被禁用" }, false, zh).text, "AssetHive 插件被禁用");
});

test("sidebar uses one task's progress and keeps detailed scan and character stages in the tooltip", async () => {
  const { getSidebarStatus, getScanFeedback } = await sidebar;
  const base = { exportFeedback: null, exporting: false, exportProgress: 0, importSaving: false, batchImport: null,
    characterImport: { message: "保存角色贴图 7/10", progress: 70 }, scanFeedback: null, scanning: true,
    scanProgress: 45, scanHint: "扫描详情".repeat(40), status: "", t: zh };
  const scan = getSidebarStatus(base);
  assert.equal(scan.text, "扫描中");
  assert.equal(scan.detail, base.scanHint);
  assert.equal(scan.progress.value, 45);
  const batch = { processed: 3, total: 10, active: true };
  const imported = getSidebarStatus({ ...base, importSaving: true, batchImport: batch, status: "导入角色 A" });
  assert.equal(imported.text, "导入中");
  assert.equal(imported.progress.count, "3/10");
  assert.match(imported.detail, /保存角色贴图/);
  const completed = getSidebarStatus({ ...base, batchImport: { ...batch, processed: 10, active: false }, status: "选中资产导入完成 · 10/10" });
  assert.equal(completed.text, "选中资产导入完成");
  assert.equal(completed.progress.count, "10/10");
  const exportFeedback = { text: "导入完成" };
  const exported = getSidebarStatus({ ...base, exportFeedback });
  assert.deepEqual(exported, { text: "导入完成" });
  assert.equal(getSidebarStatus({ ...base, exportFeedback, importSaving: true, batchImport: batch }).text, "导入中");
  assert.equal(getSidebarStatus({ ...base, exporting: true, exportFeedback: { text: "Unreal 导入中" },
    exportProgress: 92, importSaving: true, batchImport: batch }).progress.value, 92);
  assert.equal(getScanFeedback({ progress: 100, phase: "done" }, 0, zh), null);
  assert.equal(getScanFeedback({ progress: 100, phase: "done", manual: true }, 3000, zh), null);
  assert.equal(getScanFeedback({ progress: 100, phase: "done", manual: true, total: 12 }, 0, zh).text, "扫描完成，共 12 个资产");
  assert.equal(getScanFeedback({ progress: 100, phase: "partial", message: "读库失败" }, 2000, zh).durationMs, 8000);
});

async function fixture(t, tcpClient) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-export-results-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "sky.hdr");
  await fs.writeFile(source, "fixture");
  return { services: await loadApplicationServices(root, { tcpClient }), valid: { id: "valid", name: "Sky", assetType: "hdri", textureFiles: [source] } };
}

test("mixed valid and missing assets produce explicit per-item results and only count successful exports", async t => {
  let sent;
  const { services, valid } = await fixture(t, { importAssets: async job => { sent = job; return { requestId: "done" }; } });
  const result = await services.exportToUnreal([valid, { ...valid, id: "missing", textureFiles: [] }], {});
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.equal(sent.assets.length, 1);
  assert.deepEqual(Array.from(result.results, item => item.status), ["success", "skipped"]);
  assert.match(result.results[1].message, /HDRI.*缺少/);
  assert.deepEqual(Array.from(result.exportedAssetIds), ["valid"]);
  assert.match(result.message, /部分/);
});

test("one preparation failure does not prevent other assets from exporting", async t => {
  const { services, valid } = await fixture(t);
  const result = await services.exportToUnreal([{ id: "deleted", name: "Deleted", exportUnavailable: true }, valid], {});
  assert.equal(result.ok, true);
  assert.equal(result.results[0].status, "failed");
  assert.equal(result.results[1].status, "success");
});

test("all skipped assets return failure without dispatching a UE task", async t => {
  let calls = 0;
  const { services, valid } = await fixture(t, { importAssets: async () => { calls++; } });
  const result = await services.exportToUnreal([{ ...valid, textureFiles: [] }], {});
  assert.equal(result.ok, false);
  assert.equal(result.results[0].status, "skipped");
  assert.equal(calls, 0);
});

test("lost UE acknowledgment is unconfirmed and never counted as a successful export", async t => {
  const { services, valid } = await fixture(t, { importAssets: async () => { throw new Error("connection lost"); } });
  const result = await services.exportToUnreal([valid], {});
  assert.equal(result.ok, false);
  assert.equal(result.results[0].status, "unconfirmed");
  assert.equal(result.exportedAssetIds.length, 0);
});

test("an editor failure preserves confirmed successes and the parent's error on each failed asset", async t => {
  const { services, valid } = await fixture(t, { importAssets: async () => {
    throw Object.assign(new Error("job failed"), { code: "ASSETHIVE_IMPORT_FAILED", requestId: "mixed",
      assetResults: [{ assetId: "bad", status: "failed", message: "Missing parent /Game/Test" },
        { assetId: "valid", status: "success" }] });
  } });
  const result = await services.exportToUnreal([valid, { ...valid, id: "bad" }], {});
  assert.equal(result.partial, true);
  assert.deepEqual(Array.from(result.exportedAssetIds), ["valid"]);
  assert.deepEqual(Array.from(result.results, item => item.status), ["success", "failed"]);
  assert.match(result.results[1].message, /Missing parent/);
});

test("a legacy editor error identifies a single failed asset but not individual assets in a batch", async t => {
  const { services, valid } = await fixture(t, { importAssets: async () => {
    throw Object.assign(new Error("import failed"), { code: "ASSETHIVE_IMPORT_FAILED" });
  } });
  const single = await services.exportToUnreal([valid], {});
  assert.equal(single.results[0].status, "failed");
  const batch = await services.exportToUnreal([valid, { ...valid, id: "second" }], {});
  assert.deepEqual(Array.from(batch.results, item => item.status), ["unconfirmed", "unconfirmed"]);
});

test("a task rejected before dispatch is retryable as failed rather than unconfirmed", async t => {
  const { services, valid } = await fixture(t, { importAssets: async () => { throw Object.assign(new Error("not connected"), { code: "ASSETHIVE_NOT_DISPATCHED" }); } });
  const result = await services.exportToUnreal([valid], {});
  assert.equal(result.results[0].status, "failed");
  assert.equal(result.exportedAssetIds.length, 0);
});
