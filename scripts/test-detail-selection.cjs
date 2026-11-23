const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/ui/App.tsx'), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodesWhere(root, predicate) {
  const nodes = [];
  function visit(node) { if (predicate(node)) nodes.push(node); ts.forEachChild(node, visit); }
  visit(root);
  return nodes;
}
const panel = nodesWhere(ast, node => ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'aside'
  && node.openingElement.attributes.getText(ast).includes('right-panel'))[0];

test('animation detail excludes related cards while character detail retains its navigation', () => {
  assert.ok(panel, 'actual detail panel must exist');
  const foreign = ['relatedAssets', 'relatedMonsterForms', 'relatedMonsterWeapons', 'ownedMonsterWeapons'];
  const references = nodesWhere(panel, node => ts.isIdentifier(node) && foreign.includes(node.text));
  assert.deepEqual([...new Set(references.map(node => node.text))].sort(), [...foreign].sort());
  for (const reference of references) {
    let child = reference;
    let guarded = false;
    for (let parent = reference.parent; parent && parent !== panel; child = parent, parent = parent.parent) {
      if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        && parent.left.getText(ast) === '!selectedAnimationFile' && parent.right === child) guarded = true;
    }
    assert.ok(guarded, `${reference.text} must remain outside the animation detail branch`);
  }
});

test('preview, animation information and history take the selected card', () => {
  const components = nodesWhere(panel, node => ts.isJsxSelfClosingElement(node)
    && ['AnimationPreview', 'AnimationRulesPanel', 'AnimationAssetActivity', 'MonsterModelPanel'].includes(node.tagName.getText(ast)));
  assert.equal(components.length, 4);
  for (const component of components) {
    const name = component.tagName.getText(ast);
    const attributes = component.attributes.getText(ast);
    if (name === 'AnimationPreview') assert.match(attributes, /key=\{selectedAsset\.id\}/);
    else assert.match(attributes, /asset=\{selectedAsset\}/, `${name} must use this card's record`);
  }
});

test('animation sections have distinct sibling keys when switching cards', () => {
  const detail = nodesWhere(panel, node => ts.isJsxElement(node) && node.openingElement.attributes.getText(ast).includes('className="detail-info"'))[0];
  const sections = detail.children.filter(node => ts.isJsxExpression(node)).flatMap(node => nodesWhere(node.expression, item => ts.isJsxSelfClosingElement(item) && ['AnimationRulesPanel', 'AnimationAssetActivity'].includes(item.tagName.getText(ast))));
  assert.equal(sections.length, 2);
  for (const id of ['monster-a', 'monster-b', 'monster-a']) {
    const keys = sections.map(section => {
      const key = section.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText(ast) === 'key');
      return new Function('selectedAsset', `return ${key.initializer.expression.getText(ast)};`)({ id });
    });
    assert.equal(new Set(keys).size, keys.length, 'duplicate sibling keys leave orphaned sections after switching cards');
  }
});

test('delayed detail response cannot replace the newly selected card', () => {
  const declaration = nodesWhere(ast, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === 'selectedAsset')[0];
  const callback = declaration.initializer.arguments[0];
  const compiled = ts.transpileModule(`const select = ${callback.getText(ast)}; return select();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const selected = { id: 'new-card', name: 'Selected Executor', metaPath: 'new.fbx', meta: {}, modelFiles: ['new.fbx'] };
  const obsolete = { id: 'old-card', name: 'Other Monster', metaPath: 'old.fbx', meta: { animationAffiliation: '怪物' } };
  const result = new Function('catalogAssets', 'selectedAssetId', 'selectedAssetDetails', 'selectedComponentMesh', compiled)([selected, obsolete], selected.id, obsolete, null);
  assert.equal(result.id, selected.id);
  assert.equal(result.name, selected.name);
  assert.deepEqual(result.meta, selected.meta);
});
