const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { clearReadOnlyAttributes, pruneTrashDirectory, purgeTrashEntry, removeLibraryPathWithRetries } = require("../electron/services/libraryRemoval");

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "assethive-removal-"));
}

test("removeLibraryPathWithRetries deletes nested asset folders", async () => {
  const root = await makeTempDir();
  const assetDir = path.join(root, "3d_sample_abc1234");
  await fs.mkdir(path.join(assetDir, "Preview"), { recursive: true });
  await fs.mkdir(path.join(assetDir, "Tex"), { recursive: true });
  await fs.writeFile(path.join(assetDir, "Preview", "cover.png"), "png");
  await fs.writeFile(path.join(assetDir, "Tex", "T_Sample_D.png"), "png");
  const result = await removeLibraryPathWithRetries(assetDir, { trashRoot: root });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "deleted");
  assert.equal(await fs.stat(assetDir).catch(() => null), null);
  await fs.rm(root, { recursive: true, force: true });
});

test("removeLibraryPathWithRetries clears read-only files before deleting", async () => {
  const root = await makeTempDir();
  const assetDir = path.join(root, "3d_readonly_abc1234");
  await fs.mkdir(assetDir, { recursive: true });
  const readOnlyFile = path.join(assetDir, "T_Readonly_D.png");
  await fs.writeFile(readOnlyFile, "png");
  await fs.chmod(readOnlyFile, 0o444);
  const result = await removeLibraryPathWithRetries(assetDir, { trashRoot: root });
  assert.equal(result.ok, true);
  assert.equal(await fs.stat(assetDir).catch(() => null), null);
  await fs.rm(root, { recursive: true, force: true });
});

test("removeLibraryPathWithRetries stages locked folders into .assethive/Trash", async () => {
  const root = await makeTempDir();
  const assetDir = path.join(root, "3d_locked_abc1234");
  await fs.mkdir(assetDir, { recursive: true });
  await fs.writeFile(path.join(assetDir, "T_Locked_D.png"), "png");
  const busy = Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
  const stubFs = {
    lstat: fs.lstat.bind(fs),
    chmod: fs.chmod.bind(fs),
    readdir: fs.readdir.bind(fs),
    mkdir: fs.mkdir.bind(fs),
    rename: fs.rename.bind(fs),
    rm: async () => { throw busy; }
  };
  const result = await removeLibraryPathWithRetries(assetDir, { trashRoot: root, fs: stubFs });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "trashed");
  assert.equal(await fs.stat(assetDir).catch(() => null), null);
  assert.ok(result.staged.includes(path.join(".assethive", "Trash")));
  const purged = await purgeTrashEntry(result.staged);
  assert.equal(purged, true);
  assert.equal(await fs.stat(result.staged).catch(() => null), null);
  await fs.rm(root, { recursive: true, force: true });
});

test("clearReadOnlyAttributes walks nested trees", async () => {
  const root = await makeTempDir();
  const nested = path.join(root, "a", "b");
  await fs.mkdir(nested, { recursive: true });
  const file = path.join(nested, "T_Nested_D.png");
  await fs.writeFile(file, "png");
  await fs.chmod(file, 0o444);
  await clearReadOnlyAttributes(root);
  const stat = await fs.stat(file);
  assert.ok((stat.mode & 0o200) !== 0);
  await fs.rm(root, { recursive: true, force: true });
});

test("pruneTrashDirectory removes stale staged entries", async () => {
  const root = await makeTempDir();
  const trashDir = path.join(root, ".assethive", "Trash");
  const staleEntry = path.join(trashDir, "1700000000000_3d_old_abc1234");
  await fs.mkdir(staleEntry, { recursive: true });
  await fs.writeFile(path.join(staleEntry, "T_Old_D.png"), "png");
  const freshEntry = path.join(trashDir, "1700000000001_3d_new_abc1234");
  await fs.mkdir(freshEntry, { recursive: true });
  const purged = await pruneTrashDirectory(trashDir, { minAgeMs: 0 });
  assert.equal(purged, 2);
  assert.equal(await fs.stat(staleEntry).catch(() => null), null);
  assert.equal(await fs.stat(freshEntry).catch(() => null), null);
  await fs.rm(root, { recursive: true, force: true });
});
