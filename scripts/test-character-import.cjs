const assert = require("node:assert/strict");
const test = require("node:test");
test('NPC import preserves explicit variants independently of form numbers', () => {
  for (const family of ['npc', 'monster']) {
    const fields = normalizeCharacterFields(family, { name: 'Villager', monsterVariant: 'Bell', formIds: ['01', '02'] });
    assert.equal(fields.monsterVariant, 'Bell');
    assert.deepEqual(fields.formIds, ['01', '02']);
    assert.equal(normalizeCharacterFields(family, { formIds: ['02'] }).monsterVariant, '');
  }
});
test('suit parts require explicit suffixes but allow missing parts, missing textures and SM/SK pairs', () => {
  const assert = require('node:assert/strict');
  const { heroSuitPart, auditHeroPackage } = require('../shared/heroPackageRules.mjs');
  assert.equal(heroSuitPart('working_Upperbody_v2.fbx'), 'Upbody');
  assert.equal(heroSuitPart('working.fbx'), '');
  const fields = { gender: 'Male', bodyCode: '01', suitClass: 'Medium', serial: '001', suitName: 'Test' };
  assert.deepEqual(auditHeroPackage(['working_Arm.fbx'], fields), []);
  assert.ok(auditHeroPackage(['working.fbx'], fields).some(message => message.includes('部件')));
  const files = ['SM_Test_Head.fbx', 'SK_Test_Head.fbx'];
  assert.deepEqual(auditHeroPackage(files, fields, { modelAnalyses: {
    [files[0]]: { meshKind: 'staticMesh' }, [files[1]]: { meshKind: 'skeletalMesh' }
  } }), []);
  assert.ok(auditHeroPackage(files, fields).length);
});

test('same-name duplicate textures are removed only when their content matches', async () => {
  const assert = require('node:assert/strict');
  const { deduplicateCharacterTextures } = require('../electron/services/characterTextureDuplicates');
  const files = ['a/T_Sword_D.tga', 'b/T_Sword_D.tga', 'c/T_Sword_D.tga', 'model_Head.fbx'];
  const result = await deduplicateCharacterTextures([...files, files[0]], async file => ({ sourceHash: file.startsWith('c/') ? 'different' : 'same' }));
  assert.deepEqual(result.files, [files[0], files[2], files[3]]);
  assert.deepEqual(result.duplicates, [{ sourcePath: files[1], keptPath: files[0] }]);
});
const path = require("node:path");
const fs = require("node:fs");
const { createAssetMetadata } = require("../electron/services/assetMetadata");
const { buildScope } = require("./import-draft-harness.cjs");
const { partitionCharacterPackageFiles } = require("../shared/characterFilePolicy.mjs");
const heroRules = require("../shared/heroPackageRules.mjs");

const {
  buildCharacterAssetName,
  buildCharacterMaterialBaseName,
  buildCharacterModelBaseName,
  buildCharacterRelativeRoot,
  buildCharacterTextureBaseName,
  canonicalizeCharacterPart,
  classifyCharacterPackageFile,
  getCharacterCategoryFromFields,
  inferCharacterAssetType,
  inferCharacterFields,
  inferCharacterSourcePackageName,
  inferCharacterTextureGroup,
  inferCharacterTextureType,
  isCharacterAssetType,
  normalizeCharacterFields,
  validateCharacterImport
} = require("../electron/services/characterImport");

test('all outfit parts preserve hair auxiliary texture channels and material groups', () => {
  const fields = { suitName: 'BuQiang' };
  for (const part of ['head', 'upbody', 'downbody', 'arm']) {
    for (const [suffix, channel] of [['Depth','Height'],['Height','Height'],['Root','Root'],['ID','ID'],['Tangent','Tangent']]) {
      const source = `T_M01_Heavy007_Buqiang_${part}_hair_${suffix}.tga`;
      const group = inferCharacterTextureGroup(source);
      assert.equal(group, `${part}_hair`, source);
      assert.equal(buildCharacterTextureBaseName('M01_Heavy007_BuQiang', group, inferCharacterTextureType(source), source, fields),
        `T_M01_Heavy007_BuQiang_${canonicalizeCharacterPart(group, fields.suitName)}_${channel}`);
    }
  }
});

test("Character 四类资产使用独立的顶层类型", () => {
  assert.equal(isCharacterAssetType("suit"), true);
  assert.equal(isCharacterAssetType("monster"), true);
  assert.equal(isCharacterAssetType("npc"), true);
  assert.equal(isCharacterAssetType("weapon"), true);
  assert.equal(isCharacterAssetType("3d"), false);
});

