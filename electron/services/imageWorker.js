const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { Buffer } = require("node:buffer");
const { randomUUID, createHash } = require("node:crypto");
const { parentPort, workerData } = require("node:worker_threads");
const sharp = require("sharp");
const { decodeRadiancePreview, radianceSize, previewSize, toneMap } = require("./hdrPreview");

sharp.concurrency(1);
sharp.cache(false);

async function bitmapInput(filePath, metadataOnly = false) {
  // Preserve the standard Windows BMP input path without nativeImage's
  // synchronous decoding/encoding on the Electron main thread.
  const buffer = await fs.readFile(filePath);
  if (buffer.length < 54 || buffer.toString("ascii", 0, 2) !== "BM") throw new Error("无效的 BMP 文件");
  const width = buffer.readInt32LE(18);
  const signedHeight = buffer.readInt32LE(22);
  const height = Math.abs(signedHeight);
  const bits = buffer.readUInt16LE(28);
  const offset = buffer.readUInt32LE(10);
  const rowBytes = Math.ceil(width * bits / 32) * 4;
  if (width <= 0 || height <= 0 || ![24, 32].includes(bits) || buffer.readUInt32LE(30) !== 0
    || offset + rowBytes * height > buffer.length) throw new Error("不支持或损坏的 BMP 像素格式");
  if (metadataOnly) return { width, height };
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const sourceRow = offset + (signedHeight > 0 ? height - 1 - y : y) * rowBytes;
    for (let x = 0; x < width; x++) {
      const source = sourceRow + x * (bits / 8);
      const target = (y * width + x) * 3;
      rgb[target] = buffer[source + 2];
      rgb[target + 1] = buffer[source + 1];
      rgb[target + 2] = buffer[source];
    }
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } });
}

// TGA（索引色 / true-color / 灰度，未压缩或 RLE）解码：为 sharp 提供 raw RGBA 输入。
// AIAssetTool 等管线产物常见 type 2 / 24bpp；角色透明贴图也会使用 type 1 / 8bpp 调色板。
function tgaHeaderSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 18) return null;
  const width = buffer.readUInt16LE(12);
  const height = buffer.readUInt16LE(14);
  if (width <= 0 || height <= 0) return null;
  return { width, height, bits: buffer[16], imageType: buffer[2], descriptor: buffer[17], idLength: buffer[0], colorMapType: buffer[1] };
}

function decodeTga(buffer) {
  const header = tgaHeaderSize(buffer);
  if (!header) throw new Error("无效的 TGA 文件");
  const { width, height, descriptor } = header;
  const baseType = header.imageType % 8; // 1=索引色，2=true-color，3=grayscale（9/10/11 为 RLE 版本）
  const isRle = header.imageType >= 8;
  const colorMapped = baseType === 1;
  const gray = baseType === 3;
  const bits = header.bits;
  const bytesPerPixel = Math.ceil(bits / 8);
  const colorMapFirst = buffer.readUInt16LE(3);
  const colorMapLength = buffer.readUInt16LE(5);
  const colorMapBits = buffer[7];
  const colorMapBytes = Math.ceil(colorMapBits / 8);
  const supported = (baseType === 2 && (bits === 24 || bits === 32))
    || (gray && bits === 8)
    || (colorMapped && header.colorMapType === 1 && (bits === 8 || bits === 16)
      && colorMapLength > 0 && (colorMapBits === 24 || colorMapBits === 32));
  if (!supported) throw new Error("不支持的 TGA 格式");
  const topLeft = (descriptor & 0x20) !== 0;
  const rightToLeft = (descriptor & 0x10) !== 0;
  let src = 18 + header.idLength;
  const colorMapOffset = src;
  if (header.colorMapType === 1) src += colorMapLength * colorMapBytes;
  const pixelCount = width * height;
  const rgba = Buffer.alloc(pixelCount * 4);
  const put = (index, b, g, r, a) => {
    const dst = index * 4;
    rgba[dst] = r; rgba[dst + 1] = g; rgba[dst + 2] = b; rgba[dst + 3] = a;
  };
  const readMappedIndex = () => {
    if (bytesPerPixel === 1) return buffer[src++];
    const value = buffer.readUInt16LE(src);
    src += 2;
    return value;
  };
  const putMapped = (index, paletteIndex) => {
    const entry = paletteIndex - colorMapFirst;
    if (entry < 0 || entry >= colorMapLength) throw new Error("TGA 调色板索引越界");
    const offset = colorMapOffset + entry * colorMapBytes;
    put(index, buffer[offset], buffer[offset + 1], buffer[offset + 2], colorMapBytes === 4 ? buffer[offset + 3] : 255);
  };
  const readAndPut = (index) => {
    if (colorMapped) putMapped(index, readMappedIndex());
    else if (gray) { const v = buffer[src++]; put(index, v, v, v, 255); }
    else {
      const b = buffer[src], g = buffer[src + 1], r = buffer[src + 2];
      const a = bytesPerPixel === 4 ? buffer[src + 3] : 255;
      src += bytesPerPixel;
      put(index, b, g, r, a);
    }
  };
  if (!isRle) {
    for (let i = 0; i < pixelCount; i++) readAndPut(i);
  } else {
    let i = 0;
    while (i < pixelCount) {
      if (src >= buffer.length) throw new Error("TGA 数据不完整");
      const packet = buffer[src++];
      const count = (packet & 0x7f) + 1;
      if (packet & 0x80) {
        if (colorMapped) {
          const paletteIndex = readMappedIndex();
          for (let n = 0; n < count && i < pixelCount; n++, i++) putMapped(i, paletteIndex);
        }
        else if (gray) { const v = buffer[src++]; for (let n = 0; n < count && i < pixelCount; n++, i++) put(i, v, v, v, 255); }
        else {
          const b = buffer[src], g = buffer[src + 1], r = buffer[src + 2];
          const a = bytesPerPixel === 4 ? buffer[src + 3] : 255;
          src += bytesPerPixel;
          for (let n = 0; n < count && i < pixelCount; n++, i++) put(i, b, g, r, a);
        }
      } else {
        for (let n = 0; n < count && i < pixelCount; n++, i++) readAndPut(i);
      }
    }
  }
  if (!topLeft) {
    const rowBytes = width * 4;
    const tmp = Buffer.alloc(rowBytes);
    for (let y = 0; y < Math.floor(height / 2); y++) {
      const a = y * rowBytes, b = (height - 1 - y) * rowBytes;
      rgba.copy(tmp, 0, a, a + rowBytes);
      rgba.copy(rgba, a, b, b + rowBytes);
      tmp.copy(rgba, b, 0, rowBytes);
    }
  }
  if (rightToLeft) {
    for (let y = 0; y < height; y++) {
      const base = y * width * 4;
      for (let x = 0; x < Math.floor(width / 2); x++) {
        const a = base + x * 4, b = base + (width - 1 - x) * 4;
        for (let k = 0; k < 4; k++) { const t = rgba[a + k]; rgba[a + k] = rgba[b + k]; rgba[b + k] = t; }
      }
    }
  }
  return { width, height, data: rgba };
}

