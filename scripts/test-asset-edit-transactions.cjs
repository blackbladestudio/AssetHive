const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { transactionalFs, withFileTransaction, recoverFileTransactions } = require("../electron/services/assetFileTransaction");
const { loadApplicationServices } = require("./application-service-harness.cjs");
const { createImportQueueStore } = require("../electron/services/importQueue");

async function fixture(t, assetType = "surface") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-edit-transaction-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const services = await loadApplicationServices(root);
  const source = path.join(root, "Original_Diffuse.png");
  await sharp({ create: { width: 16, height: 16, channels: 3, background: "#886644" } }).png().toFile(source);
  const result = await services.importCustomAsset({ assetName: "Original", assetType, category: "Other", textureEntries: [{ filePath: source, textureType: "Diffuse", areaId: 1 }], skipDuplicateCheck: true }, null);
  assert.equal(result.ok, true);
  const asset = services.getIndex().find(item => item.id === result.assetId);
  return { root, services, asset, texture: asset.textureFiles[0], metadata: await fs.readFile(asset.metaPath, "utf8") };
}

test("the real importer recovers from a transient metadata fsync failure", async t => {
  const { root, services } = await fixture(t);
  const write = fs.writeFile;
  let attempts = 0;
  fs.writeFile = async (file, data, options) => {
    if (/^asset_info\.json\..*\.tmp$/.test(path.basename(file))) {
      attempts++;
      assert.equal(options.flush, true);
      if (attempts === 1) {
        await write(file, data, { ...options, flush: false });
        throw Object.assign(new Error("UNKNOWN: unknown error, fsync"), { code: "UNKNOWN", syscall: "fsync" });
      }
    }
    return write(file, data, options);
  };
  let result;
  try {
    result = await services.importCustomAsset({ assetName: "FlushRetry", assetType: "surface", category: "Other",
      textureEntries: [{ filePath: path.join(root, "Original_Diffuse.png"), textureType: "Diffuse", areaId: 1 }], skipDuplicateCheck: true }, null);
  } finally { fs.writeFile = write; }
  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  const raw = await fs.readFile(result.metaPath, "utf8");
  const meta = JSON.parse(raw);
  assert.equal(meta.name, "FlushRetry");
  assert.equal(meta.json.contentLength, globalThis.Buffer.byteLength(raw));
  assert.equal(services.getIndex().filter(asset => asset.id === result.assetId).length, 1);
  assert.equal((await fs.readdir(path.dirname(result.metaPath))).some(name => name.endsWith(".tmp")), false);
});

test("missing preview validation preserves existing files and the prior metadata/index", async t => {
  const { root, services, asset, texture, metadata } = await fixture(t);
  const bytes = await fs.readFile(texture);
  const result = await services.updateCustomAsset({ assetId: asset.id, removeTextureSlots: ["Diffuse"], previewImagePath: path.join(root, "missing.png") }, null);
  assert.equal(result.ok, false);
  assert.deepEqual(await fs.readFile(texture), bytes);
  assert.equal(await fs.readFile(asset.metaPath, "utf8"), metadata);
  assert.equal(services.getIndex()[0], asset);
});

test("failed save restores overwritten texture bytes and reverses a category-folder move", async t => {
  const { root, services, asset, texture, metadata } = await fixture(t);
  const bytes = await fs.readFile(texture);
  const replacement = path.join(root, "Replacement_8K_Diffuse.png");
  const corruptPreview = path.join(root, "corrupt.png");
  await fs.writeFile(corruptPreview, "invalid image data");
  await sharp({ create: { width: 16, height: 16, channels: 3, background: "#ff0000" } }).png().toFile(replacement);
  const result = await services.updateCustomAsset({ assetId: asset.id, assetType: "decal", textureEntries: [{ filePath: replacement, textureType: "Diffuse", areaId: 1 }], previewImagePath: corruptPreview }, null);
  assert.equal(result.ok, false);
  assert.deepEqual(await fs.readFile(texture), bytes);
  assert.equal(await fs.readFile(asset.metaPath, "utf8"), metadata);
  assert.equal(services.getIndex()[0].assetType, "surface");
});

test("metadata publication failure rolls back every earlier file mutation", async t => {
  const { root, services, asset, texture, metadata } = await fixture(t);
  const originalRename = fs.rename;
  fs.rename = async (source, target) => {
    if (path.resolve(target) === path.resolve(asset.metaPath)) throw Object.assign(new Error("simulated metadata failure"), { code: "EIO" });
    return originalRename(source, target);
  };
  try {
    await assert.rejects(services.updateCustomAsset({ assetId: asset.id, removeTextureSlots: ["Diffuse"] }, null), /simulated metadata failure/);
  } finally { fs.rename = originalRename; }
  assert.ok(await fs.stat(texture));
  assert.equal(await fs.readFile(asset.metaPath, "utf8"), metadata);
  assert.equal(services.getIndex()[0], asset);
  assert.ok(await fs.stat(root));
});

