const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(root, "electron/main.js"), "utf8");
const wxs = fs.readFileSync(path.join(root, "installer/assethive.wxs"), "utf8");
const iss = fs.readFileSync(path.join(root, "installer/assethive.iss"), "utf8");
const repair = fs.readFileSync(path.join(root, "scripts/repair-app-shortcuts.ps1"), "utf8");

test("packaged and preview Electron instances use different Windows AUMIDs", () => {
  assert.ok(main.includes('"com.blackblade.assethive"'));
  assert.ok(main.includes('"com.blackblade.assethive.preview"'));
  assert.ok(main.includes("app.isPackaged"));
  assert.ok(!main.includes('"Biscuits.AssetHive"'), "preview must not reuse the removed shared AUMID");
});

test("installers write the installed AUMID and the AssetHive icon on shortcuts", () => {
  assert.ok(wxs.includes('<ShortcutProperty Key="System.AppUserModel.ID" Value="com.blackblade.assethive" />'));
  assert.ok(wxs.includes('Icon="app.ico"'));
  assert.ok(iss.includes('AppUserModelID: "com.blackblade.assethive"'));
  assert.ok(iss.includes('IconFilename: "{app}\\{#MyAppExeName}"'));
});

test("shortcut repair only removes dev Electron shortcuts that carry an AssetHive AUMID", () => {
  assert.ok(repair.includes("node_modules[\\\\/]electron[\\\\/]dist[\\\\/]electron\\.exe"));
  assert.ok(repair.includes("Biscuits\\.AssetHive"));
  assert.ok(repair.includes("ShortcutBackups"));
});
