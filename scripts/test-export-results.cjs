const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { loadApplicationServices } = require("./application-service-harness.cjs");

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
