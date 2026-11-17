// Explicit, single-asset maintenance command; does not rename any resource.
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { updateCharacterNames } = require("../electron/services/characterNames");
(async () => {
  const [root, folder, id, displayNameZh, displayNameEn] = process.argv.slice(2);
  if (!root || !folder || !id || !displayNameZh) throw Error("Expected root, asset folder, ID, Chinese name, optional English name");
  const metaPath = path.join(folder, "asset_info.json");
  const before = JSON.parse(await fs.readFile(metaPath, "utf8"));
  assert.equal(String(before.assetID || before.id), id);
  // This command fills an empty name only; never overwrites another editor's work.
  const result = await updateCharacterNames({ root, asset: { id, source: "custom", assetType: before.assetType, path: folder, metaPath },
    displayNameZh, displayNameEn, expectedName: "" });
  const after = JSON.parse(await fs.readFile(metaPath, "utf8"));
  assert.equal(after.name, before.name);
  assert.equal(after.createdAt, before.createdAt);
  assert.deepEqual(after.characterManifest?.files, before.characterManifest?.files);
  console.log(JSON.stringify({ ...result, metaPath }));
})().catch(error => { console.error(error); process.exitCode = 1; });
