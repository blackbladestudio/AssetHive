// Weapon identity is independent of mesh kind. Arrows live under Bow but are
// separate library assets, never children of the bow that happened to ship them.
export const WEAPON_CATEGORIES = ['Bow', 'GreatAxe', 'Jade', 'LongSword', 'PairedSwords', 'ShieldAxe', 'Spear', 'Sword'];
export const WEAPON_TYPES = [...WEAPON_CATEGORIES, 'Arrow'];
export const WEAPON_UE_ROOT = '/Game/Characters/Weapon_PJZ';
const basename = value => String(value || '').replaceAll('\\', '/').split('/').pop() || '';
const stem = value => basename(value).replace(/\.[^.]+$/, '');
export function weaponCategory(type) {
  const canonical = WEAPON_TYPES.find(value => value.toLowerCase() === String(type || '').toLowerCase());
  return canonical === 'Arrow' ? 'Bow' : canonical || '';
}
export function parseWeaponIdentity(value) {
  const match = String(value || '').match(/^([A-Za-z]+)(\d{3})_([A-Za-z][A-Za-z0-9_]*?)$/);
  if (!match) return null;
  const type = WEAPON_TYPES.find(item => item.toLowerCase() === match[1].toLowerCase());
  if (!type) return null;
  return { type, category: weaponCategory(type), serial: match[2], name: match[3], assetName: `${type}${match[2]}_${match[3]}` };
}
export function weaponFileIdentity(file) {
  const name = stem(file).replace(/^(?:SM|SK|SKEL|MI|T)_/i, '')
    .replace(/_(?:Physics|LOD\d+)$/i, '').split(/_Part_/i)[0];
  return parseWeaponIdentity(name);
}
export function weaponTargetRoot(identity) {
  const parsed = parseWeaponIdentity(identity);
  if (!parsed) throw new Error('请确认武器类别、三位编号和名称');
  return `${WEAPON_UE_ROOT}/${parsed.category}/${parsed.assetName}`;
}
export function splitWeaponPackage(files) {
  const identities = new Map();
  for (const file of files.filter(file => /\.(?:fbx|obj|gltf|glb)$/i.test(file))) {
    const identity = weaponFileIdentity(file);
    if (identity) identities.set(identity.assetName.toLowerCase(), identity);
  }
  const groups = [...identities.values()].map(identity => ({ ...identity, files: [] }));
  const unassigned = [];
  for (const file of files) {
    const name = stem(file).replace(/^(?:SM|SK|SKEL|MI|T)_/i, '').toLowerCase();
    const matching = groups.filter(group => name === group.assetName.toLowerCase() || name.startsWith(group.assetName.toLowerCase() + '_'));
    // Prefer the longest explicit identity (names can contain underscores).
    matching.sort((a, b) => b.assetName.length - a.assetName.length);
    const folders = String(file).replaceAll('\\', '/').toLowerCase().split('/').slice(0, -1);
    const folderMatches = groups.filter(group => folders.includes(group.assetName.toLowerCase()));
    const owner = matching[0] || (folderMatches.length === 1 ? folderMatches[0] : groups.length === 1 ? groups[0] : null);
    if (owner) owner.files.push(file); else unassigned.push(file);
  }
  return { groups, unassigned };
}
// Preserve material groups and explicitly named optional parts when the Chinese
// display name changes the identity. Bow/Arrow are split before this operation.
export function weaponFileSuffix(sourceStem, role, sourceIdentity) {
  const raw = String(sourceStem).replace(/^(?:SM|SK|SKEL|MI|T)_/i, '');
  const identity = sourceIdentity || raw.match(/^[A-Za-z]+\d{3}_[A-Za-z][A-Za-z0-9]*/)?.[0];
  if (!identity || !raw.toLowerCase().startsWith(identity.toLowerCase())) return '';
  let suffix = raw.slice(identity.length);
  if (role === 'texture') suffix = suffix.replace(/_(?:D|N|ORM|A)$/i, '');
  if (role === 'physicsAsset') suffix = suffix.replace(/_Physics$/i, '');
  return suffix;
}
