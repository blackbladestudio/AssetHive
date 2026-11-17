const path = require("node:path");
const { runImageTask } = require("./imageTasks");
let sharp = null;
try {
  sharp = require("sharp");
} catch {
  // The caller can still use the existing worker fallback.
}

// Common texture formats expose dimensions in their headers. Reading those
// headers in the main process avoids spawning one worker per texture; formats
// with custom readers keep the existing worker path.
async function imageDimensions(filePath, options = {}) {
  const imageTask = options.runImageTask || runImageTask;
  const imageReader = options.sharp || sharp;
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (imageReader && ![".bmp", ".hdr", ".exr", ".tga"].includes(ext)) {
    try {
      const metadata = await imageReader(filePath, { sequentialRead: true }).metadata();
      if (Number(metadata?.width) > 0 && Number(metadata?.height) > 0) {
        return { width: metadata.width, height: metadata.height };
      }
    } catch {
      // The worker retains support for uncommon and legacy image encodings.
    }
  }
  return imageTask("imageSize", [filePath]);
}

module.exports = { imageDimensions };
