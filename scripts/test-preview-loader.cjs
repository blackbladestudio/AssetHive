const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { setImmediate } = require("node:timers/promises");
const { pathToFileURL } = require("node:url");
const ts = require("typescript");
const { Buffer } = require("node:buffer");

function load(file) {
  const sourcePath = path.join(__dirname, "../src/ui", file);
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const localRequire = request => request.startsWith(".") ? require(path.resolve(path.dirname(sourcePath), request)) : require(request);
  new Function("require", "exports", compiled)(localRequire, exports);
  return exports;
}
const { PreviewLoader } = load("previewLoader.ts");
const { getPreviewUrl } = load("previewUrl.ts");

test('deleting a character invalidates pending thumbnails without restarting the loader', async () => {
  let finish;
  let calls = 0;
  const loader = new PreviewLoader(async file => {
    if (file === 'other') return 'other-preview';
    calls++;
    if (calls === 1) return new Promise(resolve => { finish = resolve; });
    return 'fresh-preview';
  });
  const unsubscribe = loader.subscribe('deleted', () => {});
  loader.subscribe('other', () => {});
  await setImmediate();
  loader.invalidate(['deleted']);
  finish('stale-preview');
  await setImmediate();
  assert.equal(loader.get('deleted'), '');
  assert.equal(loader.get('other'), 'other-preview');
  loader.subscribe('deleted', () => {});
  unsubscribe(); // obsolete subscription must not remove the new one
  await setImmediate();
  assert.equal(loader.get('deleted'), 'fresh-preview');
});
const { buildAssetGridLayout, getAssetGridItemsInRange } = load("assetGridLayout.ts");

function clipboardHandler(clipboard, readFile = async () => { throw new Error("missing file"); }) {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.js"), "utf8");
  const start = source.indexOf('  ipcMain.handle("assets:readClipboardImage",');
  const end = source.indexOf('\n  ipcMain.handle("assets:materializeDroppedFile",', start);
  let handler;
  new Function("ipcMain", "clipboard", "fs", "path", "Buffer", "process", source.slice(start, end))(
    { handle: (_, value) => { handler = value; } }, clipboard, { readFile }, path.win32, Buffer, { platform: "win32" }
  );
  return handler;
}

test("native preview clipboard reads Electron image blobs and ignores plain text", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  const read = clipboardHandler({ read: async () => [{ types: ["text/plain", "image/png"], getType: async () => ({ arrayBuffer: async () => bytes.buffer }) }] });
  assert.deepEqual(await read(), { name: "clipboard-preview.png", bytes });
  assert.equal(await clipboardHandler({ read: async () => [{ types: ["text/plain"] }] })(), null);
});

test("native preview clipboard accepts copied image filenames and falls back when the file moved", async () => {
  const fileType = 'electron application/osclipboard;format="FileNameW"';
  const bytes = Buffer.from([137, 80, 78, 71]);
  const fileName = Buffer.from("D:\\图片\\预览.png\0", "utf16le");
  const blob = (value) => ({ arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) });
  const clipboard = { read: async () => [{ types: [fileType, "image/png"], getType: async (type) => blob(type === fileType ? fileName : bytes) }] };
  let requested;
  const result = await clipboardHandler(clipboard, async (filePath) => { requested = filePath; return bytes; })();
  assert.equal(requested, "D:\\图片\\预览.png");
  assert.equal(result.name, "预览.png");
  assert.deepEqual(result.bytes, bytes);
  assert.equal((await clipboardHandler(clipboard)()).name, "clipboard-preview.png");
});

function previewPasteFixture() {
  const source = fs.readFileSync(path.join(__dirname, "../src/ui/App.tsx"), "utf8");
  const parsed = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ["selectImportCover", "resolveDroppedFilePath", "readDroppedPath", "handlePreviewDrop", "handleEditPreviewDrop", "handleImportPreviewPaste", "handleEditPreviewPaste"];
  const pieces = [];
  (function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) pieces.push(node.getText(parsed));
    ts.forEachChild(node, visit);
  })(parsed);
  assert.equal(pieces.length, names.length);
  const js = ts.transpileModule(pieces.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const state = {
    busy: false, cutoutBusy: false, importModalLocked: false, bridgeAvailable: true,
    isCharacterAssetType: type => ['suit', 'monster', 'npc', 'weapon'].includes(type),
    activeImportIndexRef: { current: 0 }, importDraftsRef: { current: [{}] }, editLoadRequestRef: { current: 1 },
    importForm: { assetName: "Import", previewImagePath: "old.png" }, editForm: { assetId: "edit", previewImagePath: "old.png" },
    isTextureFileAccepted: (name) => /\.png$/i.test(name), normalizeLocalPath: (value) => value,
    showStatus: () => {}, t: (zh) => zh,
    bridge: { materializeDroppedFile: async (payload) => { state.payload = payload; return "D:\\temp\\clipboard-preview.png"; } },
    setImportForm: (update) => { state.importForm = update(state.importForm); },
    setEditForm: (update) => { state.editForm = update(state.editForm); }
  };
  const handlers = new Function("scope", `with (scope) { ${js}; return { readDroppedPath, handlePreviewDrop, handleEditPreviewDrop, handleImportPreviewPaste, handleEditPreviewPaste }; }`)(state);
  return { state, ...handlers };
}

