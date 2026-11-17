// Quixel's Grid/thumbnail render is the material sphere. Popup renders can be
// flat, tiled or clay, so array order must not decide a material's card image.
function materialPreview(meta, assetType) {
  if (!['surface', 'decal', 'atlas', 'imperfection'].includes(String(assetType).toLowerCase())) return null;
  const images = [...(meta.previews?.images || []), meta.previews?.thumb].filter(item => item && typeof item.uri === 'string');
  return images.filter(item => {
    const tags = (item.tags || []).map(tag => String(tag).toLowerCase());
    const name = item.uri.split(/[?#]/)[0];
    const sizes = String(item.resolution || '').split('x').map(Number);
    return !name.startsWith('data:') && /\.(png|jpe?g|webp)$/i.test(name)
      && !tags.some(tag => ['clay', 'tiled', 'tiny', 'sidepanel'].includes(tag))
      && !/(?:Popup|Clay|Tiled)/i.test(name)
      && (/(?:^|[_/.-])Grid(?:[_/.-]|$)/i.test(name) || tags.includes('sphere') || tags.includes('thumb'))
      && (!sizes[0] || Math.max(...sizes) <= 4096) && Math.max(...sizes.filter(Number.isFinite), 0) !== 24;
  }).sort((a, b) => {
    const size = item => Math.max(...String(item.resolution || '').split('x').map(Number).filter(Number.isFinite), 0);
    return size(b) - size(a) || Number(/\.png(?:[?#]|$)/i.test(b.uri)) - Number(/\.png(?:[?#]|$)/i.test(a.uri));
  })[0] || null;
}

module.exports = { materialPreview };