async function imageInput(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".bmp") return bitmapInput(filePath);
  if (ext === ".tga") {
    const decoded = decodeTga(await fs.readFile(filePath));
    return sharp(decoded.data, { raw: { width: decoded.width, height: decoded.height, channels: 4 } });
  }
  return sharp(filePath, { sequentialRead: true });
}

// Megascans / Bridge 等来源的置换 EXR 常见「单通道 + 通道名不是 Y」（如 R）：
// three 的 EXRLoader 只支持 RGB 组合或单通道 Y，会直接抛
// "file contains unsupported data channels"。通道改名不改变像素数据与偏移表，
// 因此按字节把首个通道改名为 Y 即可复用同一条解码路径。
function normalizeExrChannelNames(buffer) {
  if (buffer.length < 16 || buffer.readUInt32LE(0) !== 0x01312f76) return false;
  let offset = 8; // magic(4) + version(4)
  while (offset < buffer.length) {
    const nameEnd = buffer.indexOf(0, offset);
    if (nameEnd < 0) return false;
    const attributeName = buffer.toString("ascii", offset, nameEnd);
    offset = nameEnd + 1;
    if (!attributeName) return false; // header end marker
    const typeEnd = buffer.indexOf(0, offset);
    if (typeEnd < 0) return false;
    offset = typeEnd + 1;
    if (offset + 4 > buffer.length) return false;
    const size = buffer.readInt32LE(offset);
    offset += 4;
    if (size < 0 || offset + size > buffer.length) return false;
    if (attributeName === "channels") {
      const entries = [];
      const end = offset + size;
      let cursor = offset;
      while (cursor < end) {
        const channelEnd = buffer.indexOf(0, cursor);
        if (channelEnd < 0 || channelEnd >= end) break;
        const channelName = buffer.toString("ascii", cursor, channelEnd);
        if (!channelName) break;
        entries.push({ name: channelName, start: cursor });
        // name + pixelType(4) + pLinear(1) + reserved(3) + xSampling(4) + ySampling(4)
        cursor = channelEnd + 1 + 16;
      }
      if (entries.length === 0) return false;
      if (entries.some((entry) => entry.name === "Y")) return false;
      if (["R", "G", "B"].every((name) => entries.some((entry) => entry.name === name))) return false;
      const target = entries[0];
      if (target.name.length !== 1) return false;
      buffer[target.start] = "Y".charCodeAt(0);
      return true;
    }
    offset += size;
  }
  return false;
}

