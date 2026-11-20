// WP comes before the owner in artist/UE names. Keep old owner_form_WP names readable.
export function ownedWeaponIdentity(stem, ownerHint = '') {
  const value = String(stem || '').replace(/^(?:SM|SK|SKEL|MI|M|T)_/i, '');
  if (ownerHint && value.toLowerCase().startsWith(`wp_${ownerHint}_`.toLowerCase())) return { owner: ownerHint, suffix: value.slice(ownerHint.length + 4) };
  const modern = /^WP_([^_]+)_(.+)$/i.exec(value);
  if (modern) return { owner: modern[1], suffix: modern[2] };
  const legacy = /^(.+?)(?:_\d{2})?_WP_(.+)$/i.exec(value);
  return legacy ? { owner: legacy[1], suffix: legacy[2] } : null;
}
