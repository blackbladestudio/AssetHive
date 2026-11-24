// Keep unknown legacy categories readable; only Human / Nonhuman are offered for new imports.
export function normalizeNpcCategory(value) {
  const category = String(value || '').trim();
  if (/^(?:human|h|人类)$/i.test(category)) return 'Human';
  if (/^(?:nonhuman|nh|非人类)$/i.test(category)) return 'Nonhuman';
  return category;
}

export function inferNpcCategory(values = []) {
  for (const value of values) {
    for (const part of String(value || '').split(/[\\/]/)) {
      const match = part.match(/^(Human|Nonhuman|NH|H|非人类|人类)(?=_|$)/i);
      if (match) return normalizeNpcCategory(match[1]);
    }
  }
  return '';
}
