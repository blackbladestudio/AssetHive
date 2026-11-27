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
const { getCharacterCategoryNodes, getCharacterCategoryDisplayLabel, matchesCharacterNavigation, getCharacterNavigationSelection } = loaded.exports;
const asset = (assetType, category, extra = {}) => ({ assetType, meta: { category }, categories: [], ...extra });

test('NPC aliases agree across navigation, source inference and destination folders', () => {
  const backend = require('../electron/services/characterImport');
  for (const [alias, category] of [['H', 'Human'], ['nh', 'Nonhuman'], ['Human', 'Human'], ['Nonhuman', 'Nonhuman']]) {
    assert.equal(getCharacterNavigationSelection('character-npc:' + alias).category, category);
    assert(matchesCharacterNavigation(asset('npc', alias), 'character-npc:' + category));
    assert.equal(loaded.exports.inferCharacterAssetType(['C:/Art/' + alias + '/SK_Keeper_01.fbx']), 'npc');
    assert.equal(loaded.exports.inferFamilyPackageIdentity('npc', 'C:/Art/' + alias, ['SK_Keeper_01.fbx']).category, category);
    assert.equal(loaded.exports.getCharacterDestinationRelativePath('npc', alias), 'Character\\NPC\\' + category);
    assert.deepEqual(backend.buildCharacterRelativeRoot('npc', alias), ['Character', 'NPC', category]);
  }
  const { inferNpcCategory } = require('../shared/npcCategories.mjs');
  assert.equal(inferNpcCategory(['C:/Art/H007_Test/SM_Test.fbx']), '');
  assert.equal(inferNpcCategory(['C:/NPC/Guard/SK_Keeper_01.fbx']), '');
  assert(matchesCharacterNavigation(asset('npc', 'Guard'), 'character-npc'));
});

test('PDF source folders identify gameplay and item even with artist model names', () => {
  for (const [folder, category, name] of [
    ['GamePlay_WeaponCase_WoodenCase', 'Gameplay/Int_Loot/WeaponCase', 'WoodenCase'],
    ['Item_Eat_009010001', 'Item/Consumable/Eat', '009010001'],
    ['GamePlay_QiStatue_SouthernStatue', 'Gameplay/Int_Loot/Qi/Statue', 'SouthernStatue']
  ]) {
    const found = loaded.exports.inferFamilyPackageIdentity('item', 'C:/Art/' + folder, ['artist_model.fbx']);
    assert.equal(found.category, category);
    assert.equal(found.name, name);
    assert.ok(found.assetName);
    const backend = require('../electron/services/characterFamilyRules');
    assert.equal(backend.parsePackagePath('item', 'C:/Art/' + folder).category, category);
  }
  const npc = loaded.exports.inferFamilyPackageIdentity('npc', 'C:/Art/Merchant_FireKeeper_防火女', ['SM_FireKeeper_01.fbx']);
  assert.equal(npc.category, 'Merchant');
  assert.equal(npc.name, 'FireKeeper');
});

test('gameplay selectors offer only direct children and keep blue-only leaves valid', () => {
  const { selectionLevels } = require('../shared/gameplayCategories.mjs');
  const qi = selectionLevels('Gameplay/Int_Loot/Qi/Statue');
  assert.equal(qi.length, 4);
  assert.deepEqual(qi[3].options.map(option => option.code), ['Statue', 'Ding']);
  const item = selectionLevels('Item');
  assert.deepEqual(item[1].options.map(option => option.code), ['Dropped', 'Consumable']);
  assert.equal(selectionLevels('Item/Dropped').length, 3);
  assert.equal(selectionLevels('Gameplay/Int_Worship').length, 2);
});