test("Character package uses an allowlist and excludes ZBrush working files", () => {
  const files = ["SK_Hero.fbx", "T_Hero_D.tga", "Hero.ma", "Hero.ztl", "Hero.zpr", "Hero.ma.swatches"];
  const result = partitionCharacterPackageFiles(files);
  assert.deepEqual(result.accepted, files.slice(0, 2));
  assert.deepEqual(result.excluded, files.slice(2));
  assert.equal(classifyCharacterPackageFile("Hero.ztl"), "other");
});

test("mixed outfit packages assign only models and make related textures follow their FBX", () => {
  const files = [
    "SK_M01_Heavy001_head.fbx",
    "SK_M01_Heavy001_upbody.fbx",
    "SK_M01_Heavy001_downbody.fbx",
    "SK_M01_Heavy001_arm.fbx",
    "SK_Sword_01.fbx",
    "T_Sword_01_D.tga"
  ];
  assert.equal(heroRules.heroPackageNeedsScopeReview(files, false), true);
  const scopes = heroRules.inferHeroPackageFileScopes(files);
  assert.equal(scopes["SK_Sword_01.fbx"], "weapon");
  assert.equal(scopes["T_Sword_01_D.tga"], undefined);
  const split = heroRules.splitHeroPackageByScope(files, scopes);
  assert.equal(heroRules.heroPackageModelFiles(split.suit).length, 4);
  assert.equal(heroRules.heroPackageModelFiles(split.weapon).length, 1);
  assert.deepEqual(heroRules.auditHeroPackage(split.suit, { variant: "Heavy" }), []);
});

test('Zhou mixed package automatically excludes unsuffixed references before preview and scope review', async () => {
  const root = 'Z:/Character/Suit/SK_Char_Suit_M001_M01_周原死侍_中男';
  const reference = `${root}/scenes/SK_Char_Suit_M001_M01.fbx`;
  const parts = ['arm', 'downbody', 'upbody'].map(part => `${root}/scenes/SK_Char_Suit_M001_M01_${part}.fbx`);
  const weapon = `${root}/scenes/SK_Sword_01.fbx`;
  const texture = `${root}/scenes/Textures/T_Sword_01_D.tga`;
  const files = [reference, ...parts, weapon, texture];
  const scope = buildScope(files, { folderName: 'SK_Char_Suit_M001_M01_周原死侍_中男' });
  await scope.applyQuickDropImport([root], 'suit');
  const form = scope.state.drafts[0].form;
  const normalize = value => String(value).replace(/\\/g, '/');
  assert.deepEqual(form.characterExcludedFiles.map(normalize), [reference]);
  assert.ok(!Object.values(form.modelSlots).map(normalize).includes(reference));
  assert.ok(!form.characterPackageFiles.map(normalize).includes(reference));
  assert.ok(!Object.keys(form.characterModelAnalysis).map(normalize).includes(reference));
  assert.equal(heroRules.heroPackageModelFiles(form.characterPackageFiles).length, 4);
  // Also recheck a previously saved, unfiltered draft when confirming scopes.
  const split = heroRules.splitHeroPackageByScope(files, heroRules.inferHeroPackageFileScopes(files));
  assert.deepEqual(split.excluded, [reference]);
  assert.deepEqual(split.suit, parts);
  assert.deepEqual(split.weapon, [weapon, texture]);
  assert.deepEqual(split.unassigned, []);
  assert.deepEqual(heroRules.auditHeroPackage(split.suit), []);
  assert.deepEqual(heroRules.partitionHeroSuitFiles(files, {}, { includeWeapons: false }).accepted, [...parts, texture]);
});

test('suit filtering preserves valid SM/SK pairs and Hair/Face, but does not invent a Head', () => {
  const files = ['reference.fbx', 'SM_Test_Arm.fbx', 'SK_Test_Arm.fbx'];
  assert.deepEqual(heroRules.partitionHeroSuitFiles(files), { accepted: files.slice(1), excluded: files.slice(0, 1) });
  for (const variant of ['Hair', 'Face']) assert.deepEqual(heroRules.partitionHeroSuitFiles(files, { variant }).accepted, files);
  assert.ok(heroRules.auditHeroPackage(heroRules.partitionHeroSuitFiles(['reference.fbx']).accepted).length);
});

test("character texture allowlist rejects arbitrary images before model ownership review", () => {
  const files = ["SK_Armor.fbx", "T_Armor_D.tga", "Armor.ma", "20260605-135627.jpg", "飞书20260730.jpg", "SK_Armor.jpg", "ue.png"];
  const result = partitionCharacterPackageFiles(files);
  assert.deepEqual(result.accepted, files.slice(0, 2));
  assert.deepEqual(result.excluded, files.slice(2));
});

test("character support images archive as T_ texture files instead of SRC_ files", () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.js"), "utf8");
  assert.match(source, /const isTexture = role === "texture"/);
  assert.match(source, /isTexture \? "Texture" : "SourceFiles"/);
  assert.match(source, /buildCharacterTextureBaseName\(assetName, textureGroup/);
});

