const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const ts = require("typescript");
const file = path.resolve(__dirname, "../src/ui/characterImport.ts");
const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
}).outputText;
const loaded = { exports: {} };
new Function("require", "module", "exports", compiled)(createRequire(file), loaded, loaded.exports);
const { getCharacterCategoryNodes, matchesCharacterNavigation, getCharacterNavigationSelection } = loaded.exports;
const asset = (assetType, category, extra = {}) => ({ assetType, meta: { category }, categories: [], ...extra });

test('every character leaf seeds the matching import subtype and identity', () => {
  const { characterImportDefaults } = loaded.exports;
  for (const family of ['suit','monster','npc','weapon']) {
    const categories = family === 'suit' ? ['Face','Hair','Male_01','Female_01'] : family === 'monster' ? ['1_Boss','3_Elite'] : family === 'npc' ? ['Guard'] : ['Sword','Bow'];
    for (const category of categories) {
      const defaults = characterImportDefaults(`character-${family}:${category}`,family);
      assert.equal(defaults.category,category);
      if (['Face','Hair'].includes(category)) assert.equal(defaults.fields.variant,category);
      if (family==='weapon') assert.equal(defaults.fields.weaponType,category);
    }
  }
  assert.deepEqual(characterImportDefaults('character-suit:Female_01','suit').fields,{gender:'Female',bodyCode:'01'});
  assert.equal(characterImportDefaults('character-suit:Face','monster').category,'');
});

