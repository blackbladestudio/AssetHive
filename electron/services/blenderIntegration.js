const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { Buffer } = require("node:buffer");
const { setTimeout, clearTimeout } = require("node:timers");

const PORTS = Array.from({ length: 10 }, (_, i) => 13450 + i);
const configurations = new Map();
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function runBlender(executable, expression, timeout = 60000, factoryStartup = true) {
  return new Promise((resolve, reject) => execFile(executable,
    ["--background", ...(factoryStartup ? ["--factory-startup"] : []), "--python-exit-code", "1", "--python-expr", expression],
    { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout, stderr) => error ? reject(new Error(`Blender: ${stderr || stdout || error.message}`)) : resolve(stdout)));
}

async function getBlenderConfiguration(executable) {
  if (!executable || path.basename(executable).toLowerCase() !== "blender.exe") throw new Error("请选择 Blender 的 blender.exe");
  await fs.access(executable);
  const key = path.resolve(executable);
  if (!configurations.has(key)) {
    const pending = runBlender(executable, "import bpy,json; print('ASSETHIVE_CONFIG='+json.dumps({'version':list(bpy.app.version),'scripts':bpy.utils.user_resource('SCRIPTS',create=True)}))")
      .then(output => {
        const line = output.split(/\r?\n/).find(value => value.startsWith("ASSETHIVE_CONFIG="));
        if (!line) throw new Error("无法读取 Blender 插件目录");
        const result = JSON.parse(line.slice("ASSETHIVE_CONFIG=".length));
        if (!path.isAbsolute(result.scripts) || result.version[0] < 3 || (result.version[0] === 3 && result.version[1] < 6)) throw new Error("需要 Blender 3.6 或更新版本");
        return { ...result, addonPath: path.join(result.scripts, "addons", "assethive") };
      }).catch(error => { configurations.delete(key); throw error; });
    configurations.set(key, pending);
  }
  return configurations.get(key);
}

async function installBlenderPlugin(executable, sourcePath) {
  const config = await getBlenderConfiguration(executable);
  const source = await fs.readFile(path.join(sourcePath, "__init__.py"), "utf8");
  if (!source.includes('"name": "AssetHive"')) throw new Error("软件根目录缺少 BlenderPlugin/assethive 插件，请重新安装 AssetHive");
  const previous = await fs.readFile(path.join(config.addonPath, "bridge.json"), "utf8").then(JSON.parse).catch(() => null);
  const token = previous?.token || crypto.randomBytes(32).toString("hex");
  await fs.mkdir(config.addonPath, { recursive: true });
  await fs.writeFile(path.join(config.addonPath, "__init__.py"), source, "utf8");
  await fs.writeFile(path.join(config.addonPath, "bridge.json"), JSON.stringify({ token }), "utf8");
  // Normal startup preserves preferences without read_userpref(), which reloads GPU icons
  // and crashes Blender 3.6 in background mode.
  const expression = "import bpy,addon_utils; bpy.utils.refresh_script_paths(); addon_utils.enable('assethive',default_set=True,persistent=True); assert addon_utils.check('assethive')[1], 'AssetHive enable failed'; bpy.ops.wm.save_userpref()";
  await runBlender(executable, expression, 60000, false);
  return { ok: true, path: config.addonPath, message: "Blender 插件已安装并启用；已打开的 Blender 请重启一次" };
}

function connect(port, token, executable, command, onProgress, timeout = 1800000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let buffer = "";
    let authenticated = false;
    let accepted = false;
    let finished = false;
    let timer = setTimeout(() => finish(new Error(accepted ? "Blender 导入结果未确认，请先检查场景后重试" : "Blender 连接超时")), 2000);
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) { error.accepted = accepted; reject(error); } else resolve(result);
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ type: "hello", protocolVersion: 1, token }) + "\n"));
    socket.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) return finish(new Error("Blender 回执过大"));
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { return finish(new Error("Blender 回执格式错误")); }
        if (!authenticated) {
          if (message.type !== "hello" || message.protocolVersion !== 1 || !message.executable || !samePath(message.executable, executable)) return finish(new Error("Blender 插件版本或目标不匹配"));
          authenticated = true;
          if (command?.job?.assets?.some(asset => asset.decimationRatio < 1)
            && !message.capabilities?.includes("meshDecimation")) {
            return finish(new Error("请重新安装 Blender 插件并重启 Blender，以启用按比例减面"));
          }
          if (!command) return finish(null, { ...message, port });
          clearTimeout(timer);
          // Keep the whole request bounded while Blender processes large models.
          timer = setTimeout(() => finish(new Error("Blender 导入结果未确认，请先检查场景")), timeout);
          accepted = true; // A disconnect after dispatch must never cause automatic duplicate imports.
          socket.write(JSON.stringify({ ...command, token, protocolVersion: 1 }) + "\n");
        } else if (message.type === "progress") onProgress?.(message);
        else if (message.type === "complete") return finish(null, message);
        else if (message.type === "error") return finish(new Error(message.message || "Blender 导入失败"));
      }
    });
    socket.on("error", error => finish(error));
    socket.on("close", () => finish(new Error(accepted ? "Blender 连接中断，导入结果未确认，请先检查场景" : "Blender 未连接")));
  });
}

async function readBridge(executable) {
  const config = await getBlenderConfiguration(executable);
  const bridge = JSON.parse(await fs.readFile(path.join(config.addonPath, "bridge.json"), "utf8"));
  if (!bridge.token) throw new Error("请先安装 Blender 插件");
  return { ...config, token: bridge.token };
}

async function getBlenderStatus(executable) {
  try {
    const config = await readBridge(executable);
    await fs.access(path.join(config.addonPath, "__init__.py"));
    const candidates = await Promise.all(PORTS.map(port => connect(port, config.token, executable).catch(() => null)));
    const live = candidates.find(Boolean);
    return { installed: true, connected: Boolean(live), path: config.addonPath, port: live?.port,
      targetName: live ? `Blender ${live.version}` : "Blender", message: live ? "" : "请打开 Blender；安装后请重启 Blender 或在偏好设置中启用 AssetHive" };
  } catch (error) {
    return { installed: false, connected: false, message: executable ? error.message : "请选择 Blender 程序并安装插件" };
  }
}

async function sendToBlender(executable, job, onProgress) {
  const status = await getBlenderStatus(executable);
  if (!status.connected) throw new Error(status.message);
  const config = await readBridge(executable);
  return connect(status.port, config.token, executable, { type: "import", requestId: crypto.randomUUID(), job }, onProgress);
}

module.exports = { getBlenderConfiguration, installBlenderPlugin, getBlenderStatus, sendToBlender };
