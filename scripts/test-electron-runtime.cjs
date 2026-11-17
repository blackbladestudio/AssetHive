const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getElectronVersion, checkElectron } = require("./check_dependencies.cjs");

function fixture(t, version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/electron": { version } } }));
  return root;
}

test("packaging resolves the exact Electron version from the lockfile", t => {
  const root = fixture(t, "44.4.5");
  assert.equal(getElectronVersion(root), "44.4.5");
});

test("a stale npm runtime is rejected before it can be packaged", t => {
  const root = fixture(t, "44.4.5");
  const directory = path.join(root, "node_modules/electron");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ version: "40.8.0" }));
  assert.deepEqual(checkElectron(root), ["Electron npm package: expected 44.4.5 from package-lock.json, found 40.8.0"]);
});

test("a stale binary is rejected even when its npm manifest is current", t => {
  const root = fixture(t, "44.4.5");
  const directory = path.join(root, "node_modules/electron");
  fs.mkdirSync(path.join(directory, "dist"), { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ version: "44.4.5" }));
  fs.writeFileSync(path.join(directory, "path.txt"), "electron.exe");
  fs.writeFileSync(path.join(directory, "dist/version"), "40.8.0");
  assert.deepEqual(checkElectron(root), ["Electron binary version differs from its npm package"]);
});

test("invalid lockfile versions fail instead of silently using a fallback", t => {
  for (const version of [undefined, "^44.4.5", "latest"]) {
    assert.throws(() => getElectronVersion(fixture(t, version)), /must lock an exact stable Electron version/);
  }
});

test("EXE and MSI packaging both use the validated runtime version", () => {
  for (const name of ["package_assethive_exe.bat", "package_assethive_msi.bat"]) {
    const script = fs.readFileSync(path.join(__dirname, "..", name), "utf8");
    assert.match(script, /check_dependencies\.cjs --electron-version/);
    assert.match(script, /if not defined ELECTRON_VERSION \([\s\S]*?exit \/b 1\s*\)/);
    assert.match(script, /--electron-version=%ELECTRON_VERSION%/);
    assert.match(script, /--download\.cacheRoot=/);
    assert.doesNotMatch(script, /--electron-version=\d/);
  }
});
