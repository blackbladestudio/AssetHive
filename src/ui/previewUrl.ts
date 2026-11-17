export function getPreviewUrl(previewPath: string | null) {
  if (!previewPath) return "";
  const normalized = previewPath.replace(/\\/g, "/");
  const url = normalized.startsWith("//") ? `file:${normalized}` : `file:///${normalized.replace(/^\/+/, "")}`;
  // encodeURI preserves URL delimiters, but these characters belong to the file
  // name here. Otherwise # truncates the path and ? becomes a query string.
  return encodeURI(url).replace(/#/g, "%23").replace(/\?/g, "%3F");
}
