const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const SUPPORTED_EXTENSIONS = new Set([".fbx", ".obj", ".stl", ".ply"]);
const MODES = new Set(["ppp", "vox", "retopo"]);
const EXE_NAMES = ["3DCoatGL64.exe", "3D-CoatGL64.exe", "3DCoatDX64.exe", "3D-CoatDX64.exe"];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

async function isFile(file) {
  if (!file) return false;
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

async function isDirectory(dir) {
  if (!dir) return false;
  try { return (await fs.stat(dir)).isDirectory(); } catch { return false; }
}

function protocolPath(file) {
  if (typeof file !== "string" || /[\r\n\0]/.test(file) || !path.isAbsolute(file)) {
    fail("INVALID_PATH", "模型和 3DCoat 路径必须是有效的绝对路径");
  }
  return path.resolve(file);
}

async function isProgramRunning(executable) {
  if (process.platform !== "win32") return false;
  const name = path.basename(executable);
  const tasklist = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tasklist.exe");
  const { stdout } = await execFileAsync(tasklist, ["/FI", `IMAGENAME eq ${name}`, "/FO", "CSV", "/NH"], {
    windowsHide: true, timeout: 10000, encoding: "utf8"
  });
  return stdout.toLowerCase().includes(`"${name.toLowerCase()}"`);
}

async function launchProgram(executable) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [], { detached: true, stdio: "ignore", shell: false, windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

function createThreeDCoatBridge({
  userDataDir,
  documentsDir,
  getAsset,
  getLanguage = () => "zh",
  programRoots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean),
  running = isProgramRunning,
  launch = launchProgram
}) {
  const configFile = path.join(userDataDir, "three-dcoat-settings.json");
  let sending = false;

  async function readConfig() {
    try { return JSON.parse(await fs.readFile(configFile, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return {};
      fail("CONFIG_ERROR", "无法读取 3DCoat 连接设置，请检查 three-dcoat-settings.json");
    }
  }

  async function saveConfig(config) {
    await fs.mkdir(userDataDir, { recursive: true });
    const temp = `${configFile}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      await fs.rename(temp, configFile);
    } finally { await fs.unlink(temp).catch(() => {}); }
  }

  async function dataDirectoryFor(executable) {
    if (!executable) return "";
    try {
      const name = (await fs.readFile(path.join(path.dirname(executable), "doc_folder.txt"), "utf8")).trim();
      if (/^[\w .-]+$/.test(name)) {
        const directory = path.join(documentsDir, name);
        if (await isDirectory(path.join(directory, "UserPrefs"))) return directory;
      }
    } catch { /* Older installations may not have a doc_folder.txt. */ }
    return "";
  }

  async function connection() {
    const config = await readConfig();
    let executable = config.executable || "";
    let dataDirectory = config.dataDirectory || "";
    const profiles = (await fs.readdir(documentsDir, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isDirectory() && /^3dcoat(?:[- ]?\d{4})?$/i.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
    if (!executable) {
      for (const profile of profiles) {
        const directory = path.join(documentsDir, profile.name);
        const recorded = (await fs.readFile(path.join(directory, "executable.txt"), "utf8").catch(() => "")).trim();
        if (recorded && path.isAbsolute(recorded) && await isFile(recorded)) {
          executable = recorded;
          if (!dataDirectory) dataDirectory = directory;
          break;
        }
      }
    }
    if (!executable) {
      for (const root of programRoots) {
        const installs = (await fs.readdir(root, { withFileTypes: true }).catch(() => []))
          .filter(entry => entry.isDirectory() && /^3d[- ]?coat/i.test(entry.name))
          .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
        for (const install of installs) {
          for (const name of EXE_NAMES) {
            const candidate = path.join(root, install.name, name);
            if (await isFile(candidate)) { executable = candidate; break; }
          }
          if (executable) break;
        }
        if (executable) break;
      }
    }
    if (!dataDirectory) dataDirectory = await dataDirectoryFor(executable);
    if (!dataDirectory && profiles.length) dataDirectory = path.join(documentsDir, profiles[0].name);
    const executableExists = Boolean(executable && path.isAbsolute(executable) && await isFile(executable));
    const dataDirectoryExists = Boolean(dataDirectory && path.isAbsolute(dataDirectory) && await isDirectory(path.join(dataDirectory, "UserPrefs")));
    return {
      executable, dataDirectory, executableExists, dataDirectoryExists,
      ready: executableExists && dataDirectoryExists,
      mode: MODES.has(config.mode) ? config.mode : "ppp",
      language: getLanguage() === "en" ? "en" : "zh"
    };
  }

  async function info(assetId) {
    const asset = await getAsset(assetId);
    if (!asset) fail("ASSET_NOT_FOUND", "没有找到此资产，请刷新资产库后重试");
    if (/^(atlas|atlases|imperfection|imperfections|displacement|displacements)$/i.test(String(asset.assetType || "").trim())) fail("UNSUPPORTED_ASSET_TYPE", "Atlases / Imperfections / Displacements 请打开文件夹使用");
    const files = [];
    for (const item of Array.isArray(asset.modelFiles) ? asset.modelFiles : []) {
      if (typeof item !== "string" || !SUPPORTED_EXTENSIONS.has(path.extname(item).toLowerCase())) continue;
      const file = path.isAbsolute(item) ? item : path.resolve(asset.path, item);
      protocolPath(file);
      if (await isFile(file) && !files.some(entry => entry.path === file)) {
        files.push({ path: file, label: path.relative(asset.path, file) || path.basename(file) });
      }
    }
    files.sort((a, b) => {
      const score = file => (/lod0\b/i.test(file) ? 0 : /lod[1-9]\b/i.test(file) ? 2 : 1);
      return score(a.label) - score(b.label) || a.label.localeCompare(b.label, undefined, { numeric: true });
    });
    return { ...(await connection()), assetId: asset.id, assetName: asset.name || asset.id, files };
  }

  async function configure(patch) {
    const config = await readConfig();
    if (patch.executable !== undefined) {
      const executable = protocolPath(patch.executable);
      if (path.extname(executable).toLowerCase() !== ".exe" || !await isFile(executable)) fail("PROGRAM_MISSING", "请选择有效的 3DCoat 程序文件");
      config.executable = executable;
      const detected = await dataDirectoryFor(executable);
      if (detected) config.dataDirectory = detected;
    }
    if (patch.dataDirectory !== undefined) {
      const directory = protocolPath(patch.dataDirectory);
      if (!await isDirectory(path.join(directory, "UserPrefs"))) fail("DATA_DIRECTORY_MISSING", "请选择包含 UserPrefs 文件夹的 3DCoat 数据目录");
      config.dataDirectory = directory;
    }
    await saveConfig(config);
    return connection();
  }

  async function importAsset(payload = {}) {
    if (sending) fail("BUSY", "正在发送模型，请稍后重试");
    sending = true;
    let temporaryJob = "";
    try {
      const state = await info(payload.assetId);
      if (!state.ready) fail("NOT_CONFIGURED", "请先配置 3DCoat 程序和数据目录");
      if (!state.files.length) fail("NO_SUPPORTED_MODEL", "此资产没有可导入的 FBX、OBJ、STL 或 PLY 模型");
      const model = payload.modelFile ? state.files.find(file => file.path === payload.modelFile) : state.files[0];
      if (!model) fail("MODEL_NOT_IN_ASSET", "所选模型不属于此资产，请重新选择");
      const mode = payload.mode || state.mode;
      if (!MODES.has(mode)) fail("INVALID_MODE", "请选择有效的 3DCoat 导入模式");
      const exchange = path.join(protocolPath(state.dataDirectory), "Exchange");
      await fs.mkdir(exchange, { recursive: true });
      const pendingJob = path.join(exchange, "import.txt");
      if (await isFile(pendingJob)) fail("PENDING_IMPORT", "3DCoat 有待处理的导入任务，请先在 3DCoat 中处理后重试");
      const resultDirectory = path.join(userDataDir, "ThreeDCoatImports", crypto.randomUUID());
      await fs.mkdir(resultDirectory, { recursive: true });
      const returnFile = path.join(resultDirectory, "return.obj");
      const content = `${protocolPath(model.path)}\n${protocolPath(returnFile)}\n[${mode}]\n`;
      temporaryJob = path.join(exchange, `.assethive-${crypto.randomUUID()}.tmp`);
      await fs.writeFile(temporaryJob, content, { encoding: "utf8", flag: "wx" });
      await saveConfig({ ...(await readConfig()), executable: state.executable, dataDirectory: state.dataDirectory, mode });
      const alreadyRunning = await running(state.executable);
      if (!alreadyRunning) await launch(state.executable);
      // A hard link publishes a complete file atomically and fails if another
      // AppLink queued a job while this import was being prepared.
      try { await fs.link(temporaryJob, pendingJob); }
      catch (error) {
        if (error.code === "EEXIST") fail("PENDING_IMPORT", "3DCoat 有待处理的导入任务，请先处理后重试");
        throw error;
      }
      return { ok: true, status: "queued", modelFile: model.path, mode, alreadyRunning };
    } finally {
      if (temporaryJob) await fs.unlink(temporaryJob).catch(() => {});
      sending = false;
    }
  }

  return { info, connection, configure, importAsset };
}

function registerThreeDCoatIpc({ app, ipcMain, dialog, getAsset, getLanguage, writeLog, ...overrides }) {
  const bridge = createThreeDCoatBridge({
    userDataDir: app.getPath("userData"), documentsDir: app.getPath("documents"), getAsset, getLanguage, ...overrides
  });
  const handle = (channel, action) => ipcMain.handle(channel, async (...args) => {
    try { return { ok: true, ...(await action(...args)) }; }
    catch (error) {
      writeLog?.("WARN", "3DCoat import", { code: error.code, message: error.message });
      return { ok: false, code: error.code || "IMPORT_ERROR", message: error.message };
    }
  });
  handle("threeDCoat:info", (_, assetId) => bridge.info(assetId));
  handle("threeDCoat:status", () => bridge.connection());
  handle("threeDCoat:configure", (_, patch) => bridge.configure(patch || {}));
  handle("threeDCoat:import", (_, payload) => bridge.importAsset(payload));
  handle("threeDCoat:pickProgram", async () => {
    const result = await dialog.showOpenDialog({ title: "选择 3DCoat 程序", properties: ["openFile"], filters: [{ name: "3DCoat", extensions: ["exe"] }] });
    return result.canceled ? { canceled: true } : bridge.configure({ executable: result.filePaths[0] });
  });
  handle("threeDCoat:pickDataDirectory", async () => {
    const result = await dialog.showOpenDialog({ title: "选择 3DCoat 数据目录（包含 UserPrefs）", properties: ["openDirectory"] });
    return result.canceled ? { canceled: true } : bridge.configure({ dataDirectory: result.filePaths[0] });
  });
  return bridge;
}

module.exports = { createThreeDCoatBridge, registerThreeDCoatIpc, SUPPORTED_EXTENSIONS, MODES };
