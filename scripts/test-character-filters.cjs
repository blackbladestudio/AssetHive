const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_CHARACTER_FILTERS: defaults, characterFilterContext: context, changeCharacterFilter: change, characterFilterDefinitions: definitions, filterCharacterCards: filter } = require("../shared/characterFilters.mjs");
const { expandCharacterCards } = require("../shared/characterComponents.mjs");
const { deduplicateCharacterCategoryTags } = require("../shared/characterFilters.mjs");
const { defaultCharacterFilters } = require("../shared/characterFilters.mjs");
const { characterStatus } = require("../shared/characterFilters.mjs");

test('all character categories place rigging directly before production status', () => {
  for (const node of ['character', 'character-suit', 'character-suit:Face', 'character-suit:Hair', 'character-monster', 'character-npc', 'character-weapon', 'character-item']) {
    const keys = definitions(context(node), []).map(field => field.key);
    assert.equal(keys.indexOf('rigging'), keys.indexOf('maturity') - 1, node);
  }
});

test("character overview has its own four owner categories and no recent section", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/ui/App.tsx"), "utf8");
  assert.ok(source.includes('activeMenu === "character" ? ['));
  for (const family of ["suit", "monster", "npc", "weapon"]) assert.ok(source.includes(`id: "character-${family}"`));
  assert.ok(source.includes('!isCharacterOverviewView && recentAssets.length > 0'));
  assert.ok(source.includes('fixedCharacters={isCharacterOverviewView}'));
  assert.ok(source.includes('t("查看全部", "View all")'));
});

test("detail spacing is scoped to character panels and preserves section rhythm", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/ui/App.tsx"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "../src/ui/styles.css"), "utf8");
  assert.ok(source.includes('selectedCharacterInfo ? " character-detail-panel" : ""'));
  assert.ok(css.includes('.character-detail-panel .detail-hero { padding-top: 20px; padding-bottom: 20px; }'));
  assert.ok(css.includes('.character-detail-panel .detail-tags { margin-top: 8px; }'));
  assert.ok(css.includes('.character-detail-panel .character-detail > .character-detail-actions { margin: 0; }'));
});

test("character status exposes rigging, changes and finalized with compatible stored keys", () => {
  assert.deepEqual(definitions(context("character-monster"), []).find(field => field.key === "maturity").options.map(item => item.value), ["all", "needs_rig", "rigged", "wip", "approved"]);
  assert.equal(characterStatus("final").value, "approved");
  assert.equal(characterStatus(undefined).value, "wip");
  assert.equal(characterStatus("approved").zh, "已定版");
  assert.equal(characterStatus("wip").zh, "需修改");
  assert.equal(characterStatus("final").zh, "已定版");
  assert.equal(characterStatus("review").value, "wip");
  assert.equal(characterStatus("needs_rig").zh, "需绑定");
  assert.equal(characterStatus("rigged").zh, "已绑定");
  const asset = monster("legacy", "01");
  asset.meta.character.maturity = "final";
  assert.equal(filter([asset], { ...defaults, maturity: "review" }).length, 0);
  assert.equal(filter([asset], { ...defaults, maturity: "approved" }).length, 1);
  assert.equal(asset.meta.character.maturity, "final");
});

test("character card family and armor badges are owner-only", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/ui/App.tsx"), "utf8");
  assert.ok(source.includes('characterInfo && !componentView && <span className="character-card-family"'));
  assert.ok(source.includes('{!heroPart && <span className="character-card-chinese-name">'));
  assert.ok(source.includes('outfitClassLabel && !componentView'));
  assert.ok(source.includes('characterInfo.fields.suitClass || ""'));
  assert.ok(source.includes('selectedCharacterInfo && (() => {'));
  assert.ok(source.includes('t("引擎内路径：", "Engine path: ")'));
  assert.ok(source.includes('"character-engine-path character-engine-not-imported"'));
});

test("character directories default to owners only without affecting face/hair or explicit part navigation", () => {
  for (const node of ["character", "character-monster", "character-npc", "character-weapon", "character-suit", "character-suit:Male_01", "character-suit:Female_01"]) {
    const initial = defaultCharacterFilters(context(node));
    assert.equal(initial.display, "parents");
    assert.equal(change(initial, "suitClass", "Medium").display, "parents");
    assert.equal(change(initial, "part", "head").display, "parts");
    assert.equal(change(initial, "display", "all").display, "all");
  }
  for (const node of ["character-suit:Face", "character-suit:Hair", "environment", "animation"]) {
    assert.equal(defaultCharacterFilters(context(node)).display, "all");
  }
  assert.equal(defaults.display, "all");
});

