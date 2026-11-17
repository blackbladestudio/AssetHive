const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createImportQueueStore } = require("../electron/services/importQueue");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-queue-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  return { root, store: createImportQueueStore(root), library: path.join(root, "Library") };
}
const draft = (id, source = "") => ({ form: { queueId: id, assetName: id, previewImagePath: source }, tagInput: `unfinished-${id}` });

test('character deletion clears receipts and matching drafts live, rejects stale autosave and allows a fresh import', async t => {
  const { store, library, root } = await fixture(t);
  const source = path.join(root, 'artist.fbx');
  const related = { form: { queueId: 'related', modelSlots: { Head: source } } };
  const snapshot = { drafts: [related, draft('other')], activeIndex: 1, selectedIndexes: [1] };
  await store.save(library, snapshot);
  await store.run(library, 'completed', async () => ({ ok: true, assetId: 'deleted' }));
  await store.run(library, 'other-completed', async () => ({ ok: true, assetId: 'keep' }));
  await store.save('other-library', { drafts: [related] });
  const removed = await store.discardCharacter(library, { assetId: 'deleted', assetPath: path.join(library, 'deleted'), modelSources: [source], queueId: 'completed' });
  assert.deepEqual(new Set(removed), new Set(['completed', 'related']));
  await store.save(library, snapshot); // already queued by an older renderer render
  assert.deepEqual((await store.load(library)).drafts.map(d => d.form.queueId), ['other']);
  assert.equal((await store.load('other-library')).drafts.length, 1);
  await assert.rejects(store.run(library, 'completed', async () => ({ ok: true })), /已删除/);
  assert.equal((await store.run(library, 'other-completed', async () => { throw new Error('must retain receipt'); })).assetId, 'keep');
  let imported = false;
  const fresh = { form: { ...related.form, queueId: 'new-selection' } };
  await store.save(library, { drafts: [fresh] });
  assert.equal((await store.load(library)).drafts.length, 1);
  await store.run(library, 'new-selection', async () => { imported = true; return { ok: true, assetId: 'new-id' }; });
  assert.equal(imported, true);
  const restarted = createImportQueueStore(root);
  let oldReceipt = false;
  await restarted.run(library, 'completed', async () => { oldReceipt = true; return { ok: false }; });
  assert.equal(oldReceipt, true, 'deleted receipt is absent on disk too');
});

test("restart restores unfinished edits, selection and active draft but excludes completed imports", async t => {
  const { root, store, library } = await fixture(t);
  await store.save(library, { drafts: [draft("first"), draft("second"), draft("third")], activeIndex: 1, selectedIndexes: [0, 2] });
  await store.run(library, "first", async () => ({ ok: true, assetId: "saved" }));
  const restored = await createImportQueueStore(root).load(library);
  assert.deepEqual(restored.drafts.map(item => item.form.queueId), ["second", "third"]);
  assert.equal(restored.drafts[0].tagInput, "unfinished-second");
  assert.equal(restored.activeIndex, 0);
  assert.deepEqual(restored.selectedIndexes, [1]);
  assert.equal((await store.load("another-library")).drafts.length, 0);
});

test("retries and renderer reloads share an in-flight import and do not repeat a completed one", async t => {
  const { store, library } = await fixture(t);
  let finish;
  let calls = 0;
  const callback = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = store.run(library, "same-draft", callback);
  const second = store.run(library, "same-draft", callback);
  while (!finish) await new Promise(resolve => globalThis.setImmediate(resolve));
  finish({ ok: true, assetId: "one-asset" });
  assert.equal((await first).assetId, (await second).assetId);
  await store.run(library, "same-draft", callback);
  assert.equal(calls, 1);
});

test("failed drafts stay recoverable and can be retried", async t => {
  const { root, store, library } = await fixture(t);
  await store.save(library, { drafts: [draft("failed")], activeIndex: 0, selectedIndexes: [0] });
  await store.run(library, "failed", async () => ({ ok: false, message: "disk full" }));
  const resumed = createImportQueueStore(root);
  assert.equal((await resumed.load(library)).drafts.length, 1);
  assert.equal((await resumed.run(library, "failed", async () => ({ ok: true }))).ok, true);
});

test("metadata proof closes the crash gap between asset publication and queue completion", async t => {
  const { root, store, library } = await fixture(t);
  const proofPath = path.join(root, "asset_info.json");
  await store.save(library, { drafts: [draft("published")], activeIndex: 0, selectedIndexes: [] });
  await store.reserve(library, "published", { assetId: "saved-id", assetPath: root, proofPath });
  await fs.writeFile(proofPath, JSON.stringify({ importQueueId: "published" }));
  const restarted = createImportQueueStore(root);
  let calls = 0;
  const result = await restarted.run(library, "published", async () => { calls++; });
  assert.equal(calls, 0);
  assert.equal(result.assetId, "saved-id");
  assert.equal((await restarted.load(library)).drafts.length, 0);
});

test("queued source folders are protected and latest writes win in call order", async t => {
  const { root, store, library } = await fixture(t);
  const source = path.join(root, "DroppedArchives", "pack", "preview.png");
  await Promise.all([
    store.save(library, { drafts: [draft("old")], activeIndex: 0, selectedIndexes: [] }),
    store.save(library, { drafts: [draft("new", source)], activeIndex: 0, selectedIndexes: [] })
  ]);
  assert.equal((await store.load(library)).drafts[0].form.queueId, "new");
  assert.equal(store.protects(path.dirname(source)), true);
  assert.equal(store.protects(`${path.dirname(source)}-unrelated`), false);
});
