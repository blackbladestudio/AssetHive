import { heroMaterialRole, heroTextureGroup, heroMaterialGroupForSlot } from './heroMaterialRules.mjs';
import { weaponFileIdentity, weaponPackageOutput } from './weaponRules.mjs';
import { isSharedSuitMaterialSlot } from './suitMaterialMatching.mjs';

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

  if (!hasAnyChannel(stem) && !isSharedSuitMaterialSlot(materialName)) {
    // Renaming a managed suit does not rewrite the material slots embedded in
    // its FBX. English names may themselves contain underscores; compare suffixes
    // instead of assuming the first name token ends the asset name. Numeric-only
    // suffixes cannot identify a material, and tied groups must not be guessed.
    const clean = stem.replace(/(?:sg|material)$/i, '').replace(/(^|_)hari(?=_|$)/ig, '$1hair');
    const bases = [...new Set(rows.map(row => row.base))];
    const matchSlot = slot => {
      const materialKey = slot.replace(/[^a-z0-9]/g, '');
      const candidates = bases.flatMap(base => {
        const match = /^[mf]\d+_(?:light|medium|heavy)\d+_(.+)$/.exec(base);
        const tokens = match?.[1].split('_') || [];
        for (let start = 1; start < tokens.length; start++) {
          if (!/[a-z]/.test(tokens[start])) continue;
          const group = tokens.slice(start).join('');
          if (materialKey.endsWith(group)) return [{ base, length: group.length }];
        }
        return [];
      }).sort((a, b) => b.length - a.length);
      return candidates.length && (!candidates[1] || candidates[0].length > candidates[1].length) ? candidates[0].base : '';
    };
    stem = matchSlot(clean) || matchSlot(clean.replace(/_\d+$/, '')) || stem;
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