test('Hair and Face use independent identities, not outfit slots or four-view requirements', () => {
  for (const kind of ['Hair', 'Face']) {
    const name = `F02_${kind}017`;
    const files = [`C:/source/SK_${name}.fbx`, `C:/source/T_${name}_D.tga`];
    const fields = { ...inferCharacterFields('suit', files), displayNameZh: '', displayNameEn: '', nameConfirmed: false, confirmed: true };
    assert.equal(fields.variant, kind);
    assert.equal(buildCharacterAssetName('suit', fields), name);
    assert.equal(getCharacterCategoryFromFields('suit', fields), kind);
    assert.equal(buildCharacterModelBaseName(name, files[0], fields), `SM_${name}`);
    assert.equal(buildCharacterModelBaseName(name, files[0], fields, 'skeletalMesh'), `SK_${name}`);
    assert.equal(buildCharacterMaterialBaseName(name, 'ignored', fields), `MI_${name}`);
    assert.equal(buildCharacterTextureBaseName(name, '', 'Diffuse', files[1], fields), `T_${name}_D`);
    assert.deepEqual(validateCharacterImport({ assetType: 'suit', assetName: name, category: kind, characterFields: fields, packageFiles: files }), []);
    assert.equal(require('../shared/characterComponents.mjs').listCharacterComponents({ assetType: 'suit', meta: { character: fields } }).length, 0);
  }
});

test('Hair preserves optional material parts and audits duplicates within each part', () => {
  const fields = { gender: 'Female', bodyCode: '01', variant: 'Hair', serial: '001' };
  const files = ['SM_F01_Hair001.fbx', 'T_F01_Hair001_Eyebrow_Height.tga', 'T_F01_Hair001_Front_Height.tga', 'T_F01_Hair001_Back_Height.tga'];
  assert.equal(buildCharacterTextureBaseName('F01_Hair001', '', 'Height', files[1], fields), files[1].slice(0, -4));
  assert.deepEqual(heroRules.auditHeroPackage(files, fields), []);
  const duplicate = heroRules.auditHeroPackage([...files, 'Other/T_F01_Hair001_Front_Height.tga'], fields);
  assert.ok(duplicate.some(error => error.includes('多个候选')));
});

test("Hair distinguishes Groom ABC from card meshes without treating other ABC files as Groom", () => {
  const fields = { gender: "Male", bodyCode: "01", variant: "Hair", serial: "001" };
  assert.equal(heroRules.heroPartModelKind(fields, "M01_Hair001.abc"), "groom");
  assert.equal(heroRules.heroPartModelKind(fields, "M01_Hair001.fbx"), "cards");
  assert.equal(heroRules.heroPartModelKind({ ...fields, variant: "Face" }, "M01_Face001.abc"), "mesh");
  assert.equal(heroRules.heroModelStem("M01_Hair001", "M01_Hair001.abc", fields), "M01_Hair001_Groom");
  assert.equal(heroRules.heroModelStem("M01_Hair001", "M01_Hair001.fbx", fields), "SM_M01_Hair001");
  assert.equal(heroRules.heroModelStem("M01_Hair001", "M01_Hair001.fbx", fields, "skeletalMesh"), "SK_M01_Hair001");
  assert.deepEqual(heroRules.auditHeroPackage(["M01_Hair001.abc", "M01_Hair001.fbx"], fields), []);
  assert.ok(heroRules.auditHeroPackage(["a.abc", "b.abc"], fields).some(message => message.includes("Groom")));
});

test('confirmed character fields override source names without bypassing mixed-source checks', () => {
  const files = ['SK_M01_Face001.fbx','T_M01_Face001_D.tga'];
  const fields = { gender:'Female',bodyCode:'02',variant:'Face',serial:'009',confirmed:true };
  assert.deepEqual(validateCharacterImport({assetType:'suit',assetName:'F02_Face009',category:'Face',characterFields:fields,packageFiles:files}),[]);
  assert.equal(buildCharacterModelBaseName('F02_Face009',files[0],fields,'skeletalMesh'),'SK_F02_Face009');
  assert.equal(buildCharacterTextureBaseName('F02_Face009','','Diffuse',files[1],fields),'T_F02_Face009_D');
  assert.ok(heroRules.auditHeroPackage([...files,'T_M01_Face002_N.tga'],fields).length);
  assert.equal(buildCharacterAssetName('suit',{gender:'Female',bodyCode:'02',suitClass:'Heavy',serial:'009',suitName:'Old',displayNameEn:'New_Name2'}),'F02_Heavy009_New_Name2');
});

