const level = name => Number(String(name || '').match(/_LOD(\d+)(?=\.[^.]+$|$)/i)?.[1] || 0);
const meshRole = file => file.role === 'skeletalMesh' ? 'skeletalMesh' : ['model', 'staticMesh'].includes(file.role) ? 'staticMesh' : '';

// LOD0 stays in the ordinary model sections. Five explicit destinations allow
// several levels in one targeted update; preserve any existing higher levels.
export function characterLodUpdateTargets(groups) {
  return groups.flatMap(group => ['staticMesh', 'skeletalMesh'].flatMap(role => {
    const files = group.files.filter(file => meshRole(file) === role && /\.fbx$/i.test(file.normalizedName || file.storedPath));
    const base = files.find(file => level(file.normalizedName || file.storedPath) === 0);
    if (!base) return [];
    const modelName = (base.normalizedName || base.storedPath.split(/[\\/]/).pop()).replace(/(?:_LOD0)?\.fbx$/i, '')
      .replace(/^(?:SK|SM)_/i, role === 'skeletalMesh' ? 'SK_' : 'SM_');
    const rows = files.filter(file => level(file.normalizedName || file.storedPath) > 0).map(file => ({
      storedPath: file.storedPath, fileName: file.normalizedName || file.storedPath.split(/[\\/]/).pop(),
      role, lod: level(file.normalizedName || file.storedPath), modelName, isNew: false
    })).sort((a, b) => a.lod - b.lod);
    for (let index = 1; index <= 5; index++) {
      if (!rows.some(row => row.lod === index)) rows.push({
        storedPath: `__new_character_lod__:${role}:${index}:${encodeURIComponent(group.slot)}`,
        fileName: `${modelName}_LOD${index}.fbx`, role, lod: index, modelName, isNew: true
      });
    }
    return rows.sort((a, b) => a.lod - b.lod);
  }));
}
