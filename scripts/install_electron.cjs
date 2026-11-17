const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { setTimeout, clearTimeout } = require("node:timers");
const { checkElectron } = require("./check_dependencies.cjs");

const root = path.resolve(__dirname, "..");
const directory = path.join(root, "node_modules", "electron");
// Preserve explicit configuration; use the same regional mirror as packaging,
// then try upstream. Electron's own installer verifies the bundled SHA256 hashes.
const mirrors = [...new Set([process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/", ""] )];

async function install(mirror) {
  const env = { ...process.env, electron_config_cache: path.join(root, ".cache", "electron") };
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  delete env.ELECTRON_OVERRIDE_DIST_PATH;
  delete env.electron_use_remote_checksums;
  delete env.npm_config_electron_use_remote_checksums;
  for (const name of Object.keys(env)) {
    if (/^(npm_config_electron_mirror|npm_package_config_electron_mirror)$/i.test(name)) delete env[name];
  }
  if (mirror) env.ELECTRON_MIRROR = mirror;
  else delete env.ELECTRON_MIRROR;
  // A partial dist may still have a valid marker; force extraction when the probe failed.
  fs.rmSync(path.join(directory, "path.txt"), { force: true });
  console.log(`[INFO] Downloading Electron from ${mirror || "github.com/electron/electron"} (up to 180 seconds)...`);
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(directory, "install.js")], { cwd: root, env, stdio: "inherit", windowsHide: true });
    const timer = setTimeout(() => { console.error("[WARN] Electron download timed out."); child.kill(); }, 180000);
    child.on("error", error => { console.error(error.message); clearTimeout(timer); resolve(false); });
    child.on("close", code => { clearTimeout(timer); resolve(code === 0); });
  });
}

(async () => {
  for (const mirror of mirrors) {
    if (await install(mirror) && checkElectron().length === 0) {
      console.log("[OK] Electron downloaded and its runtime starts successfully.");
      return;
    }
  }
  throw new Error("Electron installation failed. Check the download errors above or set ELECTRON_MIRROR, then rerun the launcher.");
})().catch(error => { console.error(`[ERROR] ${error.message}`); process.exitCode = 1; });
