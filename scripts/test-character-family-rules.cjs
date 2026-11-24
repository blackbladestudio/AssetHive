const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getFamilyRule,
  parsePackageName,
  parsePackagePath,
  classifyFamilyFile,
  validateFamilyFileName,
  buildFamilyPackagePlan,
  resolveMonsterAssociation
} = require("../electron/services/characterFamilyRules");
const { buildScope } = require("./import-draft-harness.cjs");
const { auditMonsterPackage } = require("../shared/monsterPackageAudit.mjs");

test('NPC H/NH confirmation uses canonical categories without changing model identity', () => {
  for (const [alias, category] of [['H', 'Human'], ['NH', 'Nonhuman']]) {
    const source = `C:/NPC/${alias}/SK_Keeper_01/Mesh/SK_Keeper_01.fbx`;
    assert.equal(parsePackagePath('npc', source).category, category);
    const plan = buildFamilyPackagePlan('npc', source, [source], { assetName: 'SK_Keeper_01', category: alias, formIds: ['01'], monsterVariant: 'Bell' });
    assert.equal(plan.ok, true, plan.errors.join(';'));
    assert.equal(plan.category, category);
    assert.equal(plan.fields.monsterVariant, 'Bell');
    assert.equal(plan.files[0].normalizedName, 'SK_Keeper_01.fbx');
  }
});

test('confirmed monster, NPC and weapon names and categories override source identities', () => {
  const source=['SK_Executioner_01.fbx','T_Executioner_01_Hat_D.tga'];
  const monster=buildFamilyPackagePlan('monster',source[0],source,{name:'NewMonster',assetName:'SK_NewMonster_09',category:'1_Boss',formIds:['09']});
  assert.equal(monster.ok,true,monster.errors.join(';'));
  assert.deepEqual(monster.files.map(f=>f.normalizedName),['SK_NewMonster_09.fbx','T_NewMonster_09_Hat_D.tga']);
  assert.deepEqual(monster.forms.map(f=>f.id),['09']);
  for(const [family,sourcePath,assetName,category,expected] of [
    ['npc','C:/NPC/Scholar/Scholar017_Old/Mesh/SK_Old.fbx','Guard009_NewName','Guard','SK_NewName.fbx'],
    ['weapon','C:/Weapon/Spear/Spear023_Old/Mesh/SK_Spear023_Old.fbx','Sword009_NewName','Sword','SK_Sword009_NewName.fbx']
  ]) {
    const plan=buildFamilyPackagePlan(family,sourcePath,[sourcePath],{assetName,category});
    assert.equal(plan.ok,true,plan.errors.join(';'));
    assert.equal(plan.files[0].normalizedName,expected);
  }
});

function rigPackage() {
  const root = 'C:/art/Monster/3_Elite/Executioner';
  const files = ['SK_Executioner_01.fbx', 'SK_Executioner_01_WP_GreatSword.fbx', '绑定/SK_ShangExecutor.FBX', '绑定/SK_ShangExecutor_Weapon.FBX'].map(file => `${root}/${file}`);
  const modelAnalyses = Object.fromEntries(files.map((file, i) => [file, {
    ok: true, meshKind: i < 2 ? 'staticMesh' : 'skeletalMesh',
    materialNames: i % 2 ? ['MI_Executioner_01_WP_GreatSword'] : i === 0 ? ['MI_Executioner_01_Hat'] : ['MI_Executioner_01_Hat', 'MI_Executioner_01_Hat_1']
  }]));
  return { root, files, modelAnalyses };
}

test('artist WP prefix imports for monster and NPC without treating material indices as forms', () => {
  for (const family of ['monster', 'npc']) {
    const files = ['SM_FireKeeper_01.fbx', 'SM_WP_FireKeeper_Torch.fbx', 'SK_WP_FireKeeper_Torch.fbx', 'T_WP_FireKeeper_Torch_02_D.tga', 'T_FireKeeper_01_Body_02_D.tga'];
    const plan = buildFamilyPackagePlan(family, files[0], files, { name: 'FireKeeper', assetName: 'SK_FireKeeper_01', category: family === 'monster' ? '3_Elite' : 'Merchant', formIds: ['01'] });
    assert.equal(plan.ok, true, plan.errors.join(';'));
    assert.equal(plan.files[1].normalizedName, files[1]);
    assert.equal(plan.files[1].componentName, 'Torch');
    assert.equal(plan.files[1].componentRole, 'weapon');
    assert.equal(plan.files[3].normalizedName, files[3]);
    assert.equal(plan.files[3].formId, '');
  }
  assert.equal(auditMonsterPackage(['SM_FireKeeper_01.fbx', 'SM_WP_Other_Torch.fbx']).ok, false);
});

