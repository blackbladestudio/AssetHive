function nameText(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return /^(?:\[object Object\]|undefined|null)$/i.test(text) ? "" : text;
}

function resolveMegascansName(metadata = {}, fallback = "") {
  // Newer Bridge payloads use a structured name object. Its title is the
  // original display name; the short/file variants are machine-facing names.
  const candidates = [
    metadata.name,
    metadata.name?.formats?.title,
    metadata.name?.title,
    metadata.title,
    metadata.displayName,
    metadata.assetName,
    metadata.semanticTags?.name,
    fallback
  ];
  return candidates.map(nameText).find(Boolean) || "";
}

module.exports = { resolveMegascansName };
