const channels = { d: 'D', diffuse: 'D', basecolor: 'D', n: 'N', normal: 'N', orm: 'ORM', a: 'Opacity', alpha: 'Opacity', opacity: 'Opacity', opacitymask: 'Opacity', root: 'Root', id: 'ID', height: 'Height', depth: 'Height', tangent: 'Tangent', flow: 'Tangent', e: 'E', emissive: 'E', emission: 'E' };
export function heroTextureChannel(source) {
  const stem = String(source || '').replace(/\.[^.]+$/, '');
  return channels[stem.split(/[_/\\]/).at(-1).toLowerCase()] || '';
}
export function heroMaterialRole(source, variant) {
  if (variant === 'Hair') return 'hair';
  const text = String(source || '').replace(/(?:Face|Hair)\d{3}/ig, '');
  if (/eyebrow|eyelash/i.test(text)) return 'eyebrow';
  if (/eye_?occlusion/i.test(text)) return 'occlusion';
  if (/lacrimal|lacri.*fluid|tearline/i.test(text)) return 'lacrimal';
  if (/oral|teeth|mouth/i.test(text)) return 'oral';
  if (/iris|(?:^|_)eye(?:_|\d|$)/i.test(text)) return 'eye';
  if (/hair|beard|mustache/i.test(text)) return 'hair';
  if (/skin|(?:^|_)(arm|body|leg|hand|foot)(?:_|\d|$)/i.test(text)) return 'skin';
  return 'face';
}
export function heroTextureSuffix(source, variant) {
  const role = heroMaterialRole(source, variant);
  const channel = heroTextureChannel(source);
  return `${role === 'face' || variant === 'Hair' ? '' : role + '_'}${channel}`;
}
