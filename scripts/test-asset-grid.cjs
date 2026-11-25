const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const source = fs.readFileSync(path.join(__dirname, "../src/ui/assetGridLayout.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const layoutModule = { exports: {} };
new Function("exports", "require", compiled)(layoutModule.exports, require('node:module').createRequire(path.join(__dirname, '../src/ui/assetGridLayout.ts')));
const { getCardSpan, buildAssetGridLayout, getGridPlaceholderTop, getVisibleAssetGridItems, getDirectionalGridItem } = layoutModule.exports;
const { populatePreviewSize } = require("../electron/services/previewSize");
const asset = (id, size, assetType = "3d") => ({ id: String(id), assetType, meta: { previews: { relativeSize: size } } });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} != ${expected}`);

test('mixed character records never flatten outfit rows when a legacy item lacks topCategory', () => {
  const cards = [asset('s', '1x1', 'suit'), ...['head', 'upbody', 'downbody', 'arm'].map(slot => ({
    ...asset(`s::part::${slot}`, '1x1', 'suit'), name: `SM_Suit_${slot}`
  })), asset('legacy-item', '1x1', 'item')];
  const layout = buildAssetGridLayout(cards, 1000, false, 12, true, true);
  assert.equal(layout.outfitGroups[0].id, 's');
  assert.equal(new Set(layout.items.filter(item => item.asset.id.startsWith('s')).map(item => item.y)).size, 1);
  assert.ok(layout.items.find(item => item.asset.id === 'legacy-item').y > layout.outfitGroups[0].y + layout.outfitGroups[0].height);
});

test('monster variants remain independent cards without columns or collapsible headings', () => {
  const shared = { ...asset('guard', '1x1', 'monster'), name: 'Guard', meta: { character: { name: 'Guard', entityKey: 'guard-family', monsterVariant: 'NormalShield' }, monsterVariants: [
    { id: 'NormalShield', name: 'Normal Shield', assetIds: ['guard'] }, { id: 'BigShield', name: 'Big Shield', assetIds: ['guard'] }
  ] } };
  const layout = layoutModule.exports.buildMonsterVariantGridLayout([shared], 1000, new Set());
  assert.deepEqual(layout.items.map(i => i.variantId), ['NormalShield', 'BigShield']);
  assert.equal(new Set(layout.items.map(i => i.renderKey)).size, 2);
  assert.equal(layout.items[0].asset, layout.items[1].asset);
  assert.equal(layout.items[1].y, layout.items[0].y, 'variants share a compact row');
  assert(layout.items[1].x >= layout.items[0].x + layout.items[0].width);
  const collapsed = layoutModule.exports.buildMonsterVariantGridLayout([shared], 1000, new Set(['guard-family:variant:NormalShield']));
  assert.deepEqual(collapsed.items.map(i => i.variantId), ['NormalShield', 'BigShield']);
  assert.equal(layoutModule.exports.buildMonsterVariantGridLayout([shared], 1000, new Set(['guard-family'])).items.length, 2);
  assert.deepEqual(layout.sectionHeaders, []);
  assert.deepEqual(layout.outfitGroups, []);
  assert.deepEqual(getVisibleAssetGridItems(layout.items, layout.totalHeight, 0, layout.cardHeight), layout.items);
});

test("character standalone cards keep the owner and two-slot component proportions across viewport and detail modes", () => {
  const cards = [asset("a", "3x1", "suit"), asset("a::part::head", "1x3", "suit"), asset("b", "1x1", "monster")];
  for (const width of [280, 600, 1100, 1700]) for (const compact of [false, true]) {
    const layout = buildAssetGridLayout(cards, width, compact, undefined, false, true);
    close(layout.items[0].width / layout.items[0].height, .75);
    close(layout.items[1].width / layout.items[1].height, .75);
    close(layout.items[0].height, layout.items[2].height);
    assert.equal(layout.gap, 12);
  }
  const items = buildAssetGridLayout(cards, 1000, false, 0, false, true).items;
  assert.equal(getDirectionalGridItem(items, items[0], "ArrowRight"), items[1]);
  assert.equal(getDirectionalGridItem(items, items[1], "ArrowRight"), items[2]);
  assert.equal(getDirectionalGridItem(items, items[1], "ArrowDown"), null);
  assert.deepEqual(layoutModule.exports.getAssetGridItemsInRange(items, 155, 160).map(item => item.asset.id), ["a", "a::part::head", "b"]);
  const parts = buildAssetGridLayout([cards[1]], 800, false, undefined, false, true);
  close(parts.cardHeight, parts.items[0].height);
  close(parts.items[0].width / parts.items[0].height, .75);
  const environment = [asset("environment", "3x1")];
  assert.deepEqual(buildAssetGridLayout(environment, 1000, false, undefined, false, true), buildAssetGridLayout(environment, 1000));
});

test('partial suits preserve four ordered slots without adding placeholder assets to the source list', () => {
  const cards = [asset('partial', '1x1', 'suit'), ...['Arm', 'Upbody', 'Downbody'].map(part => ({ ...asset(`partial::part::${part}`, '1x1', 'suit'), name: `SM_Test_${part}` }))];
  for (const width of [600, 1000, 1700]) {
    const layout = buildAssetGridLayout(cards, width, false, 12, true, true);
    assert.deepEqual(layout.items.slice(1).map(item => item.asset.meta.missingSuitPart || item.asset.name.split('_').at(-1)), ['Head', 'Upbody', 'Downbody', 'Arm']);
    assert.equal(layout.items[1].asset.id, 'partial::missing-part::Head');
    assert.equal(cards.length, 4);
    assert.ok(cards.every(card => !card.meta.missingSuitPart));
  }
});

test("character relationship rows keep the owner full-height and components as narrow two-slot cards", () => {
  const cards = [asset("s", "1x1", "suit"), ...["head", "upbody", "downbody", "arm"].map(slot => ({ ...asset(`s::part::${slot}`, "1x1", "suit"), name: `SM_Suit_${slot}` }))];
  const layout = buildAssetGridLayout(cards, 1000, false, 12, true, true);
  close(layout.items[0].width / layout.items[0].height, .75);
  for (const part of layout.items.slice(1)) {
    close(part.height, layout.items[0].height);
    close(part.height, part.width * 2 + 56);
    assert.ok(part.width >= 150, `component mesh slot card is too small: ${part.width}`);
  }
  assert.equal(new Set(layout.items.slice(1).map(item => item.x)).size, 4);
  assert.equal(layout.outfitGroups[0].width, 984);
  close(layout.outfitGroups[0].height, layout.items[0].height + 8);
  const atBottom = layoutModule.exports.getAssetGridItemsInRange(layout.items, layout.items[0].height - 10, layout.items[0].height);
  assert.deepEqual(atBottom.map(item => item.asset.id), cards.map(item => item.id));
  assert.equal(getDirectionalGridItem(layout.items, layout.items[4], "ArrowLeft"), layout.items[3]);
  assert.equal(getDirectionalGridItem(layout.items, layout.items[1], "ArrowDown"), null);
  for (const width of [700, 800, 900]) {
    const responsive = buildAssetGridLayout(cards, width, false, 12, true, true);
    assert.equal(new Set(responsive.items.slice(1).map(item => item.y)).size, 1, "four parts shrink together before wrapping");
    assert.ok(responsive.items[0].width < 300, "owner must not grow when the viewport shrinks");
  }
  for (const width of [280, 450, 600]) {
    const narrow = buildAssetGridLayout(cards, width, false, 10, true, true);
    for (let i = 0; i < narrow.items.length; i++) for (let j = i + 1; j < narrow.items.length; j++) {
      const a = narrow.items[i], b = narrow.items[j];
      assert.ok(a.x + a.width <= b.x + 1e-6 || b.x + b.width <= a.x + 1e-6 || a.y + a.height <= b.y + 1e-6 || b.y + b.height <= a.y + 1e-6);
    }
    assert.equal(narrow.items.length, 5);
    assert.ok(narrow.items.every(item => item.x + item.width <= width));
    const bottom = Math.max(...narrow.items.map(item => item.y + item.height));
    close(narrow.outfitGroups[0].height, bottom - narrow.items[0].y + 8);
  }
  const secondOutfit = cards.map(item => ({ ...item, id: item.id.replace(/^s/, "t") }));
  const grouped = buildAssetGridLayout([...cards, ...secondOutfit], 1000, false, 12, true, true);
  assert.equal(grouped.outfitGroups[1].y - (grouped.outfitGroups[0].y + grouped.outfitGroups[0].height), 24);
});

test("mesh filters project one mesh kind with a square image and a separate caption", () => {
  const { filterCharacterCards, DEFAULT_CHARACTER_FILTERS } = require("../shared/characterFilters.mjs");
  const part = { ...asset("s::part::head", "1x1", "suit"), meta: { componentView: { slot: "head", meshKinds: { staticMesh: true, skeletalMesh: true } } } };
  for (const [display, kind] of [["staticParts", "staticMesh"], ["skeletalParts", "skeletalMesh"]]) {
    const filtered = filterCharacterCards([part], { ...DEFAULT_CHARACTER_FILTERS, display });
    assert.equal(filtered[0].meta.componentView.visibleMeshKind, kind);
    const { items } = buildAssetGridLayout(filtered, 1000, false, 12, false, true);
    close(items[0].width, 160);
    close(items[0].height - 24, items[0].width);
  }
  assert.equal(part.meta.componentView.visibleMeshKind, undefined);
  const { items } = buildAssetGridLayout([part], 1000, false, 12, true, true);
  close((items[0].height - 8) / 2 - 24, items[0].width);
  const staticOnly = { ...part, meta: { componentView: { ...part.meta.componentView, meshKinds: { staticMesh: true, skeletalMesh: false } } } };
  assert.equal(filterCharacterCards([staticOnly], { ...DEFAULT_CHARACTER_FILTERS, display: "skeletalParts" }).length, 0);
});

test("arrow navigation follows packed neighbors and stops at grid edges", () => {
  const { items } = buildAssetGridLayout([
    asset("wide", "3x1"), asset("next-row", "2x1"), asset("filler", "1x1"),
    asset("lower-right", "2x1")
  ], 500);
  assert.deepEqual(items.map(item => item.asset.id), ["wide", "filler", "next-row", "lower-right"]);
  assert.equal(getDirectionalGridItem(items, items[0], "ArrowRight"), items[1]);
  assert.equal(getDirectionalGridItem(items, items[1], "ArrowLeft"), items[0]);
  assert.equal(getDirectionalGridItem(items, items[0], "ArrowDown"), items[2]);
  assert.equal(getDirectionalGridItem(items, items[1], "ArrowDown"), items[3]);
  assert.equal(getDirectionalGridItem(items, items[3], "ArrowUp"), items[1]);
  assert.equal(getDirectionalGridItem(items, items[0], "ArrowUp"), null);
  assert.equal(getDirectionalGridItem(items, items[0], "ArrowLeft"), null);
  assert.equal(getDirectionalGridItem(items, items[1], "ArrowRight"), null);
  assert.equal(getDirectionalGridItem(items, items[3], "ArrowDown"), null);
});

test("navigation reaches unmounted rows and handles a short final row", () => {
  const { items } = buildAssetGridLayout(Array.from({ length: 101 }, (_, i) => asset(i, "1x1")), 500);
  assert.equal(getDirectionalGridItem(items, items[3], "ArrowDown"), items[7]);
  assert.equal(getDirectionalGridItem(items, items[99], "ArrowDown"), items[100]);
  assert.equal(getDirectionalGridItem([items[0]], items[0], "ArrowDown"), null);
});

test("preview shape determines all three sizes regardless of resource type", () => {
  for (const type of ["surface", "3d", "3dplant", "hdri", "decal", "imperfection", "displacement"]) {
    for (const [size, span] of [["800x1200", 1], ["1024x1024", 1], ["1200x1000", 1], ["1920x1080", 2], ["2400x1000", 3], ["4096x1024", 3], [" 3 X 1 ", 3], ["", 1], ["1x0", 1], ["0x1", 1], ["garbage", 1]]) {
      assert.equal(getCardSpan(asset(0, size, type)), span);
    }
  }
});

test("character-only views use larger portrait cards", () => {
  const characters = Array.from({ length: 4 }, (_, index) => ({ ...asset(index, "1x1", "suit"), topCategory: "character" }));
  const characterLayout = buildAssetGridLayout(characters, 1000);
  const environmentLayout = buildAssetGridLayout(Array.from({ length: 4 }, (_, index) => asset(index, "1x1", "3d")), 1000);
  assert.equal(characterLayout.cardHeight, 250);
  assert.ok(characterLayout.cardHeight > environmentLayout.cardHeight);
  assert.ok(characterLayout.items[0].width > environmentLayout.items[0].width);
});

function verifyLayout(list, width, compact) {
  const layout = buildAssetGridLayout(list, width, compact);
  assert.equal(layout.items.length, list.length);
  assert.equal(new Set(layout.items.map(item => item.asset.id)).size, list.length);
  const rows = new Map();
  const fullRow = buildAssetGridLayout(Array.from({ length: layout.columns }, (_, i) => asset(i, "1x1")), width, compact);
  for (const item of layout.items) {
    assert.ok(Number.isFinite(item.width) && item.width > 0);
    assert.ok(item.x >= 0 && item.y >= 0);
    assert.equal(item.span, getCardSpan(item.asset));
    if (!rows.has(item.y)) rows.set(item.y, []);
    rows.get(item.y).push(item);
  }
  for (const [y, row] of rows) {
    close(row[0].x, layout.padding);
    const rightEdge = Math.max(1, width) - layout.padding;
    const usedColumns = row.reduce((sum, item) => sum + Math.min(item.span, layout.columns), 0);
    assert.ok(row.at(-1).x + row.at(-1).width <= rightEdge + 0.00001);
    if (usedColumns === layout.columns) close(row.at(-1).x + row.at(-1).width, rightEdge);
    for (const item of row) {
      close(item.width + layout.gap, (fullRow.items[0].width + layout.gap) * Math.min(item.span, layout.columns));
    }
    for (let i = 1; i < row.length; i++) close(row[i].x, row[i - 1].x + row[i - 1].width + layout.gap);
    assert.ok(y + layout.cardHeight <= layout.totalHeight);
  }
  return layout;
}

test("wide character form cards cannot be separated by packing a later part or unrelated asset", () => {
  const cards = [asset("form01", "3x1", "monster"), asset("form02", "2x1", "monster"), asset("weapon", "1x1", "monster"), asset("unrelated", "1x1")];
  for (const width of [400, 600, 1000, 1600]) {
    assert.deepEqual(buildAssetGridLayout(cards, width).items.map(item => item.asset.id), cards.map(item => item.id));
    verifyLayout(cards, width, false);
  }
});

test("rows preserve card sizes and fill available columns without overlap or lost cards", () => {
  const lists = [[], [asset(0, "1x1")], Array.from({ length: 101 }, (_, i) => asset(i, "2x1")), Array.from({ length: 101 }, (_, i) => asset(i, "3x1")), Array.from({ length: 1003 }, (_, i) => asset(i, `${1 + ((i * 17) % 3)}x1`))];
  for (const width of [0, 1, 19, 100, 320, 640, 899, 900, 901, 1199, 1200, 1201, 1365.5, 1600, 1920, 2560, 3840]) {
    for (const compact of [false, true]) for (const list of lists) verifyLayout(list, width, compact);
  }
});

test("fills holes even when a fitting card is beyond the previous 96-item lookahead", () => {
  const list = [...Array.from({ length: 200 }, (_, i) => asset(i, "2x1")), asset(200, "1x1")];
  const layout = verifyLayout(list, 1600, false);
  // Six columns: the first row can only be filled by finding the distant 1x card.
  const mixed = verifyLayout([asset("wide", "3x1"), ...list], 1600, false);
  assert.equal(mixed.items[2].asset.id, "200");
  assert.equal(layout.items[0].asset.id, "0");
});

test("a single remaining wide card stays left aligned at its original size", () => {
  const list = [2, 1, 2, 1, 1, 2, 2].map((span, i) => asset(i, `${span}x1`));
  const layout = buildAssetGridLayout(list, 2200);
  assert.equal(layout.columns, 9);
  const last = layout.items.at(-1);
  assert.equal(last.y, layout.padding + layout.cardHeight + layout.gap);
  close(last.x, layout.padding);
  close(last.width, layout.items[0].width);
  assert.ok(last.x + last.width < 2200 - layout.padding);
});

test("multiple unfillable rows keep the same card width as a full row", () => {
  const list = Array.from({ length: 4 }, (_, i) => asset(i, "3x1"));
  const layout = buildAssetGridLayout(list, 1365.5);
  const filled = buildAssetGridLayout([asset("wide", "3x1"), asset("filler", "2x1")], 1365.5);
  assert.equal(layout.columns, 5);
  layout.items.forEach((item, row) => {
    close(item.x, layout.padding);
    close(item.y, layout.padding + row * (layout.cardHeight + layout.gap));
    close(item.width, filled.items[0].width);
  });
});

test("scroll culling matches full visibility checks and preserves packed positions", () => {
  const list = Array.from({ length: 20000 }, (_, i) => asset(i, `${1 + i % 3}x1`));
  const layout = buildAssetGridLayout(list, 1600);
  const before = JSON.stringify(layout);
  for (const height of [0, 500, 1000]) for (const top of [0, 220, 5000, layout.totalHeight - 500, layout.totalHeight + 5000]) {
    const overscan = Math.max(layout.cardHeight * 4, height * 0.75);
    const expected = layout.items.filter(item => item.y + item.height >= Math.max(0, top - overscan) && item.y <= top + height + overscan);
    assert.deepEqual(getVisibleAssetGridItems(layout.items, height, top, layout.cardHeight), expected);
  }
  assert.equal(JSON.stringify(layout), before);
  assert.equal(buildAssetGridLayout([], 1600).totalHeight, 0);
});

test("scroll placeholder snaps to card rows so it never shows through the gaps", () => {
  const layout = buildAssetGridLayout(Array.from({ length: 400 }, (_, i) => asset(i, `${1 + i % 3}x1`)), 1600);
  const { padding, cardHeight, gap } = layout;
  const stride = cardHeight + gap;
  const rowTops = new Set(layout.items.map(item => item.y));
  const assertSnapped = (top) => {
    const snapped = getGridPlaceholderTop(top, padding, stride);
    // The overlay must land on the grid's row lattice, never between two rows.
    close((snapped - padding) % stride, 0);
    // Above the first row there is only the grid's leading padding, which stays
    // empty for real cards too; below that the overlay must reach the viewport top.
    const covered = Math.max(top, padding);
    assert.ok(snapped <= covered, `row top ${snapped} starts below the coverage top ${covered}`);
    assert.ok(covered - snapped < stride, `row top ${snapped} lags the coverage top ${covered} by a full row`);
    assert.ok(snapped >= padding, `row top ${snapped} precedes the grid padding ${padding}`);
    return snapped;
  };
  for (const top of [0, 1, 23, 24, 25, 235, 236, 1000, 1375.5, layout.totalHeight - 100]) {
    const snapped = assertSnapped(top);
    // Inside the content it must also be a row some card actually occupies.
    assert.ok(rowTops.has(snapped), `row top ${snapped} is not a card row (scrollTop ${top})`);
  }
  assertSnapped(layout.totalHeight + 5000);
  // Degenerate geometry must stay finite instead of producing NaN offsets.
  for (const [top, pad, step] of [[100, 24, 0], [NaN, 24, 232], [100, NaN, 232], [100, 24, NaN]]) {
    assert.ok(Number.isFinite(getGridPlaceholderTop(top, pad, step)));
  }
});

test("outfit rows are owner-bounded only when opted in, with safe contiguous wrapping in narrow views", () => {
  const suit = (id) => asset(id, "1x1", "suit");
  const records = [suit("a"), suit("a::part::head"), suit("a::part::upbody"), suit("b"), suit("b::part::head")];
  const wide = buildAssetGridLayout(records, 2000, false, undefined, true);
  assert.equal(wide.items[0].y, wide.items[2].y);
  assert.ok(wide.items[3].y > wide.items[2].y);
  assert.equal(wide.items[3].x, wide.padding);
  const compact = buildAssetGridLayout(records, 2000);
  assert.equal(compact.items[0].y, compact.items[3].y);
  for (const width of [80, 350, 700, 1100]) {
    const layout = buildAssetGridLayout(records, width, true, undefined, true);
    assert.deepEqual(layout.items.map(item => item.asset.id), records.map(item => item.id));
    assert.ok(layout.items[3].y > layout.items[2].y);
    assert.equal(layout.items[3].x, layout.padding);
    assert.ok(layout.items.every(item => item.x + item.width <= width));
  }
  const environment = records.map(item => ({ ...item, assetType: "3d" }));
  assert.deepEqual(buildAssetGridLayout(environment, 2000, false, undefined, true), buildAssetGridLayout(environment, 2000));
});

test("outfit background encloses owner and all wrapped parts without joining adjacent outfits or intercepting other views", () => {
  const suit = id => asset(id, "1x1", "suit");
  const records = [suit("a"), ...["head", "upbody", "downbody", "arm"].map(part => suit(`a::part::${part}`)), suit("b"), suit("b::part::head")];
  for (const width of [350, 1100, 2000]) {
    const layout = buildAssetGridLayout(records, width, false, undefined, true);
    assert.equal(layout.outfitGroups.length, 2);
    const [first, second] = layout.outfitGroups;
    assert.ok(first.y + first.height < second.y);
    for (const group of layout.outfitGroups) {
      assert.ok(group.x >= 0 && group.x + group.width <= width);
      for (const item of layout.items.filter(item => item.asset.id.split("::part::")[0] === group.id)) {
        assert.ok(group.x <= item.x && group.y <= item.y);
        assert.ok(group.x + group.width >= item.x + item.width);
        assert.ok(group.y + group.height >= item.y + item.height);
      }
    }
  }
  assert.deepEqual(buildAssetGridLayout(records, 1100).outfitGroups, []);
  assert.deepEqual(buildAssetGridLayout([suit("a")], 1100, false, undefined, true).outfitGroups, []);
  assert.deepEqual(buildAssetGridLayout([suit("a::part::head")], 1100, false, undefined, true).outfitGroups, []);
  assert.deepEqual(buildAssetGridLayout([asset("monster", "1x1", "monster")], 1100, false, undefined, true).outfitGroups, []);
});

test("Monster and NPC owners remain ordinary cards beside expanded suits", () => {
  const suit = id => asset(id, "1x1", "suit");
  const monster = (id, entityKey) => ({ ...asset(id, "1x1", "monster"), name: "SameName", meta: { previews: { relativeSize: "1x1" }, character: { entityKey } } });
  const records = [monster("a", "entityA"), monster("b", "entityA"), monster("c", ""), asset("npc-owner", "1x1", "npc")];
  for (const width of [350, 1100, 2300]) {
    const layout = buildAssetGridLayout(records, width, false, undefined, true);
    assert.equal(layout.outfitGroups.length, 0);
    assert.deepEqual(layout.items.map(item => item.asset.id), records.map(item => item.id));
    const mixed = buildAssetGridLayout([suit("s"), suit("s::part::head"), ...records], width, false, undefined, true, true);
    assert.equal(mixed.outfitGroups.length, 1);
    for (const item of mixed.items.filter(item => records.some(record => record.id === item.asset.id))) {
      assert.ok(item.x >= 0 && item.x + item.width <= width);
      assert.ok(item.y > mixed.outfitGroups[0].y + mixed.outfitGroups[0].height);
    }
  }
  assert.deepEqual(buildAssetGridLayout(records, 2300).outfitGroups, []);
  assert.equal(buildAssetGridLayout(records.slice(0, 2), 2300, false, undefined, true).outfitGroups.length, 0);
  assert.equal(buildAssetGridLayout(records.slice(2, 4), 2300, false, undefined, true).outfitGroups.length, 0);
});

test("missing dimensions come from preview headers, including EXIF orientation", async () => {
  const sharp = require("sharp");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-grid-"));
  try {
    const preview = path.join(dir, "wide.jpg");
    await sharp({ create: { width: 300, height: 100, channels: 3, background: "red" } }).jpeg().toFile(preview);
    const record = { ...asset(1, ""), previewImage: preview };
    await populatePreviewSize(record);
    assert.equal(getCardSpan(record), 3);
    const rotated = path.join(dir, "rotated.jpg");
    await sharp(preview).withMetadata({ orientation: 6 }).toFile(rotated);
    const rotatedRecord = { ...asset(2, ""), previewImage: rotated };
    await populatePreviewSize(rotatedRecord);
    assert.equal(rotatedRecord.meta.previews.relativeSize, "100x300");
    assert.equal(getCardSpan(rotatedRecord), 1);
    const authored = { ...asset(3, "2x1"), previewImage: preview };
    await populatePreviewSize(authored);
    assert.equal(getCardSpan(authored), 2);
    const missing = { ...asset(4, ""), previewImage: path.join(dir, "missing.jpg") };
    await populatePreviewSize(missing);
    assert.equal(getCardSpan(missing), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