test('explicit Hair and Face selection survives a folder with unrecognized names', async () => {
  for (const kind of ['Hair', 'Face']) {
    const scope = buildScope(['D:/PartPack/unknown.fbx'], { folderName: 'PartPack' });
    await scope.applyQuickDropImport(['D:/PartPack'], 'suit', kind);
    const form = scope.state.drafts[0].form;
    assert.equal(form.characterFields.variant, kind);
    assert.equal(form.subCategory, kind);
    assert.equal(form.characterFields.suitName, '');
  }
});

test('single outfit revision normalizes while competing versions and foreign head textures block', () => {
  const { auditHeroPackage, cleanSuitName, isHeroCache } = require('../shared/heroPackageRules.mjs');
  assert.equal(cleanSuitName('ZhouSishi_1030_02'), 'ZhouSishi');
  const fields = { gender: 'Female', bodyCode: '01', suitClass: 'Medium', serial: '001', suitName: 'ZhouSishi_1030_02' };
  const name = buildCharacterAssetName('suit', fields);
  const source = 'SK_Char_Suit_M001_F01_arm_1030.fbx';
  assert.equal(buildCharacterModelBaseName(name, source, fields), 'SM_F01_Medium001_ZhouSishi_Arm');
  assert.equal(buildCharacterModelBaseName(name, source, fields, "skeletalMesh"), 'SK_F01_Medium001_ZhouSishi_Arm');
  assert.deepEqual(auditHeroPackage([source], fields), []);
  assert.ok(auditHeroPackage([source, 'SK_Char_Suit_M001_F01_arm.fbx'], fields).length);
  assert.ok(isHeroCache('SK_Char_Suit_M001_F01.ma.swatches'));
  assert.ok(auditHeroPackage(['SK_M01_Hair001.fbx', 'T_M01_Hair002_D.tga'], { gender: 'Male', bodyCode: '01', variant: 'Hair', serial: '001' }).length);
});

test("套装分类仅由M/F体型决定，未识别时不默认男装或Common", () => {
  assert.equal(getCharacterCategoryFromFields("suit", {}), "");
  assert.equal(getCharacterCategoryFromFields("suit", { bodyCode: "01" }), "");
  assert.equal(getCharacterCategoryFromFields("suit", { gender: "Female", bodyCode: "02" }), "Female_01");
  assert.equal(getCharacterCategoryFromFields("suit", { gender: "Male" }), "Male_01");
  assert.equal(getCharacterCategoryFromFields("monster", { gender: "Male" }), "");
});

test("Character 目标路径由类型和结构化分类稳定生成", () => {
  assert.deepEqual(buildCharacterRelativeRoot("suit", "Male_01"), ["Character", "Hero", "Male_01"]);
  assert.deepEqual(buildCharacterRelativeRoot("monster", "1_Boss"), ["Character", "Monster", "1_Boss"]);
  assert.deepEqual(buildCharacterRelativeRoot("npc", "Merchant"), ["Character", "NPC", "Merchant"]);
  assert.deepEqual(buildCharacterRelativeRoot("weapon", "Bow"), ["Character", "Weapon", "Bow"]);
  assert.equal(path.join(...buildCharacterRelativeRoot("weapon", "../Bow")), path.join("Character", "Weapon", ".._Bow"));
});

test("文件夹和文件名可以预填 Character 类型及字段", () => {
  assert.equal(inferCharacterAssetType(["Bow001_ChangGong", "SK_Bow001_ChangGong.fbx"]), "weapon");
  for (const type of ['Dagger', 'DualHands', 'DualAxe', 'GreatSword']) {
    assert.equal(inferCharacterAssetType([`C:/Art/${type}001_Test/SK_${type}001_L.fbx`]), 'weapon');
  }
  assert.equal(inferCharacterAssetType(['C:/Art/GameplayItem/Chest/SM_Test.fbx']), 'item');
  assert.equal(inferCharacterAssetType(["Merchant001_FireKeeper", "SK_FireKeeper.fbx"]), "npc");
  assert.equal(inferCharacterAssetType(["1_Boss", "GreatDingBeast_01"]), "monster");
  assert.equal(inferCharacterAssetType(["M01_Heavy001_SuitName"]), "suit");
  assert.deepEqual(inferCharacterFields("suit", ["Male_01", "M01_Heavy001_SuitName"]), {
    displayNameEn: "SuitName",
    family: "suit",
    gender: "Male",
    bodyCode: "01",
    suitClass: "Heavy",
    suitName: "SuitName",
    serial: "001",
    variant: "",
    maturity: "wip",
    confirmed: false
  });
});

