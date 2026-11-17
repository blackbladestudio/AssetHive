const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { matchesUnrealConnection } = require("../electron/services/unrealConnection");
const ts = require("typescript");

async function rendererExportState(bridge) {
  const source = await fs.readFile(path.join(__dirname, "../src/ui/App.tsx"), "utf8");
  const callbackStart = source.indexOf("  const refreshPluginStatus = useCallback(");
  const callback = source.slice(callbackStart, source.indexOf("  useEffect(() => {", callbackStart));
  const eligibility = source.match(/const canExportToUnreal = (.+);/)[1];
  const script = ts.transpileModule(`
    const settings = { unrealEditorPath: "", unrealProjectPath: "" };
    const bridgeAvailable = true;
    const pluginStatusRequestRef = { current: 0 };
    const unrealTargetRef = { current: "\\n" };
    const useCallback = fn => fn;
    let pluginInstalled = false, hasImportableProject = false, unrealConnected = false;
    const setPluginInstalled = value => { pluginInstalled = value; };
    const setHasImportableProject = value => { hasImportableProject = value; };
    const setPluginStatusMessage = () => {};
    ${callback}
    return async connected => {
      unrealConnected = connected;
      await refreshPluginStatus();
      return ${eligibility};
    };
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function("bridge", script)(bridge);
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-unreal-target-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, "Project", "Test.uproject");
  const otherProjectPath = path.join(root, "Other", "Other.uproject");
  const editorPath = path.join(root, "UE", "Engine", "Binaries", "Win64", "UnrealEditor.exe");
  async function write(file, data = "{}") {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  }
  await write(projectPath);
  await write(otherProjectPath);
  let info = { projectPath, editorPath };
  const source = await fs.readFile(path.join(__dirname, "../electron/main.js"), "utf8");
  const helpers = source.slice(source.indexOf("async function resolveProjectFilePath("), source.indexOf("function normalizePath(filePath)"));
  const handler = source.slice(source.indexOf('  ipcMain.handle("plugins:getStatus"'), source.indexOf('  ipcMain.handle("plugins:install"'));
  let getStatus;
  new Function("fs", "path", "statOrNull", "loadJson", "tcpClient", "matchesUnrealConnection", "ipcMain", helpers + handler)(
    fs, path,
    file => fs.stat(file).catch(() => null),
    async (file, fallback) => JSON.parse(await fs.readFile(file, "utf8").catch(() => JSON.stringify(fallback))),
    { getEditorInfo: async () => info },
    matchesUnrealConnection,
    { handle: (_, fn) => { getStatus = fn; } }
  );
  return {
    projectPath, otherProjectPath, editorPath, write,
    enginePlugin: path.join(root, "UE", "Engine", "Plugins", "AssetHive", "AssetHive.uplugin"),
    projectPlugin: path.join(root, "Project", "Plugins", "AssetHive", "AssetHive.uplugin"),
    connect: value => { info = value; },
    status: (target = { projectPath }) => getStatus(null, target)
  };
}

test("project target recognizes a plugin installed in the connected engine", async t => {
  const f = await fixture(t);
  await f.write(f.enginePlugin);
  const status = await f.status();
  assert.equal(status.installed, true);
  assert.equal(status.enabled, true);
  assert.equal(status.resolvedProjectPath, f.projectPath);
});

test("project directory target recognizes the connected plugin", async t => {
  const f = await fixture(t);
  assert.equal((await f.status({ projectPath: path.dirname(f.projectPath) })).installed, true);
});

test("a successful handshake recognizes plugins outside the standard install folders", async t => {
  const f = await fixture(t);
  assert.equal((await f.status()).installed, true);
});

test("another project's connection cannot satisfy the selected project", async t => {
  const f = await fixture(t);
  await f.write(f.enginePlugin);
  f.connect({ projectPath: f.otherProjectPath, editorPath: f.editorPath });
  const status = await f.status();
  assert.equal(status.installed, false);
  assert.equal(status.resolvedProjectPath, f.projectPath);
});

test("an invalid project target does not fall back to an unrelated connection", async t => {
  const f = await fixture(t);
  const status = await f.status({ projectPath: path.join(path.dirname(f.projectPath), "Missing.uproject") });
  assert.equal(status.installed, false);
  assert.equal(status.resolvedProjectPath, "");
});

test("project plugins remain detectable offline and explicit disabling is respected", async t => {
  const f = await fixture(t);
  await f.write(f.projectPlugin);
  f.connect(null);
  assert.equal((await f.status()).installed, true);
  await f.write(f.projectPath, JSON.stringify({ Plugins: [{ Name: "AssetHive", Enabled: false }] }));
  const status = await f.status();
  assert.equal(status.installed, true);
  assert.equal(status.enabled, false);
});

test("engine plugins respect the target project's disabled setting", async t => {
  const f = await fixture(t);
  await f.write(f.enginePlugin);
  await f.write(f.projectPath, JSON.stringify({ Plugins: [{ Name: "AssetHive", Enabled: false }] }));
  const status = await f.status({ projectPath: f.projectPath, editorPath: f.editorPath });
  assert.equal(status.installed, true);
  assert.equal(status.enabled, false);
});

test("engine target uses its connected project over a stale legacy project field", async t => {
  const f = await fixture(t);
  await f.write(f.otherProjectPath, JSON.stringify({ Plugins: [{ Name: "AssetHive", Enabled: false }] }));
  const status = await f.status({ editorPath: f.editorPath, projectPath: f.otherProjectPath });
  assert.equal(status.installed, true);
  assert.equal(status.enabled, true);
  assert.equal(status.resolvedProjectPath, f.projectPath);
});

test("plugin status recovers when the target editor connects after startup", async t => {
  const f = await fixture(t);
  f.connect(null);
  assert.equal((await f.status()).installed, false);
  f.connect({ projectPath: f.projectPath, editorPath: f.editorPath });
  assert.equal((await f.status()).installed, true);
});

test("export follows the discovered project when no target path is configured", async t => {
  const f = await fixture(t);
  const canExport = await rendererExportState({ getPluginStatus: target => f.status(target) });
  f.connect(null);
  assert.equal(await canExport(false), false, "startup without an editor stays disabled");
  f.connect({ projectPath: f.projectPath, editorPath: f.editorPath });
  assert.equal(await canExport(true), true, "a discovered editor enables export without selecting a path");
  f.connect(null);
  assert.equal(await canExport(false), false, "disconnect disables export again");
});
