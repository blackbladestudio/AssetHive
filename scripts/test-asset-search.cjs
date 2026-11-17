const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function loadTypeScript(relative) {
  const file = path.resolve(__dirname, "..", relative);
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const output = { exports: {} };
  const load = name => name.startsWith("./") ? loadTypeScript(path.relative(path.resolve(__dirname, ".."), path.resolve(path.dirname(file), `${name}.ts`))) : require(name);
  new Function("require", "module", "exports", compiled)(load, output, output.exports);
  return output.exports;
}
const { AssetSearchIndex } = loadTypeScript("src/ui/assetSearchIndex.ts");
const { readSearchPresets } = loadTypeScript("src/ui/searchPresetsStorage.ts");
const documents = [
  { id: "rock-1", name: "Granite Rock", fields: ["Granite Rock", "Megascans", "forest", "rock-1"] },
  { id: "rock-2", name: "Basalt Rock", fields: ["Basalt Rock", "PBRMAX", "desert", "rock-2"] },
  { id: "tree-1", name: "杉树", fields: ["杉树", "植物", "forest", "tree-1"] }
];

test("typing and committed search terms use AND matching across the same fields", () => {
  const index = new AssetSearchIndex();
  index.update(documents);
  assert.deepEqual(index.search("rock forest"), ["rock-1"]);
  assert.deepEqual(index.search("", ["rock", "forest"]), ["rock-1"]);
  assert.deepEqual(index.search('"granite rock"'), ["rock-1"]);
  assert.deepEqual(index.search("", ["granite rock"]), ["rock-1"]);
  assert.deepEqual(index.search("rock-2"), ["rock-2"]);
});

test("Chinese names and tags match full pinyin and initials; English typo matching stays bounded", () => {
  const index = new AssetSearchIndex();
  index.update(documents);
  assert.deepEqual(index.search("shanshu"), ["tree-1"]);
  assert.deepEqual(index.search("zw"), ["tree-1"]);
  assert.deepEqual(index.search("graniet"), ["rock-1"]);
  assert.deepEqual(index.search("xy"), []);
});

test("temp matches a complete tag or name word without matching temple or temperate", () => {
  const index = new AssetSearchIndex();
  index.update([
    { id: "tagged", name: "Stone", fields: ["Stone", "Temp"] },
    { id: "named", name: "Env_Temp_stone", fields: ["Env_Temp_stone"] },
    { id: "ruin", name: "Ancient Temple Stone", fields: ["Ancient Temple Stone", "temple", "ancienttemplestone"] },
    { id: "mushroom", name: "Spotted Red Mushrooms", fields: ["Spotted Red Mushrooms", "temperate"] },
    { id: "chinese", name: "杉树", fields: ["杉树", "temperate"] }
  ]);
  assert.deepEqual(index.search(" TeMp "), ["tagged", "named"]);
  assert.deepEqual(index.search("", ["Temp"]), ["tagged", "named"]);
  assert.deepEqual(index.search("temp stone"), ["tagged", "named"]);
  assert.deepEqual(index.search('"temple stone"'), ["ruin"]);
  assert.deepEqual(index.search("temp", ["temperate"]), []);
});

test("English typo fallback compares whole words and never expands four-letter queries", () => {
  const index = new AssetSearchIndex();
  index.update([
    { id: "plant", name: "Stem", fields: ["Stem"] },
    { id: "ruin", name: "Temple", fields: ["Temple"] },
    { id: "forest", name: "Forest", fields: ["Forest", "temperate"] }
  ]);
  assert.deepEqual(index.search("temp"), []);
  assert.deepEqual(index.search("", ["temp"]), []);
  assert.deepEqual(index.search("temper"), []);
  assert.deepEqual(index.search("forst"), ["forest"]);
  assert.deepEqual(index.search("forets"), ["forest"]);
  assert.deepEqual(index.search("forrest"), ["forest"]);
  assert.deepEqual(index.search("farest"), ["forest"]);
  assert.deepEqual(index.search("farast"), []);
});

test("ID fragments stay literal while pinyin cannot join separate fields", () => {
  const index = new AssetSearchIndex();
  index.update([
    { id: "abc123xyz", name: "杉树", fields: ["杉树", "森林", "abc123xyz", "old987id"], identifiers: ["old987id"] },
    { id: "other", name: "石头", fields: ["石头", "木头"] }
  ]);
  assert.deepEqual(index.search("123"), ["abc123xyz"]);
  assert.deepEqual(index.search("abc"), ["abc123xyz"]);
  assert.deepEqual(index.search("987"), ["abc123xyz"]);
  assert.deepEqual(index.search("old"), ["abc123xyz"]);
  assert.deepEqual(index.search("shanshu"), ["abc123xyz"]);
  assert.deepEqual(index.search("sl"), ["abc123xyz"]);
  assert.deepEqual(index.search("sssl"), []);
  assert.deepEqual(index.search("stmt"), []);
});

test("index updates invalidate cached results and remove renamed/deleted assets", () => {
  const index = new AssetSearchIndex();
  index.update(documents);
  assert.deepEqual(index.search("granite"), ["rock-1"]);
  index.update([{ id: "rock-1", name: "Marble", fields: ["Marble"] }], ["tree-1"]);
  assert.deepEqual(index.search("granite"), []);
  assert.deepEqual(index.search("marble"), ["rock-1"]);
  assert.deepEqual(index.search("shanshu"), []);
});

test("20,000 cached documents keep multi-term matches correct without re-reading metadata", () => {
  const index = new AssetSearchIndex();
  const large = Array.from({ length: 20000 }, (_, i) => ({ id: String(i), name: `Rock ${i}`, fields: [`Rock ${i}`, i % 2 ? "forest" : "desert"] }));
  index.update(large);
  const first = index.search("rock forest");
  assert.equal(first.length, 10000);
  assert.equal(index.search("rock forest"), first);
});

test("saved filters survive reload and corrupt storage does not break startup", () => {
  assert.deepEqual(readSearchPresets({ getItem: () => "not json" }), []);
  assert.deepEqual(readSearchPresets({ getItem: () => '[{"name":"bad"}]' }), []);
  const presets = readSearchPresets({ getItem: () => JSON.stringify([{ name: "Forest rocks", menu: "environment", search: { text: "rock forest", tags: [], assetTypes: ["3d"], themes: [], source: "custom" } }]) });
  assert.equal(presets[0].search.size, "all");
  assert.equal(presets[0].search.text, "rock forest");
});
