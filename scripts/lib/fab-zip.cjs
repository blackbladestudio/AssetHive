const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const { Buffer } = require('node:buffer');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createInflateRaw } = require('node:zlib');
const crypto = require('node:crypto');
const { inside, hashFile, freeBytes } = require('./megascans-transfer.cjs');

function trustedFabUrl(value) {
  const url = new globalThis.URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || ![
    'epicgamescdn.com', 'distro.on.epicgames.com', 'fab.com', 'cloudfront.net', 'amazonaws.com'
  ].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new Error('Fab 返回了非官方资源地址');
  return url.href;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crcUpdate(value, bytes) {
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return value >>> 0;
}

function parseDirectory(bytes, count) {
  const entries = [], names = new Set();
  let offset = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 目录损坏');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    const attributes = bytes.readUInt32LE(offset + 38), start = bytes.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length || flags & 1 || ![0, 8].includes(method) || [compressed, size, start].includes(0xffffffff)) throw new Error('不支持加密、ZIP64 或异常 ZIP 条目');
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..') || ((attributes >>> 16) & 0xf000) === 0xa000) throw new Error('ZIP 条目路径或链接不安全');
    if (!name.endsWith('/')) {
      if (names.has(name.toLowerCase())) throw new Error('ZIP 条目在 Windows 上重名');
      names.add(name.toLowerCase());
      entries.push({ name, compressed, bytes: size, start, method, crc: bytes.readUInt32LE(offset + 16) });
    }
    offset = end;
  }
  if (offset !== bytes.length) throw new Error('ZIP 目录长度不匹配');
  return entries;
}