test("character category aliases render once without changing unrelated tags or stored metadata", () => {
  const tags = ["Female_01", "Zion", "female01", "Female 01", "cloth"];
  assert.deepEqual(deduplicateCharacterCategoryTags(tags, "Female_01"), ["Female_01", "Zion", "cloth"]);
  assert.deepEqual(deduplicateCharacterCategoryTags(["3_Elite", "Zion", "3elite"], "3_Elite"), ["3_Elite", "Zion"]);
  assert.deepEqual(deduplicateCharacterCategoryTags(tags, ""), tags);
  assert.equal(tags.length, 5);
  const realTags = ["suit", "female_01", "zion", "Female_01", "Zion"];
  assert.equal(deduplicateCharacterCategoryTags(realTags, "Female_01").filter(tag => /female/i.test(tag)).length, 1);
  assert.deepEqual(deduplicateCharacterCategoryTags(["女装", "Female_01", "female01", "Zion"], "Female_01", ["女装", "Female"]), ["女装", "Zion"]);
});

function suit(id = "s", suitClass = "Medium") {
  return { id, name: `F01_${suitClass}001_Example`, assetType: "suit", path: "Library/Example", meta: {
    character: { suitClass, maturity: "wip" }, characterManifest: { files: ["Head", "Upbody", "Downbody", "Arm"].map(part => ({ role: "model", normalizedName: `SK_F01_${suitClass}001_Example_${part}.fbx`, storedPath: `Mesh/${part}.fbx` })) }
  } };
}
function monster(id, form, shared = false) {
  return { id, name: "Warden", assetType: "monster", path: "Library/Warden", meta: {
    character: { name: "Warden", formIds: [form], maturity: "review", entityKey: "same" },
    characterManifest: { files: [
      { role: "skeletalMesh", normalizedName: `SK_Warden_${form}.fbx`, storedPath: `Mesh/body.fbx` },
      { role: "skeletalMesh", normalizedName: `SK_Warden_${form}_WP_Axe.fbx`, storedPath: `Mesh/axe.fbx`, componentRole: "weapon", sharedAcrossForms: shared }
    ] }
  } };
}
test("only character directories opt into the contextual filters; environment, animation and All remain legacy", () => {
  for (const node of ["home", "environment", "3d-assets", "animation", "animation-monster", "favorite", "character-suit:%bad"]) assert.equal(context(node), null);
  assert.equal(context("character").key, "all");
  assert.equal(context("character-suit:Female_01").key, "suit");
  assert.equal(context("character-suit:Male_01").key, "suit");
  assert.equal(context("character-suit:Face").key, "suit:face");
  assert.equal(context("character-monster:3_Elite").key, "monster");
});
test("family filter sets are distinct and face/hair do not inherit outfit parts or armor", () => {
  const fields = node => definitions(context(node), []).map(field => field.key);
  assert.deepEqual(fields("character-suit"), ["suitClass", "display", "part", "rigging", "maturity"]);
  assert.deepEqual(fields("character-monster"), ["rigging", "maturity"]);
  assert.deepEqual(fields("character-weapon"), ["rigging", "maturity"]);
  assert.deepEqual(fields("character-suit:Face"), ["gender", "rigging", "maturity"]);
  assert.deepEqual(fields("character-suit:Hair"), ["gender", "hairType", "rigging", "maturity"]);
  assert.deepEqual(fields("character"), ["family", "display", "rigging", "maturity"]);
});
test("switching scope retains independent values; selecting a part excludes owners and clearing display clears the part", () => {
  const state = { suit: change(defaults, "part", "head"), monster: change(defaults, "form", "02") };
  assert.equal(state[context("character-suit:Female_01").key].display, "parts");
  assert.equal(state[context("character-monster:3_Elite").key].part, "all");
  assert.equal(state[context("character-suit:Male_01").key].part, "head");
  assert.equal(change(state.suit, "display", "parents").part, "all");
  assert.equal(defaults.part, "all");
});
test("owner, part, class, status and search filters match actual cards without dragging siblings into search results", () => {
  const cards = expandCharacterCards([suit(), suit("light", "Light")]);
  assert.equal(filter(cards, { ...defaults, display: "parents" }).length, 2);
  assert.equal(filter(cards, { ...defaults, display: "parts" }).length, 8);
  assert.equal(filter(cards, { ...defaults, suitClass: "Medium" }).length, 5);
  const heads = filter(cards, change(defaults, "part", "head"));
  assert.equal(heads.length, 2);
  assert.deepEqual(filter(cards, defaults, new Set([heads[0].id])).map(card => card.id), [heads[0].id]);
  assert.equal(filter(cards, { ...defaults, maturity: "review" }).length, 0);
  assert.equal(filter(cards, defaults, new Set()).length, 0);
});
test("form filtering uses model-derived metadata; shared weapons stay explicitly unassigned and form groups retain order", () => {
  const cards = expandCharacterCards([monster("a", "01", true), monster("b", "02")]);
  const before = JSON.stringify(cards);
  assert.deepEqual(filter(cards, { ...defaults, display: "parents" }).map(card => card.id), ["a", "b"]);
  assert.deepEqual(filter(cards, { ...defaults, form: "01" }).map(card => card.id), ["a"]);
  assert.deepEqual(filter(cards, { ...defaults, form: "shared" }), []);
  const defs = definitions(context("character-monster"), cards);
  assert.equal(defs.some(field => field.key === "form"), false);
  assert.equal(JSON.stringify(cards), before);
});
test("legacy filters are bypassed only for character context and the worker sees part cards only in that context", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/ui/App.tsx"), "utf8");
  assert.ok(source.includes('useAssetSearch(characterContext ? catalogAssets : allAssets, search.text, search.tags)'));
  assert.ok(source.includes('{characterContext ? <>'));
  for (const label of ["所有类型", "所有尺寸", "所有环境", "所有颜色"]) assert.ok(source.includes(label));
  const branch = source.slice(source.indexOf('// Logic extracted from executeSearch'), source.indexOf('let filtered = allAssets;', source.indexOf('// Logic extracted from executeSearch')));
  assert.match(branch, /if \(characterContext\)/);
  assert.match(branch, /return;/);
  assert.ok(source.includes('if (selectedCharacterInfo) { navigateCharacterDirectory(); return; }'));
  assert.ok(source.includes('matchesCharacterCategoryTag(tag, selectedCharacterCategory, selectedCharacterCategoryLabels)'));
  assert.match(source, /\['Outfit', 'Male_01', 'Female_01', 'Face', 'Hair'\]/);
  assert.ok(source.includes('t("所有套装相关", "All outfit-related assets")'));
  assert.ok(source.includes('const showCharacterSubcategories = Boolean(characterContext && characterContext.family !== "all")'));
  assert.ok(source.includes('t(`所有${getAssetTypeLabel(characterContext.family)}`, `All ${getAssetTypeLabel(characterContext.family)}`)'));
  assert.ok(source.includes("showCharacterSubcategories && characterContext.family !== 'item' && <DarkSelect"));
  assert.ok(source.includes("characterContext.family === 'item' && gameplayFilterLevels(selectedSuitSubcategory)"));
  assert.ok(source.includes('getCharacterCategoryNodes(characterContext.family, allAssets)'));
  assert.ok(source.includes('onChange={selectSuitSubcategory}'));
  assert.ok(source.includes('value={selectedSuitSubcategory || "all"}'));
  const selector = source.slice(source.indexOf('const selectSuitSubcategory ='), source.indexOf('const selectedSuitSubcategory ='));
  assert.match(selector, /setActiveMenu/);
  assert.doesNotMatch(selector, /setSearch|setCharacterFiltersByScope/);
  assert.ok(!source.includes('onChange={selectCharacterFamily}'));
  assert.ok(!source.includes('value={characterContext.family}'));
});