async function decodeExr(filePath) {
  const { HalfFloatType, DataUtils } = require("three");
  const { EXRLoader } = await import("three/examples/jsm/loaders/EXRLoader.js");
  const buffer = await fs.readFile(filePath);
  normalizeExrChannelNames(buffer);
  const array = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const parsed = new EXRLoader().setDataType(HalfFloatType).parse(array);
  const { width, height, data } = parsed;
  const channels = data.length / (width * height);
  if (![1, 2, 3, 4].includes(channels)) throw new Error("无效的 EXR 通道数据");
  return { width, height, channels, read(x, y, c) {
    // EXRLoader returns bottom-up texture data; PNG and raw libvips are top-down.
    const channel = channels < 3 ? 0 : c;
    return DataUtils.fromHalfFloat(data[((height - 1 - y) * width + x) * channels + channel]);
  } };
}

async function writePng(pipeline, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const staged = `${outputPath}.${randomUUID()}.tmp`;
  try {
    await pipeline.png({ compressionLevel: 3 }).toFile(staged);
    await fs.rename(staged, outputPath);
    return outputPath;
  } finally {
    await fs.rm(staged, { force: true }).catch(() => {});
  }
}

async function hdrPreview(sourcePath, outputPath, options = {}) {
  let pixels;
  if (path.extname(sourcePath).toLowerCase() === ".hdr") {
    pixels = decodeRadiancePreview(await fs.readFile(sourcePath), options);
  } else {
    const image = await decodeExr(sourcePath);
    const size = previewSize(image.width, image.height, options);
    const data = Buffer.alloc(size.width * size.height * 3);
    for (let y = 0; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        for (let c = 0; c < 3; c++) {
          const value = image.read(Math.floor(x * image.width / size.width), Math.floor(y * image.height / size.height), c);
          data[(y * size.width + x) * 3 + c] = toneMap(value, Number(options.exposure) || 1);
        }
      }
    }
    pixels = { ...size, data, channels: 3 };
  }
  return writePng(sharp(pixels.data, { raw: { width: pixels.width, height: pixels.height, channels: 3 } }), outputPath);
}

async function exrToPng(sourcePath, outputPath, options = {}) {
  const image = await decodeExr(sourcePath);
  const normalize = options?.normalize !== false;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const value = Number(image.read(x, y, 0));
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error("EXR 没有可转换的像素数据");
  }
  const maxSize = Math.max(0, Number(options?.maxSize) || 0);
  const size = maxSize > 0 ? boundedSize(image, maxSize) : { width: image.width, height: image.height };
  const hasRange = max > min;
  const scale = normalize && hasRange ? 255 / (max - min) : 255;
  const offset = normalize && hasRange ? -min * scale : 0;
  const data = Buffer.alloc(size.width * size.height);
  for (let y = 0; y < size.height; y++) {
    const sourceY = Math.min(image.height - 1, Math.floor(y * image.height / size.height));
    for (let x = 0; x < size.width; x++) {
      const sourceX = Math.min(image.width - 1, Math.floor(x * image.width / size.width));
      const value = Number(image.read(sourceX, sourceY, 0)) * scale + offset;
      data[y * size.width + x] = Math.max(0, Math.min(255, Math.round(Number.isFinite(value) ? value : 0)));
    }
  }
  return writePng(sharp(data, { raw: { width: size.width, height: size.height, channels: 1 } }), outputPath);
}

async function imageSize(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".bmp") return bitmapInput(filePath, true);
  if (ext === ".tga") {
    const handle = await fs.open(filePath, "r");
    try {
      const header = Buffer.alloc(18);
      const { bytesRead } = await handle.read(header, 0, 18, 0);
      const size = bytesRead === 18 ? tgaHeaderSize(header) : null;
      if (!size) throw new Error("无效的 TGA 文件");
      return { width: size.width, height: size.height };
    } finally {
      await handle.close();
    }
  }
  if (ext === ".hdr") return radianceSize(await fs.readFile(filePath));
  if (ext === ".exr") {
    // Read the data window without decompressing the image just to choose an
    // output size. Most EXR headers fit well within this prefix.
    const file = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(65536);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      let offset = 8;
      while (offset < bytesRead && buffer[offset]) {
        const nameEnd = buffer.indexOf(0, offset);
        if (nameEnd < 0 || nameEnd >= bytesRead) break;
        const name = buffer.toString("ascii", offset, nameEnd);
        const typeEnd = buffer.indexOf(0, nameEnd + 1);
        if (typeEnd < 0 || typeEnd + 5 > bytesRead) break;
        const size = buffer.readUInt32LE(typeEnd + 1);
        offset = typeEnd + 5;
        if (offset + size > bytesRead) break;
        if (name === "dataWindow" && size === 16) {
          return { width: buffer.readInt32LE(offset + 8) - buffer.readInt32LE(offset) + 1,
            height: buffer.readInt32LE(offset + 12) - buffer.readInt32LE(offset + 4) + 1 };
        }
        offset += size;
      }
    } finally { await file.close(); }
    const { width, height } = await decodeExr(filePath);
    return { width, height };
  }
  return sharp(filePath, { sequentialRead: true }).metadata();
}