// Read only selected ZIP members through official signed HTTP Range requests.
// Raw FBX archives also contain 8K maps. Only the Raw normal is selected in
// addition to the Raw mesh; the importer bounds its stored copy to 4K.
class RemoteZip {
  constructor(url, size, { fetchImpl = fetch } = {}) {
    this.url = trustedFabUrl(url); this.size = size; this.fetch = fetchImpl;
    if (!Number.isSafeInteger(size) || size < 22) throw new Error('ZIP 大小无效');
    if (size >= 0xffffffff) throw Object.assign(new Error('Fab ZIP 超过当前支持范围，已保留此项待处理'), { code: 'FAB_UNSUPPORTED' });
  }
  async range(start, end, { timeoutMs = 30 * 60 * 1000 } = {}) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= this.size) throw new Error('ZIP Range 越界');
    const headerAbort = new globalThis.AbortController();
    const headerTimer = globalThis.setTimeout(() => headerAbort.abort(Object.assign(new Error('Fab ZIP response headers timed out'), { code: 'UND_ERR_HEADERS_TIMEOUT', source: 'cdn' })), 30000);
    let response;
    try {
      response = await this.fetch(this.url, { headers: { Range: `bytes=${start}-${end}` }, redirect: 'error',
        signal: globalThis.AbortSignal.any([headerAbort.signal, globalThis.AbortSignal.timeout(timeoutMs)]) });
    } finally { globalThis.clearTimeout(headerTimer); }
    if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${this.size}`) {
      await response.body?.cancel();
      throw Object.assign(new Error(`Fab ZIP Range 请求失败：HTTP ${response.status}`), { status: response.status, source: 'cdn' });
    }
    return response;
  }
  async directory() {
    const tail = Buffer.from(await (await this.range(Math.max(0, this.size - 65557), this.size - 1, { timeoutMs: 30000 })).arrayBuffer());
    let offset = tail.length - 22;
    while (offset >= 0 && (tail.readUInt32LE(offset) !== 0x06054b50 || offset + 22 + tail.readUInt16LE(offset + 20) !== tail.length)) offset--;
    if (offset < 0 || tail.readUInt16LE(offset + 4) || tail.readUInt16LE(offset + 6) || tail.readUInt16LE(offset + 8) !== tail.readUInt16LE(offset + 10)) throw new Error('ZIP 尾部无效或为分卷压缩包');
    const count = tail.readUInt16LE(offset + 10), length = tail.readUInt32LE(offset + 12), start = tail.readUInt32LE(offset + 16);
    if (count === 65535 || length > 16 * 1024 * 1024 || !length || start + length > this.size - 22) throw new Error('ZIP 目录超限');
    const bytes = Buffer.from(await (await this.range(start, start + length - 1, { timeoutMs: 30000 })).arrayBuffer());
    this.entries = parseDirectory(bytes, count);
    return this.entries;
  }
  async stream(entry, { timeoutMs = 30 * 60 * 1000 } = {}) {
    const header = Buffer.from(await (await this.range(entry.start, entry.start + 29, { timeoutMs: 30000 })).arrayBuffer());
    if (header.length !== 30 || header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(8) !== entry.method || header.readUInt16LE(6) & 1) throw new Error('ZIP 文件头无效');
    const start = entry.start + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    if (!entry.compressed) throw new Error('资源条目为空');
    const response = await this.range(start, start + entry.compressed - 1, { timeoutMs });
    const source = Readable.fromWeb(response.body);
    if (!entry.method) return source;
    const inflate = createInflateRaw();
    source.on('error', error => inflate.destroy(error));
    inflate.on('close', () => source.destroy());
    return source.pipe(inflate);
  }
  async read(entry, maxBytes = 4 * 1024 * 1024) {
    if (entry.bytes > maxBytes) throw new Error('ZIP 元数据超限');
    const chunks = []; let count = 0, crc = 0xffffffff;
    for await (const chunk of await this.stream(entry, { timeoutMs: 30000 })) {
      count += chunk.length;
      if (count > entry.bytes) throw new Error('ZIP 解压长度超限');
      crc = crcUpdate(crc, chunk); chunks.push(chunk);
    }
    if (count !== entry.bytes || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw new Error('ZIP 元数据 CRC 校验失败');
    return Buffer.concat(chunks);
  }
}

async function downloadZipEntry(file, root, { reserveBytes = 0, onBytes = async () => {}, idleTimeoutMs = 60000 } = {}) {
  const destination = path.resolve(root, file.file);
  if (!inside(root, destination)) throw new Error('ZIP 输出路径越界');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const checksum = `${destination}.transfer-sha256`, temporary = `${destination}.part`;
  try {
    if ((await fs.stat(destination)).size === file.bytes && await hashFile(destination) === (await fs.readFile(checksum, 'utf8')).trim()) return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (await freeBytes(root) < file.bytes + reserveBytes) throw new Error('本地剩余空间不足');
  await fs.rm(temporary, { force: true });
  const hash = crypto.createHash('sha256'); let count = 0, crc = 0xffffffff, last = 0, source, idleTimer;
  const active = () => {
    globalThis.clearTimeout(idleTimer);
    idleTimer = globalThis.setTimeout(() => source.destroy(Object.assign(new Error('Fab ZIP body stopped sending data'), { code: 'UND_ERR_BODY_TIMEOUT', source: 'cdn' })), idleTimeoutMs);
  };
  const check = new Transform({ transform(chunk, encoding, callback) {
    active();
    count += chunk.length; crc = crcUpdate(crc, chunk); hash.update(chunk);
    if (count > file.bytes) { callback(new Error('ZIP 资源解压超过声明大小')); return; }
    if (Date.now() - last > 3000) { last = Date.now(); Promise.resolve(onBytes(count)).then(() => callback(null, chunk), callback); }
    else callback(null, chunk);
  } });
  try {
    source = await file.zip.stream(file.entry); active();
    await pipeline(source, check, createWriteStream(temporary, { flags: 'wx' }));
    if (count !== file.bytes || ((crc ^ 0xffffffff) >>> 0) !== file.entry.crc) throw new Error('ZIP 资源长度或 CRC 校验失败');
    await fs.rename(temporary, destination);
    await fs.writeFile(checksum, hash.digest('hex'));
  } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  finally { globalThis.clearTimeout(idleTimer); }
}

module.exports = { RemoteZip, parseDirectory, trustedFabUrl, downloadZipEntry };
