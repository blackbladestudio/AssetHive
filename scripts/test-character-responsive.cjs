const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const api = {};
new Function('exports', 'require', ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/ui/assetGridLayout.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(api, require('node:module').createRequire(path.join(__dirname, '../src/ui/assetGridLayout.ts')));
const owner = { id: 'suit', assetType: 'suit', meta: {} };
const parts = ['head', 'upbody', 'downbody', 'arm'].map(slot => ({ id: `suit::part::${slot}`, assetType: 'suit', meta: {} }));
test('overview retains its original 180 by 240 thumbnail size', () => {
  for (const width of [400, 1000, 2100]) {
    const layout = api.buildAssetGridLayout([owner], width, false, 0, false, true, 240);
    assert.equal(layout.items[0].width, 180);
    assert.equal(layout.items[0].height, 240);
  }
});
test('monster with one weapon matches outfit owner size without stretching to fill the row', () => {
  const monster = { id: 'monster', assetType: 'monster', meta: {} };
  const weapon = { id: 'monster::part::weapon', assetType: 'monster', meta: {} };
  for (const width of [280, 400, 680, 1000, 1350, 1800, 2100, 3400]) {
    const outfit = api.buildAssetGridLayout([owner, ...parts], width, false, 24, true, true);
    const layout = api.buildAssetGridLayout([monster, weapon], width, false, 24, true, true);
    const main = layout.items[0];
    const child = layout.items[1];
    const outfitHeight = outfit.items.find(x => x.asset.id === owner.id).height;
    const expected = Math.min(outfitHeight, (width - 56) / 1.7875);
    assert.ok(Math.abs(main.height - expected) < 1e-6);
    assert.ok(Math.abs(main.width / main.height - .75) < 1e-6);
    assert.equal(child.width, child.height);
    assert.equal(child.y + child.height, main.y + main.height);
    assert.ok(child.x + child.width <= width - 32 + 1e-6);
    assert.equal(layout.outfitGroups[0].width, width - 40);
  }
});
test('owner and square parts use half-size geometry and align inside a full-row frame', () => {
  for (const [width, columns] of [[180, 1], [400, 2], [680, 4], [1100, 4], [2100, 4]]) {
    const grouped = api.buildAssetGridLayout([owner, ...parts], width, false, 24, true, true);
    const main = grouped.items.find(x => x.asset.id === owner.id);
    const children = grouped.items.filter(x => x.asset.id !== owner.id);
    assert.equal(new Set(children.map(x => x.x)).size, columns);
    assert.equal(main.width / main.height, .75);
    assert.ok(Math.max(...grouped.items.map(x => x.x + x.width)) <= width - 32 + 1e-6);
    assert.ok(Math.max(...children.map(x => x.y + x.height)) <= main.y + main.height + 1e-6);
    if (columns > 1) assert.ok(Math.abs(Math.max(...children.map(x => x.x + x.width)) - (width - 32)) < 1e-6);
    for (const child of children) { assert.equal(child.width, child.height); assert.ok(child.x + child.width <= width); }
    const topRow = children.filter(child => child.y === main.y).sort((a, b) => a.x - b.x);
    for (let i = 1; i < topRow.length; i++) {
      assert.ok(topRow[i].x - topRow[i - 1].x - topRow[i - 1].width <= main.height * .038);
    }
    assert.equal(grouped.outfitGroups[0].width, width - 40);
  }
});
test('mouse changes tilt only, not a cursor light', () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/ui/App.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/ui/styles.css'), 'utf8');
  assert.ok(!app.includes('--card-light-'));
  assert.ok(!css.includes('--card-light-'));
  assert.match(app, /card.dataset.characterComponent === "true"/);
});
test('actual content width controls arrangement, not a stale full-stage measurement', () => {
  const full = api.buildAssetGridLayout([owner, ...parts], 1800, false, 24, true, true, undefined, 1800);
  const detail = api.buildAssetGridLayout([owner, ...parts], 680, true, 24, true, true, undefined, 1800);
  assert.equal(new Set(full.items.slice(1).map(x => x.x)).size, 4);
  assert.equal(new Set(detail.items.slice(1).map(x => x.x)).size, 4);
  const sameWidth = api.buildAssetGridLayout([owner, ...parts], 680, false, 24, true, true, undefined, 900);
  assert.deepEqual(detail.items, sameWidth.items);
  for (const width of [280, 400, 680]) {
    const monster = { id: 'monster', assetType: 'monster', meta: {} };
    const weapon = { id: 'monster::part::weapon', assetType: 'monster', meta: {} };
    const layout = api.buildAssetGridLayout([monster, weapon], width, false, 24, true, true);
    assert.ok(layout.items.every(x => x.x + x.width <= width));
  }
});

test('character model, material groups, and texture filenames are collapsed by default', () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/ui/App.tsx'), 'utf8');
  const sections = app.match(/<details className="character-file-section">/g) || [];
  assert.equal(sections.length, 2);
  assert.match(app, /<summary>\{t\(`模型文件/);
  assert.match(app, /<summary>\{t\(`材质 \/ 贴图文件/);
  assert.match(app, /<details className="character-texture-file-details">/);
  assert.doesNotMatch(app, /<details className="character-(?:file-section|texture-file-details)" open>/);
});
