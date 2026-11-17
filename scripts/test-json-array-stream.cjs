const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { Buffer } = require("node:buffer");
const { Readable } = require("node:stream");
const { gzipSync, gunzipSync } = require("node:zlib");
const { test } = require("node:test");
const { parseJsonArray, readGzipJsonArray, gzipJsonArray } = require("../electron/services/jsonArrayStream");

function chunks(text, size = 7) {
  const bytes = Buffer.from(text);
  return Readable.from((function* () { for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size); })());
}

test("streamed JSON preserves Unicode, escapes, nested/primitive members and metadata across byte boundaries", async () => {
  const assets = [{ id: "中文🌿", path: 'C:\\a\\"quoted"\\', nested: [1, { special: '},{[]:\\"' }] }, [], "a,b]}", null, true, 1.2e-5];
  for (const value of [{ version: 2, root: "共享库", assets, extra: { keep: true } }, { assets }, { root: "before", assets: [], after: "assets:[fake]" }]) {
    for (const size of [1, 2, 7, 64, 65536]) assert.deepEqual(await parseJsonArray(chunks(JSON.stringify(value), size)), value);
  }
  assert.deepEqual(await parseJsonArray(chunks('{"a\\u0073sets":[1]}')), { assets: [1] });
});

test("truncated/corrupt envelopes and members never publish a partial cache", async () => {
  for (const input of ['{"assets":[{},]}', '{"assets":[,{}]}', '{"assets":[true false]}', '{"assets":["\\x"]}',
    '{"assets":[{"id":1}', '{"assets":[1]} trailing', '{"assets":[1],}', '{"assets":[1]', '{"assets":null}',
    '{}', '[]', '{"assets":[1],"assets":[]}', '{"assets":[1],"assets":null}']) {
    await assert.rejects(parseJsonArray(chunks(input)), undefined, input);
  }
});

test("stream parsing has independent total, member and envelope bounds", async () => {
  await assert.rejects(parseJsonArray(chunks('{"assets":["long value"]}'), { maxBytes: 12 }), /document exceeds/);
  await assert.rejects(parseJsonArray(chunks('{"assets":["long value"]}'), { maxItemBytes: 4 }), /member exceeds/);
  await assert.rejects(parseJsonArray(chunks('{"root":"long value","assets":[]}'), { maxEnvelopeBytes: 12 }), /envelope exceeds/);
});

test("streamed gzip writes retain the exact version-2 JSON schema and read errors remain bounded", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-json-stream-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = path.join(root, "memo.gz");
  const metadata = { version: 2, generatedAt: "now", root: "库" }, assets = [{ id: "a", text: "[\\\"]" }];
  const bytes = await gzipJsonArray(metadata, assets);
  assert.deepEqual(JSON.parse(gunzipSync(bytes)), { ...metadata, assets });
  await fs.writeFile(file, bytes);
  assert.deepEqual(await readGzipJsonArray(file), { ...metadata, assets });
  assert.deepEqual(JSON.parse(gunzipSync(await gzipJsonArray({}, []))), { assets: [] });
  await assert.rejects(gzipJsonArray(metadata, assets, { maxBytes: 1 }), /Compressed JSON exceeds/);
  await fs.writeFile(file, gzipSync('{"assets":[1]}').subarray(0, -4));
  await assert.rejects(readGzipJsonArray(file));
  await assert.rejects(readGzipJsonArray(path.join(root, "missing.gz")));
});