test("successful edit commits the canonical metadata and removes transaction backups", async t => {
  const { services, asset, texture } = await fixture(t);
  const result = await services.updateCustomAsset({ assetId: asset.id, removeTextureSlots: ["Diffuse"] }, null);
  assert.equal(result.ok, true);
  assert.equal(await fs.stat(texture).catch(() => null), null);
  const meta = JSON.parse(await fs.readFile(asset.metaPath, "utf8"));
  assert.equal(meta.textureFiles.length, 0);
});

test("editing cleans empty slots while retaining broken models and textures", async t => {
  const { root, services, asset } = await fixture(t, "3d");
  const meta = JSON.parse(await fs.readFile(asset.metaPath, "utf8"));
  const missingModel = path.join(asset.path, "Models", "Missing.fbx");
  const missingTexture = path.join(root, "Offline", "Missing_Normal.png");
  meta.modelSlots = { Mesh: missingModel, Mesh02: " " };
  meta.modelFiles = [missingModel, ""];
  meta.components.push({ type: "model", uri: "Models/Missing.fbx" }, { type: "texture", slot: "Normal", uri: missingTexture },
    { type: "model", uri: " " }, { type: "texture", slot: "Roughness", uri: "" });
  meta.textureSlots.Normal = missingTexture;
  meta.textureSlots.Roughness = " ";
  meta.textureEntries.push({ textureType: "Normal", uri: missingTexture, areaIndex: 1, width: 4096, height: 4096 },
    { textureType: "Roughness", uri: "" });
  await fs.writeFile(asset.metaPath, JSON.stringify(meta));
  let result = await services.updateCustomAsset({ assetId: asset.id, tags: ["edited"] }, null);
  assert.equal(result.ok, true, result.message);
  let saved = JSON.parse(await fs.readFile(asset.metaPath, "utf8"));
  assert.deepEqual(Object.keys(saved.modelSlots), ["Mesh"]);
  assert.equal(path.normalize(saved.modelSlots.Mesh), path.normalize(missingModel));
  assert.equal(path.normalize(saved.textureSlots.Normal), path.normalize(missingTexture));
  assert.equal("Roughness" in saved.textureSlots, false);
  assert.equal(saved.textureEntries.length, 2);
  assert.equal(saved.textureEntries.find(entry => entry.textureType === "Normal").width, 4096);
  // Full texture lists include unchanged broken paths when a different row is edited.
  result = await services.updateCustomAsset({ assetId: asset.id, textureEntries: saved.textureEntries.map(entry => ({
    textureType: entry.textureType, areaId: entry.areaIndex,
    filePath: path.isAbsolute(entry.uri) ? entry.uri : path.join(asset.path, entry.uri)
  })) }, null);
  assert.equal(result.ok, true, result.message);
  saved = JSON.parse(await fs.readFile(asset.metaPath, "utf8"));
  assert.equal(path.normalize(saved.textureEntries.find(entry => entry.textureType === "Normal").uri), path.normalize(missingTexture));
  const rejected = await services.updateCustomAsset({ assetId: asset.id, textureEntries: [{
    textureType: "Normal", filePath: path.join(root, "new-missing.png")
  }] }, null);
  assert.equal(rejected.ok, false, "new nonexistent files still require a valid source");
  const moved = await services.updateCustomAsset({ assetId: asset.id, assetType: "3dplant",
    modelSlots: saved.modelSlots, textureEntries: saved.textureEntries.map(entry => ({
      textureType: entry.textureType, areaId: entry.areaIndex,
      filePath: path.isAbsolute(entry.uri) ? entry.uri : path.join(asset.path, entry.uri)
    })) }, null);
  assert.equal(moved.ok, true, moved.message);
  const movedMeta = JSON.parse(await fs.readFile(moved.asset.metaPath, "utf8"));
  assert.equal(path.normalize(movedMeta.modelSlots.Mesh), path.join(moved.asset.path, "Models", "Missing.fbx"));
  assert.equal(path.normalize(movedMeta.textureSlots.Normal), path.normalize(missingTexture));
  assert.ok((await fs.stat(movedMeta.textureSlots.Diffuse)).isFile(), "existing valid files follow a type-folder move");
});

test("importing and editing one asset leave another asset's metadata bytes and timestamp unchanged", async t => {
  const { root, services, asset } = await fixture(t);
  const before = await fs.readFile(asset.metaPath);
  const beforeStat = await fs.stat(asset.metaPath);
  const imported = await services.importCustomAsset({ assetName: "Second", assetType: "surface", category: "Other",
    textureEntries: [{ filePath: path.join(root, "Original_Diffuse.png"), textureType: "Diffuse", areaId: 1 }], skipDuplicateCheck: true }, null);
  assert.equal(imported.ok, true);
  assert.equal((await services.updateCustomAsset({ assetId: imported.assetId, assetName: "Edited second" }, null)).ok, true);
  assert.deepEqual(await fs.readFile(asset.metaPath), before);
  assert.equal((await fs.stat(asset.metaPath)).mtimeMs, beforeStat.mtimeMs);
});

