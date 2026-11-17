let sharp = null;
try {
  sharp = require("sharp");
} catch { /* Preview size remains optional when the decoder is unavailable. */ }

function hasPreviewSize(value) {
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)$/i);
  return Boolean(match && Number(match[1]) > 0 && Number(match[2]) > 0
    && Number.isFinite(Number(match[1])) && Number.isFinite(Number(match[2])));
}

// Resolve before publishing records, so scrolling/image loading never changes spans.
// Only read image headers; do not decode full previews or modify library files.
async function populatePreviewSize(asset) {
  if (!asset || hasPreviewSize(asset.meta?.previews?.relativeSize) || !sharp) return asset;
  const previewPath = String(asset.previewImage || asset.preview || "").trim();
  if (!previewPath) return asset;
  try {
    const metadata = await sharp(previewPath).metadata();
    const rotated = metadata.orientation >= 5 && metadata.orientation <= 8;
    const width = rotated ? metadata.height : metadata.width;
    const height = rotated ? metadata.width : metadata.height;
    if (width > 0 && height > 0) {
      asset.meta = { ...asset.meta, previews: { ...asset.meta?.previews, relativeSize: `${width}x${height}` } };
    }
  } catch { /* Missing/unsupported images keep the small placeholder card. */ }
  return asset;
}

module.exports = { hasPreviewSize, populatePreviewSize };
