// Hidden test window and temporary AppLink directories only; never launch 3DCoat.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { setTimeout, clearTimeout } = require("node:timers");

async function runElectron() {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const { registerThreeDCoatIpc } = require("../electron/services/threeDCoat");
  const directory = process.argv[2];
  const fixture = JSON.parse(fs.readFileSync(path.join(directory, "fixture.json"), "utf8"));
  app.setPath("userData", path.join(directory, "profile"));
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  await app.whenReady();
  registerThreeDCoatIpc({ app, ipcMain,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    getAsset: async id => fixture.assets[id], getLanguage: () => "zh",
    documentsDir: fixture.documents, programRoots: [], running: async () => true,
    launch: async () => { throw new Error("The test must never launch a real application"); }
  });
  const window = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false,
      preload: path.resolve(__dirname, "../electron/preload.js") }
  });
  const errors = [];
  window.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  try {
    await window.loadFile(path.join(directory, "index.html"));
    const result = await window.webContents.executeJavaScript("window.runThreeDCoatTests()");
    assert.equal(result.ok, true);
    const task = fs.readFileSync(path.join(fixture.dataDirectory, "Exchange/import.txt"), "utf8").trimEnd().split("\n");
    assert.equal(task[0], result.selectedModel);
    assert.equal(task[2], "[vox]");
    assert.ok(task[1].startsWith(path.join(directory, "profile", "ThreeDCoatImports") + path.sep));
    assert.equal(fs.readFileSync(result.selectedModel, "utf8"), fixture.originalModel);
    assert.deepEqual(errors, []);
    await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(directory, "3dcoat-import.png"), (await window.webContents.capturePage()).toPNG());
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ ok: false, error: error.stack || String(error), errors }, null, 2));
    fs.writeFileSync(path.join(directory, "3dcoat-failure.png"), (await window.webContents.capturePage()).toPNG());
    app.exit(1);
  }
}

async function launch() {
  const { spawn } = require("node:child_process");
  const { build } = require("esbuild");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-3dcoat-ui-"));
  const documents = path.join(directory, "Documents");
  const dataDirectory = path.join(documents, "3DCoat2026");
  const executable = path.join(directory, "3DCoat-2026", "3DCoatGL64.exe");
  const library = path.join(directory, "中文 资产");
  fs.mkdirSync(path.join(dataDirectory, "UserPrefs"), { recursive: true });
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(executable, "Test fixture only; never executed");
  fs.writeFileSync(path.join(dataDirectory, "executable.txt"), executable);
  const originalModel = "o Test\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
  const models = ["模型_Lod0.obj", "模型_Lod1.obj"].map(name => path.join(library, name));
  for (const model of models) fs.writeFileSync(model, originalModel);
  const assets = {
    mesh: { id: "mesh", name: "中文测试模型", path: library, modelFiles: models },
    empty: { id: "empty", name: "Unsupported", path: library, modelFiles: [] }
  };
  fs.writeFileSync(path.join(directory, "fixture.json"), JSON.stringify({ documents, dataDirectory, originalModel, assets }));
  await build({ entryPoints: [path.join(__dirname, "three-dcoat-renderer-tests.tsx")], bundle: true,
    outfile: path.join(directory, "renderer.js"), jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' }, logLevel: "silent" });
  fs.writeFileSync(path.join(directory, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script src="renderer.js"></script>');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [path.join(__dirname, "check-three-dcoat-electron.cjs"), directory], { env, windowsHide: true, stdio: "inherit" });
  const timer = setTimeout(() => child.kill(), 45000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  clearTimeout(timer);
  const resultFile = path.join(directory, "result.json");
  console.log(fs.existsSync(resultFile) ? fs.readFileSync(resultFile, "utf8") : "Electron did not produce a result");
  console.log(`Artifacts: ${directory}`);
  process.exitCode = code === 0 ? 0 : 1;
}

if (process.versions.electron) void runElectron();
else void launch().catch(error => { console.error(error); process.exitCode = 1; });