async function cachedOutput(kind, assetId, sources, maxSize) {
  const versions = await Promise.all(sources.map(async (file) => {
    if (!file) return null;
    const stats = await fs.stat(file);
    return [file, stats.size, stats.mtimeMs];
  }));
  // 缓存版本同时标识解码语义，源文件未变也不能复用旧的派生像素。
  const hash = createHash("sha256").update(JSON.stringify(["image-v4", kind, versions, maxSize])).digest("hex").slice(0, 24);
  const safeId = String(assetId || "asset").replace(/[^\w-]/g, "_");
  const suffix = kind === "packed" ? "M" : kind === "bcr" ? "BCR" : kind === "channel" ? "C" : "albedoA";
  const outputPath = path.join(os.tmpdir(), "assethive", kind, `${safeId}_${hash}_${suffix}.png`);
  return { outputPath, exists: (await fs.stat(outputPath).catch(() => null))?.size > 0 };
}

function boundedSize(size, maxSize = 4096) {
  return previewSize(Number(size.width), Number(size.height), { maxWidth: maxSize, maxHeight: maxSize });
}

async function scalarChannel(filePath, width, height, slot) {
  if (!filePath) return null;
  if (path.extname(filePath).toLowerCase() !== ".exr") {
    // Remove alpha explicitly: grayscale+alpha would otherwise produce two
    // channels and the fallback JS loop would allocate yet another full buffer.
    return (await imageInput(filePath)).resize(width, height, { fit: "fill" })
      .removeAlpha().greyscale().raw().toBuffer();
  }
  const image = await decodeExr(filePath);
  const out = Buffer.alloc(width * height);
  let min = Infinity;
  let max = -Infinity;
  if (slot === "displacement") {
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const value = image.read(x, y, 0);
        if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); }
      }
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = image.read(Math.floor(x * image.width / width), Math.floor(y * image.height / height), 0);
      if (slot === "displacement" && max > min) value = (value - min) / (max - min);
      out[y * width + x] = Math.round(255 * Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)));
    }
  }
  return out;
}

async function nonExrSibling(filePath) {
  if (path.extname(filePath).toLowerCase() !== ".exr") return filePath;
  const parsed = path.parse(filePath);
  for (const ext of [".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"]) {
    const candidate = path.join(parsed.dir, parsed.name + ext);
    if ((await fs.stat(candidate).catch(() => null))?.isFile()) return candidate;
  }
  return filePath;
}

async function packTextures(entries, assetId, sourceEntries, maxSize) {
  const slots = new Map(entries);
  const sourceSlots = new Map(sourceEntries || []);
  const displacementKeys = [...slots.keys()].filter((key) => key.startsWith("displacement"));
  const dispKey = displacementKeys.find((key) => !String(slots.get(key)).toLowerCase().endsWith(".exr")) || displacementKeys[0];
  const displacement = dispKey ? await nonExrSibling(sourceSlots.get(dispKey) || slots.get(dispKey)) : "";
  const sources = [slots.get("ao"), slots.get("roughness"), displacement, slots.get("opacity")];
  const packedSource = sourceSlots.get("mask") || slots.get("mask") || sourceSlots.get("ordp") || slots.get("ordp");
  if (!sources.some(Boolean) && !packedSource) return "";
  const cached = await cachedOutput("packed", assetId, [...sources, packedSource], maxSize);
  if (cached.exists) return cached.outputPath;
  const sizes = await Promise.all([...sources, packedSource].filter(Boolean).map(imageSize));
  const largest = sizes.reduce((best, size) => size.width * size.height > best.width * best.height ? size : best);
  const { width, height } = boundedSize(largest, maxSize);
  // Only one source decoder and one final RGBA buffer are alive at a time.
  const rgba = Buffer.alloc(width * height * 4);
  const names = ["ao", "roughness", "displacement", "opacity"];
  const defaults = [255, 128, 128, 255];
  for (let c = 0; c < 4; c++) {
    let bytes = await scalarChannel(sources[c], width, height, names[c]);
    if (!bytes && packedSource) {
      // Treat packed channels as independent data, including transparent pixels.
      bytes = await (await imageInput(packedSource)).ensureAlpha().extractChannel(c)
        .resize(width, height, { fit: "fill" }).raw().toBuffer();
    }
    for (let i = 0; i < width * height; i++) rgba[i * 4 + c] = bytes ? bytes[i] : defaults[c];
  }
  // Explicit RGBA avoids libvips promoting the first grayscale input into RGB
  // before joinChannel, which can shift packed mask channels.
  return writePng(sharp(rgba, { raw: { width, height, channels: 4 } }), cached.outputPath);
}

