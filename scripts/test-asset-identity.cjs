const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  deriveSourceIdentity,
  computeContentIdentity
} = require("../electron/services/assetIdentity");
const {
  applyAnimationIdentityMetadata,
  getAnimationIdentitySidecarPath,
  readAnimationIdentitySidecar,
  writeAnimationIdentitySidecar
} = require("../electron/services/animationIdentity");

async function writeFile(directory, name, content) {
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, content);
  return filePath;
}

test("source identity prefers stable Megascans metadata ids", () => {
  const identity = deriveSourceIdentity({
    assetName: "Rock Cliff",
    assetType: "surface",
    standardAssetTags: ["Megascans"],
    sourceIdentity: {
      sourceAssetId: "abc123",
      sourceVersion: "2",
      sourceRevision: "7"
    }
  });

  assert.equal(identity.sourceKind, "megascans");
  assert.equal(identity.sourceKey, "megascans:abc123");
  assert.equal(identity.sourceVersion, "2");
  assert.equal(identity.sourceRevision, "7");
});

test("source identity keeps source families separate and normalizes fallback names", () => {
  const pbrMax = deriveSourceIdentity({
    assetName: "Metal_Crate_4K",
    assetType: "3d",
    standardAssetTags: ["PBRMAX"]
  });
  const zion = deriveSourceIdentity({
    assetName: "Metal_Crate_4K",
    assetType: "3d",
    standardAssetTags: ["Props"]
  });

  assert.equal(pbrMax.sourceKind, "pbrmax");
  assert.equal(pbrMax.sourceKey, "pbrmax:metal-crate");
  assert.equal(zion.sourceKind, "zion");
  assert.equal(zion.sourceKey, "zion:3d:metal-crate");
});

test("content identity is deterministic and includes models, lods and textures", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-identity-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const model = await writeFile(directory, "SM_Rock.fbx", "model-v1");
  const lod1 = await writeFile(directory, "SM_Rock_LOD1.fbx", "lod-v1");
  const albedo = await writeFile(directory, "T_Rock_AL.png", "texture-v1");
  const normal = await writeFile(directory, "T_Rock_N.png", "normal-v1");

  const first = await computeContentIdentity({
    modelSlots: [{ suffix: "Mesh", source: model }],
    modelLodFiles: { Mesh: [{ filePath: lod1, lod: 1 }] },
    textureSlots: [
      { suffix: "Albedo", source: albedo },
      { suffix: "Normal", source: normal }
    ]
  });
  const second = await computeContentIdentity({
    modelSlots: { Mesh: model },
    modelLodFiles: new Map([["Mesh", [{ source: lod1, lod: 1 }]]]),
    textureSlots: [
      { suffix: "Normal", source: normal },
      { suffix: "Albedo", source: albedo }
    ]
  });

  assert.equal(first.contentFingerprint, second.contentFingerprint);
  assert.equal(first.textureFingerprint, second.textureFingerprint);
  assert.deepEqual(Object.keys(first.modelFingerprints), ["Mesh"]);

  await fs.writeFile(albedo, "texture-v2");
  const changed = await computeContentIdentity({
    modelSlots: [{ suffix: "Mesh", source: model }],
    modelLodFiles: { Mesh: [{ filePath: lod1, lod: 1 }] },
    textureSlots: [
      { suffix: "Albedo", source: albedo },
      { suffix: "Normal", source: normal }
    ]
  });

  assert.notEqual(first.textureFingerprint, changed.textureFingerprint);
  assert.notEqual(first.contentFingerprint, changed.contentFingerprint);
});

test("animation identity sidecar persists source identity, revision and import history", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-animation-identity-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const model = await writeFile(directory, "AS_Run.fbx", "animation-model-v1");
  const contentIdentity = await computeContentIdentity({
    modelSlots: [{ suffix: "Mesh", source: model }]
  });
  const sourceIdentity = deriveSourceIdentity({
    assetName: "AS_Run",
    assetType: "animation",
    sourceIdentity: { sourceKind: "zion" }
  });
  const meta = {
    identity: { ...sourceIdentity, ...contentIdentity },
    revision: 3,
    importHistory: [{ at: "2026-01-01T00:00:00.000Z", action: "update" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z"
  };

  const sidecarPath = await writeAnimationIdentitySidecar(model, meta);
  assert.equal(sidecarPath, getAnimationIdentitySidecarPath(model));
  assert.match(path.basename(sidecarPath), /\.assethive\.identity\.json$/);

  const restored = await readAnimationIdentitySidecar(model);
  assert.deepEqual(restored.identity, JSON.parse(JSON.stringify(meta.identity)));
  assert.equal(restored.revision, 3);
  assert.deepEqual(restored.importHistory, meta.importHistory);

  const hydrated = applyAnimationIdentityMetadata({ name: "AS_Run" }, restored);
  assert.deepEqual(hydrated.identity, JSON.parse(JSON.stringify(meta.identity)));
  assert.equal(hydrated.revision, 3);
  assert.deepEqual(hydrated.importHistory, meta.importHistory);
});