test('renamed rig body and weapon join the numbered static models through inspected material slots', async () => {
  const { root, files, modelAnalyses } = rigPackage();
  const audit = auditMonsterPackage(files, { modelAnalyses });
  assert.equal(audit.ok, true, JSON.stringify(audit.issues));
  assert.deepEqual(audit.formIds, ['01']);
  const scope = buildScope(files, { folderName: 'Executioner', modelAnalyses });
  await scope.applyQuickDropImport([root], 'monster');
  const form = scope.state.drafts[0].form;
  assert.deepEqual(form.characterFields.formIds, ['01']);
  assert.equal(form.assetName, 'SK_Executioner_01');
  assert.equal(form.characterFields.displayNameEn, 'Executioner');
  assert.equal(form.characterFields.displayNameZh, '');
  const analyses = new Map(Object.entries(modelAnalyses).map(([file, value]) => [require('node:path').resolve(file).toLowerCase(), value]));
  const plan = buildFamilyPackagePlan('monster', files[0], files, { name: 'Executioner', category: '3_Elite', assetName: form.assetName, modelAnalyses: analyses });
  assert.equal(plan.ok, true, plan.errors.join('; '));
  assert.deepEqual(plan.files.map(file => file.relativePath), [
    'Mesh/StaticMesh/SM_Executioner_01.fbx', 'Mesh/StaticMesh/SM_Executioner_01_WP_GreatSword.fbx',
    'Mesh/SkeletalMesh/SK_Executioner_01.FBX', 'Mesh/SkeletalMesh/SK_Executioner_01_WP_GreatSword.FBX'
  ]);
  assert.equal(plan.files[3].componentRole, 'weapon');
  assert.equal(plan.files[3].componentName, 'GreatSword');
  assert.deepEqual(plan.forms.map(form => form.id), ['01']);
  assert.equal(plan.unassignedFiles.length, 0);
});

test('rig matching does not merge competing versions, unrelated materials, occupied types or multiple weapons', () => {
  const { files, modelAnalyses } = rigPackage();
  const check = (moreFiles, moreAnalyses) => auditMonsterPackage(moreFiles, { modelAnalyses: moreAnalyses }).ok;
  assert.equal(check(files, {}), false);
  assert.equal(check(files, { ...modelAnalyses, [files[2]]: { ...modelAnalyses[files[2]], materialNames: ['MI_OtherMonster_01_Hat'] } }), false);
  assert.equal(check(files, { ...modelAnalyses, [files[2]]: { ...modelAnalyses[files[2]], meshKind: 'staticMesh' } }), false);
  const duplicate = files[2].replace('.FBX', '_copy2.FBX');
  assert.equal(check([...files, duplicate], { ...modelAnalyses, [duplicate]: modelAnalyses[files[2]] }), false);
  const otherWeapon = files[1].replace('GreatSword', 'Axe');
  assert.equal(check([...files, otherWeapon], { ...modelAnalyses, [otherWeapon]: modelAnalyses[files[1]] }), false);
  const occupied = files[0].replace('.fbx', '.FBX');
  assert.equal(check([...files, occupied], { ...modelAnalyses, [occupied]: modelAnalyses[files[2]] }), false);
  const otherForm = files[0].replace('_01', '_02');
  assert.equal(check([...files, otherForm], { ...modelAnalyses, [otherForm]: modelAnalyses[files[0]] }), false);
});

