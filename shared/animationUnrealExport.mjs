// UE folders are chosen independently from the archive. The FBX stem is the
// AnimSequence name; archive folders only provide search hints.
export const ANIMATION_UE_EXPORT_VERSION = 1;
export const ANIMATION_UE_CAPABILITY = 'characterAnimationV1';
export const DEFAULT_ANIMATION_UE_ROOT = '/Game/Animation';
export const DEFAULT_HERO_ANIMATION_SKELETON = '/Game/Characters/Hero/Asset_PJZ/Common/SKEL_Character';
export const ANIMATION_LABEL_LIMIT = 12;
export const ANIMATION_LABEL_MAX_LENGTH = 24;

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const ASSET_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const slashes = value => String(value || '').trim().replaceAll('\\', '/');

export function parseAnimationLabels(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[,，、;；\n\r]+/);
  const seen = new Set();
  const labels = [];
  for (const item of raw) {
    const label = String(item || '').trim().replace(/\s+/g, ' ').slice(0, ANIMATION_LABEL_MAX_LENGTH);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
    if (labels.length >= ANIMATION_LABEL_LIMIT) break;
  }
  return labels;
}

export function normalizeUnrealFolder(value) {
  const folder = slashes(value).replace(/\/+/g, '/').replace(/\/$/, '');
  if (!/^\/Game(?:\/|$)/.test(folder)) return '';
  return folder.split('/').slice(2).every(segment => SEGMENT.test(segment)) ? folder : '';
}

export function animationArchiveLocation(fbxPath, libraryRoot = '') {
  const file = slashes(fbxPath);
  if (!/\.fbx$/i.test(file) || file.split('/').some(part => part === '.' || part === '..')) return null;
  const root = slashes(libraryRoot).replace(/\/+$/, '');
  let parts = file.split('/').filter(Boolean);
  if (root) {
    if (!file.toLowerCase().startsWith(root.toLowerCase() + '/') || root.split('/').some(part => part === '.' || part === '..')) return null;
    parts = file.slice(root.length + 1).split('/');
    if (parts[0]?.toLowerCase() !== 'animation' || parts.some(part => !part)) return null;
  }
  const animationIndex = parts.findIndex(part => part.toLowerCase() === 'animation');
  if (animationIndex < 0) return null;
  const segments = parts.slice(animationIndex + 1, -1);
  const stem = parts[parts.length - 1].replace(/\.[^.]+$/, '');
  return { segments, stem };
}

// Clips of one character share a Skeleton: Animation/<Owner>/<Character>/...
export function animationCharacterKey(location) {
  const segments = (location?.segments || []).slice(0, 2);
  if (segments.length === 1) {
    const character = location?.stem?.match(/^AS_([^_]+)/i)?.[1];
    if (character) segments.push(character);
  }
  return segments.join('/');
}

export function animationDestinationKey(location) {
  return (location?.segments || []).join('/') || animationCharacterKey(location);
}

export function suggestAnimationFolders(folders, location, query = '') {
  const character = animationCharacterKey(location).split('/')[1] || '';
  const category = location?.segments?.at(-1) || '';
  const categoryHint = ({ locomotion: 'loco', attack: 'attack', hit: 'hit' })[category.toLowerCase()] || category;
  const terms = String(query).toLowerCase().split(/[\s/\\]+/).filter(Boolean);
  const fuzzy = (value, term) => {
    if (value.includes(term)) return true;
    let index = 0;
    for (const letter of value) if (letter === term[index]) index++;
    return index === term.length;
  };
  return [...new Set(folders)].filter(folder => normalizeUnrealFolder(folder))
    .filter(folder => terms.length ? terms.every(term => fuzzy(folder.toLowerCase(), term)) : !character || folder.toLowerCase().includes(character.toLowerCase()))
    .sort((a, b) => {
      const score = folder => Number(folder.toLowerCase().includes(character.toLowerCase())) * 4
        + Number(Boolean(categoryHint) && folder.toLowerCase().split('/').at(-1) === categoryHint.toLowerCase()) * 3
        + Number(folder.includes('/Animation/'));
      return score(b) - score(a) || a.localeCompare(b);
    }).slice(0, 20);
}

export function defaultAnimationSkeleton(affiliation, location) {
  const owner = String(location?.segments?.[0] || '').toLowerCase();
  return affiliation === '主角' || (!affiliation && owner === 'hero') ? DEFAULT_HERO_ANIMATION_SKELETON : '';
}

export function resolveAnimationExportOptions(saved = {}) {
  return {
    root: saved.root === undefined ? DEFAULT_ANIMATION_UE_ROOT : String(saved.root),
    skeletons: saved.skeletons && typeof saved.skeletons === 'object' ? { ...saved.skeletons } : {},
    targetFolders: saved.targetFolders && typeof saved.targetFolders === 'object' ? { ...saved.targetFolders } : undefined,
    enableRootMotion: saved.enableRootMotion !== false,
    forceRootLock: saved.forceRootLock !== false,
    showImportDialog: saved.showImportDialog !== false,
    allowEngineCompressionFallback: saved.allowEngineCompressionFallback !== false
  };
}

// items: { assetId, name, fbxPath, affiliation }
export function planAnimationExport(items, options = {}, libraryRoot = '') {
  const settings = resolveAnimationExportOptions(options);
  const root = normalizeUnrealFolder(options.root ?? settings.root);
  return items.map(item => {
    const location = animationArchiveLocation(item.fbxPath, libraryRoot);
    const characterKey = animationCharacterKey(location);
    const skeletonPath = String(settings.skeletons[characterKey] ?? defaultAnimationSkeleton(item.affiliation, location)).trim();
    const row = { assetId: item.assetId, name: location?.stem || item.name, characterKey, sourcePath: item.fbxPath, targetPath: '', skeletonPath, error: '' };
    const folder = settings.targetFolders ? normalizeUnrealFolder(settings.targetFolders[animationDestinationKey(location)]) : root;
    if (!folder) return { ...row, error: '请选择 UE 目标目录，需以 /Game 开头，且只包含字母、数字、下划线或连字符' };
    if (!location) return { ...row, error: '动画 FBX 必须位于当前资源库的 Animation 归档目录内，且不能包含相对路径' };
    if (!ASSET_NAME.test(location.stem)) return { ...row, error: `文件名不符合 UE 资产命名：${location.stem}` };
    const targetPath = [folder, location.stem].join('/');
    if (!skeletonPath && settings.showImportDialog) return { ...row, targetPath };
    if (!normalizeUnrealFolder(skeletonPath)) return { ...row, targetPath, error: '请填写 UE 中已有的 Skeleton 路径（/Game/...）' };
    return { ...row, targetPath };
  });
}
