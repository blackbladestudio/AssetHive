const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const sharp = require("sharp");
const { runImageTask } = require("../electron/services/imageTasks");

// 独立构造各行不同的 TGA，纯色图不能发现翻转时下半幅被首行覆盖的问题。
function fixture({ bits, rle, top, right, height }) {
  const width = 5;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const column = x < 2 ? 0 : x;
    const value = 20 + y * 23 + column * 5;
    const pixel = bits === 8 ? [value, value, value, 255]
      : [value, 200 - y * 19, 31 + column * 17, bits === 32 ? 40 + y * 29 + column : 255];
    rgba.set(pixel, (y * width + x) * 4);
  }
  const header = Buffer.alloc(18);
  header[2] = (bits === 8 ? 3 : 2) + (rle ? 8 : 0);
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header[16] = bits;
  header[17] = (top ? 0x20 : 0) | (right ? 0x10 : 0) | (bits === 32 ? 8 : 0);
  const pixels = [];
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const x = right ? width - 1 - column : column;
    const y = top ? row : height - 1 - row;
    const offset = (y * width + x) * 4;
    pixels.push(bits === 8 ? Buffer.from([rgba[offset]])
      : Buffer.from([rgba[offset + 2], rgba[offset + 1], rgba[offset], ...(bits === 32 ? [rgba[offset + 3]] : [])]));
  }
  const data = [];
  if (!rle) data.push(...pixels);
  else for (let index = 0; index < pixels.length;) {
    let run = 1;
    while (run < 128 && index + run < pixels.length && pixels[index].equals(pixels[index + run])) run++;
    if (run > 1) {
      data.push(Buffer.from([0x80 | (run - 1)]), pixels[index]);
      index += run;
    } else {
      const start = index++;
      while (index - start < 128 && index < pixels.length
        && !(index + 1 < pixels.length && pixels[index].equals(pixels[index + 1]))) index++;
      data.push(Buffer.from([index - start - 1]), ...pixels.slice(start, index));
    }
  }
  return { bytes: Buffer.concat([header, ...data]), rgba, width, height };
}

for (const bits of [8, 24, 32]) for (const rle of [false, true]) for (const top of [false, true]) for (const right of [false, true]) {
  const name = `${rle ? "RLE" : "raw"} ${bits === 32 ? "RGBA" : bits === 24 ? "RGB" : "gray"} ${top ? "top" : "bottom"}-${right ? "right" : "left"}`;
  test(name + " preserves every scanline and alpha", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-tga-orientation-"));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const image = fixture({ bits, rle, top, right, height: right ? 5 : 6 });
    const source = path.join(root, "input.tga");
    const output = path.join(root, "output.tga");
    await fs.writeFile(source, image.bytes);
    await runImageTask("convertTextureToTga", [source, output, 32, { includeAlpha: true }]);
    const bytes = await fs.readFile(output);
    assert.equal(bytes.readUInt16LE(12), image.width);
    assert.equal(bytes.readUInt16LE(14), image.height);
    assert.equal(bytes[16], 32);
    assert.equal(bytes.length, 18 + image.rgba.length);
    const decoded = Buffer.alloc(image.rgba.length);
    for (let offset = 0; offset < decoded.length; offset += 4) {
      decoded[offset] = bytes[18 + offset + 2];
      decoded[offset + 1] = bytes[18 + offset + 1];
      decoded[offset + 2] = bytes[18 + offset];
      decoded[offset + 3] = bytes[18 + offset + 3];
    }
    assert.deepEqual(decoded, image.rgba, "RGB 和 Alpha 的每个像素必须位于原始行列");
  });
}

test("old decoded alpha caches cannot survive the TGA scanline fix", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-tga-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const image = fixture({ bits: 32, rle: true, top: false, right: false, height: 6 });
  const source = path.join(root, "input.tga");
  await fs.writeFile(source, image.bytes);
  const stats = await fs.stat(source);
  const id = path.basename(root);
  const hash = crypto.createHash("sha256").update(JSON.stringify(["image-v3", "opacity-alpha", [[source, stats.size, stats.mtimeMs]], 32])).digest("hex").slice(0, 24);
  const stale = path.join(os.tmpdir(), "assethive", "opacity-alpha", `${id}_${hash}_albedoA.png`);
  await fs.mkdir(path.dirname(stale), { recursive: true });
  t.after(() => fs.rm(stale, { force: true }));
  await sharp({ create: { width: image.width, height: image.height, channels: 3, background: "black" } }).png().toFile(stale);
  const output = await runImageTask("opacityFromAlpha", [source, id, 32]);
  t.after(() => fs.rm(output, { force: true }));
  assert.notEqual(output, stale);
  const actual = await sharp(output).removeAlpha().extractChannel(0).raw().toBuffer();
  assert.deepEqual(actual, Buffer.from(image.rgba.filter((_, index) => index % 4 === 3)));
});
