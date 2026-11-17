const path = require("node:path");
const { spawnSync } = require("node:child_process");

const WEBP_ROUND_TRIP = String.raw`
const assert = require("node:assert/strict");
const path = require("node:path");
const applicationRoot = process.argv[2];
const batch = require(path.join(applicationRoot, "electron", "services", "megascansBatchImport.js"));
const worker = require(path.join(applicationRoot, "scripts", "lib", "megascans-import-worker.cjs"));
assert.equal(typeof batch.inspectImportSource, "function");
assert.equal(typeof batch.runImportJob, "function");
assert.equal(typeof worker.ImportWorker, "function");
assert.equal(typeof worker.serveImportWorker, "function");
console.log("Packaged native import modules OK");
const sharp = require(process.argv[1]);
sharp({
  create: {
    width: 2,
    height: 2,
    channels: 4,
    background: { r: 42, g: 128, b: 214, alpha: 0.75 }
  }
})
  .webp({ quality: 80 })
  .toBuffer()
  .then((webp) => sharp(webp).png().toBuffer())
  .then(async (png) => {
    if (!png || png.length === 0) {
      throw new Error("WebP round-trip produced no output");
    }
    console.log("Sharp WebP round-trip OK");
    const fs = require("node:fs/promises");
    const os = require("node:os");
    const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-package-native-"));
    const importer = new worker.ImportWorker({ cacheRoot, executable: process.execPath });
    try {
      await importer.start();
      console.log("Packaged native import worker boot OK");
    } finally {
      await importer.close();
      const resolvedCache = await fs.realpath(cacheRoot);
      const resolvedTemp = await fs.realpath(os.tmpdir());
      assert.equal(path.dirname(resolvedCache).toLowerCase(), resolvedTemp.toLowerCase());
      await fs.rm(resolvedCache, { recursive: true, force: true });
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
`;

function runSourceCheck() {
  let sharp;
  try {
    sharp = require("sharp");
  } catch (error) {
    console.error(`Sharp load failed: ${error?.message || error}`);
    process.exit(1);
  }

  sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 42, g: 128, b: 214, alpha: 0.75 }
    }
  })
    .webp({ quality: 80 })
    .toBuffer()
    .then((webp) => sharp(webp).png().toBuffer())
    .then((png) => {
      if (!png || png.length === 0) {
        throw new Error("WebP round-trip produced no output");
      }
      console.log("Source Sharp WebP round-trip OK");
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

function runPackagedCheck(packageRoot) {
  const appRoot = path.resolve(packageRoot);
  const executablePath = path.join(appRoot, "AssetHive.exe");
  const sharpPath = path.join(appRoot, "resources", "app.asar", "node_modules", "sharp");
  const result = spawnSync(executablePath, ["-e", WEBP_ROUND_TRIP, sharpPath, path.join(appRoot, "resources", "app.asar")], {
    cwd: appRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    windowsHide: true
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  process.exit(typeof result.status === "number" ? result.status : 1);
}

if (process.argv[2] === "--source") {
  runSourceCheck();
} else if (process.argv[2]) {
  runPackagedCheck(process.argv[2]);
} else {
  console.error("Usage: node scripts/verify_sharp_webp.cjs --source|<packaged-app-directory>");
  process.exit(2);
}
