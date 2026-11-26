import patterns from './characterFilePatterns.json' with { type: 'json' };

// Strip the channel once, then preserve the entire group after the known owner.
// Parts_a is a group: its final 'a' must not be stripped as an opacity channel.
export function characterMaterialSuffix(stem, role, owners = []) {
  if (!['texture', 'material'].includes(role)) return '';
  let raw = String(stem).replace(/^(?:MI|T)_/i, '');
  if (role === 'texture') raw = raw.replace(new RegExp(patterns.textureSuffix, 'i'), '');
  const candidates = owners.filter(Boolean).map(value => String(value).replace(/^(?:SK|SM)_/i, ''))
    .sort((a, b) => b.length - a.length);
  for (const owner of candidates) {
    if (raw.toLowerCase() === owner.toLowerCase()) return '';
    if (raw.toLowerCase().startsWith(owner.toLowerCase() + '_')) return raw.slice(owner.length);
  }
  // Legacy numbered packages have a single name token after their category/id.
  const legacy = raw.match(/^[A-Za-z]+\d{3}_[A-Za-z][A-Za-z0-9]*(.*)$/);
  return legacy?.[1] || '';
}
