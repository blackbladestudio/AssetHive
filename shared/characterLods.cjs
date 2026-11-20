// File suffixes describe levels of one model, never additional components.
const level = value => Number(String(value || '').match(/_LOD(\d+)(?=\.[^.]+$|$)/i)?.[1] || 0);
const strip = value => String(value || '').replace(/_LOD\d+(?=\.[^.]+$|$)/i, '');
const suffix = value => level(value) ? `_LOD${level(value)}` : '';
const identity = value => strip(value).replaceAll('\\', '/').split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
function validate(files) {
  const groups = new Map();
  for (const file of files.filter(file => ['model', 'staticMesh', 'skeletalMesh'].includes(file.role))) {
    const name = file.normalizedName || file.storedPath || file.sourcePath;
    const index = level(name);
    if (index && !/\.fbx$/i.test(name)) throw new Error('独立 LOD 仅支持 FBX：' + name);
    const key = (file.role === 'skeletalMesh' ? 'SK:' : 'SM:') + identity(name).replace(/^(?:sk|sm)_/i, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  }
  for (const [key, levels] of groups) {
    levels.sort((a, b) => a - b);
    if (levels.some((index, position) => index !== position)) throw new Error('模型 LOD 必须从 LOD0 连续排列，不能缺少主模型、重复或跳级：' + key);
  }
}
module.exports = { level, strip, suffix, identity, validate };
