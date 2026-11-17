const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { groupDroppedAssets } = require("../electron/services/dropAssetGroups");
const file = (...parts) => path.resolve("test-input", ...parts);

test("single-asset archives use their original names in natural numeric order", () => {
  const numbers = [1, 10, 11, 2, 3, 4, 5, 6, 7, 8, 9];
  const sources = numbers.map(n => ({ root: file(`temp_${n}`), name: `Zhiwu_${n}` }));
  const files = sources.flatMap(source => [path.join(source.root, "6012_Plabts.fbx"), path.join(source.root, "8bit_T_6012_Plabts_Albedo_8K.png")]);
  const groups = groupDroppedAssets(files, [], sources);
  assert.deepEqual(groups.map(g => g.preferredName), Array.from({ length: 11 }, (_, i) => `Zhiwu_${i + 1}`));
});

test("archive naming preserves metadata and does not rename separate assets to the same pack name", () => {
  const root = file("archive");
  const source = { root, name: "Collection" };
  const files = [path.join(root, "Chair.fbx"), path.join(root, "Table.fbx")];
  assert.deepEqual(groupDroppedAssets(files, [], [source]).map(g => g.preferredName), ["Chair", "Table"]);
  const metadata = { name: "Official title" };
  const groups = groupDroppedAssets(files, [{ root, preferredName: metadata.name, metadata }], [source]);
  assert.equal(groups[0].preferredName, "Official title");
});

test("plant ZIP naming keeps bit-depth and T-prefixed maps with their model", () => {
  for (const name of ["6011_Plants", "草本植物", "白脉椒草..", "草9-0"]) {
    const files = [file(name + ".fbx"), file(name + ".jpg"), file("8bit_T_" + name + "_Albedo_8K.png"), file("8bit_T_" + name + "_Scatter_8K.png"), file("T_" + name + "_Displacement_8K.exr")];
    const groups = groupDroppedAssets(files);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].files, files);
  }
});

test("PBRMAX folders keep model, LODs, ZBrush source, preview and 8K maps as one asset", () => {
  const root = file("Dimian_1");
  const names = [
    "00369_MD_Stone.fbx",
    "00369_MD_Stone_LOD0.fbx",
    "00369_MD_Stone_LOD5.fbx",
    "00369_MD_Stone.ZTL",
    "00369_MD_Stone.jpg",
    "00369_MD_Stone_thumb.jpg",
    "8bit_T_00369_MD_Stone_Albedo_8K.png",
    "8bit_T_00369_MD_Stone_AO_8K.png",
    "8bit_T_00369_MD_Stone_Cavity_8K.png",
    "8bit_T_00369_MD_Stone_Displacement_8K.exr",
    "8bit_T_00369_MD_Stone_Displacement_8K.png",
    "8bit_T_00369_MD_Stone_Gloss_8K.png",
    "8bit_T_00369_MD_Stone_Metallic_8K.png",
    "8bit_T_00369_MD_Stone_Normal_8K.png",
    "8bit_T_00369_MD_Stone_Normal_8K_LOD0.png",
    "8bit_T_00369_MD_Stone_Roughness_8K.png",
    "8bit_T_00369_MD_Stone_Specular_8K.png"
  ];
  const files = names.map(name => path.join(root, name));
  const groups = groupDroppedAssets(files);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].files, files);
  assert.equal(groups[0].preferredName, "00369 MD Stone");
  assert.equal(groups[0].folderName, "Dimian_1");
});

test("PBRMAX fuzz map stays with its asset instead of becoming a separate surface asset", () => {
  const root = file("Dimian_10");
  const names = [
    "Ground.fbx", "Ground.ZTL", "Ground.jpg",
    "8bit_T_Ground_Albedo_8K.png",
    "8bit_T_Ground_Fuzz_8K.png",
    "8bit_T_Ground_Metallic_8K.png",
    "8bit_T_Ground_Normal_8K.png",
    "8bit_T_Ground_Roughness_8K.png"
  ];
  const files = names.map(name => path.join(root, name));
  const groups = groupDroppedAssets(files);
  assert.equal(groups.length, 1, "the fuzz map must not split off into its own asset");
  assert.deepEqual(groups[0].files, files);
  assert.equal(groups[0].preferredName, "Ground");
});

