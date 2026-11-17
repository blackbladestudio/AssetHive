const { Buffer } = require("node:buffer");

function previewSize(width, height, options = {}) {
  if (!Number.isSafeInteger(width * height) || width <= 0 || height <= 0) {
    throw new Error("无效的 HDRI 尺寸");
  }
  const scale = Math.min(1, (Number(options.maxWidth) || 1024) / width,
    (Number(options.maxHeight) || 1024) / height);
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

function toneMap(value, exposure = 1) {
  const linear = Math.max(0, value * exposure);
  if (linear === Infinity) return 255;
  if (!Number.isFinite(linear)) return 0;
  return Math.round(255 * Math.pow(linear / (1 + linear), 1 / 2.2));
}

function radianceSize(buffer) {
  let pos = 0;
  const line = () => {
    const end = buffer.indexOf(10, pos);
    if (end < 0 || end - pos > 8192) throw new Error("HDR 文件头不完整");
    const text = buffer.toString("ascii", pos, end).trim();
    pos = end + 1;
    return text;
  };
  if (!/^#\?/.test(line())) throw new Error("无效的 Radiance HDR 文件");
  let format = "";
  for (let header = line(); header; header = line()) {
    if (header.startsWith("FORMAT=")) format = header.slice(7);
  }
  if (format !== "32-bit_rle_rgbe") throw new Error(`不支持的 HDR 格式：${format}`);
  let resolution = line();
  while (!resolution) resolution = line();
  const match = /^([+-])([XY])\s+(\d+)\s+([+-])([XY])\s+(\d+)$/.exec(resolution);
  if (!match || match[2] === match[5]) throw new Error("无效的 HDR 分辨率");
  const major = Number(match[3]);
  const minor = Number(match[6]);
  return {
    width: match[2] === "X" ? major : minor,
    height: match[2] === "Y" ? major : minor
  };
}

// Decode one RGBE scanline at a time. A 16K panorama must not allocate an
// additional full-resolution RGBA half/float texture just to make a thumbnail.
function decodeRadiancePreview(buffer, options = {}) {
  let pos = 0;
  const line = () => {
    const end = buffer.indexOf(10, pos);
    if (end < 0 || end - pos > 8192) throw new Error("HDR 文件头不完整");
    const text = buffer.toString("ascii", pos, end).trim();
    pos = end + 1;
    return text;
  };
  if (!/^#\?/.test(line())) throw new Error("无效的 Radiance HDR 文件");
  let format = "";
  for (let header = line(); header; header = line()) {
    if (header.startsWith("FORMAT=")) format = header.slice(7);
  }
  if (format !== "32-bit_rle_rgbe") throw new Error(`不支持的 HDR 格式：${format}`);
  let resolution = line();
  while (!resolution) resolution = line();
  const match = /^([+-])([XY])\s+(\d+)\s+([+-])([XY])\s+(\d+)$/.exec(resolution);
  if (!match || match[2] === match[5]) throw new Error("无效的 HDR 分辨率");
  const major = Number(match[3]);
  const minor = Number(match[6]);
  const width = match[2] === "X" ? major : minor;
  const height = match[2] === "Y" ? major : minor;
  const size = previewSize(width, height, options);
  // Every modern scanline needs at least its four-byte marker. Reject absurd
  // dimensions/truncated files before allocating scanline memory.
  if (!Number.isSafeInteger(width * height) || width * height > 536870912) {
    throw new Error("HDR 尺寸过大或像素数据不完整");
  }
  const outputRgbe = options.output === "rgbe";
  const out = Buffer.alloc(size.width * size.height * (outputRgbe ? 4 : 3));
  const scanline = Buffer.alloc(minor * 4);
  const byte = () => {
    if (pos >= buffer.length) throw new Error("HDR 像素数据不完整");
    return buffer[pos++];
  };
  const sampleMap = (axis, sign, count, outputCount) => {
    const result = new Map();
    for (let i = 0; i < outputCount; i++) {
      const coordinate = Math.min(count - 1, Math.floor(i * count / outputCount));
      const reversed = axis === "X" ? sign === "-" : sign === "+";
      result.set(reversed ? count - 1 - coordinate : coordinate, i);
    }
    return result;
  };
  const majorSamples = sampleMap(match[2], match[1], major, match[2] === "X" ? size.width : size.height);
  const minorSamples = sampleMap(match[5], match[4], minor, match[5] === "X" ? size.width : size.height);
  for (let row = 0; row < major; row++) {
    const first = [byte(), byte(), byte(), byte()];
    if (minor >= 8 && minor <= 32767 && first[0] === 2 && first[1] === 2 && !(first[2] & 128)) {
      if ((first[2] * 256 + first[3]) !== minor) throw new Error("HDR 扫描线尺寸不匹配");
      for (let channel = 0; channel < 4; channel++) {
        let x = 0;
        while (x < minor) {
          const code = byte();
          const count = code > 128 ? code - 128 : code;
          if (!count || x + count > minor) throw new Error("无效的 HDR RLE 数据");
          if (code > 128) {
            const value = byte();
            for (let j = 0; j < count; j++) scanline[(x++) * 4 + channel] = value;
          } else {
            for (let j = 0; j < count; j++) scanline[(x++) * 4 + channel] = byte();
          }
        }
      }
    } else {
      let x = 0;
      let shift = 0;
      let pixel = first;
      while (x < minor) {
        if (pixel[0] === 1 && pixel[1] === 1 && pixel[2] === 1) {
          const count = pixel[3] * (2 ** shift);
          if (!x || shift > 24 || x + count > minor) throw new Error("无效的 HDR 旧式 RLE 数据");
          for (let j = 0; j < count; j++, x++) scanline.copy(scanline, x * 4, (x - 1) * 4, x * 4);
          shift += 8;
        } else {
          scanline.set(pixel, x++ * 4);
          shift = 0;
        }
        if (x < minor) pixel = [byte(), byte(), byte(), byte()];
      }
    }
    const majorOut = majorSamples.get(row);
    if (majorOut === undefined) continue;
    for (const [source, minorOut] of minorSamples) {
      const x = match[2] === "X" ? majorOut : minorOut;
      const y = match[2] === "Y" ? majorOut : minorOut;
      const offset = source * 4;
      const target = (y * size.width + x) * (outputRgbe ? 4 : 3);
      if (outputRgbe) {
        out[target] = scanline[offset];
        out[target + 1] = scanline[offset + 1];
        out[target + 2] = scanline[offset + 2];
        out[target + 3] = scanline[offset + 3];
        continue;
      }
      const exponent = scanline[offset + 3];
      const scale = exponent ? 2 ** (exponent - 128) / 255 : 0;
      for (let c = 0; c < 3; c++) {
        out[target + c] = toneMap(scanline[offset + c] * scale, Number(options.exposure) || 1);
      }
    }
  }
  return { ...size, data: out, channels: outputRgbe ? 4 : 3 };
}

module.exports = { decodeRadiancePreview, radianceSize, previewSize, toneMap };
