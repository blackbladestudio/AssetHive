const token = value => String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
export const suitMaterialChoiceKey = (part, slot) => `${token(part)}|${slot}`;
export const isSharedSuitMaterialSlot = slot => /^(?:MI|M)_(?:Male|Female)_?\d*_(arm|body|foot|hand|leg|oral|underwear|head\d+|hair\d+|eyebrow\d+|EyeOcclusion)(?:SG|Material)?$/i.test(slot);

// Only a documented spelling alias is corrected. Never fuzzy-match arbitrary
// artist names: multiple valid material groups must remain a user decision.
export function matchSuitMaterialSlot(slot, groups, part = '', choice = '') {
  if (choice) return { key: groups.find(group => group.key === choice)?.key || '', corrected: false };
  const clean = String(slot).replace(/(?:SG|Material)$/i, '');
  function direct(value) {
    const normalized = token(value);
    const candidates = groups.filter(group => normalized === group.key || normalized.endsWith(group.key)).sort((a, b) => b.key.length - a.key.length);
    return candidates.length && (!candidates[1] || candidates[0].key.length > candidates[1].key.length) ? candidates[0].key : '';
  }
  const exact = direct(clean) || direct(clean.replace(/_\d+$/, ''));
  if (exact) return { key: exact, corrected: false };
  const corrected = clean.replace(/(^|_)hari(?=_|$)/ig, '$1hair');
  const correctedKey = corrected !== clean && (direct(corrected) || direct(corrected.replace(/_\d+$/, '')));
  if (correctedKey) return { key: correctedKey, corrected: true };
  // Old FBX hair slots omit the body part. Use the current mesh's part and
  // require exactly one hair/fur group there (or one in the whole package).
  const role = /(?:^|_)(hair|fur)(?:_\d+)?$/i.exec(corrected)?.[1]?.toLowerCase();
  if (!role) return { key: '', corrected: false };
  const candidates = groups.filter(group => new RegExp(`(?:^|_)${role}(?:_\\d+)?$`, 'i').test(group.name));
  const scoped = candidates.filter(group => token(group.name).startsWith(token(part)));
  const selected = scoped.length ? scoped : candidates;
  return { key: selected.length === 1 ? selected[0].key : '', corrected: corrected !== clean };
}

export function reviewSuitMaterialSlots(models, groupNames, choices = {}) {
  const groups = [...new Map(groupNames.filter(Boolean).map(name => [token(name), { key: token(name), name }])).values()];
  if (!groups.length) return []; // Model-only packages are allowed.
  return models.flatMap(model => (model.slots || []).filter(slot => !isSharedSuitMaterialSlot(slot)).map(slot => {
    const id = suitMaterialChoiceKey(model.part, slot);
    const match = matchSuitMaterialSlot(slot, groups, model.part, choices[id]);
    return { id, file: model.file, slot, ...match, groupName: groups.find(group => group.key === match.key)?.name || '', groups };
  }));
}
