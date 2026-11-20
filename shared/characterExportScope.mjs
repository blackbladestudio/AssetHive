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
