import { characterModelPreviewComponents } from './characterComponents.mjs';
import { ownedWeaponIdentity } from './ownedWeaponNaming.mjs';

// Variant identifies a gameplay subtype; form remains independent within it.
// Never use the legacy character.variant field: it also stores outfit/body data.
export function monsterVariantId(asset) {
  return asset?.assetType === 'monster' ? String(asset.meta?.character?.monsterVariant || '').trim() : '';
}

export function monsterVariantLabel(asset) {
  const id = monsterVariantId(asset);
  const saved = asset?.meta?.monsterVariants?.find(item => item.id === id);
  return saved?.name || id;
}

export function monsterCardOccurrence(assetId, variantId) {
  return variantId === undefined ? assetId : `${assetId}::variant::${encodeURIComponent(variantId)}`;
}

export function monsterVariantGroups(assets) {
  const groups = new Map();
  for (const asset of assets.filter(item => item.assetType === 'monster')) {
    for (const variant of asset.meta?.monsterVariants || []) {
      if (!variant.id) continue;
      const previous = groups.get(variant.id);
      groups.set(variant.id, { ...previous, ...variant, assets: previous?.assets || [] });
    }
    const id = monsterVariantId(asset);
    const group = groups.get(id) || { id, name: id || '', assets: [] };
    group.assets.push(asset);
    groups.set(id, group);
  }
  for (const group of groups.values()) {
    for (const id of group.assetIds || []) {
      const asset = assets.find(item => item.id === id);
      if (asset && !group.assets.some(item => item.id === id)) group.assets.push(asset);
    }
  }
  return [...groups.values()];
}

export function monsterVariantModelGroups(asset, variantId = '') {
  const groups = characterModelPreviewComponents(asset);
  const variant = asset?.meta?.monsterVariants?.find(item => item.id === variantId);
  const slots = variant?.modelSlotsByAsset?.[asset.id];
  if (variant?.modelSlotsByAsset && !Array.isArray(slots)) return [];
  return Array.isArray(slots) ? groups.filter(part => slots.includes(part.slot)) : groups;
}

export function monsterVariantModelEntries(asset, variantId = '', relatedAssets = []) {
  if (!asset) return [];
  const own = monsterVariantModelGroups(asset, variantId).map(part => ({ asset, part }));
  if (!variantId) return own;
  const variant = asset.meta?.monsterVariants?.find(item => item.id === variantId);
  if (!variant?.modelSlotsByAsset) return own;
  const shared = relatedAssets.filter(owner => owner.id !== asset.id).flatMap(owner => {
    const slots = variant.modelSlotsByAsset[owner.id] || [];
    return characterModelPreviewComponents(owner).filter(part => part.role === 'weapon' && slots.includes(part.slot)).map(part => ({ asset: owner, part }));
  });
  return [...own, ...shared];
}

export function characterOwnedWeapons(asset, variantId = '', relatedAssets = []) {
  if (!['monster', 'npc'].includes(asset?.assetType) || asset.meta?.componentView) return [];
  return monsterVariantModelEntries(asset, variantId, relatedAssets).map(entry => entry.part).filter(part => part.role === 'weapon'
    && part.files.some(file => ['model', 'staticMesh', 'skeletalMesh'].includes(file.role)
      && !/_LOD[1-9]\d*\./i.test(file.normalizedName || file.storedPath))).map(part => ({
        id: part.slot,
        name: part.label !== part.name.replace(/^(?:SM|SK)_/i, '') ? part.label
          : ownedWeaponIdentity(part.name, asset.meta?.character?.name)?.suffix || part.label,
        modelName: part.name,
        sharedAcrossForms: part.sharedAcrossForms
      }));
}