test("character detail tags order category, specification, other tags, status then Zion without changing other modules", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/ui/App.tsx"), "utf8");
  assert.ok(source.includes('style={{ order: 1 }} title={t("套装规格/编号", "Suit Spec / Serial")}'));
  assert.ok(source.includes('style={{ order: 3 }} title={t("制作状态", "Maturity")}'));
  assert.ok(source.includes('style={selectedCharacterInfo ? { order: isSelectedCharacterCategoryTag(tag) ? 0 : selectedAssetZionTagSet.has(String(tag || "").toLowerCase()) ? 4 : 2 } : undefined}'));
});
test('face and hair gender filters compose with HairCard/Groom without extra owner cards', () => {
  const make = (id, gender, variant, extensions) => ({ id, assetType: 'suit', meta: { character: { gender, variant }, characterManifest: { files: extensions.map(ext => ({ role: 'model', storedPath: `${id}.${ext}` })) } } });
  const cards = [make('male','Male','Hair',['fbx']),make('female','Female','Hair',['abc']),make('both','Female','Hair',['fbx','abc'])];
  assert.deepEqual(filter(cards,{...defaults,gender:'Female',hairType:'groom'}).map(a=>a.id),['female','both']);
  assert.deepEqual(filter(cards,{...defaults,hairType:'haircard'}).map(a=>a.id),['male','both']);
  assert.deepEqual(filter([make('face','Male','Face',['fbx'])],{...defaults,gender:'Female'}),[]);
});
