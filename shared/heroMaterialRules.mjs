const channels = { d: 'D', diffuse: 'D', basecolor: 'D', n: 'N', normal: 'N', orm: 'ORM', shadingmask: 'ShadingMask', a: 'Opacity', alpha: 'Opacity', opacity: 'Opacity', opacitymask: 'Opacity', root: 'Root', id: 'ID', height: 'Height', depth: 'Height', tangent: 'Tangent', flow: 'Tangent', e: 'E', emissive: 'E', emission: 'E' };
export function heroTextureChannel(source) {
  const stem = String(source || '').replace(/\.[^.]+$/, '');
  const token = stem.split(/[_/\\]/).at(-1).toLowerCase();
  return ({ scatter: 'Scatter', srmf: 'SRMF', mask: 'Mask' })[token] || channels[token] || '';
}
export function heroMaterialRole(source, variant) {
  const text = String(source || '').replace(/(?:Face|Hair)\d{3}/ig, '');
  if (/eyebrow|eyelash/i.test(text)) return 'eyebrow';
  if (variant === 'Hair') return 'hair';
  if (/eye_?occlusion/i.test(text)) return 'occlusion';
  if (/lacrimal|lacri.*fluid|tearline/i.test(text)) return 'lacrimal';
  if (/oral|teeth|mouth/i.test(text)) return 'oral';
  if (/iris|(?:^|_)eye(?:_|\d|$)/i.test(text)) return 'eye';
  if (/hair|beard|mustache/i.test(text)) return 'hair';
  if (/skin|(?:^|_)(arm|body|leg|hand|foot)(?:_|\d|$)/i.test(text)) return 'skin';
  return 'face';
}
export function heroTextureSuffix(source, variant) {
  const { part, role } = heroTextureGroup(source, variant);
  const channel = heroTextureChannel(source);
  return `${part ? part + '_' : role === 'face' || variant === 'Hair' ? '' : role + '_'}${channel}`;
}

export function heroTextureGroup(source, variant) {
  const stem = String(source || '').replaceAll('\\', '/').split('/').at(-1).replace(/\.[^.]+$/, '');
  const channel = heroTextureChannel(source);
  const body = channel ? stem.slice(0, stem.lastIndexOf('_')) : stem;
  const part = body.match(/^(?:T_)?[MF]\d+_(?:Hair|Face)\d+_(.+)$/i)?.[1] || '';
  const role = heroMaterialRole(source, variant);
  return { key: part ? part.toLowerCase() : role, part, role };
}

export function heroMaterialGroupForSlot(slot, variant, groups) {
  const normalized = String(slot).replace(/(?:SG|Material)$/i, '').replace(/[^a-z0-9]/ig, '').toLowerCase();
  const matches = groups.filter(group => group.part && normalized.endsWith(group.part.replace(/[^a-z0-9]/ig, '').toLowerCase()))
    .sort((a, b) => b.part.length - a.part.length);
  if (matches.length && (!matches[1] || matches[0].part.length > matches[1].part.length)) return matches[0].key;
  const role = heroMaterialRole(slot, variant);
  const candidates = groups.filter(group => group.role === role);
  return candidates.length === 1 ? candidates[0].key : '';
}
