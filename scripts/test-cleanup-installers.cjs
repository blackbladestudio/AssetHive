const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { test } = require("node:test");
const { cleanupOldInstallers } = require("./cleanup-installers.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-installer-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const write = (name, content = "MZfixture") => { const file = path.join(root, name); fs.writeFileSync(file, content); return file; };
  return { root, write, clean: (version, requiredArtifacts) => cleanupOldInstallers({ outputDir: root, version, requiredArtifacts }) };
}

test("successful packaging removes only older versioned installers and checksums, preserving all current formats", t => {
  const f = fixture(t);
  const current = f.write("AssetHive-2.2.10-setup-win64.exe");
  for (const name of ["AssetHive-2.2.9-setup-win64.exe", "AssetHive-2.2.9-setup-win64.exe.sha256", "AssetHive-2.1.0-Windows.msi", "AssetHive-2.1.0-portable-win64.zip"]) f.write(name);
  for (const name of ["AssetHive-2.2.10-win64.msi", "AssetHive-2.2.10-Windows-setup.exe", "AssetHive-2.3.0-setup-win64.exe", "notes.txt", "OtherApp-1.0.0-setup.exe", "AssetHive-2.1.0-setup-win64.exe.tmp"]) f.write(name);
  const nested = path.join(f.root, "test-artifacts"); fs.mkdirSync(nested); fs.writeFileSync(path.join(nested, "AssetHive-1.0.0-setup-win64.exe"), "preserve");
  const result = f.clean("2.2.10", [current]);
  assert.equal(result.removed.length, 4);
  assert.equal(fs.existsSync(path.join(f.root, "AssetHive-2.2.10-win64.msi")), true);
  assert.equal(fs.existsSync(path.join(f.root, "AssetHive-2.3.0-setup-win64.exe")), true);
  assert.equal(fs.readFileSync(path.join(nested, "AssetHive-1.0.0-setup-win64.exe"), "utf8"), "preserve");
  const checksum = fs.readFileSync(`${current}.sha256`, "utf8").split(" ")[0];
  assert.equal(checksum, createHash("sha256").update(fs.readFileSync(current)).digest("hex"));
});

test("missing, empty, incomplete or wrongly versioned outputs never authorize cleanup", t => {
  const f = fixture(t);
  const old = f.write("AssetHive-2.0.0-setup-win64.exe");
  const current = f.write("AssetHive-2.2.10-win64.msi");
  const empty = f.write("AssetHive-2.2.10-setup-win64.exe", "");
  for (const required of [[], [old], [empty], [current, path.join(f.root, "AssetHive-2.2.10-Windows-setup.exe")]]) {
    assert.throws(() => f.clean("2.2.10", required));
    assert.equal(fs.existsSync(old), true);
    assert.equal(fs.existsSync(`${current}.sha256`), false, "all required outputs must validate before writing or deleting anything");
  }
  assert.throws(() => f.clean("invalid", [current]));
});

test("an installer outside Output cannot authorize deletion", t => {
  const f = fixture(t), outside = fixture(t);
  const old = f.write("AssetHive-1.0.0-setup-win64.exe");
  assert.throws(() => f.clean("2.0.0", [outside.write("AssetHive-2.0.0-setup-win64.exe")]));
  assert.equal(fs.existsSync(old), true);
});

test("EXE and MSI packaging call cleanup only after every installer compiler succeeds", () => {
  for (const file of ["package_assethive_exe.bat", "package_assethive_msi.bat"]) {
    const code = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const compile = code.lastIndexOf('"%ISCC%" /Qp');
    const clean = code.indexOf("call node scripts\\cleanup-installers.cjs");
    assert.ok(compile >= 0 && clean > compile);
    assert.match(code.slice(compile, clean), /if errorlevel 1 \(/);
    assert.equal((code.slice(clean).split(/\r?\n/)[0].match(/--require /g) || []).length, file.includes("msi") ? 2 : 1);
  }
});