test('gameplay list filters cascade, clear descendants and keep parent asset scope', () => {
  const { filterLevels, categories } = require('../shared/gameplayCategories.mjs');
  const empty = filterLevels('');
  assert.equal(empty.length, 3);
  assert.deepEqual(empty.map(level => level.disabled), [false, true, true]);
  assert.equal(empty[1].terminal, false);
  const records = categories.map(category => asset('item', category));
  const visible = value => records.filter(record => matchesCharacterNavigation(record, value ? 'character-item:' + encodeURIComponent(value) : 'character-item'));
  for (const category of categories) {
    const levels = filterLevels(category);
    assert.equal(visible(category).length, 1);
    for (const level of levels.filter(level => !level.disabled)) {
      assert(level.options.every(option => !option.label.includes(' / ')));
      assert(level.options.some(option => option.value === level.value));
      // Choosing "all" at this level keeps only its parent path.
      assert(visible(level.allValue).some(record => record.meta.category === category));
      if (level.allValue) {
        const cleared = filterLevels(level.allValue);
        assert.equal(cleared[level.allValue.split('/').length].value, '');
      }
    }
  }
  const qi = filterLevels('Gameplay/Int_Loot/Qi/Statue');
  assert.equal(qi[3].allValue, 'Gameplay/Int_Loot/Qi');
  assert.equal(visible(qi[3].allValue).length, 2);
  assert.equal(filterLevels('Gameplay/Int_Door')[2].options.some(option => option.code === 'Statue'), false);
  assert.deepEqual(filterLevels('Item/Consumable/Eat')[2].options.map(option => option.code), ['Eat','Drink','Crush','Use','Throw','FlagSetup']);
  for (const category of ['Int_Worship', 'Int_TengyunFormation', 'Tombstone']) {
    const levels = filterLevels('Gameplay/' + category);
    assert.equal(levels[2].disabled, true);
    assert.equal(levels[2].terminal, true);
    assert.equal(visible('Gameplay/' + category).length, 1);
  }
  assert.equal(visible('').length, categories.length);
});

test('face Scatter is retained as its own texture channel', () => {
  const file = 'T_F01_Face001_Scatter.tga';
  assert.equal(loaded.exports.classifyCharacterPackageFile(file), 'texture');
  assert.equal(loaded.exports.inferCharacterTextureType(file), 'Scatter');
  assert.equal(require('../shared/heroMaterialRules.mjs').heroTextureSuffix(file, 'Face'), 'Scatter');
  const backend = require('../electron/services/characterImport');
  assert.equal(backend.inferCharacterTextureType(file), 'Scatter');
  assert.equal(backend.buildCharacterTextureBaseName('F01_Face001', '', 'Scatter', file, { variant: 'Face' }), 'T_F01_Face001_Scatter');
});

test('gameplay tree keeps repeated leaf names scoped and filters descendants', () => {
  const { categories } = require('../shared/gameplayCategories.mjs');
  assert.equal(categories.length, 50);
  const nodes = getCharacterCategoryNodes('item', []);
  assert.deepEqual(nodes.map(node => node.label), ['交互物资源', '道具资源']);
  const door = asset('item', 'Gameplay/Int_Door/Standard');
  assert.equal(matchesCharacterNavigation(door, 'character-item:Gameplay'), true);
  assert.equal(matchesCharacterNavigation(door, 'character-item:Gameplay%2FInt_Door'), true);
  assert.equal(matchesCharacterNavigation(door, 'character-item:Gameplay%2FInt_Elevator%2FStandard'), false);
  assert.equal(getCharacterCategoryDisplayLabel('item', door.meta.category), '交互物资源 / 门 / 常规门');
  for (const category of categories) {
    const { gameplayIdentity } = require('../shared/gameplayNaming.mjs');
    const name = category.startsWith('Item/') ? '901010001' : 'TestObject';
    const identity = gameplayIdentity(category, name);
    const folder = 'C:/Art/GameplayItem/' + category + '/' + identity.assetName;
    assert.equal(loaded.exports.inferCharacterAssetType([folder]), 'item');
    assert.equal(loaded.exports.inferFamilyPackageIdentity('item', folder, ['SM_TestObject.fbx']).category, category);
    const backend = require('../electron/services/characterFamilyRules');
    const plan = backend.buildFamilyPackagePlan('item', folder, ['SM_TestObject.fbx'], { assetName: identity.assetName, category, name });
    assert.equal(plan.ok, true, JSON.stringify(plan.errors));
    assert.equal(plan.relativeDirectory, 'GameplayItem/' + category + '/' + identity.assetName);
    assert.equal(backend.parsePackagePath('item', folder).category, category);
  }
});

