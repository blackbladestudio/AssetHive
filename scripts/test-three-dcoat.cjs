const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createThreeDCoatBridge, registerThreeDCoatIpc } = require("../electron/services/threeDCoat");
const { setTimeout } = require("node:timers");

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(__dirname, ".three-dcoat-test-"));
  const documents = path.join(root, "Documents");
  const data = path.join(documents, "3DCoat2026");
  const program = path.join(root, "3DCoat-2026", "3DCoatGL64.exe");
  const library = path.join(root, "中文 资产");
  await fs.mkdir(path.join(data, "UserPrefs"), { recursive: true });
  await fs.mkdir(path.dirname(program), { recursive: true });
  await fs.mkdir(library, { recursive: true });
  await fs.writeFile(program, "test executable");
  await fs.writeFile(path.join(path.dirname(program), "doc_folder.txt"), "3DCoat2026\n");
  await fs.writeFile(path.join(data, "executable.txt"), program);
  const model = path.join(library, "带 空格_Lod0.obj");
  await fs.writeFile(model, "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
  const originalModel = await fs.readFile(model);
  const assets = { mesh: { id: "mesh", name: "中文模型", path: library, modelFiles: [model] } };
  let launchCount = 0;
  const bridge = createThreeDCoatBridge({
    userDataDir: path.join(root, "UserData"), documentsDir: documents,
    getAsset: async id => assets[id], programRoots: [],
    running: async () => true, launch: async () => { launchCount++; }, ...overrides
  });
  t.after(async () => {
    // Test-owned paths only; resolve the target before recursive cleanup.
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(__dirname) + path.sep) || !path.basename(resolved).startsWith(".three-dcoat-test-")) throw new Error("Unexpected test cleanup target");
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { root, data, program, model, originalModel, assets, bridge, launches: () => launchCount };
}

test("discovers the installed program and sends the official UTF-8 AppLink contract without modifying the library model", async t => {
  const f = await fixture(t);
  const info = await f.bridge.info("mesh");
  assert.equal(info.ready, true);
  assert.equal(info.executable, f.program);
  const result = await f.bridge.importAsset({ assetId: "mesh", modelFile: f.model, mode: "ppp" });
  assert.equal(result.status, "queued");
  const lines = (await fs.readFile(path.join(f.data, "Exchange", "import.txt"), "utf8")).trimEnd().split("\n");
  assert.equal(lines[0], f.model);
  assert.equal(lines[2], "[ppp]");
  assert.ok(lines[1].startsWith(path.join(f.root, "UserData", "ThreeDCoatImports") + path.sep));
  assert.notEqual(lines[1], f.model);
  assert.deepEqual(await fs.readFile(f.model), f.originalModel);
  assert.equal(f.launches(), 0);
});

test("preserves another AppLink's pending import", async t => {
  const f = await fixture(t);
  const job = path.join(f.data, "Exchange", "import.txt");
  await fs.mkdir(path.dirname(job), { recursive: true });
  await fs.writeFile(job, "another application's job");
  await assert.rejects(f.bridge.importAsset({ assetId: "mesh" }), { code: "PENDING_IMPORT" });
  assert.equal(await fs.readFile(job, "utf8"), "another application's job");
});

test("rejects files outside the selected asset and invalid native command modes", async t => {
  const f = await fixture(t);
  await assert.rejects(f.bridge.importAsset({ assetId: "mesh", modelFile: f.program }), { code: "MODEL_NOT_IN_ASSET" });
  await assert.rejects(f.bridge.importAsset({ assetId: "mesh", mode: "ppp]\n[script anything]" }), { code: "INVALID_MODE" });
  assert.equal(await fs.stat(path.join(f.data, "Exchange", "import.txt")).catch(() => null), null);
});

test("launches a closed program once and queues the selected sculpting mode", async t => {
  const f = await fixture(t, { running: async () => false });
  await f.bridge.importAsset({ assetId: "mesh", mode: "vox" });
  assert.equal(f.launches(), 1);
  assert.match(await fs.readFile(path.join(f.data, "Exchange", "import.txt"), "utf8"), /\n\[vox\]\n$/);
});