test("结构化字段必须由导入者整包确认", () => {
  const previewPaths = { front: "front.png", left: "left.png", right: "right.png", back: "back.png" };
  const base = {
    assetType: "suit",
    assetName: "M01_Heavy001_SuitName",
    category: "Male_01",
    packageFiles: ["D:\\Source\\SK_M01_Heavy001_SuitName_Head.fbx"],
    previewPaths
  };
  const incomplete = validateCharacterImport({ ...base, characterFields: { confirmed: false } });
  assert.equal(incomplete.includes("请填写套装名字"), true);
  assert.equal(incomplete.includes("请确认结构化字段和目标路径"), true);
  const fields = normalizeCharacterFields("suit", {
    displayNameZh: "测试套装", nameConfirmed: true, gender: "Male", bodyCode: "01", suitClass: "Heavy", suitName: "SuitName", serial: "001", confirmed: true, maturity: "needs_rig"
  });
  assert.deepEqual(validateCharacterImport({ ...base, characterFields: fields }), []);
  assert.equal(fields.family, "suit");
  assert.equal(fields.maturity, "needs_rig");
});

test("旧套装命名把 M001 与 F01 分域解析并生成规范名称预览字段", () => {
  const values = [
    "SK_Char_Suit_M001_F01",
    "Z:\\Character\\Suit\\SK_Char_Suit_M001_F01\\scenes\\SK_Char_Suit_M001_F01_arm.fbx"
  ];
  const fields = inferCharacterFields("suit", values);
  assert.deepEqual(fields, {
    family: "suit",
    gender: "Female",
    bodyCode: "01",
    suitClass: "Medium",
    suitName: "",
    serial: "001",
    variant: "",
    maturity: "wip",
    confirmed: false
  });
  assert.equal(getCharacterCategoryFromFields("suit", fields), "Female_01");
  assert.equal(buildCharacterAssetName("suit", { ...fields, suitName: "SuitName" }), "F01_Medium001_SuitName");
  assert.equal(inferCharacterSourcePackageName("scenes", values.slice(1)), "SK_Char_Suit_M001_F01");
  assert.equal(inferCharacterTextureType("T_Char_Suit_M001_F01_downbody_A.tga"), "Opacity");
  assert.equal(inferCharacterTextureGroup("T_Char_Suit_M001_F01_upbody_01_ORM.tga"), "upbody_01");
  assert.equal(inferCharacterTextureGroup("T_F01_Medium001_ZhouSishi_upbody_01_ORM.tga"), "upbody_01");
  assert.equal(inferCharacterTextureGroup("T_F01_Medium001_ZhouSishi_suoyi_D.tga"), "suoyi");
});

test("套装入库副本严格复用父名并为模型、材质和贴图添加规范前后缀", () => {
  const assetName = "F01_Medium001_SuoYi";
  const fields = { suitName: "SuoYi" };
  assert.equal(canonicalizeCharacterPart("arm", fields.suitName), "Arm");
  assert.equal(canonicalizeCharacterPart("upbody_1", fields.suitName), "Upbody_01");
  assert.equal(canonicalizeCharacterPart("suoyi", fields.suitName), "SuoYi");
  assert.equal(
    buildCharacterModelBaseName(assetName, "Z:\\scenes\\SK_Char_Suit_M001_F01_arm.fbx", fields),
    "SM_F01_Medium001_SuoYi_Arm"
  );
  assert.equal(buildCharacterModelBaseName(assetName, "Z:\\scenes\\SK_Char_Suit_M001_F01_arm.fbx", fields, "skeletalMesh"), "SK_F01_Medium001_SuoYi_Arm");
  assert.equal(buildCharacterMaterialBaseName(assetName, "upbody_02", fields), "MI_F01_Medium001_SuoYi_Upbody_02");
  assert.equal(
    buildCharacterTextureBaseName(assetName, "upbody_02", "Diffuse", "T_Char_Suit_M001_F01_upbody_02_D.tga", fields),
    "T_F01_Medium001_SuoYi_Upbody_02_D"
  );
  assert.equal(
    buildCharacterTextureBaseName(assetName, "suoyi", "Opacity", "T_Char_Suit_M001_F01_suoyi_A.tga", fields),
    "T_F01_Medium001_SuoYi_SuoYi_A"
  );
});