test("Monster accepts the seven documented tiers and parses a nonexample boss", () => {
  assert.deepEqual(getFamilyRule("monster").categories, [
    "0_Common", "1_Boss", "2_MiniBoss", "3_Elite", "4_NormalMonster", "5_Minion", "6_Temp"
  ]);
  const root = "C:/work/Monster/1_Boss/Boss042_StoneGolem";
  const files = [
    `${root}/Mesh/SkeletalMesh/SK_StoneGolem_01.fbx`,
    `${root}/Mesh/SkeletalMesh/SK_StoneGolem_01_Physics.uasset`,
    `${root}/Mesh/SkeletalMesh/SKEL_StoneGolem_01.uasset`,
    `${root}/Mesh/StaticMesh/SM_StoneGolem_01.uasset`,
    `${root}/Material/MI_StoneGolem_01.uasset`,
    `${root}/Texture/T_StoneGolem_01_D.png`,
    `${root}/ABP/ABP_StoneGolem_01.uasset`,
    `${root}/BP/BP_StoneGolem_01.uasset`,
    `${root}/ActionFiles/hit.json`
  ];
  const plan = buildFamilyPackagePlan("monster", files[0], files, { assetName: "Boss042_StoneGolem", category: "1_Boss" });
  assert.equal(plan.ok, true, plan.errors.join("; "));
  assert.deepEqual(plan.files.map((item) => item.role), ["skeletalMesh", "texture"]);
  assert(plan.files.every(item => !/\.(uasset|json)$/i.test(item.sourcePath)));
  assert.equal(plan.warnings.length, 0);
  assert.equal(parsePackageName("monster", "Dragon042_StoneGolem"), null);
});

test("NPC category comes from the package prefix; the static mesh keeps the full package name", () => {
  const root = "C:/work/NPC/Scholar/Scholar017_MoonReader";
  const files = [
    `${root}/Mesh/SkeletalMesh/SK_MoonReader.fbx`,
    `${root}/Mesh/StaticMesh/SM_Scholar017_MoonReader.fbx`,
    `${root}/Material/MI_MoonReader_Upbody_01.uasset`,
    `${root}/Texture/T_MoonReader_01_D.png`,
    `${root}/Animation/Idle.fbx`
  ];
  const plan = buildFamilyPackagePlan("npc", files[0], files, { assetName: "Scholar017_MoonReader", category: "Scholar" });
  assert.equal(plan.ok, true, plan.errors.join("; "));
  assert.equal(plan.category, "Scholar");
  assert.equal(plan.files[1].nameStatus, "valid");
  assert.equal(plan.files.at(-1).role, "animation");
  assert(plan.files.every(item => !/\.uasset$/i.test(item.sourcePath)));
  assert.equal(parsePackagePath("npc", "C:/work/NPC/Guard/Scholar017_MoonReader"), null);
});

test("new NPC imports match monster file identities and omit the legacy category serial", () => {
  const files = [
    "C:/delivery/SK_ShangExecutioner_01.fbx",
    "C:/delivery/SM_ShangExecutioner_01.fbx",
    "C:/delivery/T_ShangExecutioner_01_Body_D.tga",
    "C:/delivery/T_ShangExecutioner_01_Body_A.tga"
  ];
  const plan = buildFamilyPackagePlan("npc", files[0], files, {
    assetName: "SK_ShangExecutioner_01", category: "Merchant", name: "ShangExecutioner", formIds: ["01"]
  });
  assert.equal(plan.ok, true, plan.errors.join("; "));
  assert.equal(plan.assetName, "SK_ShangExecutioner_01");
  assert.deepEqual(plan.fields, { serial: "", name: "ShangExecutioner", category: "Merchant", formIds: ["01"] });
  assert.deepEqual(plan.files.map(file => file.normalizedName), [
    "SK_ShangExecutioner_01.fbx", "SM_ShangExecutioner_01.fbx",
    "T_ShangExecutioner_01_Body_D.tga", "T_ShangExecutioner_01_Body_A.tga"
  ]);
  assert.equal(plan.files.every(file => !file.normalizedName.includes("Merchant001")), true);
  const legacyRoot = "C:/NPC/Merchant/Merchant001_ShangExecutioner";
  const renamed = buildFamilyPackagePlan("npc", `${legacyRoot}/SK_Merchant001_ShangExecutioner.fbx`, [
    `${legacyRoot}/SK_Merchant001_ShangExecutioner.fbx`, `${legacyRoot}/T_ShangExecutioner_Body_D.tga`
  ], { assetName: "SK_ShangExecutioner_01", category: "Merchant", name: "ShangExecutioner", formIds: ["01"] });
  assert.equal(renamed.ok, true, renamed.errors.join("; "));
  assert.deepEqual(renamed.files.map(file => file.normalizedName), ["SK_ShangExecutioner_01.fbx", "T_ShangExecutioner_01_Body_D.tga"]);
});