test("a launch error leaves no pending job and permits a later retry", async t => {
  let launchFails = true;
  const f = await fixture(t, { running: async () => false, launch: async () => { if (launchFails) throw new Error("launch failed"); } });
  await assert.rejects(f.bridge.importAsset({ assetId: "mesh" }), /launch failed/);
  assert.equal(await fs.stat(path.join(f.data, "Exchange", "import.txt")).catch(() => null), null);
  assert.deepEqual(await fs.readdir(path.join(f.data, "Exchange")), []);
  launchFails = false;
  const result = await f.bridge.importAsset({ assetId: "mesh", mode: "retopo" });
  assert.equal(result.ok, true);
});

test("rejects concurrent sends and a competing job created during launch", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { running: async () => { await gate; return true; } });
  const first = f.bridge.importAsset({ assetId: "mesh" });
  await assert.rejects(f.bridge.importAsset({ assetId: "mesh" }), { code: "BUSY" });
  const pending = path.join(f.data, "Exchange", "import.txt");
  while (!await fs.stat(path.dirname(pending)).catch(() => null)) await new Promise(resolve => setTimeout(resolve, 5));
  await fs.writeFile(pending, "competing import");
  release();
  await assert.rejects(first, { code: "PENDING_IMPORT" });
  assert.equal(await fs.readFile(pending, "utf8"), "competing import");
});

test("unsupported assets give a clear error without creating a native import", async t => {
  const f = await fixture(t);
  f.assets.mesh.modelFiles = [path.join(f.assets.mesh.path, "mesh.glb")];
  const info = await f.bridge.info("mesh");
  assert.equal(info.files.length, 0);
  await assert.rejects(f.bridge.importAsset({ assetId: "mesh" }), { code: "NO_SUPPORTED_MODEL" });
});

test("manual configuration validates paths and persists the selected connection", async t => {
  const f = await fixture(t);
  await assert.rejects(f.bridge.configure({ dataDirectory: f.assets.mesh.path }), { code: "DATA_DIRECTORY_MISSING" });
  await assert.rejects(f.bridge.configure({ executable: f.model }), { code: "PROGRAM_MISSING" });
  const state = await f.bridge.configure({ executable: f.program, dataDirectory: f.data });
  assert.equal(state.ready, true);
  const saved = JSON.parse(await fs.readFile(path.join(f.root, "UserData", "three-dcoat-settings.json"), "utf8"));
  assert.equal(saved.executable, f.program);
  assert.equal(saved.dataDirectory, f.data);
});

test("IPC returns typed results, preserves canceled configuration, and reports import errors", async t => {
  const f = await fixture(t);
  const handlers = new Map();
  const logs = [];
  registerThreeDCoatIpc({
    app: { getPath: name => name === "documents" ? path.dirname(f.data) : path.join(f.root, "UserData") },
    ipcMain: { handle: (channel, action) => handlers.set(channel, action) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    getAsset: async id => f.assets[id], getLanguage: () => "en",
    writeLog: (...args) => logs.push(args), programRoots: [], running: async () => true
  });
  const info = await handlers.get("threeDCoat:info")({}, "mesh");
  assert.equal(info.ok, true);
  assert.equal(info.language, "en");
  const status = await handlers.get("threeDCoat:status")({});
  assert.equal(status.ok, true);
  assert.equal(status.ready, true);
  assert.equal(status.executable, f.program);
  for (const channel of ["threeDCoat:pickProgram", "threeDCoat:pickDataDirectory"]) {
    assert.deepEqual(await handlers.get(channel)({}), { ok: true, canceled: true });
  }
  assert.equal(await fs.stat(path.join(f.root, "UserData", "three-dcoat-settings.json")).catch(() => null), null);
  const configured = await handlers.get("threeDCoat:configure")({}, { executable: f.program });
  assert.equal(configured.ok, true);
  assert.equal(configured.ready, true);
  assert.equal(configured.dataDirectory, f.data);
  const result = await handlers.get("threeDCoat:import")({}, { assetId: "mesh", mode: "retopo" });
  assert.equal(result.ok, true);
  assert.equal(result.status, "queued");
  assert.match(await fs.readFile(path.join(f.data, "Exchange", "import.txt"), "utf8"), /\n\[retopo\]\n$/);
  const pending = await handlers.get("threeDCoat:import")({}, { assetId: "mesh" });
  assert.equal(pending.ok, false);
  assert.equal(pending.code, "PENDING_IMPORT");
  assert.ok(logs.some(log => log[2]?.code === "PENDING_IMPORT"));
});
