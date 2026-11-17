// Gallery concurrency must not depend on unrelated metadata writes (UE receipts/history/status).
export function characterGalleryRevision(meta) {
  const state = meta?.characterComponents || {};
  if (state.previewGalleryRevision) return state.previewGalleryRevision;
  const images = (meta?.previews?.images || []).map(image => ({ uri: String(image.uri || ''), tags: [...(image.tags || [])].sort() }));
  const cover = String(meta?.previewImage || meta?.detailImage || '');
  if (!images.length && !cover) return state.contentRevision || 'initial';
  const snapshot = JSON.stringify({ revision: state.contentRevision || 'initial', images, cover });
  let hash = 2166136261;
  for (let i = 0; i < snapshot.length; i++) hash = Math.imul(hash ^ snapshot.charCodeAt(i), 16777619);
  return `gallery-${(hash >>> 0).toString(16)}`;
}