test("Weapon supports new categories and names its files from the full package name", () => {
  const root = "C:/work/Weapon/Spear/Spear023_SilverFang";
  const files = [
    `${root}/Mesh/SkeletalMesh/SK_Spear023_SilverFang.fbx`,
    `${root}/Mesh/SkeletalMesh/SK_Spear023_SilverFang_Physics.uasset`,
    `${root}/Mesh/SkeletalMesh/SKEL_Spear023_SilverFang.uasset`,
    `${root}/Mesh/StaticMesh/SM_Spear023_SilverFang.uasset`,
    `${root}/Material/MI_Spear023_SilverFang.uasset`,
    `${root}/Texture/T_Spear023_SilverFang_ORM.png`
  ];
  const plan = buildFamilyPackagePlan("weapon", files[0], files, { assetName: "Spear023_SilverFang", category: "Spear" });
  assert.equal(plan.ok, true, plan.errors.join("; "));
  assert.equal(plan.files[1].relativePath, "Texture/T_Spear023_SilverFang_ORM.png");
  assert.equal(plan.files.length, 2);
  assert.equal(classifyFamilyFile("weapon", `${root}/ABP/ABP_Spear023_SilverFang.uasset`).role, "other");
});

test("Family validation catches cross-package files, category mismatch, and target collisions", () => {
  const root = "C:/work/Weapon/GreatAxe/GreatAxe011_IronCrest";
  const mesh = `${root}/Mesh/SkeletalMesh/mesh.fbx`;
  const files = [mesh, `${root}/Mesh/SkeletalMesh/another.fbx`];
  const plan = buildFamilyPackagePlan("weapon", mesh, files, { assetName: "GreatAxe011_IronCrest", category: "GreatAxe" });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(" "), /重名/);
  assert.equal(plan.files[0].normalizedName, "SK_GreatAxe011_IronCrest.fbx");
  assert.equal(validateFamilyFileName("weapon", parsePackageName("weapon", "GreatAxe011_IronCrest"), mesh, "skeletalMesh"), "mismatch");
  const wrongCategory = buildFamilyPackagePlan("weapon", mesh, [mesh], { assetName: "GreatAxe011_IronCrest", category: "Sword" });
  assert.match(wrongCategory.errors.join(" "), /类别/);
  const mixed = buildFamilyPackagePlan("weapon", mesh, [mesh, "C:/work/Weapon/GreatAxe/GreatAxe012_Other/Mesh/SK_GreatAxe012_Other.fbx"], {
    assetName: "GreatAxe011_IronCrest", category: "GreatAxe"
  });
  assert.match(mixed.errors.join(" "), /另一资产包/);
});

test("Common and Temp engine folders are not monster import categories", () => {
  const file = "C:/work/Monster/0_Common/Animation/SharedIdle.uasset";
  const plan = buildFamilyPackagePlan("monster", file, [file], { assetName: "Common001_SharedMotion", category: "0_Common" });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(" "), /请选择怪物类别/);
});

test("confirmed fields organize a raw art package without requiring the UE destination folder structure", () => {
  const file = "C:/art/Monster/delivery/final_model.fbx";
  const plan = buildFamilyPackagePlan("monster", file, [file], { assetName: "Boss042_StoneGolem", category: "1_Boss" });
  assert.equal(plan.ok, true, plan.errors.join("; "));
  assert.equal(plan.assetName, "Boss042_StoneGolem");
  assert.equal(plan.files[0].relativePath, "Mesh/SkeletalMesh/SK_StoneGolem.fbx");
  const previous = "C:/art/Monster/1_Boss/Boss041_OldName/Mesh/SK_OldName_01.fbx";
  const renamed = buildFamilyPackagePlan("monster", previous, [previous], { assetName: "Boss042_StoneGolem", category: "1_Boss" });
  assert.equal(renamed.ok, true, renamed.errors.join("; "));
  assert.equal(renamed.files[0].normalizedName, "SK_StoneGolem_01.fbx");
});

