import { categories, entries, normalizeCategory } from './gameplayCategories.mjs';
import patterns from './characterFilePatterns.json' with { type: 'json' };

const mapSuffix = new RegExp(patterns.textureSuffix, 'i');
export function gameplayPrefix(category) {
  // Retain old Dropped records; new imports must select one of its child categories.
  return entries.find(entry => entry.leaf && entry.value === normalizeCategory(category))?.prefix || (normalizeCategory(category) === 'Item/Dropped' ? 'Dropped' : '');
}
export function gameplayUsesResourceId(category) { return category === 'Item' || String(category).startsWith('Item/'); }
export function gameplayIdentity(category, value) {
  const prefix = gameplayPrefix(category);
  let name = String(value || '').trim().replace(/^(?:SKEL|SM|SK|MI|T)_/i, '');
  if (prefix && name.toLowerCase().startsWith(prefix.toLowerCase() + '_')) name = name.slice(prefix.length + 1);
  const valid = gameplayUsesResourceId(category) ? /^\d+$/.test(name) : /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
  return { prefix, name, assetName: valid ? (prefix ? `${prefix}_${name}` : name) : '' };
}
export function gameplayCategoryFromName(value) {
  const stem = String(value || '').replaceAll('\\', '/').split('/').at(-1).replace(/^(?:GamePlay|Item)_/i, '').replace(/^(?:SKEL|SM|SK|MI|T)_/i, '');
  return categories.find(category => stem.toLowerCase().startsWith(gameplayPrefix(category).toLowerCase() + '_')) || (/^Dropped_/i.test(stem) ? 'Item/Dropped' : '');
}
// Preserve the material/part tail when the asset name changes. Source files stay intact.
export function gameplayFileStem(assetName, role, sourceStem, aliases = []) {
  const prefix = { staticMesh: 'SM', skeletalMesh: 'SK', skeleton: 'SKEL', physicsAsset: 'SK', material: 'MI', texture: 'T' }[role];
  if (!prefix) return sourceStem;
  let raw = String(sourceStem).replace(/^(?:SKEL|SM|SK|MI|T)_/i, '');
  const channel = role === 'texture' ? patterns.textureMapCodes[raw.match(mapSuffix)?.[1]?.toLowerCase()] : '';
  if (role === 'texture' && !channel) return '';
  if (role === 'texture') raw = raw.replace(mapSuffix, '');
  if (role === 'physicsAsset') raw = raw.replace(/_Physics$/i, '');
  const category = gameplayCategoryFromName(assetName);
  const candidates = [...new Set([assetName, ...aliases, gameplayIdentity(category, assetName).name])]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  let tail = '';
  for (const candidate of candidates) {
    if (raw.toLowerCase() === candidate.toLowerCase()) break;
    if (raw.toLowerCase().startsWith(candidate.toLowerCase() + '_')) { tail = raw.slice(candidate.length); break; }
  }
  // A material named simply Wood_01 is a valid per-asset group, not another asset.
  if (!tail && ['texture', 'material'].includes(role) && !candidates.some(candidate => candidate.toLowerCase() === raw.toLowerCase())) tail = '_' + raw;
  tail = tail.replace(/[()]/g, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/_$/, '');
  return `${prefix}_${assetName}${tail}${role === 'physicsAsset' ? '_Physics' : channel ? '_' + channel : ''}`;
}
