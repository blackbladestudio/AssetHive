const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCharacterNames, normalizeMonsterNames, validCharacterChineseName } = require("../shared/characterNames.mjs");
const { normalizeCharacterFields, validateCharacterImport } = require("../electron/services/characterImport");
test('all character drafts prefill only detected names and always require a name confirmation', async () => {
  const { buildScope } = require('./import-draft-harness.cjs');
  for (const [family, folder, model] of [
    ['suit', 'M01_Heavy001_IronGuard', 'SM_M01_Heavy001_IronGuard_Arm.fbx'],
    ['monster', 'Executioner', 'SK_Executioner_01.fbx'],
    ['npc', 'Guard001_Watchman', 'SK_Watchman.fbx'],
    ['weapon', 'Sword001_LongBlade', 'SK_Sword001_LongBlade.fbx']
  ]) {
    const scope = buildScope([`C:/source/正式名称/${folder}/${model}`], { folderName: folder });
    await scope.applyQuickDropImport([`C:/source/正式名称/${folder}`], family);
    const fields = scope.state.drafts[0].form.characterFields;
    assert.equal(fields.displayNameZh, '正式名称');
    assert.equal(fields.displayNameEn, { suit: 'IronGuard', monster: 'Executioner', npc: 'Watchman', weapon: 'LongBlade' }[family]);
    assert.notEqual(fields.nameConfirmed, true);
    const errors = validateCharacterImport({ assetType: family, characterFields: fields });
    assert.ok(errors.some(e => e.includes('勾选确认')));
  }
  const files = ['C:/art/只有中文/SK_Char_Suit_M001_M01_arm.fbx'];
  const scope = buildScope(files, { folderName: '只有中文' });
  await scope.applyQuickDropImport(['C:/art/只有中文'], 'suit');
  assert.equal(scope.state.drafts[0].form.characterFields.displayNameEn, '');
  const named = buildScope(files, { folderName: '只有中文', metadata: { character: { displayNameZh: '官方中文', displayNameEn: 'OfficialOutfit' } } });
  await named.applyQuickDropImport(['C:/art/只有中文'], 'suit');
  assert.equal(named.state.drafts[0].form.characterFields.displayNameEn, 'OfficialOutfit');
});
test("monster identity follows English display name through import normalization", () => {
  const fields = { displayNameZh: "行刑官", displayNameEn: "Executioner", name: "ShangExecutor" };
  assert.equal(normalizeMonsterNames(fields).name, "Executioner");
  assert.equal(normalizeCharacterFields("monster", fields).name, "Executioner");
  assert.equal(normalizeMonsterNames({ ...fields, displayNameZh: "测试", displayNameEn: "" }).name, "");
  assert.equal(normalizeMonsterNames({ name: "Executioner" }).displayNameEn, "Executioner");
  assert.equal(fields.name, "ShangExecutor");
});

test("monster form presentation shows numbers without changing stored identities", () => {
  const { displayMonsterFormNumbers } = require("../shared/monsterPackageAudit.mjs");
  const forms = ["01", "base"];
  assert.equal(displayMonsterFormNumbers(forms), "01");
  assert.equal(displayMonsterFormNumbers(["base"]), "01");
  assert.equal(displayMonsterFormNumbers(["01", "02"]), "01 / 02");
  assert.equal(displayMonsterFormNumbers(), "");
  assert.deepEqual(forms, ["01", "base"]);
});