test("The shared drag scanner creates editable drafts for Monster, NPC, and Weapon", async () => {
  const cases = [
    ["monster", "Monster/2_MiniBoss/MiniBoss007_AshHound", "SK_AshHound_01.fbx", "2_MiniBoss", "007", "AshHound"],
    ["npc", "NPC/Guard/Guard009_Watchman", "SK_Watchman.fbx", "Guard", "009", "Watchman"],
    ["weapon", "Weapon/GreatAxe/GreatAxe008_ForestBite", "SK_GreatAxe008_ForestBite.fbx", "GreatAxe", "008", "ForestBite"]
  ];
  for (const [family, packagePath, meshName, category, serial, name] of cases) {
    const root = `C:/art/${packagePath}`;
    const files = [`${root}/Mesh/SkeletalMesh/${meshName}`];
    const scope = buildScope(files, { folderName: root.split("/").pop() });
    await scope.applyQuickDropImport([root], family);
    const form = scope.state.drafts[0]?.form;
    assert.equal(form?.assetType, family);
    assert.equal(form?.subCategory, category);
    assert.equal(form?.assetName, family === "monster" ? `SK_${name}_01` : root.split("/").pop());
    assert.equal(form?.characterFields?.serial, family === "monster" ? "" : serial);
    assert.equal(form?.characterFields?.name, name);
    assert.equal(form?.characterFields?.confirmed, false);
    assert.deepEqual(form?.characterPackageFiles?.map((file) => file.replace(/\\/g, "/")), files);
  }
});

test("a raw monster mesh supplies name and form automatically without an invented asset serial", async () => {
  const root = "C:/art/delivery/SK_Executioner_01";
  const files = [`${root}/SK_Executioner_01.fbx`, `${root}/T_Executioner_01_D.png`];
  const scope = buildScope(files, { folderName: "SK_Executioner_01" });
  await scope.applyQuickDropImport([root], "monster");
  const form = scope.state.drafts[0].form;
  assert.equal(form.assetName, "SK_Executioner_01");
  assert.equal(form.characterFields.name, "Executioner");
  assert.equal(form.characterFields.serial, "");
  assert.deepEqual(form.characterFields.formIds, ["01"]);
  assert.equal(form.subCategory, "");
  const plan = buildFamilyPackagePlan("monster", files[0], files, {
    assetName: form.assetName, category: "1_Boss", name: form.characterFields.name
  });
  assert.equal(plan.ok, true, plan.errors.join("; "));
  assert.equal(plan.files[0].normalizedName, "SK_Executioner_01.fbx");
});

test("later monster forms share a name hint, require an explicit relationship, and import separately", () => {
  const options = { assetName: "Executioner", category: "1_Boss", name: "Executioner" };
  const first = buildFamilyPackagePlan("monster", "", ["C:/art/SK_Executioner_01.fbx"], options);
  const second = buildFamilyPackagePlan("monster", "", ["C:/art/SK_Executioner_02.fbx"], options);
  assert.equal(first.ok && second.ok, true);
  assert.equal(first.monsterNameKey, second.monsterNameKey);
  assert.equal(first.entityKey, undefined);
  assert.equal(second.entityKey, undefined);
  assert.deepEqual(first.forms.map((form) => form.id), ["01"]);
  assert.deepEqual(second.forms.map((form) => form.id), ["02"]);
  const combined = buildFamilyPackagePlan("monster", "", [
    "C:/art/SK_Executioner_01.fbx", "C:/art/SK_Executioner_02.fbx", "C:/art/SKEL_Executioner.uasset"
  ], options);
  assert.equal(combined.ok, false);
  assert.match(combined.errors.join(" "), /每个形态分别/);
  assert.equal(combined.forms.length, 2);
  assert.deepEqual(combined.sharedFiles, []);
});

test("monster association is explicit and rejects wrong owners, missing records, and duplicate forms", () => {
  const plan = buildFamilyPackagePlan("monster", "", ["C:/art/SK_StoneGolem_02.fbx"], { assetName: "StoneGolem", category: "1_Boss" });
  const records = [
    { id: "first", assetType: "monster", name: "StoneGolem", meta: { category: "1_Boss", character: { name: "StoneGolem", entityKey: "monster:asset:first", formIds: ["01"] } } },
    { id: "other", assetType: "monster", name: "StoneGolem", meta: { category: "1_Boss", character: { name: "StoneGolem", entityKey: "monster:asset:other", formIds: ["02"] } } }
  ];
  assert.deepEqual(resolveMonsterAssociation(plan, "", records), { ok: true, entityKey: "" });
  assert.deepEqual(resolveMonsterAssociation(plan, "first", records), { ok: true, entityKey: "monster:asset:first" });
  assert.match(resolveMonsterAssociation(plan, "other", records).message, /相同形态/);
  assert.equal(resolveMonsterAssociation(plan, "deleted", records).ok, false);
  assert.equal(resolveMonsterAssociation({ ...plan, category: "3_Elite" }, "first", records).ok, false);
  assert.equal(resolveMonsterAssociation({ ...plan, fields: { name: "OtherMonster" } }, "first", records).ok, false);
});

