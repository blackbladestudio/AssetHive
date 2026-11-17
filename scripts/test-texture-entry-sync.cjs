const assert = require("node:assert/strict");
const test = require("node:test");
const {
  resolveSyncedTextureMaterialRole,
  buildSyncedTextureToken,
  splitSyncedTextureToken
} = require("../electron/services/textureEntrySync");

test("synced texture material role treats non-billboard megascans maps as atlas", () => {
  assert.equal(
    resolveSyncedTextureMaterialRole("", "Z:/Library/T_beech_fern_w3bqun3_Albedo.jpg", { megascansSource: true }),
    "atlas"
  );
  assert.equal(
    resolveSyncedTextureMaterialRole("", "Z:/Library/T_beech_fern_w3bqun3_Billboard_Albedo.jpg", { megascansSource: true }),
    "billboard"
  );
  assert.equal(
    resolveSyncedTextureMaterialRole("", "Z:/Library/T_props_zg_ding_Albedo.jpg", { megascansSource: false }),
    ""
  );
  assert.equal(
    resolveSyncedTextureMaterialRole("atlas", "Z:/Library/T_x_Billboard_Albedo.jpg", { megascansSource: true }),
    "atlas"
  );
});

test("synced texture tokens keep area index and material role apart", () => {
  assert.equal(buildSyncedTextureToken("Albedo", 1, ""), "Albedo");
  assert.equal(buildSyncedTextureToken("Albedo", 2, ""), "002_Albedo");
  assert.equal(buildSyncedTextureToken("Albedo", 1, "atlas"), "Albedo|atlas");
  assert.equal(buildSyncedTextureToken("Normal", 3, "billboard"), "003_Normal|billboard");
  assert.deepEqual(splitSyncedTextureToken("Albedo|billboard"), { token: "Albedo", materialRole: "billboard" });
  assert.deepEqual(splitSyncedTextureToken("001_Albedo"), { token: "001_Albedo", materialRole: "" });
  assert.deepEqual(splitSyncedTextureToken(""), { token: "", materialRole: "" });
});

test("3d plant atlas and billboard maps collect into separate slots", () => {
  const slots = new Map();
  const collect = (filePath) => {
    const role = resolveSyncedTextureMaterialRole("", filePath, { megascansSource: true });
    const token = buildSyncedTextureToken("Albedo", 1, role);
    if (!slots.has(token)) {
      slots.set(token, filePath);
    }
  };
  collect("Z:/Library/T_beech_fern_w3bqun3_Albedo.jpg");
  collect("Z:/Library/T_beech_fern_w3bqun3_Billboard_Albedo.jpg");
  assert.equal(slots.size, 2);
  assert.equal(slots.get("Albedo|atlas"), "Z:/Library/T_beech_fern_w3bqun3_Albedo.jpg");
  assert.equal(slots.get("Albedo|billboard"), "Z:/Library/T_beech_fern_w3bqun3_Billboard_Albedo.jpg");
});
