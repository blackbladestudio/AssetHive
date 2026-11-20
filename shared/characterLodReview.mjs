const basename = value => String(value || '').split(/[\\/]/).pop() || '';
const level = value => Number(String(value).match(/_LOD(\d+)(?=\.[^.]+$|$)/i)?.[1] || 0);

// Use normalized names for ownership, source paths/hashes for confirmation.
export function characterLodReview(files) {
  const groups = new Map();
  for (const file of files) {
    if (!/\.fbx$/i.test(file.name)) continue;
    const index = level(file.name);
    const name = basename(file.name).replace(/_LOD\d+(?=\.fbx$)/i, '').replace(/\.fbx$/i, '');
    const key = `${file.kind || (/^SK_/i.test(name) ? 'skeletalMesh' : 'staticMesh')}:${name.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { key, name, files: [] });
    groups.get(key).files.push({ ...file, index });
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)).map(group => ({
    ...group, files: group.files.sort((a, b) => a.index - b.index || a.name.localeCompare(b.name)),
    automatic: [1, 2, 3, 4, 5].filter(index => !group.files.some(file => file.index === index)),
    missingBase: !group.files.some(file => file.index === 0),
    duplicate: new Set(group.files.map(file => file.index)).size !== group.files.length
  }));
}

export function characterLodReviewToken(files) {
  return JSON.stringify(characterLodReview(files).map(group => [group.key, group.files.map(file =>
    [file.index, file.name, file.sourcePath || '', file.sourceHash || '', file.kind || ''])]));
}