test("import and edit preview paste materialize image bytes and preserve unrelated fields", async () => {
  for (const target of ["Import", "Edit"]) {
    const fixture = previewPasteFixture();
    const file = { name: "clipboard-preview.png", arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    await fixture[`handle${target}PreviewPaste`](file);
    assert.equal(fixture.state[`${target.toLowerCase()}Form`].previewImagePath, "D:\\temp\\clipboard-preview.png");
    assert.equal(fixture.state.importForm.assetName, "Import");
    assert.equal(fixture.state.editForm.assetId, "edit");
    assert.deepEqual(new Uint8Array(fixture.state.payload.bytes), new Uint8Array([1, 2, 3]));
  }
});

test("late materialized clipboard images do not overwrite another import or edited asset", async () => {
  for (const target of ["Import", "Edit"]) {
    const fixture = previewPasteFixture();
    let finish;
    fixture.state.bridge.materializeDroppedFile = () => new Promise(resolve => { finish = resolve; });
    const pending = fixture[`handle${target}PreviewPaste`]({ name: "clipboard-preview.png", arrayBuffer: async () => new ArrayBuffer(1) });
    await setImmediate();
    fixture.state.activeImportIndexRef.current++;
    fixture.state.editLoadRequestRef.current++;
    finish("D:\\temp\\clipboard-preview.png");
    await pending;
    assert.equal(fixture.state[`${target.toLowerCase()}Form`].previewImagePath, "old.png");
  }
});

function previewDropEvent(files, items) {
  return {
    preventDefault() {}, stopPropagation() {},
    dataTransfer: { files, get items() { return items(); }, getData: () => "" }
  };
}

test("preview drops use FileList without requesting the same virtual files again", async () => {
  const fixture = previewPasteFixture();
  const file = { name: "preview.png", arrayBuffer: async () => new ArrayBuffer(1) };
  const event = previewDropEvent([file], () => { throw new Error("duplicate virtual file read"); });
  await fixture.handlePreviewDrop(event);
  assert.equal(fixture.state.importForm.previewImagePath, "D:\\temp\\clipboard-preview.png");
});

test("preview drops still accept item-only sources", async () => {
  const fixture = previewPasteFixture();
  const event = previewDropEvent([], () => [{ getAsFile: () => ({ path: "D:\\preview.png" }) }]);
  await fixture.handleEditPreviewDrop(event);
  assert.equal(fixture.state.editForm.previewImagePath, "D:\\preview.png");
});

test("delayed ZIP preview drops do not replace the next asset's preview", async () => {
  for (const target of ["Import", "Edit"]) {
    const fixture = previewPasteFixture();
    let finish;
    fixture.state.bridge.materializeDroppedFile = () => new Promise(resolve => { finish = resolve; });
    const event = previewDropEvent([{ name: "preview.png", arrayBuffer: async () => new ArrayBuffer(1) }], () => []);
    const pending = target === "Import" ? fixture.handlePreviewDrop(event) : fixture.handleEditPreviewDrop(event);
    await setImmediate();
    fixture.state.activeImportIndexRef.current++;
    fixture.state.editLoadRequestRef.current++;
    finish("D:\\temp\\clipboard-preview.png");
    await pending;
    assert.equal(fixture.state[`${target.toLowerCase()}Form`].previewImagePath, "old.png");
  }
});

test("viewport cards precede mounted overscan after a scroll jump", async () => {
  const calls = [];
  const pending = new Map();
  const loader = new PreviewLoader(path => {
    calls.push(path);
    return new Promise(resolve => pending.set(path, resolve));
  }, 1);
  const stop = ["above", "onscreen", "below"].map(path => loader.subscribe(path, () => {}));
  loader.setPrefetch(["speculative"]);
  loader.setViewport(["unmounted", "onscreen"]);
  await setImmediate();
  assert.deepEqual(calls, ["onscreen"]);
  loader.setViewport(["below"]);
  pending.get("onscreen")("onscreen.thumb");
  await setImmediate();
  assert.deepEqual(calls, ["onscreen", "below"]);
  pending.get("below")("below.thumb");
  stop.forEach(unsubscribe => unsubscribe());
  loader.setPrefetch([]);
  loader.setViewport([]);
  await setImmediate();
  assert.equal(loader.get("below"), "below.thumb");
});

test("rapid scroll preserves completed work, deduplicates requests and prioritizes mounted cards", async () => {
  const calls = [];
  const pending = new Map();
  let active = 0;
  let peak = 0;
  const loader = new PreviewLoader((path) => {
    calls.push(path);
    peak = Math.max(peak, ++active);
    return new Promise(resolve => pending.set(path, () => { active--; resolve(`${path}.thumb`); }));
  }, 2);
  loader.setPrefetch(["old1", "old2", "obsolete"]);
  await setImmediate();
  let notifications = 0;
  const unsubscribe = loader.subscribe("visible", () => notifications++);
  const unsubscribeDuplicate = loader.subscribe("visible", () => notifications++);
  for (let i = 0; i < 100; i++) loader.setPrefetch([`unused${i}`, "visible"]);
  loader.setPrefetch(["next"]);
  pending.get("old1")();
  await setImmediate();
  assert.deepEqual(calls, ["old1", "old2", "visible"]);
  assert.equal(loader.get("old1"), "old1.thumb");
  pending.get("visible")();
  await setImmediate();
  assert.equal(notifications, 2);
  assert.equal(calls.filter(path => path === "visible").length, 1);
  assert.equal(peak, 2);
  unsubscribe();
  unsubscribeDuplicate();
  pending.get("old2")();
  pending.get("next")();
  await setImmediate();
  assert.equal(loader.get("next"), "next.thumb");
  assert.equal(calls.length, 4);
});

test("overview subscriptions load without prefetch, cache remounts, and isolate notifications", async () => {
  const calls = [];
  const loader = new PreviewLoader(async path => { calls.push(path); return `${path}.thumb`; });
  let first = 0;
  let second = 0;
  const leave = loader.subscribe("overview", () => first++);
  await setImmediate();
  leave();
  const leaveAgain = loader.subscribe("overview", () => first++);
  const leaveSecond = loader.subscribe("other", () => second++);
  await setImmediate();
  assert.deepEqual(calls, ["overview", "other"]);
  assert.equal(first, 1);
  assert.equal(second, 1);
  leaveAgain();
  leaveSecond();
});

test("failed and empty resolutions fall back without stopping the queue or retry loops", async () => {
  const loader = new PreviewLoader(async path => {
    if (path === "bad") throw new Error("missing thumbnail service");
    return path === "empty" ? "" : `${path}.thumb`;
  }, 1);
  loader.setPrefetch(["bad", "empty", "good"]);
  await setImmediate();
  assert.equal(loader.get("bad"), "bad");
  assert.equal(loader.get("empty"), "empty");
  assert.equal(loader.get("good"), "good.thumb");
});

test("cache stays bounded and mounted images survive eviction; obsolete queues are released", async () => {
  let calls = 0;
  const loader = new PreviewLoader(async path => { calls++; return `${path}.thumb`; }, 2, 3);
  const leave = loader.subscribe("pinned", () => {});
  loader.setPrefetch(Array.from({ length: 50 }, (_, i) => String(i)));
  await setImmediate();
  assert.equal(loader.get("pinned"), "pinned.thumb");
  assert.equal(loader.get("0"), "");
  assert.equal(loader.get("49"), "49.thumb");
  assert.equal(calls, 51);
  assert.equal(loader.cache.size, 3);
  leave();
  loader.setPrefetch(["never-started"]);
  loader.setPrefetch([]);
  await setImmediate();
  assert.equal(calls, 51);
});

test("file URLs preserve Unicode, spaces, hash, percent and network paths", () => {
  for (const file of ["D:\\素材库\\预览 #1 100%.jpg", "D:\\Images\\a&b+c.jpg", "D:\\Images\\normal.png"]) {
    assert.equal(getPreviewUrl(file), pathToFileURL(file).href);
  }
  assert.equal(getPreviewUrl("\\\\server\\share\\预览 #1.jpg"), "file://server/share/%E9%A2%84%E8%A7%88%20%231.jpg");
  assert.equal(getPreviewUrl(null), "");
});

test("directional prefetch matches full scans with logarithmic lookup on a large library", () => {
  const assets = Array.from({ length: 100000 }, (_, i) => ({ id: String(i), meta: { previews: { relativeSize: `${i % 3 + 1}x1` } } }));
  const { items } = buildAssetGridLayout(assets, 1600);
  let reads = 0;
  const indexed = new Proxy(items, { get(target, key) {
    if (/^\d+$/.test(String(key))) reads++;
    return Reflect.get(target, key);
  } });
  for (const top of [0, 10000, items.at(-1).y, items.at(-1).y + 1000]) {
    reads = 0;
    const result = getAssetGridItemsInRange(indexed, top, top + 1000);
    assert.deepEqual(result, items.filter(item => item.y + item.height >= top && item.y <= top + 1000));
    assert.ok(reads < 150, `range lookup accessed ${reads} of 100000 entries`);
  }
});