test('highlighted gameplay subcategories alone form the filename prefix', () => {
  const { gameplayPrefix, gameplayIdentity, gameplayFileStem } = require('../shared/gameplayNaming.mjs');
  const cases = {
    'Gameplay/Int_Loot/WeaponCase': 'WeaponCase',
    'Gameplay/Int_Loot/Qi/Statue': 'QiStatue',
    'Gameplay/Int_Loot/Qi/Ding': 'QiDing',
    'Gameplay/Int_Door/StandardDoor': 'StandardDoor',
    'Gameplay/Int_Door/QiDoor': 'QiDoor',
    'Gameplay/Int_Elevator/AutoElevator': 'AutoElevator',
    'Gameplay/Int_EscapePoint/TokenEscapePoint': 'TokenEscapePoint',
    'Gameplay/Trap/ArrowTrap': 'ArrowTrap',
    'Gameplay/Trap/TrapControllerTrap': 'TrapControllerTrap',
    'Gameplay/Destructible/BarrelDestructible': 'BarrelDestructible',
    'Gameplay/Int_Worship': 'Int_Worship',
    'Gameplay/Int_TengyunFormation': 'Int_TengyunFormation',
    'Gameplay/Tombstone': 'Tombstone',
    'Item/Consumable/Eat': 'Eat'
  };
  for (const [category, prefix] of Object.entries(cases)) {
    assert.equal(gameplayPrefix(category), prefix);
    const name = category.startsWith('Item/') ? '001234567' : 'WoodenCase';
    const identity = gameplayIdentity(category, name);
    assert.equal(identity.assetName, prefix + '_' + name);
    assert.equal(loaded.exports.buildCharacterAssetName('item', { displayNameEn: name }, category), identity.assetName);
    assert.equal(gameplayIdentity(category, identity.assetName).assetName, identity.assetName);
    assert.equal(loaded.exports.inferFamilyPackageIdentity('item', 'C:/Art/' + identity.assetName, ['SM_' + identity.assetName + '.fbx']).name, name);
  }
  assert.equal(gameplayIdentity('Item/Consumable/Eat', 'Herb').assetName, '');
  assert.equal(gameplayIdentity('Gameplay/Int_Door/StandardDoor', '901010001').assetName, '');
  const prefixList = require('../shared/gameplayCategories.mjs').categories.map(gameplayPrefix);
  assert.equal(new Set(prefixList).size, prefixList.length);
  assert.equal(gameplayFileStem('WeaponCase_WoodenCase', 'texture', 'T_WoodenCase_Wood_01_Opacity'), 'T_WeaponCase_WoodenCase_Wood_01_A');
  assert.equal(loaded.exports.previewFamilyFileName('item', 'WeaponCase_WoodenCase', 'T_WoodenCase_Wood_01_Opacity.tga'), 'T_WeaponCase_WoodenCase_Wood_01_A.tga');
});

test('new weapon types are recognized outside the library Weapon folder', () => {
  for (const type of ['Dagger', 'DualHands', 'DualAxe', 'GreatSword']) {
    assert.equal(loaded.exports.inferCharacterAssetType([`C:/Art/${type}001_Test/SK_${type}001_L.fbx`]), 'weapon');
  }
});

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
  assert.deepEqual(characterImportDefaults('character-suit:Outfit','suit'), { category: '', fields: {} });
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
  assert.equal(buildMonsterAssetName("Executioner", ["base"]), "SK_Executioner_01");
  assert.equal(buildMonsterAssetName("Executioner", ["01", "02"]), "");
  assert.equal(previewFamilyFileName("monster", "SK_Executioner_01", "T_Executioner_01_Body_D.tga", "Executioner"), "T_Executioner_01_Body_D.tga");
  const plan = require("../electron/services/characterFamilyRules").buildFamilyPackagePlan("monster", "", ["SK_Executioner_01.fbx", "SK_Executioner_01_WP_Axe.fbx"], {
    assetName: "SK_Executioner_01", name: "Executioner", category: "3_Elite"
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.files.map((file) => file.normalizedName), ["SK_Executioner_01.fbx", "SK_Executioner_01_WP_Axe.fbx"]);
});

test("NPC uses the monster-style English name and two-digit form without a category serial", () => {
  const { buildCharacterAssetName, previewFamilyFileName, inferFamilyPackageIdentity } = loaded.exports;
  const fields = { name: "ShangExecutioner", displayNameEn: "ShangExecutioner", formIds: ["01"], serial: "" };
  assert.equal(buildCharacterAssetName("npc", fields, "Merchant"), "SK_ShangExecutioner_01");
  assert.equal(buildCharacterAssetName("npc", { ...fields, formIds: [] }, "Merchant"), "");
  assert.equal(previewFamilyFileName("npc", "SK_ShangExecutioner_01", "SK_Merchant001_ShangExecutioner.fbx"), "SK_ShangExecutioner_01.fbx");
  assert.equal(previewFamilyFileName("npc", "SK_ShangExecutioner_01", "T_ShangExecutioner_Body_D.tga"), "T_ShangExecutioner_01_Body_D.tga");
  assert.equal(previewFamilyFileName("npc", "SK_ShangExecutioner_01", "T_ShangExecutioner_01_Body_D.tga"), "T_ShangExecutioner_01_Body_D.tga");
  assert.deepEqual(inferFamilyPackageIdentity("npc", "C:/NPC/Merchant/delivery", [
    "C:/NPC/Merchant/delivery/SK_ShangExecutioner_01.fbx",
    "C:/NPC/Merchant/delivery/T_ShangExecutioner_01_Body_D.tga"
  ]), {
    assetName: "SK_ShangExecutioner_01", category: "Merchant", serial: "", name: "ShangExecutioner", variant: "01", formIds: ["01"]
  });
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
  assert.deepEqual(getCharacterCategoryNodes("suit", []).map((node) => node.label), ["套装衣服", "脸部", "头发"]);
  assert.deepEqual(getCharacterCategoryNodes("suit", [])[0].children.map(node => node.label), ["男装", "女装"]);
  assert.ok(getCharacterCategoryNodes("monster", []).every((node) => node.children.length === 0));
});

