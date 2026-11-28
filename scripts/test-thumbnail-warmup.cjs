const assert = require("node:assert/strict");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { createThumbnailWarmup } = require("../electron/services/thumbnailWarmup");

async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(5); }
  assert.fail("Background thumbnail queue did not settle");
}

test("background queue yields to foreground/scans and checks each image once per interval", async t => {
  let allowed = false;
  const calls = [];
  const queue = createThumbnailWarmup({ initialDelayMs: 0, delayMs: 1, canRun: () => allowed,
    ensure: async file => { calls.push(file); return { status: "cached" }; } });
  t.after(() => queue.dispose());
  queue.enqueue(["a", "b", "a"]);
  await delay(20);
  assert.deepEqual(calls, []);
  allowed = true;
  queue.enqueue(["a", "b"], { priority: true });
  await until(() => queue.status().checked === 2);
  queue.enqueue(["a", "b"]);
  await delay(20);
  assert.deepEqual(calls, ["b", "a"]);
  assert.equal(queue.status().queued, 0);
});

test("new/edited assets precede the remaining full-library backlog", async t => {
  const calls = [];
  let finish;
  const queue = createThumbnailWarmup({ initialDelayMs: 0, delayMs: 1,
    ensure: file => { calls.push(file); return file === "a" ? new Promise(resolve => { finish = resolve; }) : { status: "published" }; } });
  t.after(() => queue.dispose());
  queue.enqueue(["a", "b", "c"]);
  await until(() => finish);
  queue.enqueue(["c"], { priority: true });
  finish({ status: "cached" });
  await until(() => queue.status().checked === 3);
  assert.deepEqual(calls, ["a", "c", "b"]);
});

test("backgrounding drains in-flight thumbnails and keeps only import/edit priority eligible", async t => {
  const calls = [];
  let finishFirst;
  const queue = createThumbnailWarmup({ initialDelayMs: 0, delayMs: 1,
    ensure: file => {
      calls.push(file);
      return file === "active" ? new Promise(resolve => { finishFirst = resolve; }) : { status: "cached" };
    }
  });
  t.after(() => queue.dispose());
  queue.enqueue(["active", "backlog"]);
  await until(() => finishFirst);
  queue.enqueue(["scan", "edited"], { priority: true, foregroundOnly: true });
  queue.setNormalPaused(true);
  queue.enqueue(["edited"], { priority: true });
  finishFirst({ status: "cached" });
  await until(() => queue.status().checked === 2);
  await delay(20);
  assert.deepEqual(calls, ["active", "edited"]);
  assert.equal(queue.status().queued, 2);
  queue.setNormalPaused(false);
  await until(() => queue.status().checked === 4);
  assert.deepEqual(calls, ["active", "edited", "scan", "backlog"]);
});

test("a fresh edit overtakes older scan updates without duplicating an existing urgent entry", async t => {
  let allowed = false;
  const calls = [];
  const queue = createThumbnailWarmup({ initialDelayMs: 0, delayMs: 1, canRun: () => allowed,
    ensure: async file => { calls.push(file); return { status: "cached" }; } });
  t.after(() => queue.dispose());
  queue.enqueue(["edited", "old-scan-update"], { priority: true });
  allowed = true;
  queue.enqueue(["edited"], { priority: true });
  await until(() => queue.status().checked === 2);
  assert.deepEqual(calls, ["edited", "old-scan-update"]);
});

test("same-path edits during an active publication schedule another fingerprint check", async t => {
  let calls = 0;
  let finish;
  const queue = createThumbnailWarmup({ initialDelayMs: 0, delayMs: 1,
    ensure: () => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : { status: "published" } });
  t.after(() => queue.dispose());
  queue.enqueue(["preview.png"]);
  await until(() => finish);
  queue.enqueue(["preview.png"], { priority: true });
  finish({ status: "published" });
  await until(() => queue.status().checked === 2);
  assert.equal(calls, 2);
  assert.equal(queue.status().queued, 0);
});

test("reconciliation removes deleted work and late results cannot lose replacement work", async t => {
  const calls = [];
  let finish;
  const queue = createThumbnailWarmup({ initialDelayMs: 0, delayMs: 1,
    ensure: file => { calls.push(file); return calls.length === 1 ? new Promise(resolve => { finish = resolve; }) : { status: "cached" }; } });
  t.after(() => queue.dispose());
  queue.enqueue(["a", "deleted"]);
  await until(() => finish);
  queue.enqueue([], { replace: true });
  queue.enqueue(["a"], { priority: true });
  finish({ status: "published" });
  await until(() => queue.status().checked === 2);
  assert.deepEqual(calls, ["a", "a"]);
});

test("publication failures retry without a tight loop and can recover", async t => {
  let calls = 0;
  const queue = createThumbnailWarmup({ initialDelayMs: 0, delayMs: 1, retryMs: 50,
    ensure: async () => ++calls === 1 ? { status: "failed" } : { status: "published" } });
  t.after(() => queue.dispose());
  queue.enqueue(["a"]);
  await until(() => calls === 1);
  await delay(20);
  assert.equal(calls, 1);
  await until(() => queue.status().published === 1);
  assert.equal(calls, 2);
  assert.equal(queue.status().failed, 1);
});

test("disposing a library discards queued jobs and ignores an active job's late result", async () => {
  let finish;
  const calls = [];
  const queue = createThumbnailWarmup({ initialDelayMs: 0, delayMs: 1,
    ensure: file => { calls.push(file); return new Promise(resolve => { finish = resolve; }); } });
  queue.enqueue(["a", "b"]);
  await until(() => finish);
  queue.dispose();
  finish({ status: "published" });
  await delay(20);
  queue.enqueue(["c"], { priority: true });
  await delay(20);
  assert.deepEqual(calls, ["a"]);
  assert.equal(queue.status().queued, 0);
});
