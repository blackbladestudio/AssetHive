const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// 固定批次大小，让“最后一批才被读到”的断言不受默认值变化影响。
process.env.ASSETHIVE_SCAN_CHUNK_SIZE = "16";
process.env.ASSETHIVE_SCAN_CONCURRENCY = "2";

const { scanLibrary } = require("../electron/services/assetScanner");

// 1x1 透明 PNG：让 preview/贴图相关逻辑能正常读到真实图片。
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/v8/AwAJoAP+2GZ4WQAAAABJRU5ErkJggg==",
  "base64"
);

const SLOW_ASSET_NAME = "zz_slow_asset";

async function writeAssetDir(root, name) {
  const dir = path.join(root, name);
  await fsPromises.mkdir(dir, { recursive: true });
  await fsPromises.writeFile(path.join(dir, "T_Diffuse.png"), PNG_1X1);
  await fsPromises.writeFile(
    path.join(dir, "asset_info.json"),
    JSON.stringify(
      {
        assetID: `test-${name}`,
        name,
        assetType: "surface",
        topCategory: "environment",
        textureFiles: ["T_Diffuse.png"]
      },
      null,
      2
    ),
    "utf8"
  );
  return dir;
}

test("library scan streams records batch by batch instead of after the whole walk", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "assethive-scan-stream-"));
  const assetCount = 130;
  try {
    for (let index = 0; index < assetCount; index += 1) {
      await writeAssetDir(root, `asset_${String(index).padStart(3, "0")}`);
    }
    // 名称排在最后：它只会在最后一个扫描批次里被处理。
    await writeAssetDir(root, SLOW_ASSET_NAME);
    const slowMetaPath = path.join(root, SLOW_ASSET_NAME, "asset_info.json").toLowerCase();

    let slowEntryTouched = false;
    const originalStat = fsPromises.stat;
    fsPromises.stat = async function patchedStat(target, ...rest) {
      if (String(target || "").toLowerCase() === slowMetaPath) {
        slowEntryTouched = true;
        await new Promise((resolve) => globalThis.setTimeout(resolve, 200));
      }
      return originalStat.call(this, target, ...rest);
    };

    let recordsBeforeSlowEntry = 0;
    let totalRecords = 0;
    let firstRecordSawSlowEntry = null;
    const progressValues = [];
    try {
      const index = await scanLibrary(root, {
        onProgress: (payload) => {
          if (Number.isFinite(Number(payload?.progress))) {
            progressValues.push(Number(payload.progress));
          }
        },
        onRecord: () => {
          totalRecords += 1;
          if (firstRecordSawSlowEntry === null) {
            firstRecordSawSlowEntry = slowEntryTouched;
          }
          if (!slowEntryTouched) {
            recordsBeforeSlowEntry += 1;
          }
        }
      });

      assert.equal(index.length, assetCount + 1, "every asset must reach the index");
      assert.equal(totalRecords, assetCount + 1, "every asset must be streamed to the UI");
      assert.equal(
        firstRecordSawSlowEntry,
        false,
        "the first record must be reported before the last batch is read, otherwise a cold scan shows nothing for hours"
      );
      assert.ok(recordsBeforeSlowEntry > 0, "records must be emitted while the scan is still running");
      assert.ok(progressValues.length > 1, "scan progress must advance during the walk, not only at the end");
    } finally {
      fsPromises.stat = originalStat;
    }
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("library scan reports directory-walk progress before the first record", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "assethive-scan-collect-"));
  try {
    for (let index = 0; index < 8; index += 1) {
      await writeAssetDir(root, `asset_${index}`);
    }
    const phases = [];
    await scanLibrary(root, {
      onProgress: (payload) => {
        phases.push(String(payload?.phase || ""));
      }
    });
    assert.ok(phases.includes("start"), "scan start must be reported");
    assert.ok(phases.includes("scan"), "per-batch scan progress must be reported");
    assert.ok(phases.includes("done"), "scan completion must be reported");
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("first cards arrive before directory discovery finishes and before a slow peer in the same batch", async (t) => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "assethive-scan-walk-"));
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  for (let i = 0; i < 35; i += 1) await writeAssetDir(root, `asset_${String(i).padStart(3, "0")}`);
  const originalRead = fsPromises.readdir;
  const originalStat = fsPromises.stat;
  let lastFolderRead = false;
  let slowPeerDone = false;
  let firstState = null;
  fsPromises.readdir = async function (target, ...args) {
    if (String(target).endsWith("asset_034")) lastFolderRead = true;
    return originalRead.call(this, target, ...args);
  };
  fsPromises.stat = async function (target, ...args) {
    if (String(target) === path.join(root, "asset_000", "asset_info.json")) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 200));
      slowPeerDone = true;
    }
    return originalStat.call(this, target, ...args);
  };
  try {
    const index = await scanLibrary(root, {
      onRecord: () => { firstState ||= { lastFolderRead, slowPeerDone }; }
    });
    assert.equal(index.length, 35);
    assert.deepEqual(firstState, { lastFolderRead: false, slowPeerDone: false });
  } finally {
    fsPromises.readdir = originalRead;
    fsPromises.stat = originalStat;
  }
});
