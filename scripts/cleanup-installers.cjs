const fs = require("node:fs");
const path = require("node:path");
const { Buffer } = require("node:buffer");
const { createHash } = require("node:crypto");
const { parseArgs } = require("node:util");

function versionParts(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid stable build version: ${version}`);
  return version.split(".").map(Number);
}

function artifactVersion(name) {
  return /^AssetHive-(\d+\.\d+\.\d+)-(?:[\w.-]+)\.(?:exe|msi|zip)(?:\.sha256)?$/i.exec(name)?.[1];
}

function isOlder(version, current) {
  const parts = versionParts(version);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== current[i]) return parts[i] < current[i];
  }
  return false;
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sha256(file) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const handle = fs.openSync(file, "r");
  try {
    let bytes;
    while ((bytes = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    return hash.digest("hex");
  } finally { fs.closeSync(handle); }
}

// Called only after the installer compiler succeeds. Validate every required
// output before touching old artifacts; never walk or remove subdirectories.
function cleanupOldInstallers({ outputDir, version, requiredArtifacts = [] }) {
  const current = versionParts(version);
  const requested = path.resolve(outputDir);
  if (fs.lstatSync(requested).isSymbolicLink()) throw new Error("Output must not be a directory link");
  const root = fs.realpathSync(requested);
  if (root === path.parse(root).root) throw new Error("Output must not be a filesystem root");
  if (!requiredArtifacts.length) throw new Error("At least one successful installer output is required");
  const required = requiredArtifacts.map(file => {
    const absolute = path.resolve(file);
    const stat = fs.lstatSync(absolute);
    if (!inside(root, fs.realpathSync(absolute)) || !stat.isFile() || stat.size === 0
      || artifactVersion(path.basename(absolute)) !== version || /\.sha256$/i.test(absolute)) {
      throw new Error(`Invalid completed installer: ${absolute}`);
    }
    const checksum = `${absolute}.sha256`;
    if (fs.existsSync(checksum) && !fs.lstatSync(checksum).isFile()) throw new Error(`Invalid checksum path: ${checksum}`);
    return absolute;
  });
  for (const file of required) fs.writeFileSync(`${file}.sha256`, `${sha256(file)}  ${path.basename(file)}\n`);

  const removed = [];
  let removedBytes = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const oldVersion = artifactVersion(entry.name);
    if (!entry.isFile() || !oldVersion || !isOlder(oldVersion, current)) continue;
    const target = path.join(root, entry.name);
    const stat = fs.lstatSync(target);
    if (!stat.isFile()) continue;
    fs.unlinkSync(target);
    removed.push(entry.name);
    removedBytes += stat.size;
  }
  return { version, removed, removedBytes };
}

if (require.main === module) {
  try {
    const { values } = parseArgs({ options: {
      output: { type: "string" }, version: { type: "string" }, require: { type: "string", multiple: true }
    } });
    if (!values.output || !values.version) throw new Error("Usage: --output <directory> --version <version> --require <installer> [--require <installer>]");
    console.log(JSON.stringify(cleanupOldInstallers({ outputDir: values.output, version: values.version, requiredArtifacts: values.require })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { cleanupOldInstallers };