test("套装目录被通用扫描器拆分后重新聚合为一个资产，并保留独立 FBX 与材质组", async () => {
  const root = "Z:\\Character\\Suit\\SK_Char_Suit_M001_F01\\scenes";
  const modelFiles = ["arm", "downbody", "head", "upbody"].map((part) => `${root}\\SK_Char_Suit_M001_F01_${part}.fbx`);
  const textureGroups = ["arm", "downbody", "head", "suoyi", "upbody_01", "upbody_02"];
  const textureFiles = textureGroups.flatMap((group) => ["D", "N", "ORM", ...(group === "downbody" || group === "suoyi" ? ["A"] : [])]
    .map((suffix) => `${root}\\Textures\\T_Char_Suit_M001_F01_${group}_${suffix}.tga`));
  const sourceFile = `${root}\\SK_Char_Suit_M001_F01.ma`;
  const resolvedAssets = [
    ...modelFiles.map((file) => ({ files: [file], folderName: "scenes", metadata: null })),
    ...textureGroups.map((group) => ({ files: textureFiles.filter((file) => file.includes(`_${group}_`)), folderName: "Textures", metadata: null })),
    { files: [sourceFile], folderName: "scenes", metadata: null }
  ];
  const scope = buildScope([...modelFiles, ...textureFiles, sourceFile], { folderName: "scenes", resolvedAssets });
  await scope.applyQuickDropImport([root], "suit");
  assert.equal(scope.state.drafts.length, 1);
  const form = scope.state.drafts[0]?.form;
  assert.equal(Object.values(form?.modelSlots || {}).filter(Boolean).length, 4);
  assert.equal(form?.characterPackageFiles.length, 24);
  assert.ok(form?.characterExcludedFiles.includes(sourceFile));
  assert.deepEqual([...new Set((form?.textureEntries || []).map((entry) => entry.areaId))], [1, 2, 3, 4, 5, 6]);
  assert.equal(form?.textureEntries.some((entry) => entry.textureType === "Opacity"), true);
  assert.deepEqual(form?.materialNames, { 1: "arm", 2: "downbody", 3: "head", 4: "suoyi", 5: "upbody_01", 6: "upbody_02" });
});

test("整包文件不会静默丢弃，未知格式被标为 other", () => {
  assert.equal(classifyCharacterPackageFile("SK_Hero.fbx"), "model");
  assert.equal(classifyCharacterPackageFile("T_Hero_D.png"), "texture");
  assert.equal(classifyCharacterPackageFile("Hero_preview.jpg"), "preview");
  assert.equal(classifyCharacterPackageFile("Hero.spp"), "source");
  assert.equal(classifyCharacterPackageFile("notes.custom"), "other");
});

test("角色文件夹仅保留白名单文件并展示排除清单", async () => {
  const packageFiles = [
    "D:\\CharacterPack\\SK_Bow001_ChangGong.fbx",
    "D:\\CharacterPack\\T_Bow001_ChangGong_D.png",
    "D:\\CharacterPack\\notes.custom"
  ];
  const scope = buildScope(packageFiles, { folderName: "Bow001_ChangGong" });
  await scope.applyQuickDropImport(["D:\\CharacterPack"], "weapon");
  const form = scope.state.drafts[0]?.form;
  assert.equal(form?.assetType, "weapon");
  assert.equal(form?.subCategory, "Bow");
  assert.deepEqual(form?.characterPackageFiles, packageFiles.slice(0, 2));
  assert.deepEqual(form?.characterExcludedFiles, packageFiles.slice(2));
  assert.equal(form?.characterFields?.confirmed, false);
});

test("套装 scenes 文件夹按父包命名、女性目录和 A 贴图生成草稿，不拿 A 当预览", async () => {
  const root = "Z:\\Character\\Suit\\SK_Char_Suit_M001_F01\\scenes";
  const packageFiles = [
    `${root}\\SK_Char_Suit_M001_F01_arm.fbx`,
    `${root}\\Textures\\T_Char_Suit_M001_F01_downbody_D.tga`,
    `${root}\\Textures\\T_Char_Suit_M001_F01_downbody_A.tga`
  ];
  const scope = buildScope(packageFiles, { folderName: "scenes" });
  await scope.applyQuickDropImport([root], "suit");
  const form = scope.state.drafts[0]?.form;
  assert.equal(form?.assetName, "SK_Char_Suit_M001_F01");
  assert.equal(form?.subCategory, "Female_01");
  assert.equal(form?.characterFields?.suitClass, "Medium");
  assert.equal(form?.characterFields?.serial, "001");
  assert.equal(form?.textureEntries?.some((entry) => entry.textureType === "Opacity" && /_A\.tga$/i.test(entry.filePath)), true);
  assert.equal(form?.previewImagePath, "");
});