test("Zion Tile/Surface folders keep all texture maps as one asset", () => {
  for (const folderName of ["Tile_ZG_Scorched", "Surface_ZG_Scorched"]) {
    const root = file(folderName);
    const names = [
      "T_Env_Tile_Landscape_ZG_Scorched_BCR.tga",
      "T_Env_Tile_Landscape_ZG_Scorched_Dis.png",
      "T_Env_Tile_Landscape_ZG_Scorched_Metalness.png",
      "T_Env_Tile_Landscape_ZG_Scorched_N.tga"
    ];
    const files = names.map(name => path.join(root, name));
    const groups = groupDroppedAssets(files);
    assert.equal(groups.length, 1, `${folderName} must stay as one Surface draft`);
    assert.deepEqual(groups[0].files, files);
    assert.equal(groups[0].folderName, folderName);
    assert.equal(groups[0].preferredName, "ZG_Scorched");
  }
});

test("separates sibling asset folders and joins their model and texture subfolders", () => {
  const files = [file("Chair", "Models", "Chair.fbx"), file("Chair", "Textures", "Chair_Albedo.png"), file("Table", "Models", "Table.fbx"), file("Table", "Textures", "Table_Normal.png")];
  const groups = groupDroppedAssets(files);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(g => g.files.length), [2, 2]);
  assert.deepEqual(groups.map(g => g.folderName), ["Chair", "Table"]);
  assert.ok(groups[0].files.every(p => p.includes("Chair")));
});

test("separates texture sets in one folder, retaining UDIMs and resolutions", () => {
  const groups = groupDroppedAssets([file("Stone_Albedo_4K_1001.png"), file("Stone_Normal_4K_1002.png"), file("Wood_Albedo_2K.png"), file("Wood_Roughness_2K.png")]);
  assert.deepEqual(groups.map(g => [g.preferredName, g.files.length]), [["Stone", 2], ["Wood", 2]]);
});

test("retains variants and generic maps of one model as one asset", () => {
  const files = [file("Rock_Var1.fbx"), file("Rock_Var_2.obj"), file("Rock_001_Normal.png"), file("Albedo.png"), file("preview.jpg")];
  assert.deepEqual(groupDroppedAssets(files)[0].files, files);
  assert.equal(groupDroppedAssets(files).length, 1);
});

test("retains numbered model variants and st9 files as one asset", () => {
  const files = [
    file("Props_Rock", "SM_Env_Props_Rock_01.fbx"),
    file("Props_Rock", "SM_Env_Props_Rock_02.fbx"),
    file("Props_Rock", "SM_Env_Props_Rock_03.st9"),
    file("Props_Rock", "T_Env_Props_Rock_01_4K_D.png")
  ];
  const groups = groupDroppedAssets(files);
  assert.equal(groups.length, 1, "same base stem and numbered variants must stay together");
  assert.deepEqual(groups[0].files, files);
});

test("retains alphabetic model variants from megascans and pbr names as one asset", () => {
  const files = [
    file("Rock", "SM_Rock_A.fbx"),
    file("Rock", "SM_Rock_B.fbx"),
    file("Rock", "SM_Rock_B2.fbx"),
    file("Rock", "SM_Rock_VarD.fbx"),
    file("Rock", "SM_Rock_Var11.fbx"),
    file("Rock", "T_Rock_A_Normal.png")
  ];
  const groups = groupDroppedAssets(files);
  assert.equal(groups.length, 1, "alphabetic variants of one base stem must stay together");
  assert.deepEqual(groups[0].files, files);
});

