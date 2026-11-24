const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { Buffer } = require('node:buffer');
const { setTimeout, clearTimeout } = require('node:timers');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function textureSignature(file) {
  const bytes = await fs.readFile(file);
  let data, width, height;
  if (path.extname(file).toLowerCase() === '.tga') {
    const { TGALoader } = await import('three/examples/jsm/loaders/TGALoader.js');
    ({ data, width, height } = new TGALoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
    data = Uint16Array.from(data, value => value * 257);
  } else {
    const sharp = require('sharp');
    const metadata = await sharp(bytes).metadata();
    if (!['uchar', 'ushort'].includes(metadata.depth)) throw new Error('此贴图精度尚无法无损核验，未建立关联');
    const sixteenBit = metadata.depth === 'ushort';
    const result = await sharp(bytes).toColourspace(sixteenBit ? 'rgb16' : 'srgb').ensureAlpha().raw({depth:sixteenBit ? 'ushort' : 'uchar'}).toBuffer({ resolveWithObject: true });
    data = sixteenBit ? result.data : Uint16Array.from(result.data, value => value * 257);
    width = result.info.width; height = result.info.height;
  }
  const pixels = ArrayBuffer.isView(data) && !(data instanceof Buffer) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : data;
  return { version: 2, kind: 'texture', width, height, digest: digest(pixels) };
}

function meshSignature(file, materialPaths = {}, lodIndex = null) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'characterLinkContentWorker.js'), { workerData: { file, materialPaths, lodIndex }, resourceLimits: { maxOldGenerationSizeMb: 4096 } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('内容核验超时')); }, 240000);
    worker.once('message', message => { clearTimeout(timer); void worker.terminate(); if (message.error) reject(new Error(message.error)); else resolve(message); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code) reject(new Error('内容核验进程退出')); });
  });
}

async function compareLinkContent(source, exported, kind, materials = {}) {
  const read = kind === 'texture' ? textureSignature : meshSignature;
  const left = await read(source, materials.source, materials.sourceLod ?? null), right = await read(exported, materials.target, materials.targetLod ?? null);
  return { equal: JSON.stringify(left) === JSON.stringify(right), source: left, target: right };
}
const meshLodCount = async file => (await meshSignature(file, {}, 'count')).count;
module.exports = { compareLinkContent, textureSignature, meshSignature, meshLodCount };