test("asset_info 元数据保留角色结构字段、整包清单和入库状态", () => {
  const character = normalizeCharacterFields("weapon", { serial: "001", maturity: "needs_rig", confirmed: true });
  const characterManifest = {
    schemaVersion: "1.0",
    family: "weapon",
    completeness: "complete",
    fileCount: 1,
    files: [{ originalName: "SK_Bow001.fbx", storedPath: "SK_Bow001.fbx", role: "model", size: 1, sha256: "a".repeat(64) }]
  };
  const metadata = createAssetMetadata({
    assetID: "character-test-001",
    name: "Bow001_ChangGong",
    assetType: "weapon",
    topCategory: "character",
    category: "Bow",
    character,
    characterManifest,
    packageStatus: "stored"
  });
  assert.deepEqual(metadata.character, character);
  assert.deepEqual(metadata.characterManifest, characterManifest);
  assert.equal(metadata.packageStatus, "stored");
  assert.equal(metadata.topCategory, "character");
});
test('Groom ABC reaches the real renderer submit payload after draft confirmation', async () => {
  const { buildScope, defaultImportForm } = require('./import-draft-harness.cjs');
  const file = 'C:/source/F01_Hair991_Groom.abc';
  const scope = buildScope([file], { folderName: 'groomtest' });
  await scope.applyQuickDropImport(['C:/source/groomtest'], 'suit');
  const draft = scope.state.drafts[0].form;
  const form = { ...defaultImportForm, ...draft, characterFields: { ...draft.characterFields, confirmed: true, identityConfirmed: true } };
  const payload = scope.buildImportPayload(form);
  assert.equal(payload.character.variant, 'Hair');
  assert.ok(Object.values(payload.modelSlots).some(p => p.endsWith('.abc')));
  assert.ok(payload.characterPackageFiles.some(p => p.endsWith('.abc')));
  assert.equal(scope.isModelFileAcceptedForType(file, 'suit', { variant: 'Face' }), false);
  assert.equal(scope.isModelFileAcceptedForType(file, 'monster', { variant: 'Hair' }), false);
  assert.equal(scope.isModelFileAcceptedForType('hair.fbx', 'suit', { variant: 'Hair' }), true);
});

test('FBX LOD confirmation gates actual submit and is invalidated by a new level', async () => {
  const { buildScope, defaultImportForm } = require('./import-draft-harness.cjs');
  const { characterLodReviewToken } = require('../shared/characterLodReview.mjs');
  const files = ['C:/source/SM_F01_Face991.fbx', 'C:/source/SM_F01_Face991_LOD1.fbx'];
  const scope = buildScope(files, { folderName: 'F01_Face991' });
  await scope.applyQuickDropImport(['C:/source/F01_Face991'], 'suit');
  const draft = scope.state.drafts[0].form;
  const form = { ...defaultImportForm, ...draft, characterFields: { ...draft.characterFields, confirmed: true, identityConfirmed: true } };
  const baseOnly = { ...form, characterPackageFiles: [form.characterPackageFiles[0]] };
  baseOnly.characterLodConfirmation = characterLodReviewToken(baseOnly.characterPackageFiles.map(file => ({ name: file.split(/[\\/]/).pop(), sourcePath: file, kind: 'staticMesh' })));
  assert.equal(scope.buildImportPayload(baseOnly).characterPackageFiles.length, 1);
  assert.throws(() => scope.buildImportPayload(form), /LOD/);
  form.characterLodConfirmation = characterLodReviewToken(form.characterPackageFiles.map(file => ({ name: file.split(/[\\/]/).pop(), sourcePath: file, kind: 'staticMesh' })));
  assert.equal(scope.buildImportPayload(form).characterPackageFiles.length, 2);
  const extra = 'C:/source/SM_F01_Face991_LOD2.fbx';
  form.characterPackageFiles = [...form.characterPackageFiles, extra];
  form.characterModelAnalysis[extra] = { ok: true, meshKind: 'staticMesh' };
  assert.throws(() => scope.buildImportPayload(form), /LOD/);
});

test('character package whitelist excludes authoring projects and documents for new imports', () => {
  const { partitionCharacterPackageFiles } = require('../shared/characterFilePolicy.mjs');
  const accepted = ['SM_Hero.fbx', 'SK_Hero.fbx', 'F01_Hair001_Groom.abc', 'T_F01_Face001_Scatter.tga'];
  const excluded = ['Hero.spp', 'Hero.blend', 'Hero.max', 'Hero.ma', 'Hero.mb', 'Hero.psd', 'notes.txt', 'data.json', 'SK_Hero.uasset'];
  assert.deepEqual(partitionCharacterPackageFiles([...accepted, ...excluded]), { accepted, excluded });
});

