// Game tags tie an animation to a UE gameplay row: hero clips to a weapon
// category (DT_WeaponCategoryConfig), monster clips to a monster
// (DT_MonsterPrototype).
export const WEAPON_CATEGORY_TABLE = 'Content/Config/Battle/Weapon/DT_WeaponCategoryConfig.uasset';
export const MONSTER_PROTOTYPE_TABLE = 'Content/Config/Battle/DT_MonsterPrototype.uasset';

// The weapon table has no display text; names follow ESEFVWeaponType.
const WEAPON_TYPE_NAMES = {
  UnArmed: '空手',
  Sword: '单手剑',
  GreatSword: '大剑',
  Jade: '玉',
  Bow: '弓',
  PairedSwords: '双剑',
  GreatAxe: '巨斧',
  Spear: '长枪',
  LongSword: '长剑',
  ShieldAxe: '盾斧'
};

const text = value => String(value ?? '').trim();
const enumValue = value => text(value).split('::').pop();

export function animationGameTagKind(affiliation) {
  const value = text(affiliation);
  return value === '主角' ? 'weapon' : value === '怪物' ? 'monster' : '';
}

export function normalizeAnimationGameTag(value) {
  if (!value || typeof value !== 'object') return undefined;
  const kind = text(value.kind);
  const id = text(value.id);
  if (!id || (kind !== 'weapon' && kind !== 'monster')) return undefined;
  return { kind, id, name: text(value.name) || id };
}

export function formatAnimationGameTag(tag) {
  const normalized = normalizeAnimationGameTag(tag);
  if (!normalized) return '';
  return normalized.name === normalized.id ? normalized.id : `${normalized.name} · ${normalized.id}`;
}

export function inferAnimationGameTag(assetName, affiliation, options) {
  const kind = animationGameTagKind(affiliation);
  if (!kind) return undefined;
  const stem = text(assetName).replace(/\.[^.]+$/, '').replace(/^(?:AS|BS|ABP|AM|AC)_/i, '').split('_')[0];
  const normalize = value => text(value).toLowerCase().replace(/^monster[_\s-]*/i, '').replace(/[^a-z0-9\u3400-\u9fff]/g, '').replace(/^unarm(?=\d|$)/, 'unarmed');
  const identity = normalize(stem);
  if (!identity) return undefined;
  const scored = (options || []).filter(option => option.kind === kind).map(option => {
    const aliases = [option.id, option.name, ...(kind === 'weapon' ? [option.group] : [])].map(normalize).filter(Boolean);
    let score = 0;
    for (const alias of aliases) {
      if (identity === alias) score = Math.max(score, 1000 + alias.length);
      else if (identity.replace(/\d+$/, '') === alias.replace(/\d+$/, '')) score = Math.max(score, 700 + alias.length);
      else if (Math.min(identity.length, alias.length) >= 4 && (identity.includes(alias) || alias.includes(identity))) score = Math.max(score, 100 + Math.min(identity.length, alias.length) - Math.abs(identity.length - alias.length));
    }
    return { option, score };
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length || scored[1]?.score === scored[0].score) return undefined;
  return normalizeAnimationGameTag(scored[0].option);
}

export function syncAnimationGameTag(form, options) {
  if (form.assetType !== 'animation' || form.animationGameTagManual === true) return form;
  // 旧草稿的已有选择按手选保留；新自动匹配可随名称刷新，歧义时交给用户选择。
  if (form.animationGameTagManual === undefined && form.animationGameTag) return { ...form, animationGameTagManual: true };
  const kind = animationGameTagKind(form.animationAffiliation);
  const inferred = inferAnimationGameTag(form.assetName, form.animationAffiliation, kind === 'weapon' ? options.weapons : options.monsters) || null;
  if (form.animationGameTagManual === false && JSON.stringify(form.animationGameTag) === JSON.stringify(inferred)) return form;
  return { ...form, animationGameTag: inferred, animationGameTagManual: false };
}

// rows: [{ name, values }] as read from the DataTable.
export function weaponOptionsFromRows(rows) {
  return (rows || []).map(row => {
    const id = text(row?.name);
    const type = enumValue(row?.values?.WeaponType);
    return id ? { kind: 'weapon', id, name: WEAPON_TYPE_NAMES[type] || id, group: type } : null;
  }).filter(Boolean);
}

export function monsterOptionsFromRows(rows) {
  return (rows || []).map(row => {
    const id = text(row?.name);
    const subType = enumValue(row?.values?.CharacterSubType);
    if (!id || subType === 'InteractObj') return null;
    return { kind: 'monster', id, name: text(row?.values?.CharacterName) || id, group: subType };
  }).filter(Boolean);
}