test("NPC offers Human/Nonhuman and weapons group categories by equipment count", () => {
  const assets = [
    asset("npc", "Scholar"), asset("npc", "scholar"), asset("npc", "Guard"),
    asset("weapon", "Spear"), asset("weapon", "Axe"), asset("3d", "Bow"),
    asset("weapon", "", { tags: ["Sword"], categories: ["character", "weapon", "Hammer"] })
  ];
  assert.deepEqual(getCharacterCategoryNodes("npc", assets).map((node) => node.label), ["人类", "非人类"]);
  const nodes = getCharacterCategoryNodes('weapon', assets);
  assert.deepEqual(nodes.map(node => node.label), ['弓箭', '匕首', '同类双持', '巨斧', '巨剑', '玉器', '长剑', '参差剑', '盾斧', '长枪', '短剑']);
  assert(nodes.every(node => node.children.length === 0));
  assert(nodes.every(node => getCharacterCategoryDisplayLabel('weapon', getCharacterNavigationSelection(node.id).category, 'zh') === node.label));
  assert.deepEqual(nodes.map(node => getCharacterCategoryDisplayLabel('weapon', getCharacterNavigationSelection(node.id).category, 'en')),
    ['Bow', 'Dagger', 'DualHands', 'GreatAxe', 'GreatSword', 'Jade', 'LongSword', 'PairedSwords', 'ShieldAxe', 'Spear', 'Sword']);
  const combined = asset('weapon', 'Sword', { meta: { category: 'Sword', character: { weaponAssembly: 'combined' } } });
  assert(matchesCharacterNavigation(combined, 'character-weapon:combined%2FSword'));
  assert(!matchesCharacterNavigation(combined, 'character-weapon:single%2FSword'));
  assert.deepEqual(loaded.exports.characterImportDefaults('character-weapon:combined%2FSword', 'weapon'),
    { category: 'Sword', fields: { weaponAssembly: 'combined', weaponType: 'Sword' } });
  assert.deepEqual(getCharacterCategoryNodes("npc", []).map(node => node.label), ["人类", "非人类"]);
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
  const suits = [asset("suit", "Male_01"), asset("suit", "Female_01"), asset("suit", "Face"), asset("suit", "Hair")];
  assert.deepEqual(suits.filter((item) => matchesCharacterNavigation(item, "character-suit:Outfit")), suits.slice(0, 2));
  assert.equal(getCharacterCategoryDisplayLabel("suit", "Outfit"), "套装衣服");
});

test('nine dropped subcategories use their exact yellow name plus numeric ID without duplicating Dropped', () => {
  const {categories,selectionLevels}=require('../shared/gameplayCategories.mjs');
  const {gameplayIdentity,gameplayFileStem,gameplayCategoryFromName}=require('../shared/gameplayNaming.mjs');
  const children=['Weapon','Armor','Accessory','Ashes','Consumable','Craft','Loot','Currency','SpecialItem'];
  assert.equal(selectionLevels('Item/Dropped')[2].options.length,9);
  assert(!categories.includes('Item/Dropped'));
  for(const suffix of children){
    const prefix='Dropped'+suffix,category='Item/Dropped/'+prefix, name=prefix+'_009010001';
    assert(categories.includes(category));
    assert.equal(gameplayIdentity(category,'009010001').assetName,name);
    assert.equal(gameplayCategoryFromName('Item_'+name),category);
    assert.equal(loaded.exports.inferFamilyPackageIdentity('item','C:/Art/Item_'+name,['artist.fbx']).category,category);
    for(const [role,tag] of [['staticMesh','SM'],['skeletalMesh','SK'],['texture','T']])
      assert.equal(gameplayFileStem(name,role,tag+'_'+name+(role==='texture'?'_D':'')),tag+'_'+name+(role==='texture'?'_D':''));
  }
  assert.equal(gameplayIdentity('Item/Dropped','009010001').assetName,'Dropped_009010001');
});
