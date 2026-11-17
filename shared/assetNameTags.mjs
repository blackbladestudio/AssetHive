const fingerprint = value => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function nameFingerprints(metadata, extraNames = []) {
  const names = new Set();
  const visit = value => {
    if (typeof value === 'string') {
      if ((value.match(/[\p{L}\p{N}]+/gu) || []).length > 1) names.add(fingerprint(value));
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  for (const value of [metadata.name, metadata.title, metadata.displayName, metadata.assetName,
    metadata.semanticTags?.name, metadata.semanticTags?.name_formats, metadata.semanticTags?.nameFormats, ...extraNames]) visit(value);
  return names;
}

export function removeAssetNameTags(tags, metadata = {}, extraNames = []) {
  const names = nameFingerprints(metadata, extraNames);
  return (Array.isArray(tags) ? tags : []).filter(tag => !names.has(fingerprint(tag)));
}
