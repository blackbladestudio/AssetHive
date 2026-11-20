import tree from './gameplayCategories.json' with { type: 'json' };
const entries = [];
function visit(nodes, codes = [], labels = [], subtype = [], legacy = []) {
  for (const node of nodes) {
    const path = [...codes, node.code];
    const names = [...labels, node.zh];
    const naming = node.tier === 'subcategory' ? [...subtype, node.code] : subtype;
    const oldPath = [...legacy, node.aliases?.[0] || node.code];
    entries.push({ value: path.join('/'), label: names.join(' / '), leaf: !node.children?.length,
      prefix: naming.length ? naming.join('').replaceAll('_', '') : node.code, legacy: oldPath.join('/') });
    visit(node.children || [], path, names, naming, oldPath);
  }
}
visit(tree);
const categories = entries.filter(entry => entry.leaf).map(entry => entry.value);
function normalizeCategory(value) {
  const raw = String(value || '').replaceAll('\\', '/');
  return entries.find(entry => [entry.value, entry.legacy].some(path => path.toLowerCase() === raw.toLowerCase()))?.value || raw;
}
function inferCategory(values) {
  const matches = entries.filter(entry => values.some(value => [entry.value, entry.legacy].some(path => (`/${String(value).replaceAll('\\', '/').toLowerCase()}/`).includes(`/${path.toLowerCase()}/`))));
  return matches.sort((a, b) => b.value.length - a.value.length)[0]?.value || '';
}
export { tree, entries, categories, inferCategory, normalizeCategory };

// Keep each selector local to its parent; choosing a parent clears its descendants.
export function selectionLevels(value) {
  const selected = normalizeCategory(value).split('/');
  const levels = [];
  let nodes = tree, parent = [];
  while (nodes.length) {
    const choice = nodes.find(node => node.code === selected[parent.length]);
    levels.push({ value: choice ? [...parent, choice.code].join('/') : '', options: nodes.map(node => ({ value: [...parent, node.code].join('/'), label: node.zh, code: node.code })) });
    if (!choice) break;
    parent = [...parent, choice.code];
    nodes = choice.children || [];
  }
  return levels;
}

// Each "all" option selects its parent, so changing a parent also drops stale descendants.
export function filterLevels(value) {
  const levels = selectionLevels(value).map(level => ({
    ...level,
    allValue: level.options[0]?.value.split('/').slice(0, -1).join('/') || '',
    disabled: false, terminal: false
  }));
  const terminal = Boolean(levels.at(-1)?.value);
  while (levels.length < 3) levels.push({ value: '', options: [], allValue: '', disabled: true, terminal });
  return levels;
}