async function packOrmTexture(aoPath, roughnessPath, metalnessPath, assetId, groupId, maxSize) {
  const channels = [aoPath, roughnessPath, metalnessPath];
  if (!channels.some(Boolean)) return "";
  const cached = await cachedOutput("orm", assetId + "_g" + groupId, channels, maxSize);
  if (cached.exists) return cached.outputPath;
  const sizes = await Promise.all(channels.filter(Boolean).map(imageSize));
  const largest = sizes.reduce((best, size) => size.width * size.height > best.width * best.height ? size : best);
  const { width, height } = boundedSize(largest, maxSize);
  const rgba = Buffer.alloc(width * height * 4);
  const slotNames = ["ao", "roughness", "metalness"];
  const defaults = [255, 128, 0, 255];
  for (let c = 0; c < 3; c++) {
    const bytes = await scalarChannel(channels[c], width, height, slotNames[c]);
    for (let i = 0; i < width * height; i++) rgba[i * 4 + c] = bytes ? bytes[i] : defaults[c];
  }
  for (let i = 0; i < width * height; i++) rgba[i * 4 + 3] = 255;
  return writePng(sharp(rgba, { raw: { width, height, channels: 4 } }), cached.outputPath);
}
async function packBcrTexture(albedoPath, roughnessPath, assetId, groupId, maxSize) {
  if (!albedoPath) return "";
  const cached = await cachedOutput("bcr", `${assetId}_g${groupId}`, [albedoPath, roughnessPath], maxSize);
  if (cached.exists) return cached.outputPath;
  const size = boundedSize(await imageSize(albedoPath), maxSize);
  const { data: rgb, info } = await (await imageInput(albedoPath))
    .resize(size.width, size.height, { fit: "fill" })
    .toColourspace("srgb").removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = roughnessPath
    ? await scalarChannel(roughnessPath, size.width, size.height, "roughness")
    : Buffer.alloc(size.width * size.height, 255);
  const rgba = Buffer.alloc(size.width * size.height * 4);
  for (let i = 0; i < size.width * size.height; i++) {
    const source = i * info.channels;
    const target = i * 4;
    rgba[target] = rgb[source] ?? 0;
    rgba[target + 1] = rgb[source + 1] ?? rgb[source] ?? 0;
    rgba[target + 2] = rgb[source + 2] ?? rgb[source] ?? 0;
    rgba[target + 3] = alpha?.[i] ?? 255;
  }
  return writePng(sharp(rgba, { raw: { width: size.width, height: size.height, channels: 4 } }), cached.outputPath);
}

async function unpackPackedTextureChannel(sourcePath, channelIndex, assetId, maxSize) {
  if (!sourcePath) return "";
  const channel = Math.max(0, Math.min(3, Math.floor(Number(channelIndex) || 0)));
  const cached = await cachedOutput("channel", `${assetId}_c${channel}`, [sourcePath], maxSize);
  if (cached.exists) return cached.outputPath;
  const size = boundedSize(await imageSize(sourcePath), Math.max(1, Number(maxSize) || 4096));
  const bytes = await (await imageInput(sourcePath))
    .resize(size.width, size.height, { fit: "fill" })
    .ensureAlpha()
    .extractChannel(channel)
    .raw()
    .toBuffer();
  return writePng(sharp(bytes, { raw: { width: size.width, height: size.height, channels: 1 } }), cached.outputPath);
}

async function hasOpacityAlpha(sourcePath) {
  const image = await imageInput(sourcePath);
  return (await image.metadata()).hasAlpha === true && !(await image.stats()).isOpaque;
}

async function opacityFromAlpha(sourcePath, assetId, maxSize) {
  if (!sourcePath) return "";
  const cached = await cachedOutput("opacity-alpha", assetId, [sourcePath], maxSize);
  if (cached.exists) return cached.outputPath;
  const image = await imageInput(sourcePath);
  if (!(await image.metadata()).hasAlpha) return "";
  const size = boundedSize(await imageSize(sourcePath), Math.max(1, Number(maxSize) || 4096));
  const bytes = await image.resize(size.width, size.height, { fit: "fill" })
    .extractChannel("alpha").raw().toBuffer();
  // 全白 Alpha 等同于不透明；全黑或部分透明都属于有效透贴。
  if (!bytes.some((value) => value < 255)) return "";
  return writePng(sharp(bytes, { raw: { width: size.width, height: size.height, channels: 1 } }), cached.outputPath);
}

async function convertTextureToTga(sourcePath, outputPath, maxSize = 4096, options = {}) {
  const includeAlpha = options?.includeAlpha === true;
  const size = boundedSize(await imageSize(sourcePath), Math.max(1, Number(maxSize) || 4096));
  let image = (await imageInput(sourcePath)).resize(size.width, size.height, { fit: "fill" });
  image = includeAlpha ? image.ensureAlpha() : image.removeAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const channels = includeAlpha ? 4 : 3;
  const header = Buffer.alloc(18);
  header[2] = 2; // Uncompressed true-color image.
  header.writeUInt16LE(size.width, 12);
  header.writeUInt16LE(size.height, 14);
  header[16] = includeAlpha ? 32 : 24;
  header[17] = includeAlpha ? 0x28 : 0x20; // 顶部原点，RGBA 明确声明 8 位 Alpha。
  const pixels = Buffer.alloc(size.width * size.height * channels);
  for (let i = 0; i < size.width * size.height; i++) {
    const source = i * info.channels;
    const target = i * channels;
    pixels[target] = data[source + 2] ?? data[source] ?? 0;
    pixels[target + 1] = data[source + 1] ?? data[source] ?? 0;
    pixels[target + 2] = data[source] ?? 0;
    if (includeAlpha) pixels[target + 3] = data[source + 3] ?? 255;
  }
  return writeBufferAtomic(Buffer.concat([header, pixels]), outputPath);
}

