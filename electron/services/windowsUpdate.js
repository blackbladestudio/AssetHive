const fs = require("node:fs/promises");
const path = require("node:path");
const { Buffer } = require("node:buffer");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { verifyCachedUpdatePackage } = require("./updatePackage");

// Windows-setup.exe is an MSI bootstrapper, not the standalone Inno installer.
function windowsPackageType(fileName) {
  const name = path.win32.basename(String(fileName || "")).toLowerCase();
  if (!name.startsWith("assethive-") || /(?:^|[-_])(arm64|ia32|x86)(?:[-_.]|$)/.test(name)) return "";
  if (name.endsWith(".msi") || name.endsWith("-windows-setup.exe")) return "msi";
  if (/-setup-(win64|x64)\.exe$/.test(name)) return "exe";
  if (name.endsWith(".zip")) return "portable";
  return "";
}

function pickWindowsUpdateAsset(assets, installType) {
  const candidates = (Array.isArray(assets) ? assets : []).filter(asset =>
    asset && windowsPackageType(asset.name) === installType && installType);
  const score = asset => {
    const name = String(asset.name).toLowerCase();
    // MSI installations use the MSI directly when both MSI and its wrapper exist.
    return (name.endsWith(".msi") ? 100 : 0) + (/win64|x64/.test(name) ? 10 : 0);
  };
  return candidates.sort((a, b) => score(b) - score(a))[0] || null;
}

async function findLocalUpdatePackage(updateDir, latestVersion, installType) {
  const entries = await fs.readdir(updateDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !installType || windowsPackageType(entry.name) !== installType) continue;
    const fullPath = path.join(updateDir, entry.name);
    if ((await verifyCachedUpdatePackage(fullPath, latestVersion)).ok) return fullPath;
  }
  return "";
}

async function detectWindowsInstallation(appRootPath) {
  try {
    const marker = await fs.readFile(path.join(appRootPath, "assethive-install.ini"), "utf8");
    const type = /^Type=(exe|msi)\s*$/im.exec(marker)?.[1].toLowerCase();
    const scope = /^Scope=(user|machine)\s*$/im.exec(marker)?.[1].toLowerCase();
    if (type && scope && (type !== "msi" || scope === "machine")) return { type, scope };
    throw new Error("安装类型记录无效，请使用原类型安装包修复安装");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // Older releases have no marker. Match this executable's directory to its
  // registered installer, rather than guessing from Program Files or other copies.
  const script = await fs.readFile(path.join(__dirname, "detectWindowsInstallation.ps1"), "utf8");
  try {
    const { stdout } = await promisify(execFile)("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")
    ], { windowsHide: true, timeout: 30000, env: { ...process.env, ASSETHIVE_UPDATE_APP_ROOT: appRootPath } });
    const result = JSON.parse(stdout.trim());
    if (["exe", "msi", "portable"].includes(result.type) && ["user", "machine"].includes(result.scope)) return result;
  } catch {
    throw new Error("无法确认当前安装类型，请使用原类型安装包修复安装");
  }
  throw new Error("无法确认当前安装类型，请使用原类型安装包修复安装");
}

module.exports = { windowsPackageType, pickWindowsUpdateAsset, findLocalUpdatePackage, detectWindowsInstallation };
