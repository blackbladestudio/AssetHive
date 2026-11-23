const { Buffer } = require("node:buffer");
const fs = require("node:fs/promises");

const PACKAGE_TAG = 0x9e2a83c1;
const MAX_ROWS = 5000;

function createReader(buffer, names) {
  let offset = 0;
  const need = (size) => {
    if (size < 0 || offset + size > buffer.length) throw new RangeError("out of bounds");
  };
  const reader = {
    get offset() { return offset; },
    set offset(value) { offset = value; },
    int32() { need(4); const value = buffer.readInt32LE(offset); offset += 4; return value; },
    uint8() { need(1); return buffer[offset++]; },
    skip(size) { need(size); offset += size; },
    fstring() {
      const length = reader.int32();
      if (length === 0) return "";
      if (length > 0) {
        if (length > 65536) throw new RangeError("string too long");
        need(length);
        const text = buffer.toString("latin1", offset, offset + length - 1);
        offset += length;
        return text;
      }
      const chars = -length;
      if (chars > 65536) throw new RangeError("string too long");
      need(chars * 2);
      const text = buffer.toString("utf16le", offset, offset + (chars - 1) * 2);
      offset += chars * 2;
      return text;
    },
    fname() {
      const index = reader.int32();
      const number = reader.int32();
      if (!names || index < 0 || index >= names.length || number < 0 || number > 0xffff) throw new RangeError("invalid name");
      return number > 0 ? `${names[index]}_${number - 1}` : names[index];
    }
  };
  return reader;
}

function readNameMap(buffer) {
  // Locate the summary's NameCount/NameOffset pair by checking which pair
  // describes a name table that parses completely.
  const limit = Math.min(buffer.length - 8, 16384);
  for (let position = 8; position < limit; position += 1) {
    const count = buffer.readInt32LE(position);
    const start = buffer.readInt32LE(position + 4);
    if (count < 4 || count > 200000 || start < position + 8 || start >= buffer.length) continue;
    const reader = createReader(buffer, null);
    reader.offset = start;
    try {
      const names = [];
      for (let i = 0; i < count; i += 1) {
        names.push(reader.fstring());
        reader.skip(4);
      }
      if (names.includes("None")) return names;
    } catch {
      // Try the next candidate pair.
    }
  }
  throw new Error("无法读取 UE 资源名称表");
}

function readTypeName(reader) {
  const name = reader.fname();
  const innerCount = reader.int32();
  if (innerCount < 0 || innerCount > 8) throw new RangeError("invalid type name");
  const inner = [];
  for (let i = 0; i < innerCount; i += 1) inner.push(readTypeName(reader));
  return { name, inner };
}

function readText(reader, end) {
  reader.skip(4);
  const historyType = (reader.uint8() << 24) >> 24;
  if (historyType === -1) {
    const hasInvariant = reader.int32();
    return hasInvariant ? reader.fstring() : "";
  }
  if (historyType === 0) {
    reader.fstring();
    reader.fstring();
    return reader.fstring();
  }
  reader.offset = end;
  return "";
}

function readTaggedProperties(reader) {
  const values = {};
  for (let guard = 0; guard < 512; guard += 1) {
    const name = reader.fname();
    if (name === "None") return values;
    const type = readTypeName(reader);
    const size = reader.int32();
    const flags = reader.uint8();
    if (size < 0) throw new RangeError("invalid property size");
    if (flags & 0x01) reader.skip(4);
    if (flags & 0x02) reader.skip(16);
    if (flags & 0x04) {
      const extensions = reader.uint8();
      if (extensions & 0x02) reader.skip(2);
    }
    const start = reader.offset;
    const end = start + size;
    if (type.name === "BoolProperty") {
      values[name] = Boolean(flags & 0x10);
    } else if (type.name === "StrProperty") {
      values[name] = reader.fstring();
    } else if (type.name === "NameProperty" || type.name === "EnumProperty") {
      values[name] = reader.fname();
    } else if (type.name === "TextProperty") {
      values[name] = readText(reader, end);
    } else if (type.name === "IntProperty") {
      values[name] = reader.int32();
    }
    if (reader.offset > end) throw new RangeError("property overflow");
    reader.offset = start;
    reader.skip(size);
  }
  throw new RangeError("too many properties");
}

function tryReadRows(buffer, names, position) {
  const reader = createReader(buffer, names);
  reader.offset = position;
  const count = reader.int32();
  if (count < 1 || count > MAX_ROWS) return null;
  const rows = [];
  const seen = new Set();
  try {
    for (let i = 0; i < count; i += 1) {
      const rowName = reader.fname();
      if (rowName === "None" || seen.has(rowName)) return null;
      seen.add(rowName);
      const values = readTaggedProperties(reader);
      if (Object.keys(values).length === 0 && i === 0) return null;
      rows.push({ name: rowName, values });
    }
  } catch {
    return null;
  }
  return rows;
}

function parseDataTableRows(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 64 || buffer.readUInt32LE(0) !== PACKAGE_TAG) {
    throw new Error("不是有效的 UE 资源文件");
  }
  const names = readNameMap(buffer);
  for (let position = 0; position < buffer.length - 12; position += 1) {
    const rows = tryReadRows(buffer, names, position);
    if (rows) return rows;
  }
  throw new Error("没有在资源里找到 DataTable 行");
}

async function readDataTableRows(filePath) {
  return parseDataTableRows(await fs.readFile(filePath));
}

module.exports = { parseDataTableRows, readDataTableRows };