async function mergeAlbedo(albedoPath, opacityPath, assetId, groupId, maxSize) {
  if (!albedoPath || !opacityPath) return albedoPath;
  const cached = await cachedOutput("merged_albedo", `${assetId}_g${groupId}`, [albedoPath, opacityPath], maxSize);
  if (cached.exists) return cached.outputPath;
  const { width, height } = boundedSize(await imageSize(albedoPath), maxSize);
  const alpha = await scalarChannel(opacityPath, width, height, "opacity");
  const rgba = await (await imageInput(albedoPath))
    .resize(width, height, { fit: "fill" }).toColourspace("srgb").ensureAlpha().raw().toBuffer();
  for (let i = 0; i < width * height; i++) rgba[i * 4 + 3] = alpha[i];
  return writePng(sharp(rgba, { raw: { width, height, channels: 4 } }), cached.outputPath);
}

async function autoPreviewCutout(sourcePath, outputPath, tolerance, filterNoise) {
  const { autoCutout, opaqueBounds } = require("./previewCutout");
  const { data, info } = await sharp(sourcePath).rotate()
    .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const result = autoCutout(data, info.width, info.height, tolerance, filterNoise);
  if (!result.ok) return result;
  // Match the 10px padding used when confirming a cutout, and show it immediately.
  const bounds = opaqueBounds(data, info.width, info.height);
  const left = Math.max(0, bounds.minX - 10), top = Math.max(0, bounds.minY - 10);
  const right = Math.min(info.width, bounds.maxX + 11), bottom = Math.min(info.height, bounds.maxY + 11);
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .extract({ left, top, width: right - left, height: bottom - top }).png().toFile(outputPath);
  return { ...result, path: outputPath, message: `${result.message}；已裁剪透明留白` };
}

