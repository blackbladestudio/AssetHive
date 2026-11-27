// Keep inspection independent of the user's optional static-mesh selection.
// Remove only dependencies used exclusively by excluded models; standalone
// materials/textures remain sendable before binding has been delivered.
export function characterExportScope(rows, includeStaticMeshes = false) {
  if (includeStaticMeshes) return rows;
  if (!rows.some(row => ['skeletalMesh', 'groom'].includes(row.kind))) return rows.filter(row => row.kind !== 'staticMesh');
  const byKey = new Map(rows.map(row => [row.key, row]));
  const closure = roots => {
    const found = new Set();
    const visit = key => {
      if (found.has(key)) return;
      found.add(key);
      for (const dependency of byKey.get(key)?.dependencies || []) visit(dependency);
    };
    roots.forEach(row => visit(row.key));
    return found;
  };
  const excluded = closure(rows.filter(row => row.kind === 'staticMesh'));
  const retained = closure(rows.filter(row => row.kind !== 'staticMesh' && !excluded.has(row.key)));
  return rows.filter(row => row.kind !== 'staticMesh' && (!excluded.has(row.key) || retained.has(row.key)));
}

// Skip a failed branch together with its dependents. Other branches remain
// sendable; aliases of one shared UE resource must always have one decision.
export function skipUnreadyCharacterEntries(rows, decisions = {}) {
  const skipped = new Set(rows.filter(row => ['failed', 'blocked'].includes(row.status) || decisions[row.key] === 'skip').map(row => row.key));
  let changed = true;
  while (changed) {
    changed = false;
    const shared = new Set(rows.filter(row => skipped.has(row.key) && row.sharedEntryKey).map(row => row.sharedEntryKey));
    for (const row of rows) {
      if (!skipped.has(row.key) && ((row.dependencies || []).some(key => skipped.has(key)) || shared.has(row.sharedEntryKey))) {
        skipped.add(row.key);
        changed = true;
      }
    }
  }
  return { ...decisions, ...Object.fromEntries([...skipped].map(key => [key, 'skip'])) };
}