test("unmatched textures block import, projects are excluded, numbered weapons retain their form", async () => {
  const root = "C:/art/Monster/SK_Executioner_01/scenes";
  const files = [
    `${root}/SK_Executioner_01.fbx`,
    `${root}/SK_Executioner_01.ma`,
    `${root}/SK_Executioner_01_WP_GreatSword.fbx`,
    `${root}/Texture/T_Executioner_01_WP_GreatSword_D.tga`,
    `${root}/SK_Executioner_02/sp/SK_Executioner_02.spp`,
    `${root}/SK_Executioner_02/Texture/T_Executioner_02_Hat_Emissive.tga`,
    `${root}/SK_Executioner_02/Texture/T_Executioner_02_Shoulder_Arm_OpacityMask.tga`
  ];
  const scope = buildScope(files, { folderName: "scenes" });
  await scope.applyQuickDropImport([root], "monster");
  const fields = scope.state.drafts[0].form.characterFields;
  assert.equal(fields.name, "Executioner");
  assert.deepEqual(fields.formIds, ["01"]);
  const plan = buildFamilyPackagePlan("monster", root, files, { assetName: "Executioner", category: "1_Boss" });
  assert.equal(plan.ok, false);
  assert.ok(plan.validationIssues.some((issue) => issue.code === "wrong-form"));
  assert(plan.files.every(item => !/\.(ma|spp)$/i.test(item.sourcePath)));
  assert.equal(plan.files[1].normalizedName, "SK_Executioner_01_WP_GreatSword.fbx");
  assert.equal(plan.files[1].componentRole, "weapon");
  assert.equal(plan.files[1].componentName, "GreatSword");
  assert.equal(plan.files[1].sharedAcrossForms, undefined);
  assert.equal(plan.files[1].formId, "01");
  assert.equal(plan.files[2].componentName, "GreatSword");
  assert.equal(plan.files[2].formId, "01");
  assert.equal(plan.files[3].textureMapCode, "Emissive");
  assert.equal(plan.files[4].normalizedName, "T_Executioner_02_Shoulder_Arm_A.tga");
  assert.deepEqual(plan.forms.map((form) => form.id), ["01"]);
  for (const index of [3, 4]) {
    assert.equal(plan.files[index].formId, "");
    assert.equal(plan.files[index].unresolvedFormToken, "02");
    assert.ok(plan.unassignedFiles.includes(plan.files[index].relativePath));
    assert.ok(!plan.sharedFiles.includes(plan.files[index].relativePath));
  }
});

test("revision names alone are accepted, but competing models and same-slot textures require cleanup", () => {
  const body = "C:/art/SK_IronWarden_01.fbx";
  const options = { assetName: "IronWarden", category: "3_Elite" };
  for (const suffix of ["final", "clean", "v2", "backup"]) {
    const candidate = `C:/art/SK_IronWarden_01_${suffix}.fbx`;
    const single = buildFamilyPackagePlan("monster", "", [candidate], options);
    assert.equal(single.ok, true, single.errors.join("; "));
    assert.equal(single.files[0].normalizedName, "SK_IronWarden_01.fbx");
    const mixed = buildFamilyPackagePlan("monster", "", [body, candidate], options);
    assert.equal(mixed.ok, false);
    assert.ok(mixed.validationIssues.some((issue) => issue.code === "competing-versions" && issue.files.length === 2));
  }
  const textures = [body, "C:/art/T_IronWarden_01_Body_D.tga", "C:/art/T_IronWarden_01_Body_D_final.png"];
  assert.equal(auditMonsterPackage(textures).ok, false);
  assert.equal(auditMonsterPackage([body, textures[2]]).ok, true);
  const aliases = [body, "C:/art/T_IronWarden_01_Body_A.tga", "C:/art/T_IronWarden_01_Body_OpacityMask.tga"];
  assert.ok(auditMonsterPackage(aliases).issues.some((issue) => issue.code === "competing-versions"));
});