// 智能去背景：本地 U2-Net（silueta）ONNX 推理，完全离线、无网络依赖。
// 模型为 Apache-2.0（silueta），运行时为 MIT（onnxruntime-node），可闭源商用分发。
// 预处理与 rembg 的 SiluetaSession 保持一致：320x320 拉伸输入、ImageNet 归一化，
// 输出 min-max 归一化后作为 alpha。
async function smartCutout(sourcePath, outputPath, options = {}) {
  const ort = require("onnxruntime-node");
  const { opaqueBounds, recoverModelCutout, refineModelCutout, softenCutoutEdges } = require("./previewCutout");
  const modelPath = options.modelPath || path.join(__dirname, "..", "models", "silueta.onnx");
  const INPUT = 320;
  const MEAN = [0.485, 0.456, 0.406];
  const STD = [0.229, 0.224, 0.225];

  // 原图：归一化方向、限制最大边 2048（与颜色抠图一致的预览尺度）。
  const { data: sourceRgba, info } = await sharp(sourcePath).rotate()
    .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  // Hidden RGB in transparent PNGs must not influence foreground recognition.
  const data = await sharp(sourceRgba, { raw: { width: W, height: H, channels: 4 } })
    .flatten({ background: "#ffffff" }).raw().toBuffer();

  // 模型输入固定 320x320（PIL 直接拉伸，非等比）。
  const rgb = await sharp(data, { raw: { width: W, height: H, channels: 3 } })
    .resize(INPUT, INPUT, { fit: "fill" }).raw().toBuffer();
  const ch = INPUT * INPUT;
  const tensorData = new Float32Array(3 * ch);
  for (let i = 0; i < ch; i++) {
    for (let c = 0; c < 3; c++) {
      tensorData[c * ch + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
    }
  }

  const session = await ort.InferenceSession.create(modelPath);
  const results = await session.run({
    [session.inputNames[0]]: new ort.Tensor("float32", tensorData, [1, 3, INPUT, INPUT])
  });
  const mask = results[session.outputNames[0]].data; // Float32Array，[1,1,320,320]

  // min-max 归一化到 [0,1]。
  let mi = Infinity, ma = -Infinity;
  for (let i = 0; i < ch; i++) { const v = mask[i]; if (v < mi) mi = v; if (v > ma) ma = v; }
  const range = ma - mi || 1;

  // 采样纯色背景参考色：mask 极低的像素是确定的背景。
  let br = 0, bg = 0, bb = 0, bc = 0;
  for (let i = 0; i < ch; i++) {
    if ((mask[i] - mi) / range < 0.02) { br += rgb[i * 3]; bg += rgb[i * 3 + 1]; bb += rgb[i * 3 + 2]; bc++; }
  }
  const bgr = bc ? br / bc : 0, bgg = bc ? bg / bc : 0, bgb = bc ? bb / bc : 0;

  // Keep confidence until after upscaling so full-resolution colors can resolve
  // thin details and openings that do not fit in a 320px binary mask.
  const maskU8 = Buffer.alloc(ch);
  for (let i = 0; i < ch; i++) maskU8[i] = Math.round(255 * (mask[i] - mi) / range);
  const modelAlpha = await sharp(maskU8, { raw: { width: INPUT, height: INPUT, channels: 1 } })
    .resize(W, H, { fit: "fill" }).greyscale().raw().toBuffer();
  const COLOR_DIST_SQ = 30 * 30;
  const rgba = Buffer.from(sourceRgba);
  for (let i = 0; i < W * H; i++) {
    const m = modelAlpha[i] / 255;
    const dr = data[i * 3] - bgr, dg = data[i * 3 + 1] - bgg, db = data[i * 3 + 2] - bgb;
    rgba[i * 4 + 3] = m > 0.5 || (m >= 0.02 && dr * dr + dg * dg + db * db > COLOR_DIST_SQ) ? 255 : 0;
  }

  recoverModelCutout(rgba, data, W, H);
  refineModelCutout(rgba, data, modelAlpha, W, H);
  await softenCutoutEdges(rgba, W, H);
  for (let i = 0; i < W * H; i++) rgba[i * 4 + 3] = Math.min(rgba[i * 4 + 3], sourceRgba[i * 4 + 3]);

  const bounds = opaqueBounds(rgba, W, H);
  if (!bounds) return { ok: false, message: "智能去背景未能识别主体，请改用自动去背景或吸管" };
  const left = Math.max(0, bounds.minX - 10), top = Math.max(0, bounds.minY - 10);
  const right = Math.min(W, bounds.maxX + 11), bottom = Math.min(H, bounds.maxY + 11);
  await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
    .extract({ left, top, width: right - left, height: bottom - top }).png().toFile(outputPath);
  return { ok: true, path: outputPath, message: "已智能去背景并裁剪透明留白，请检查主体边缘" };
}

async function glossToRoughness(sourcePath, assetId, maxSize) {
  const cached = await cachedOutput("gloss-to-roughness", assetId, [sourcePath], maxSize);
  if (cached.exists) return cached.outputPath;
  const { width, height } = boundedSize(await imageSize(sourcePath), maxSize);
  const bytes = await scalarChannel(sourcePath, width, height, "gloss");
  for (let i = 0; i < bytes.length; i++) bytes[i] = 255 - bytes[i];
  return writePng(sharp(bytes, { raw: { width, height, channels: 1 } }), cached.outputPath);
}

async function writeBufferAtomic(buffer, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const staged = `${outputPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(staged, buffer);
    await fs.rename(staged, outputPath);
    return outputPath;
  } finally {
    await fs.rm(staged, { force: true }).catch(() => {});
  }
}

async function resizeTexture(sourcePath, outputPath, maxSize = 4096) {
  const metadata = await imageSize(sourcePath);
  const size = boundedSize(metadata, Math.max(1, Number(maxSize) || 4096));
  let pipeline = (await imageInput(sourcePath)).resize(size.width, size.height, { fit: "fill" });
  const ext = path.extname(outputPath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") pipeline = pipeline.jpeg({ quality: 95, chromaSubsampling: "4:4:4" });
  else if (ext === ".webp") pipeline = pipeline.webp({ quality: 95, effort: 4 });
  else if (ext === ".tif" || ext === ".tiff") pipeline = pipeline.tiff({ compression: "lzw" });
  else pipeline = pipeline.png({ compressionLevel: 3, effort: 2 });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const staged = `${outputPath}.${randomUUID()}.tmp`;
  try {
    // libvips needs an extended Windows path for deeply nested import staging.
    await pipeline.toFile(path.toNamespacedPath(staged));
    await fs.rename(staged, outputPath);
    return outputPath;
  } finally {
    await fs.rm(staged, { force: true }).catch(() => {});
  }
}

function encodeRadianceRgbe(image) {
  const { width, height, data } = image;
  const parts = [Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`)];
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * width * 4, (y + 1) * width * 4);
    if (width >= 8 && width <= 32767) {
      parts.push(Buffer.from([2, 2, (width >> 8) & 255, width & 255]));
      for (let channel = 0; channel < 4; channel++) {
        for (let x = 0; x < width; x += 128) {
          const count = Math.min(128, width - x);
          const values = Buffer.alloc(count);
          for (let i = 0; i < count; i++) values[i] = row[(x + i) * 4 + channel];
          parts.push(Buffer.from([count]), values);
        }
      }
    } else {
      parts.push(row);
    }
  }
  return Buffer.concat(parts);
}

