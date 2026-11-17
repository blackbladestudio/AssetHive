export function characterSendSummary(rows, decisions = {}, done = false) {
  const selected = rows.filter(row => {
    if (['unchanged', 'retained'].includes(row.action)) return false;
    if (done) return row.status === 'success';
    if (row.status === 'missing' || row.status === 'ready') return true;
    return row.status === 'conflict' && ['adopt', 'keepUE', 'applyMapping'].includes(decisions[row.key]);
  });
  const byKind = kind => selected.filter(row => row.kind === kind);
  const models = kind => ({ count: byKind(kind).length, parts: [...new Set(byKind(kind).map(row => row.partSlot || row.name))] });
  const textures = byKind('texture');
  const groups = new Map();
  for (const row of textures) {
    const key = row.key.replace(/:[^:]+$/, '');
    groups.set(key, row.groupName || key.split(':').pop());
  }
  return {
    total: selected.length,
    staticMesh: models('staticMesh'), skeletalMesh: models('skeletalMesh'), groom: models('groom'),
    textures: { count: textures.length, groupCount: groups.size, groups: [...new Set(groups.values())] },
    materials: { count: byKind('material').length, groups: [...new Set(byKind('material').map(row => row.groupName || row.name))] },
    pending: rows.filter(row => !selected.includes(row) && !['unchanged', 'retained'].includes(row.action)).length
  };
}
