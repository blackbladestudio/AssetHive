const test = require('node:test');
const assert = require('node:assert/strict');
const { collectMegascansTags, removeMegascansNameTags } = require('../electron/services/megascansTags');

const source = { tags: ['Branch'], categories: ['3d', 'nature'], semanticTags: {
  name: 'Grassland African Tree Branch Wood Large 04', contains: ['Branch'], region: 'Africa',
  name_formats: { title: 'Grassland African Tree Branch Wood Large 04', short: 'Gra_Afr_Tree_Branch_Wood_Large_04', file: 'Grassland_African_Tree_Branch_Wood_Large_04' },
  name_fields: { category: 'Grassland', type: 'Tree', materialCaseSpecific: 'Wood', variation: '04' }
} };
test('Megascans names and name formats are not tag sources', () => {
  const tags = collectMegascansTags(source);
  assert.ok(tags.includes('branch') && tags.includes('grassland') && tags.includes('tree') && tags.includes('wood'));
  assert.ok(!tags.some(tag => tag.includes('_') || tag.includes('large 04')));
  assert.ok(!tags.includes('04'));
});
test('repair removes full and shortened name variants but keeps ordinary source tags', () => {
  const tags = ['branch', 'grasslandafricantreebranchwoodlarge04', 'gra_afr_tree_branch_wood_large_04', 'grassland_african_tree_branch_wood_large_04', 'Grassland', 'Tree', 'dry_leaves'];
  assert.deepEqual(removeMegascansNameTags(tags, source), ['branch', 'Grassland', 'Tree', 'dry_leaves']);
});
test('a single-word asset name does not erase its legitimate semantic tag', () => {
  assert.deepEqual(collectMegascansTags({ name: 'Rock', tags: ['Rock'], semanticTags: { name: 'Rock' } }), ['rock']);
});
test('explicit tag objects retain their name labels', () => {
  assert.deepEqual(collectMegascansTags({ tags: [{ name: 'Stone' }], semanticTags: { name: 'A Rock', contains: [{ name: 'Weathered' }] } }), ['stone', 'weathered']);
});
test('variant identifiers and pure numeric tags are not descriptive tags', () => {
  assert.deepEqual(collectMegascansTags({ tags: ['02', '4k', '3d', 'Wood'], semanticTags: {
    variant: 'A', name_fields: { type: 'Sideboard', variation: 'B', variant_number: '02' }
  } }), ['4k', '3d', 'wood', 'sideboard']);
  assert.deepEqual(removeMegascansNameTags(['Wood', '02', '004', '3d', 'Old'], {}), ['Wood', '3d', 'Old']);
});


test('full asset-name tags disappear from current detail cards, including legacy compact and punctuated names', () => {
  const path = require('node:path');
  const fs = require('node:fs');
  const ts = require('typescript');
  const { removeAssetNameTags } = require('../shared/assetNameTags.mjs');
  const text = fs.readFileSync(path.join(__dirname, '../src/ui/App.tsx'), 'utf8');
  const ast = ts.createSourceFile('App.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer;
  (function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'selectedDetailTags') initializer = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  })(ast);
  assert.ok(initializer);
  const detailTags = new Function('selectedAsset', 'getAssetColorTags', 'removeAssetNameTags', 'return ' + initializer);
  const asset = { name: 'Concrete Tile Displacement', tags: ['Concretetiledisplacement', 'Concrete_Tile-Displacement', 'concrete', 'tile', 'displacement', 'rough'], meta: {} };
  assert.deepEqual(detailTags(asset, () => ['gray'], removeAssetNameTags), ['concrete', 'tile', 'displacement', 'rough', 'gray']);
  assert.deepEqual(removeAssetNameTags(['rock', 'old', '02'], { name: 'Rock' }), ['rock', 'old', '02']);
});

test('saving removes name tags from tags and semantic contains while retaining taxonomy and source data', () => {
  const { createAssetMetadata } = require('../electron/services/assetMetadata');
  const input = { assetID: 'name-tags', name: 'Concrete Tile Displacement', assetType: 'displacement', category: 'Concrete',
    tags: ['concretetiledisplacement', 'Concrete Tile Displacement', 'concrete', 'rough'],
    semanticTags: { contains: ['concrete_tile_displacement', 'tile'], name: 'Concrete Tile Displacement' },
    sourceClassification: { semanticTags: { name: 'Concrete Tile Displacement' } } };
  const before = JSON.stringify(input), saved = createAssetMetadata(input);
  assert.ok(!saved.tags.some(tag => /concrete.*tile.*displacement/i.test(tag)));
  assert.ok(!saved.semanticTags.contains.some(tag => /concrete.*tile.*displacement/i.test(tag)));
  assert.ok(saved.tags.includes('Concrete') && saved.tags.includes('rough'));
  assert.ok(saved.semanticTags.contains.includes('tile'));
  assert.deepEqual(saved.sourceClassification, input.sourceClassification);
  assert.equal(JSON.stringify(input), before, 'the caller metadata and provenance remain intact');
});

test('legacy asset reads remove redundant name tags without modifying shared metadata', async t => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const { getAssetDetailsByMetaPath } = require('../electron/services/assetScanner');
  const parent = path.resolve(__dirname, '../.tmp/name-tag-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'case-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(parent));
    await fs.rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'asset_info.json');
  const metadata = { assetID: 'name-tags', name: 'Concrete Tile Displacement', assetType: 'surface', category: 'Concrete',
    tags: ['Concretetiledisplacement', 'rough'], semanticTags: { contains: ['concrete_tile_displacement', 'concrete'] }, textureFiles: ['height.png'] };
  await fs.writeFile(file, JSON.stringify(metadata));
  await require('sharp')({ create: { width: 4, height: 4, channels: 3, background: '#808080' } }).png().toFile(path.join(root, 'height.png'));
  const before = await fs.readFile(file), stat = await fs.stat(file);
  const record = await getAssetDetailsByMetaPath(file, 'custom');
  assert.ok(!record.tags.some(tag => /concrete.*tile.*displacement/i.test(tag)));
  assert.ok(record.tags.includes('concrete') && record.tags.includes('rough'));
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
});
