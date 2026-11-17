const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

async function loadApplicationServices(directory, options = {}) {
  const electronStub = {
    app: { setName() {}, setAppUserModelId() {}, getPath: () => directory,
      commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true,
      on() {}, whenReady: () => ({ then() {} }) },
    BrowserWindow: { getAllWindows: () => [] },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }
  };
  const load = async (relative, append, overrides = {}) => {
    const file = path.resolve(__dirname, "..", relative);
    const localRequire = createRequire(file);
    const context = vm.createContext({ process, console, __dirname: path.dirname(file), module: { exports: {} },
      require: name => name in overrides ? overrides[name] : name === "electron" ? electronStub
        : name === "./logManager" ? { writeLog() {}, setupLogger() {}, onLogLine() {} } : localRequire(name) });
    vm.runInContext(await fs.readFile(file, "utf8") + append, context, { filename: file });
    return context.module.exports;
  };
  const main = await load("electron/main.js", `
settings.customLibraryPath = ${JSON.stringify(path.join(directory, "Library"))};
markInternalLibraryMutation = () => {};
scheduleIndexSnapshotSave = () => {};
applyLibrarySqlCacheChanges = async () => {};
inferColorTagsSafely = async () => [];
module.exports = { importCustomAsset, updateCustomAsset, readMegascansDropMetadata, getIndex: () => index };
`);
  const exporter = await load("electron/services/unrealExporter.js", `
resolveUnrealOptions = async () => ({});
ensurePluginInstalled = async () => ({});
module.exports = { exportToUnreal, buildExportAssets };
`, { "./unrealDiscovery": { tcpClient: options.tcpClient || { importAssets: async () => ({ requestId: "test-complete" }) } } });
  return { ...main, ...exporter };
}

module.exports = { loadApplicationServices };