test('manual file exclusion updates textures and previews; restore preserves map settings', () => {
  const { buildScope, defaultImportForm } = require('./import-draft-harness.cjs');
  const { setCharacterPackageFileIncluded: select } = buildScope([]);
  const mesh = 'C:/art/SM_F01_Face001.fbx';
  const texture = 'C:/art/T_F01_Face001_D.tga';
  const entry = { id: 'map-1', filePath: texture, type: 'Diffuse', areaId: 'skin' };
  for (const assetType of ['suit', 'monster', 'npc', 'weapon', 'item']) {
    const form = { ...defaultImportForm, assetType, characterPackageFiles: [mesh, texture], textureEntries: [entry],
      modelSlots: { Mesh: mesh }, characterFields: { confirmed: true }, characterLodConfirmation: 'checked',
      characterPreviewPaths: { front: 'generated.png', left: '', right: '', back: '' }, previewImagePath: 'generated.png' };
    const removed = select(form, texture, false);
    assert.deepEqual(removed.characterPackageFiles, [mesh]);
    assert.deepEqual(removed.textureEntries, []);
    assert.equal(removed.previewImagePath, '');
    assert.equal(removed.characterLodConfirmation, '');
    assert.equal(removed.characterFields.confirmed, false);
    assert.deepEqual(form.textureEntries, [entry], 'original draft is not mutated');
    const restored = select(removed, texture, true);
    assert.deepEqual(restored.textureEntries, [entry]);
    assert.equal(restored.characterManualExclusions.length, 0);
    assert.equal(select(restored, texture, true), restored, 'repeated restore cannot duplicate a file');
  }
});

test('removing a base model retains LOD1 for review and clears stale model slot metadata', () => {
  const { buildScope, defaultImportForm } = require('./import-draft-harness.cjs');
  const { setCharacterPackageFileIncluded: select } = buildScope([]);
  const base = 'C:/art/SM_F01_Face001.fbx', lod = 'C:/art/SM_F01_Face001_LOD1.fbx';
  const form = { ...defaultImportForm, assetType: 'suit', characterPackageFiles: [base, lod],
    modelSlots: { Mesh: base }, modelLodFiles: { Mesh: [lod] }, characterLodConfirmation: 'checked' };
  const removed = select(form, base, false);
  assert.deepEqual(removed.characterPackageFiles, [lod]);
  assert(!Object.values(removed.modelSlots).includes(base));
  assert.deepEqual(removed.modelLodFiles, {});
  assert.equal(removed.characterLodConfirmation, '');
  const review = require('../shared/characterLodReview.mjs').characterLodReview([{ name: lod.split('/').pop(), sourcePath: lod, kind: 'staticMesh' }]);
  assert.equal(review[0].missingBase, true);
  assert(Object.values(select(removed, base, true).modelSlots).includes(base));
});

test('resumed drafts automatically exclude SPP and cannot restore prohibited files', () => {
  const { buildScope, defaultImportForm } = require('./import-draft-harness.cjs');
  const { pruneCharacterImportFiles: prune, setCharacterPackageFileIncluded: select } = buildScope([]);
  const mesh = 'C:/art/SM_Hero.fbx', spp = 'C:/art/Hero.spp', blend = 'C:/art/Hero.blend';
  const form = { ...defaultImportForm, assetType: 'suit', characterPackageFiles: [mesh, spp],
    characterManualExclusions: [{ filePath: blend, textureEntries: [] }],
    characterFields: { confirmed: true }, previewImagePath: 'custom.png' };
  const result = prune(form);
  assert.deepEqual(result.characterPackageFiles, [mesh]);
  assert.deepEqual(new Set(result.characterExcludedFiles), new Set([spp, blend]));
  assert.deepEqual(result.characterManualExclusions, []);
  assert.equal(result.previewImagePath, 'custom.png');
  assert.equal(result.characterFields.confirmed, false);
  assert.equal(select(result, spp, true), result);
  assert.equal(prune(result), result, 'clean drafts are stable across renders');
});

test('manually excluded LODs stay out of the actual submit payload and model analysis', async () => {
  const { buildScope } = require('./import-draft-harness.cjs');
  const { characterLodReviewToken } = require('../shared/characterLodReview.mjs');
  const base = 'C:/art/SM_F01_Face991.fbx', lod = 'C:/art/SM_F01_Face991_LOD1.fbx';
  const scope = buildScope([base, lod], { folderName: 'F01_Face991' });
  await scope.applyQuickDropImport(['C:/art/F01_Face991'], 'suit');
  const draft = scope.state.drafts[0].form;
  const removedFile = draft.characterPackageFiles.find(file => /_LOD1/.test(file));
  const edited = scope.setCharacterPackageFileIncluded(draft, removedFile, false);
  const form = { ...edited, characterFields: { ...edited.characterFields, confirmed: true, identityConfirmed: true } };
  form.characterLodConfirmation = characterLodReviewToken(form.characterPackageFiles.map(file => ({ name: file.split(/[\\/]/).pop(), sourcePath: file, kind: 'staticMesh' })));
  const payload = scope.buildImportPayload(form);
  assert.equal(payload.characterPackageFiles.length, 1);
  assert(!payload.characterPackageFiles.includes(removedFile));
  assert(!Object.values(payload.modelSlots).includes(removedFile));
  assert(!Object.hasOwn(payload.characterModelAnalysis, removedFile));
});
