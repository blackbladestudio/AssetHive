// Explicitly named legacy Arrow assets stay independent. Bow_<part> and L/R
// suffixes instead identify components of one equipment package.
// DualHands covers dual knives/swords/axes. PairedSwords is the specific
// uneven-sword type (参差剑), a peer of ShieldAxe, never a mixed-weapon bucket.
export const WEAPON_CATEGORIES = ['Bow', 'Dagger', 'DualHands', 'GreatAxe', 'GreatSword', 'Jade', 'LongSword', 'PairedSwords', 'ShieldAxe', 'Spear', 'Sword'];
export const WEAPON_TYPES = [...WEAPON_CATEGORIES, 'Arrow', 'DualAxe'];
export const WEAPON_UE_ROOT = '/Game/Characters/Weapon_PJZ';
const basename = value => String(value || '').replaceAll('\\', '/').split('/').pop() || '';
const stem = value => basename(value).replace(/\.[^.]+$/, '');
// Canonical names keep the package English name before L/R. Read legacy
// side-first and shortened names without rewriting source files.
export function weaponSideInternal(value, owner = '') {
  const lod = String(value || '').match(/_LOD(\d+)$/i);
  if (lod) return weaponSideInternal(value.slice(0, lod.index), owner) + `_LOD${Number(lod[1])}`;
  const ownerPrefix = String(owner || '').match(/^([A-Za-z]+\d{3})_/i)?.[1];
  if (ownerPrefix) {
    const shared = String(value || '').match(new RegExp('^((?:SM|SK|SKEL|MI|M|T)_)' + ownerPrefix + '(_(?:Physics|D|N|ORM|A|E))?$', 'i'));
    if (shared) return `${shared[1]}${owner}${shared[2] || ''}`;
  }
  const short = String(value || '').match(/^((?:SM|SK|SKEL|MI|M|T)_)?([A-Za-z]+\d{3})_([LR])(_(?:Physics|D|N|ORM|A|E))?$/i);
  if (short && owner.toLowerCase().startsWith(short[2].toLowerCase() + '_')) return `${short[1] || ''}${owner}_${short[3].toUpperCase()}${short[4] || ''}`;
  if (short) return value;
  return String(value || '').replace(/^((?:(?:SM|SK|SKEL|MI|M|T)_)?[A-Za-z]+\d{3})_([LR])_(.+?)(_(?:D|N|ORM|A|E|Physics))?$/i,
    (_, head, side, name, tail = '') => `${head}_${name}_${side.toUpperCase()}${tail}`);
}
export function weaponSideOutput(value) {
  return weaponSideInternal(value);
}
export function weaponPackageOutput(value, owner) {
  return weaponSideInternal(value, owner);
}
export function weaponCategory(type) {
  const canonical = WEAPON_TYPES.find(value => value.toLowerCase() === String(type || '').replace(/^SheidAxe$/i, 'ShieldAxe').toLowerCase());
  return canonical === 'Arrow' ? 'Bow' : canonical === 'DualAxe' ? 'DualHands' : canonical || '';
}
export function parseWeaponIdentity(value) {
  const match = String(value || '').match(/^([A-Za-z]+)(\d{3})_([A-Za-z][A-Za-z0-9_]*?)$/);
  if (!match) return null;
  const type = WEAPON_TYPES.find(item => item.toLowerCase() === match[1].replace(/^SheidAxe$/i, 'ShieldAxe').toLowerCase());
  if (!type) return null;
  return { type, category: weaponCategory(type), serial: match[2], name: match[3], assetName: `${type}${match[2]}_${match[3]}` };
}
export function weaponFileIdentity(file) {
  const name = weaponSideInternal(stem(file)).replace(/^(?:SM|SK|SKEL|MI|T)_/i, '')
    .replace(/_(?:Physics|LOD\d+)$/i, '').split(/_Part_/i)[0];
  const part = /_(L|R|Bow|Arrow|Arrowbag)(?:_|$)/i.exec(name);
  const identity = parseWeaponIdentity(part ? name.slice(0, part.index) : name);
  if (identity) return identity;
  // Short L/R filenames intentionally omit the package name; obtain it from
  // the containing art package, never treat L/R as a new asset name.
  if (/^[A-Za-z]+\d{3}_[LR]$/i.test(name)) {
    const categoryNumber = name.replace(/_[LR]$/i, '');
    const folders = String(file).replaceAll('\\', '/').split('/').slice(0, -1).reverse();
    for (const folder of folders) {
      const candidate = folder.match(/^[A-Za-z]+\d{3}_[A-Za-z][A-Za-z0-9_]*/)?.[0]?.replace(/_+$/, '');
      if (candidate?.toLowerCase().startsWith(categoryNumber.toLowerCase() + '_')) return parseWeaponIdentity(candidate);
    }
  }
  return null;
}
export function weaponModelSlot(value) {
  // Legacy art packages name the quiver Bow_06_Parts_a. Match this
  // before the generic Bow token, which would otherwise merge two meshes.
  if (/^(?:SM_|SK_)?Bow_\d+_Parts_a$/i.test(stem(value))) return 'Arrowbag';
  const part = /_(L|R|Bow|Arrow|Arrowbag)(?:_|$)/i.exec(stem(value));
  return part ? ['L', 'R', 'Bow', 'Arrow', 'Arrowbag'].find(slot => slot.toLowerCase() === part[1].toLowerCase()) : '';
}
export function weaponAssemblyKind(asset) {
  const explicit = asset?.meta?.character?.weaponAssembly;
  if (['single', 'combined'].includes(explicit)) return explicit;
  if (['sharedPair', 'separatePair', 'bow', 'custom'].includes(asset?.meta?.character?.weaponLayout)) return 'combined';
  const type = asset?.meta?.character?.weaponType || parseWeaponIdentity(asset?.name)?.type;
  if (['DualHands', 'DualAxe', 'PairedSwords', 'ShieldAxe'].includes(type)) return 'combined';
  const slots = new Set((asset?.meta?.characterManifest?.files || [])
    .filter(file => ['model', 'staticMesh', 'skeletalMesh'].includes(file.role))
    .map(file => weaponModelSlot(file.normalizedName || file.storedPath)).filter(Boolean));
  return slots.size > 1 || slots.has('L') || slots.has('R') ? 'combined' : 'single';
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
    const name = weaponSideInternal(stem(file)).replace(/^(?:SM|SK|SKEL|MI|T)_/i, '').replace(/^SheidAxe/i, 'ShieldAxe').toLowerCase();
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
  sourceStem = weaponSideInternal(sourceStem, sourceIdentity);
  if (['staticMesh', 'skeletalMesh', 'model'].includes(role)) {
    const slot = weaponModelSlot(sourceStem);
    if (slot) return '_' + slot;
  }
  const raw = String(sourceStem).replace(/^(?:SM|SK|SKEL|MI|T)_/i, '').replace(/^SheidAxe/i, 'ShieldAxe');
  const identity = sourceIdentity || raw.match(/^[A-Za-z]+\d{3}_[A-Za-z][A-Za-z0-9]*/)?.[0];
  if (!identity || !raw.toLowerCase().startsWith(identity.toLowerCase())) return '';
  let suffix = raw.slice(identity.length);
  if (['staticMesh', 'skeletalMesh', 'model'].includes(role)) {
    const slot = weaponModelSlot(raw);
    if (slot) return '_' + slot;
  }
  if (role === 'texture') suffix = suffix.replace(/_(?:D|N|ORM|A)$/i, '');
  if (role === 'physicsAsset') suffix = suffix.replace(/_Physics$/i, '');
  return suffix;
}