test("Monster UE name composes name and detected form without requiring a category to display it", () => {
  const { buildMonsterAssetName, buildCharacterAssetName, getMonsterFieldIssues, previewFamilyFileName } = loaded.exports;
  const fields = { name: "Executioner", formIds: ["01"] };
  assert.equal(buildMonsterAssetName(fields.name, fields.formIds), "SK_Executioner_01");
  assert.equal(buildCharacterAssetName("monster", fields, ""), "");
  assert.equal(buildCharacterAssetName("monster", fields, "3_Elite"), "SK_Executioner_01");
  assert.deepEqual(getMonsterFieldIssues(fields, ""), { category: true, name: false, form: false });
  assert.deepEqual(getMonsterFieldIssues({ name: "", formIds: [] }, "3_Elite"), { category: false, name: true, form: true });
  assert.equal(buildMonsterAssetName("Executioner", ["base"]), "SK_Executioner");
  assert.equal(buildMonsterAssetName("Executioner", ["01", "02"]), "");
  assert.equal(previewFamilyFileName("monster", "SK_Executioner_01", "T_Executioner_01_Body_D.tga", "Executioner"), "T_Executioner_01_Body_D.tga");
  const plan = require("../electron/services/characterFamilyRules").buildFamilyPackagePlan("monster", "", ["SK_Executioner_01.fbx", "SK_Executioner_01_WP_Axe.fbx"], {
    assetName: "SK_Executioner_01", name: "Executioner", category: "3_Elite"
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.files.map((file) => file.normalizedName), ["SK_Executioner_01.fbx", "SK_Executioner_01_WP_Axe.fbx"]);
});

test("Monster preview and backend use the same audit and normalize a single revision consistently", () => {
  const backend = require("../electron/services/characterFamilyRules");
  const cases = [
    ["SK_IronWarden_01_final.fbx", "T_IronWarden_01_Body_D_final.tga"],
    ["SK_IronWarden_01.fbx", "SK_IronWarden_01——final.fbx"],
    ["SK_IronWarden_01_clean.fbx", "SK_IronWarden_01_final.fbx"],
    ["SK_IronWarden_01.fbx", "T_IronWarden_02_D.tga"],
    ["SK_IronWarden_01.fbx", "T_IronWarden_01_Body_02_D.tga", "T_IronWarden_01_Body_03_D.tga"],
    ["SK_IronWarden_01.fbx", "SK_IronWarden_01_LOD1.fbx"]
  ];
  for (const files of cases) {
    const report = loaded.exports.auditMonsterPackage(files);
    const plan = backend.buildFamilyPackagePlan("monster", "", files, { assetName: "IronWarden", category: "3_Elite" });
    assert.deepEqual(report.issues, plan.validationIssues);
    if (report.ok) for (const file of plan.files) {
      assert.equal(loaded.exports.previewFamilyFileName("monster", "IronWarden", file.sourcePath), file.normalizedName);
    }
  }
  assert.equal(loaded.exports.auditMonsterPackage(cases[0]).ok, true);
  assert.equal(loaded.exports.auditMonsterPackage(cases[1]).ok, false);
  assert.equal(loaded.exports.auditMonsterPackage(cases[2]).ok, false);
  assert.equal(loaded.exports.auditMonsterPackage(cases[4]).ok, true);
  assert.equal(loaded.exports.auditMonsterPackage(cases[5]).ok, true);
});

test("linked monster cards are adjacent and phase ordered without merging same-name independent monsters", () => {
  const { groupMonsterCards, buildMonsterGroups, getMonsterLinkCandidates } = loaded.exports;
  const make = (id, form, entityKey) => ({ id, name: "IronWarden", source: "custom", assetType: "monster",
    meta: { category: "1_Boss", character: { name: "IronWarden", formIds: [form], ...(entityKey ? { entityKey } : {}) } } });
  const a = make("a", "01", "monster:asset:a"), b = make("b", "02", "monster:asset:a"), independent = make("c", "01");
  const prop = { id: "prop", assetType: "3d" };
  const records = [b, prop, independent, a];
  assert.deepEqual(groupMonsterCards(records).map((item) => item.id), ["a", "b", "prop", "c"]);
  assert.equal(buildMonsterGroups(records).size, 2);
  assert.deepEqual(getMonsterLinkCandidates(records, "IronWarden", "1_Boss").map((item) => item.formIds), [["01", "02"], ["01"]]);
  assert.deepEqual(getMonsterLinkCandidates(records, "IronWarden", "3_Elite"), []);
  assert.deepEqual(records.map((item) => item.id), ["b", "prop", "c", "a"]);
});

test("Monster preview counts body meshes only and separates unassigned resource numbers", () => {
  const { getMonsterFormSummary, getMonsterUnassignedResourceTokens, inferFamilyPackageIdentity } = loaded.exports;
  const files = [
    "C:/art/SK_IronWarden_01.fbx", "C:/art/SK_IronWarden_03_WP_Axe.fbx",
    "C:/art/T_IronWarden_02_D.tga", "C:/art/SK_IronWarden_02.spp",
    "C:/art/SK_IronWarden_04.png", "C:/art/SKEL_IronWarden_05.uasset",
    "C:/art/SK_IronWarden_06_Physics.uasset"
  ];
  assert.deepEqual(getMonsterFormSummary(files).map((form) => form.id), ["01"]);
  assert.deepEqual(inferFamilyPackageIdentity("monster", "C:/art/SK_IronWarden_02", files).formIds, ["01"]);
  assert.ok(getMonsterUnassignedResourceTokens(files).includes("02"));
  assert.deepEqual(getMonsterFormSummary([...files, "C:/art/SK_IronWarden_02.fbx"]).map((form) => form.id), ["01", "02"]);
  assert.ok(!getMonsterUnassignedResourceTokens([...files, "C:/art/SK_IronWarden_02.fbx"]).includes("02"));
});

test("empty libraries still show fixed Monster and Suit categories, never package or UE component folders", () => {
  assert.deepEqual(getCharacterCategoryNodes("monster", []).map((node) => node.label),
    ["01大首领", "02小首领", "03精英怪", "04普通怪", "05杂兵怪"]);
  assert.deepEqual(getCharacterCategoryNodes("suit", []).map((node) => node.label), ["男装", "女装", "脸部", "头发"]);
  assert.ok(getCharacterCategoryNodes("monster", []).every((node) => node.children.length === 0));
});

test("NPC uses stored categories and Weapon exposes the agreed eight categories", () => {
  const assets = [
    asset("npc", "Scholar"), asset("npc", "scholar"), asset("npc", "Guard"),
    asset("weapon", "Spear"), asset("weapon", "Axe"), asset("3d", "Bow"),
    asset("weapon", "", { tags: ["Sword"], categories: ["character", "weapon", "Hammer"] })
  ];
  assert.deepEqual(getCharacterCategoryNodes("npc", assets).map((node) => node.label), ["守卫", "学者"]);
  assert.deepEqual(getCharacterCategoryNodes("weapon", assets).map((node) => node.label), ["弓 / 箭", "巨斧", "玉器", "长剑", "双剑", "盾斧", "长枪", "短剑"]);
  assert.deepEqual(getCharacterCategoryNodes("npc", []), []);
});

test("category clicks filter on family and category, not arbitrary tags or name substrings", () => {
  const [boss, miniBoss] = getCharacterCategoryNodes("monster", []);
  const assets = [
    asset("monster", "1_Boss"), asset("monster", "2_MiniBoss", { tags: ["1_Boss"] }),
    asset("npc", "1_Boss"), asset("monster", "0_Common")
  ];
  assert.deepEqual(assets.filter((item) => matchesCharacterNavigation(item, boss.id)), [assets[0]]);
  assert.deepEqual(assets.filter((item) => matchesCharacterNavigation(item, miniBoss.id)), [assets[1]]);
  assert.equal(assets.filter((item) => matchesCharacterNavigation(item, "character-monster")).length, 3);
  assert.deepEqual(getCharacterNavigationSelection("character-weapon:Sword%20%26%20Shield"), { family: "weapon", category: "Sword & Shield" });
});