async function resizeHdr(sourcePath, outputPath, maxSize = 4096) {
  const image = decodeRadiancePreview(await fs.readFile(sourcePath), {
    maxWidth: Math.max(1, Number(maxSize) || 4096),
    maxHeight: Math.max(1, Number(maxSize) || 4096),
    output: "rgbe"
  });
  return writeBufferAtomic(encodeRadianceRgbe(image), outputPath);
}

function exrInt32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value);
  return buffer;
}

function exrFloat32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(value);
  return buffer;
}

function exrAttribute(name, type, value) {
  return Buffer.concat([Buffer.from(`${name}\0${type}\0`), exrInt32(value.length), value]);
}

function encodeExrRgb(image) {
  const { width, height } = image;
  const channelList = Buffer.concat([
    ...["B", "G", "R"].map((name) => Buffer.concat([
      Buffer.from(`${name}\0`), exrInt32(2), Buffer.alloc(4), exrInt32(1), exrInt32(1)
    ])),
    Buffer.from([0])
  ]);
  const box = Buffer.concat([exrInt32(0), exrInt32(0), exrInt32(width - 1), exrInt32(height - 1)]);
  const header = Buffer.concat([
    exrInt32(20000630), exrInt32(2),
    exrAttribute("channels", "chlist", channelList),
    exrAttribute("compression", "compression", Buffer.from([0])),
    exrAttribute("dataWindow", "box2i", box),
    exrAttribute("displayWindow", "box2i", box),
    exrAttribute("lineOrder", "lineOrder", Buffer.from([0])),
    exrAttribute("pixelAspectRatio", "float", exrFloat32(1)),
    exrAttribute("screenWindowCenter", "v2f", Buffer.alloc(8)),
    exrAttribute("screenWindowWidth", "float", exrFloat32(1)),
    Buffer.from([0])
  ]);
  const offsets = Buffer.alloc(height * 8);
  const rows = [];
  let offset = header.length + offsets.length;
  for (let y = 0; y < height; y++) {
    const dataSize = width * 3 * 4;
    const row = Buffer.alloc(8 + dataSize);
    row.writeInt32LE(y, 0);
    row.writeInt32LE(dataSize, 4);
    for (let channel = 0; channel < 3; channel++) {
      for (let x = 0; x < width; x++) {
        row.writeFloatLE(Number(image.read(x, y, 2 - channel)) || 0, 8 + (channel * width + x) * 4);
      }
    }
    offsets.writeBigUInt64LE(BigInt(offset), y * 8);
    rows.push(row);
    offset += row.length;
  }
  return Buffer.concat([header, offsets, ...rows]);
}

async function resizeExr(sourcePath, outputPath, maxSize = 4096) {
  const source = await decodeExr(sourcePath);
  const size = boundedSize(source, Math.max(1, Number(maxSize) || 4096));
  const image = {
    width: size.width,
    height: size.height,
    channels: 3,
    read(x, y, channel) {
      const sourceX = Math.min(source.width - 1, Math.floor(x * source.width / size.width));
      const sourceY = Math.min(source.height - 1, Math.floor(y * source.height / size.height));
      return source.read(sourceX, sourceY, channel);
    }
  };
  return writeBufferAtomic(encodeExrRgb(image), outputPath);
}

async function cropPreviewSelection(sourcePath, outputPath, selection) {
  const { cropPixelBounds } = require("./previewCutout");
  // Normalize orientation before applying coordinates measured on the displayed image.
  const { data, info } = await sharp(sourcePath).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bounds = cropPixelBounds(selection, info.width, info.height);
  const cropped = Buffer.alloc(bounds.width * bounds.height * 4);
  const left = Math.max(0, bounds.left), top = Math.max(0, bounds.top);
  const right = Math.min(info.width, bounds.left + bounds.width), bottom = Math.min(info.height, bounds.top + bounds.height);
  if (right > left) for (let y = top; y < bottom; y++) {
    const sourceOffset = (y * info.width + left) * 4;
    const targetOffset = ((y - bounds.top) * bounds.width + left - bounds.left) * 4;
    data.copy(cropped, targetOffset, sourceOffset, sourceOffset + (right - left) * 4);
  }
  await sharp(cropped, { raw: { width: bounds.width, height: bounds.height, channels: 4 } }).png().toFile(outputPath);
  return { ok: true, path: outputPath, message: "已裁剪选区，可继续抠图或撤销" };
}

const operations = { imageSize, glossToRoughness, hdrPreview, exrToPng, resizeTexture, resizeHdr, resizeExr, packTextures, packOrmTexture, packBcrTexture, unpackPackedTextureChannel, hasOpacityAlpha, opacityFromAlpha, convertTextureToTga, mergeAlbedo, autoPreviewCutout, smartCutout, cropPreviewSelection };
if (parentPort) {
  (async () => {
    try {
      const operation = operations[workerData.operation];
      if (!operation) throw new Error(`未知图像任务：${workerData.operation}`);
      parentPort.postMessage({ result: await operation(...workerData.args) });
    } catch (error) {
      parentPort.postMessage({ error: error?.message || String(error) });
    } finally {
      parentPort.close();
    }
  })();
}