test("selected-asset recovery leaves other interrupted edits untouched until explicit library maintenance", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-scoped-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const targets = [];
  for (const id of ["selected", "other", "legacy"]) {
    const target = path.join(root, id, "asset_info.json");
    const directory = path.join(root, ".assethive", "EditTransactions", "owner", id);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.mkdir(directory, { recursive: true });
    const backup = path.join(directory, "backup-0");
    await fs.writeFile(target, "partial");
    await fs.writeFile(backup, "original");
    await fs.writeFile(path.join(directory, "journal.json"), JSON.stringify({ actions: [{ kind: "restore", target, backup }] }));
    if (id !== "legacy") await fs.writeFile(path.join(directory, "scope.json"), JSON.stringify({ key: `${root}|${id}` }));
    targets.push(target);
  }
  await recoverFileTransactions(root, "owner", [], { key: `${root}|selected`, paths: [targets[0]] });
  assert.deepEqual(await Promise.all(targets.map(file => fs.readFile(file, "utf8"))), ["original", "partial", "partial"]);
  await recoverFileTransactions(root, "owner", [], { key: `${root}|legacy`, paths: [targets[2]] });
  assert.equal(await fs.readFile(targets[1], "utf8"), "partial");
  assert.equal(await fs.readFile(targets[2], "utf8"), "original");
  await recoverFileTransactions(root, "owner");
  assert.equal(await fs.readFile(targets[1], "utf8"), "original");
});

test("the real importer publishes queue identity that can recover a missing completion receipt", async t => {
  const { root, services } = await fixture(t);
  const result = await services.importCustomAsset({ queueId: "published-real-asset", assetName: "Recovered", assetType: "surface", category: "Other", textureEntries: [{ filePath: path.join(root, "Original_Diffuse.png"), textureType: "Diffuse", areaId: 1 }], skipDuplicateCheck: true }, null);
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(await fs.readFile(result.metaPath, "utf8")).importQueueId, "published-real-asset");
  const restarted = createImportQueueStore(path.join(root, "ImportQueue"));
  const recovered = await restarted.run(path.join(root, "Library"), "published-real-asset", () => { throw new Error("must not import twice"); });
  assert.equal(recovered.assetId, result.assetId);
});

test("transaction journal recovers interrupted edits without touching another owner", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-edit-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const target = path.join(root, "texture.png");
  const journalDir = path.join(root, ".assethive", "EditTransactions", "owner", "interrupted");
  await fs.mkdir(journalDir, { recursive: true });
  const backup = path.join(journalDir, "backup-0");
  await fs.writeFile(backup, "original");
  await fs.writeFile(target, "partial");
  await fs.writeFile(path.join(journalDir, "journal.json"), JSON.stringify({ actions: [{ kind: "restore", target, backup }] }));
  await recoverFileTransactions(root, "another-owner");
  assert.equal(await fs.readFile(target, "utf8"), "partial");
  await recoverFileTransactions(root, "owner");
  assert.equal(await fs.readFile(target, "utf8"), "original");
});

test("edits to one asset serialize while unrelated filesystem work stays outside the transaction", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-edit-lock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const target = path.join(root, "value");
  const calls = [];
  const options = { root, owner: "owner", key: target };
  await Promise.all([withFileTransaction(options, async () => {
    calls.push(1); await transactionalFs.writeFile(target, "first"); return { ok: false };
  }), withFileTransaction(options, async () => {
    calls.push(2); assert.equal(await fs.stat(target).catch(() => null), null);
    await transactionalFs.writeFile(target, "second"); return { ok: true };
  })]);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(await fs.readFile(target, "utf8"), "second");
});

test("recovery resumes an interrupted rollback without recreating the moved asset folder", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-rollback-resume-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const original = path.join(root, "Original");
  const moved = path.join(root, "Moved");
  await fs.mkdir(original);
  await fs.writeFile(path.join(original, "texture"), "original bytes");
  const rawRename = fs.rename;
  let failRollback = false;
  fs.rename = async (source, target) => {
    if (failRollback && path.basename(target) === "journal.json") {
      failRollback = false;
      throw new Error("interrupted rollback checkpoint");
    }
    return rawRename(source, target);
  };
  try {
    await assert.rejects(withFileTransaction({ root, owner: "owner", key: "asset" }, async () => {
      await transactionalFs.rename(original, moved);
      await transactionalFs.writeFile(path.join(moved, "texture"), "replacement");
      failRollback = true;
      return { ok: false };
    }), /interrupted rollback checkpoint/);
  } finally { fs.rename = rawRename; }
  await recoverFileTransactions(root, "owner");
  assert.equal(await fs.readFile(path.join(original, "texture"), "utf8"), "original bytes");
  assert.equal(await fs.stat(moved).catch(() => null), null);
});
