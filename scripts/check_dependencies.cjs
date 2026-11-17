const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));

function getElectronVersion(projectRoot = root) {
  const lock = readJson(path.join(projectRoot, "package-lock.json"));
  const version = lock.packages?.["node_modules/electron"]?.version;
  if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
    throw new Error("package-lock.json must lock an exact stable Electron version");
  }
  return version;
}

function checkPackages(projectRoot = root) {
  const manifest = readJson(path.join(projectRoot, "package.json"));
  const lockPath = path.join(projectRoot, "package-lock.json");
  const lock = fs.existsSync(lockPath) ? readJson(lockPath) : null;
  const failures = [];
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    try {
      const directory = path.join(projectRoot, "node_modules", name);
      const pkg = readJson(path.join(directory, "package.json"));
      const expected = lock?.packages?.[`node_modules/${name}`]?.version;
      if (expected && pkg.version !== expected) throw new Error(`expected ${expected}, found ${pkg.version}`);
      const bins = typeof pkg.bin === "string" ? { [name.split("/").pop()]: pkg.bin } : pkg.bin || {};
      for (const [command, file] of Object.entries(bins)) {
        if (!fs.existsSync(path.join(directory, file))) throw new Error(`missing executable ${file}`);
        if (!fs.existsSync(path.join(projectRoot, "node_modules", ".bin", `${command}.cmd`))) throw new Error(`missing command shim ${command}.cmd`);
      }
    } catch (error) { failures.push(`${name}: ${error.message}`); }
  }
  // Detect interrupted installs inside the dependency tree as well as at its root.
  for (const [relative, pkg] of Object.entries(lock?.packages || {})) {
    if (!relative || pkg.optional || pkg.link || (pkg.os && !pkg.os.includes(process.platform)) || (pkg.cpu && !pkg.cpu.includes(process.arch))) continue;
    try {
      const installed = readJson(path.join(projectRoot, relative, "package.json"));
      if (installed.version !== pkg.version) throw new Error("version differs from package-lock.json");
    } catch (error) { failures.push(`${relative}: ${error.message}`); }
  }
  return failures;
}

function checkElectron(projectRoot = root) {
  try {
    const directory = path.join(projectRoot, "node_modules", "electron");
    const version = getElectronVersion(projectRoot);
    const installedVersion = readJson(path.join(directory, "package.json")).version;
    if (installedVersion !== version) return [`Electron npm package: expected ${version} from package-lock.json, found ${installedVersion}`];
    const binary = fs.readFileSync(path.join(directory, "path.txt"), "utf8").trim();
    if (binary !== "electron.exe") return ["Electron executable marker is missing or invalid"];
    if (fs.readFileSync(path.join(directory, "dist", "version"), "utf8").trim().replace(/^v/, "") !== version) return ["Electron binary version differs from its npm package"];
    const result = spawnSync(path.join(directory, "dist", binary), ["-e", "process.stdout.write(process.versions.electron)"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", windowsHide: true, timeout: 20000
    });
    if (result.error || result.status !== 0 || result.stdout.trim() !== version) return [`Electron runtime cannot start: ${result.error?.message || result.stderr || result.status}`];
    return [];
  } catch (error) { return [`Electron runtime: ${error.message}`]; }
}

if (require.main === module) {
  const versionOnly = process.argv.includes("--electron-version");
  const failures = process.argv.includes("--electron") || versionOnly ? checkElectron() : checkPackages();
  failures.slice(0, 12).forEach(message => console.error(`[MISSING] ${message}`));
  if (failures.length > 12) console.error(`[MISSING] ${failures.length - 12} more dependency errors`);
  if (versionOnly && failures.length === 0) console.log(getElectronVersion());
  process.exitCode = failures.length ? 1 : 0;
}
module.exports = { checkPackages, checkElectron, getElectronVersion };