test("each metadata root keeps its own name, files, tags and component boundaries", () => {
  const first = { root: file("PackA"), preferredName: "Asset A", metadata: { name: "Asset A", tags: ["rock"] } };
  const second = { root: file("PackB"), preferredName: "Asset B", metadata: { name: "Asset B", tags: ["wood"] } };
  const groups = groupDroppedAssets([file("PackA", "part1.fbx"), file("PackA", "part2.fbx"), file("PackB", "part1.fbx")], [first, second]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].files.length, 2);
  assert.equal(groups[0].metadata, first.metadata);
  assert.equal(groups[1].metadata, second.metadata);
});

test("separates HDR environments and does not duplicate ambiguous unnamed textures", () => {
  const groups = groupDroppedAssets([file("Sunset.hdr"), file("Studio.hdr"), file("preview.jpg")]);
  assert.equal(groups.length, 3);
  assert.equal(groups.flatMap(g => g.files).length, 3);
});

test("nested metadata uses the closest root and similar prefixes do not overlap", () => {
  const groups = groupDroppedAssets([file("A", "mesh.fbx"), file("A", "B", "mesh.fbx"), file("AB", "other.fbx")], [
    { root: file("A"), metadata: { name: "A" } },
    { root: file("A", "B"), metadata: { name: "B" } }
  ]);
  assert.equal(groups.length, 3);
  assert.ok(groups.every(g => g.files.length === 1));
});
test("standard internal Prop folders keep SM/T/Thumb files as one asset", () => {
  const root = file("Props_ZG_Ding");
  const names = [
    "SM_Env_Props_Ding_01.fbx",
    "T_Env_Props_Ding_01_4K_D.tga",
    "T_Env_Props_Ding_01_4K_N.tga",
    "T_Env_Props_Ding_01_4K_ORM.tga",
    "Thumb_Env_Props_Ding_thumb.jpg",
    "Thumb_Env_Props_Ding.png"
  ];
  const files = names.map((name) => path.join(root, name));
  const groups = groupDroppedAssets(files);
  assert.equal(groups.length, 1, "the internal asset files must stay in one draft");
  assert.equal(groups[0].preferredName, "Env Props Ding");
  assert.deepEqual(groups[0].files, files);
});

test("Thumbs folders are excluded before dropped assets are grouped", () => {
  const root = file("Props_ZG_Lamp");
  const files = [
    path.join(root, "SM_ZG_Lamp.fbx"),
    path.join(root, "T_ZG_Lamp_Albedo.png"),
    path.join(root, "Thumbs", "Preview", "SM_ZG_Lamp.jpg"),
    path.join(root, "thumbs", "SM_ZG_Lamp_LOD1.png")
  ];
  const groups = groupDroppedAssets(files);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].files, files.slice(0, 2));
  assert.ok(groups[0].files.every((filePath) => !/[/\\]thumbs?[/\\]/i.test(filePath)));
});

test("FBX embedded-media .fbm folders stay with their model (Tripo layout)", () => {
  const root = file("ruined+brick+wall+3d+model");
  const fbm = path.join(root, "tripo_convert_43403502-9c10-4da0-aad4-258b531be07f.fbm");
  const files = [
    path.join(root, "tripo_convert_43403502-9c10-4da0-aad4-258b531be07f.fbx"),
    path.join(fbm, "ruined_brick_wall_3d_model_basecolor.JPEG"),
    path.join(fbm, "ruined_brick_wall_3d_model_metallic.JPEG"),
    path.join(fbm, "ruined_brick_wall_3d_model_normal.PNG"),
    path.join(fbm, "ruined_brick_wall_3d_model_roughness.JPEG")
  ];
  const source = { root, name: "ruined brick wall 3d model", archivePath: "ruined+brick+wall+3d+model.zip" };
  const groups = groupDroppedAssets(files, [], [source]);
  assert.equal(groups.length, 1, "the .fbm textures must not split into a separate surface draft");
  assert.equal(groups[0].files.length, 5);
  assert.ok(groups[0].files.some((filePath) => filePath.endsWith(".fbx")));
  assert.equal(groups[0].files.filter((filePath) => /\.(JPEG|PNG)$/i.test(filePath)).length, 4);
});
