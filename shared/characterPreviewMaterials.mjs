import { heroMaterialRole, heroTextureGroup, heroMaterialGroupForSlot } from './heroMaterialRules.mjs';
import { weaponFileIdentity, weaponPackageOutput } from './weaponRules.mjs';

const channelAliases = Object.freeze({
  d: ['d', 'diffuse', 'basecolor'],
  n: ['n', 'normal'],
  orm: ['orm'],
  a: ['a', 'alpha', 'opacity', 'opacitymask']
});

const heroSlotPattern = /head|face|hair|beard|mustache|eyebrow|eyelash|iris|eye|lacri|tearline|oral|teeth|mouth|skin|body|arm|hand|foot|leg/i;

function normalizedKeys(textureKeys) {
  return new Set([...textureKeys].map(value => String(value || '').trim().toLowerCase()).filter(Boolean));
}

export function characterPreviewTextureKey(stem, channel, textureKeys) {
  const keys = textureKeys instanceof Set ? textureKeys : normalizedKeys(textureKeys);
  const prefix = `t_${String(stem || '').trim().toLowerCase()}_`;
  for (const suffix of channelAliases[channel] || []) {
    const key = prefix + suffix;
    if (keys.has(key)) return key;
  }
  return '';
}

function textureBaseRows(textureKeys) {
  const rows = [];
  for (const key of normalizedKeys(textureKeys)) {
    for (const [channel, aliases] of Object.entries(channelAliases)) {
      const suffix = aliases.find(alias => key.endsWith(`_${alias}`));
      if (!suffix) continue;
      rows.push({ key, base: key.slice(2, -(suffix.length + 1)), channel });
      break;
    }
  }
  return rows;
}

export function heroPreviewMaterialRole(materialName, heroPart = '') {
  if (!/^(Face|Hair)$/i.test(heroPart)) return '';
  if (/^Hair$/i.test(heroPart)) return heroMaterialRole(materialName, 'Hair');
  const name = String(materialName || '');
  return heroSlotPattern.test(name) ? heroMaterialRole(name, 'Face') : '';
}

export function characterPreviewMaterialPlan(materialName, textureKeys, heroPart = '', allowWeaponFallback = true) {
  const keys = normalizedKeys(textureKeys);
  const rows = textureBaseRows(keys);
  let stem = String(materialName || '').replace(/^(?:mi|m)_/i, '').toLowerCase();
  const hasAnyChannel = candidate => Object.keys(channelAliases)
    .some(channel => characterPreviewTextureKey(candidate, channel, keys));

  if (!hasAnyChannel(stem)) {
    const identity = weaponFileIdentity(materialName);
    // FBX material slots may retain either old naming scheme. Resolve aliases
    // only when they identify one texture group, preserving the left/right side.
    const owners = identity ? [identity.assetName] : [...new Set(rows.map(row => weaponFileIdentity('MI_' + row.base)?.assetName).filter(Boolean))];
    const matches = [...new Set(rows.filter(row => owners.some(owner =>
      weaponPackageOutput('MI_' + row.base, owner).toLowerCase() === weaponPackageOutput('MI_' + stem, owner).toLowerCase()))
      .map(row => row.base))];
    if (matches.length === 1) stem = matches[0];
  }

  if (!hasAnyChannel(stem)) {
    // Renaming a managed suit does not rewrite the material slots embedded in
    // its FBX. Match the longest unique suit group (for example Upbody_01).
    const materialKey = stem.replace(/(?:sg|material)$/i, '').replace(/[^a-z0-9]/g, '');
    const candidates = rows.filter(row => row.channel === 'd').flatMap(row => {
      const match = /^[mf]\d+_(?:light|medium|heavy)\d+_[^_]+_(.+)$/.exec(row.base);
      const group = match?.[1].replace(/[^a-z0-9]/g, '');
      return group && materialKey.endsWith(group) ? [{ base: row.base, length: group.length }] : [];
    }).sort((a, b) => b.length - a.length);
    if (candidates.length && (!candidates[1] || candidates[0].length > candidates[1].length)) stem = candidates[0].base;
  }

  if (!hasAnyChannel(stem) && allowWeaponFallback) {
    // A single-material weapon may retain its original FBX material name.
    const weaponGroups = [...new Set(rows.filter(row => row.channel === 'd'
      && /^(?:(?:bow|arrow|greataxe|jade|longsword|spear|sword)\d+_.+|(?:dagger|dualhands|dualaxe|greatsword|pairedswords|shieldaxe)\d+(?:_.+)?)$/i.test(row.base))
      .map(row => row.base))];
    if (weaponGroups.length === 1) stem = weaponGroups[0];
  }

  const role = heroPreviewMaterialRole(materialName, heroPart);
  if (!hasAnyChannel(stem) && role) {
    const heroGroups = [...new Set(rows.filter(row => /^[mf]\d+_(face|hair)\d+(?:_.+)?$/i.test(row.base)).map(row => row.base))]
      .map(base => ({ ...heroTextureGroup('T_' + base + '_D', heroPart), key: base }));
    const matched = heroMaterialGroupForSlot(materialName, heroPart, heroGroups);
    if (matched) stem = matched;
  }

  return {
    stem,
    role,
    hasTextures: hasAnyChannel(stem),
    // Face hair, beard, moustache, brows and lashes use a white neutral base
    // in AssetHive previews when their final colour comes from a shared UE MI.
    neutralWhite: ['hair', 'eyebrow'].includes(role)
  };
}