test("distinct parts, maps and editable source projects coexist without false duplicate warnings", () => {
  const files = ["SK_IronWarden_01_Body.fbx", "SK_IronWarden_01_Head.fbx", "SK_IronWarden_01_WP_Axe.fbx",
    "T_IronWarden_01_Body_D.tga", "T_IronWarden_01_Body_N.tga", "T_IronWarden_01_Head_D.tga", "SK_IronWarden_01.ma"];
  assert.equal(auditMonsterPackage(files).ok, true);
  assert.equal(auditMonsterPackage([...files, "T_FrostWorm_01_D.tga"]).ok, false);
  assert.equal(auditMonsterPackage([...files, "unknown.bin"]).ok, false);
  assert.equal(auditMonsterPackage([...files, "notes.txt"]).ok, true);
});

test("wrong-form owned weapons cannot become shared to bypass validation", () => {
  const options = { assetName: "IronWarden", category: "3_Elite" };
  const mismatch = buildFamilyPackagePlan("monster", "", ["SK_IronWarden_01.fbx", "SK_IronWarden_02_WP_Axe.fbx"], options);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.files[1].sharedAcrossForms, undefined);
  const shared = buildFamilyPackagePlan("monster", "", ["SK_IronWarden_01.fbx", "SK_IronWarden_WP_Axe.fbx"], options);
  assert.equal(shared.ok, true, shared.errors.join("; "));
  assert.equal(shared.files[1].normalizedName, "SK_IronWarden_WP_Axe.fbx");
  assert.equal(shared.files[1].sharedAcrossForms, true);
});

test("arbitrary model suffixes require evidence of parts, not a list of forbidden revision words", () => {
  for (const tails of [["", "take7"], ["publish", "deliver"], ["自定义甲", "自定义乙"]]) {
    const files = tails.map((tail) => `SK_IronWarden_01${tail ? `_${tail}` : ""}.fbx`);
    const report = auditMonsterPackage(files);
    assert.equal(report.ok, false);
    assert.ok(report.issues.some((issue) => issue.code === "ambiguous-model-relationship"));
  }
  const parts = ["SK_IronWarden_01_Tentacle.fbx", "SK_IronWarden_01_Carapace.fbx",
    "T_IronWarden_01_Tentacle_D.tga", "T_IronWarden_01_Carapace_D.tga"];
  assert.equal(auditMonsterPackage(parts).ok, true);
  const overlapping = ["SK_IronWarden_01.fbx", "T_IronWarden_01_Body_take7_D.tga", "T_IronWarden_01_Body_publish_D.tga"];
  assert.ok(auditMonsterPackage(overlapping).issues.some((issue) => issue.code === "overlapping-texture-groups"));
  assert.equal(auditMonsterPackage([...overlapping, "MI_IronWarden_01_Body_take7.uasset", "MI_IronWarden_01_Body_publish.uasset"]).ok, true);
});

test("a weapon or a misleading image prefix cannot establish a monster body form", () => {
  for (const files of [
    ["C:/art/SK_IronWarden_02_WP_Axe.fbx", "C:/art/T_IronWarden_02_D.tga"],
    ["C:/art/SK_IronWarden_02.png", "C:/art/SK_IronWarden_02.ma"]
  ]) {
    const plan = buildFamilyPackagePlan("monster", "", files, { assetName: "IronWarden", category: "3_Elite" });
    assert.equal(plan.ok, false);
    assert.deepEqual(plan.forms, []);
    assert.match(plan.errors.join(" "), /主体模型/);
  }
});
test('inspected model content controls mesh prefix/folder without changing family identities or forms', () => {
  const { applyFamilyModelAnalyses } = require('../electron/services/characterFamilyRules');
  const path = require('node:path');
  for (const family of ['monster', 'npc', 'weapon']) {
    const file = { sourcePath: 'C:/source/SK_Example_01.fbx', normalizedName: 'SK_Example_01.fbx', relativePath: 'Mesh/SkeletalMesh/SK_Example_01.fbx', role: 'skeletalMesh', formId: '01' };
    const plan = { family, assetName: 'Example', files: [file], forms: [{ id: '01', files: [file.relativePath] }] };
    applyFamilyModelAnalyses(plan, new Map([[path.resolve(file.sourcePath).toLowerCase(), { meshKind: 'staticMesh' }]]));
    assert.equal(file.normalizedName, 'SM_Example_01.fbx');
    assert.equal(file.relativePath, 'Mesh/StaticMesh/SM_Example_01.fbx');
    assert.equal(plan.assetName, 'Example');
    assert.equal(plan.forms[0].id, '01');
    assert.deepEqual(plan.forms[0].files, [file.relativePath]);
  }
});