test("editing monster English name updates the draft identity and requires a fresh confirmation", () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ts = require('typescript');
  const source = ts.createSourceFile('App.tsx', fs.readFileSync(path.join(__dirname, '../src/ui/App.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  (function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'updateCharacterFields') declaration = node.getText(source);
    ts.forEachChild(node, visit);
  })(source);
  assert.ok(declaration);
  const uiFile = path.join(__dirname, '../src/ui/characterImport.ts');
  const uiModule = { exports: {} };
  const uiCompiled = ts.transpileModule(fs.readFileSync(uiFile, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  new Function('require', 'module', 'exports', uiCompiled)(require('node:module').createRequire(uiFile), uiModule, uiModule.exports);
  const scope = {
    ...require('../shared/characterNames.mjs'),
    ...uiModule.exports,
    isCharacterAssetType: () => true,
    getDefaultImportDestinationPath: () => 'test-library'
  };
  const compiled = ts.transpileModule(declaration, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const update = new Function('scope', `with (scope) { ${compiled}; return updateCharacterFields; }`)(scope);
  const form = { assetType: 'monster', subCategory: '3_Elite', characterFields: {
    name: 'Executioner', displayNameZh: '行刑官', displayNameEn: 'Executioner', formIds: ['01'], relatedAssetId: 'old-relation', identityConfirmed: true
  } };
  const updated = update(form, { displayNameEn: 'NewExecutioner' });
  assert.equal(updated.characterFields.name, 'NewExecutioner');
  assert.equal(updated.assetName, 'SK_NewExecutioner_01');
  assert.equal(updated.characterFields.identityConfirmed, false);
  assert.equal(updated.characterFields.relatedAssetId, '');
  const unchanged = update(form, { displayNameEn: 'Executioner' });
  assert.equal(unchanged.characterFields.identityConfirmed, true);
  assert.equal(unchanged.characterFields.relatedAssetId, 'old-relation');
  const chinese = update({ ...form, characterFields: { ...form.characterFields, displayNameZh: '测试', displayNameEn: 'CeShi', name: 'CeShi' } }, { displayNameZh: '怪物' });
  assert.equal(chinese.characterFields.name, chinese.characterFields.displayNameEn);
  assert.equal(chinese.characterFields.name, 'CeShi');
  assert.equal(chinese.characterFields.nameConfirmed, false);
  for (const family of ['suit', 'monster', 'npc', 'weapon']) {
    const base = { ...form, assetType: family, characterFields: { ...form.characterFields, suitName: 'Executioner', nameConfirmed: true } };
    const en = update(base, { displayNameEn: 'OfficialName' });
    assert.equal(en.characterFields[family === 'suit' ? 'suitName' : 'name'], 'OfficialName');
    assert.equal(en.characterFields.nameConfirmed, false);
    const zh = update(en, { displayNameZh: '正式名字' });
    assert.equal(zh.characterFields.displayNameEn, 'OfficialName');
    const cleared = update(zh, { displayNameEn: '' });
    assert.equal(cleared.characterFields[family === 'suit' ? 'suitName' : 'name'], '');
    assert.equal(cleared.characterFields.nameConfirmed, false);
    assert.equal(update(zh, { nameConfirmed: true }).characterFields.nameConfirmed, true);
  }
});
test("form switching stays above facts; related forms and vertical Chinese names remain accessible", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const app = fs.readFileSync(path.join(__dirname, "../src/ui/App.tsx"), "utf8");
  const detail = app.slice(app.indexOf('<div className="detail-list character-detail">'));
  const switcher = detail.indexOf('className="monster-form-switcher"');
  assert.ok(switcher >= 0 && switcher < detail.indexOf('t("角色资产结构"'));
  assert.ok(app.includes('caption={selectedAsset.assetType'));
  assert.ok(app.includes('{characterChineseName}</span>'));
  const css = fs.readFileSync(path.join(__dirname, "../src/ui/styles.css"), "utf8");
  assert.match(css, /character-card-chinese-name[^}]+writing-mode: vertical-rl/);
  assert.match(css, /character-card-chinese-name[^}]+font-size: min\(42px/);
  assert.match(css, /character-card-status \{[^}]+text-align: center/);
  assert.ok(css.includes('./fonts/XuanZongTi-v0.1.otf'));
  assert.doesNotMatch(css, /character-card \.character-card-summary \{ opacity: 0/);
});
test("Chinese and English names stay independent with no pinyin fallback", () => {
  for (const name of ["", "Suoyi", "Executioner", "a/女", "女".repeat(33)]) assert.equal(validCharacterChineseName(name), false);
  assert.deepEqual(normalizeCharacterNames({ displayNameZh: " 蓑衣女 " }), { displayNameZh: "蓑衣女", displayNameEn: "" });
  assert.equal(normalizeCharacterNames({ displayNameZh: "拼音格式" }).displayNameEn, "");
  assert.equal(normalizeCharacterNames({ displayNameZh: "行刑官", displayNameEn: "Executioner" }).displayNameEn, "Executioner");
  for (const family of ["suit", "monster", "npc", "weapon"]) {
    const fields = normalizeCharacterFields(family, { displayNameZh: "测试", name: "Original", suitName: "Original" });
    assert.equal(fields.displayNameEn, "Original");
    assert.equal(fields.suitName, "Original");
    assert.ok(validateCharacterImport({ assetType: family, characterFields: { displayNameZh: "PinYin" } }).some(message => message.includes("中文名")));
  }
});
