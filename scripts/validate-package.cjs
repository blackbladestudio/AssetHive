const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));

const requiredFiles = [
  "dist/index.html",
  "electron/main.js",
  "electron/preload.js",
  "LOGO/Icon_V2_256.png",
  "AssetHiveUpdater.exe",
  "AssetHive-UE-Plugin/AssetHive/AssetHive.uplugin",
  "AssetHive-UE-Plugin/AssetHive/Binaries/Win64/UnrealEditor-AssetHive.dll",
  "AssetHive-UE-Plugin/AssetHive/Binaries/Win64/UnrealEditor.modules"
];

const failures = [];

if (!/^\d+\.\d+\.\d+$/.test(String(packageJson.version || ""))) {
  failures.push(`package.json version must use X.Y.Z for MSI upgrades: ${packageJson.version}`);
}

for (const relativePath of requiredFiles) {
  const absolutePath = path.join(root, relativePath);
  let stat = null;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    failures.push(`missing required package input: ${relativePath}`);
    continue;
  }
  if (!stat.isFile() || stat.size === 0) {
    failures.push(`invalid required package input: ${relativePath}`);
    continue;
  }
  const prefix = fs.readFileSync(absolutePath, { encoding: "utf8", flag: "r" }).slice(0, 64);
  if (prefix.startsWith("version https://git-lfs.github.com/spec/v1")) {
    failures.push(`Git LFS pointer is not materialized: ${relativePath}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.map((failure) => `[package] ${failure}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`[package] validated AssetHive ${packageJson.version} inputs\n`);
