const fs = require("node:fs");
const { Buffer } = require("node:buffer");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { StringDecoder } = require("node:string_decoder");
const zlib = require("node:zlib");

async function* decode(chunks) {
  const decoder = new StringDecoder("utf8");
  for await (const chunk of chunks) yield typeof chunk === "string" ? chunk : decoder.write(chunk);
  const tail = decoder.end();
  if (tail) yield tail;
}

// Parse each array member with native JSON.parse, retaining neither a complete
// decompressed Buffer nor a second whole-document string. The small envelope
// and each member are still validated as JSON before any result is returned.
async function parseJsonArray(chunks, { key = "assets", maxBytes = 512 * 1024 * 1024,
  maxItemBytes = 64 * 1024 * 1024, maxEnvelopeBytes = 1024 * 1024, mapItem = value => value } = {}) {
  const entries = [], envelope = [];
  let parts = [], itemBytes = 0, envelopeBytes = 0, totalBytes = 0;
  let mode = "before", depth = 0, inString = false, escaped = false;
  const stringEnd = /["\\]/g;
  let rootString = null, lastRootString = null, awaitingArray = false, afterComma = false;
  function addEnvelope(text) {
    envelopeBytes += Buffer.byteLength(text);
    if (envelopeBytes > maxEnvelopeBytes) throw new Error("JSON envelope exceeds limit");
    envelope.push(text);
  }
  function addItem(text) {
    itemBytes += Buffer.byteLength(text);
    if (itemBytes > maxItemBytes) throw new Error("JSON array member exceeds limit");
    parts.push(text);
  }
  function finishItem(text, allowEmpty) {
    addItem(text);
    const value = parts.join("").trim();
    parts = []; itemBytes = 0;
    if (!value) {
      if (allowEmpty) return;
      throw new SyntaxError("Missing JSON array member");
    }
    entries.push(mapItem(JSON.parse(value)));
  }
  for await (const chunk of decode(chunks)) {
    totalBytes += Buffer.byteLength(chunk);
    if (totalBytes > maxBytes) throw new Error("JSON document exceeds limit");
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      let ch = chunk[i];
      if (inString) {
        if (escaped) { if (rootString !== null) rootString += ch; escaped = false; continue; }
        // Most cache bytes are path/tag strings. Skip their plain contents in
        // a native delimiter search rather than visiting every character.
        stringEnd.lastIndex = i;
        const next = stringEnd.exec(chunk)?.index ?? -1;
        if (next < 0) {
          if (rootString !== null) rootString += chunk.slice(i);
          i = chunk.length - 1; continue;
        }
        if (rootString !== null) rootString += chunk.slice(i, next + 1);
        i = next; ch = chunk[i];
        if (ch === "\\") escaped = true;
        else {
          inString = false;
          if (rootString !== null) { lastRootString = JSON.parse(rootString); rootString = null; }
        }
        continue;
      }
      if (ch === '"') { inString = true; rootString = depth === 1 ? '"' : null; continue; }
      if (depth === 1 && ch === ":") { awaitingArray = lastRootString === key; lastRootString = null; continue; }
      if (depth === 1 && ch === "[" && awaitingArray) {
        if (mode !== "before") throw new SyntaxError("Duplicate JSON array property");
        addEnvelope(chunk.slice(start, i + 1));
        mode = "array"; depth++; start = i + 1; awaitingArray = false; continue;
      }
      if (mode === "array" && depth === 2 && ch === ",") {
        finishItem(chunk.slice(start, i), false); start = i + 1; afterComma = true; continue;
      }
      if (mode === "array" && depth === 2 && ch === "]") {
        finishItem(chunk.slice(start, i), !afterComma);
        addEnvelope("]"); mode = "after"; depth--; start = i + 1; continue;
      }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth--;
      if (!/\s/.test(ch)) { awaitingArray = false; lastRootString = null; }
    }
    if (mode === "array") addItem(chunk.slice(start));
    else addEnvelope(chunk.slice(start));
  }
  if (mode !== "after") throw new SyntaxError("Incomplete JSON array document");
  const document = JSON.parse(envelope.join(""));
  if (!document || !Array.isArray(document[key]) || document[key].length) throw new SyntaxError("Invalid JSON array envelope");
  document[key] = entries;
  return document;
}

async function readGzipJsonArray(file, options) {
  const source = fs.createReadStream(file);
  const unzip = zlib.createGunzip();
  source.once("error", error => unzip.destroy(error));
  source.pipe(unzip);
  try { return await parseJsonArray(unzip, options); }
  finally { source.destroy(); unzip.destroy(); }
}

async function gzipJsonArray(metadata, entries, { key = "assets", maxBytes = 128 * 1024 * 1024 } = {}) {
  if (Object.hasOwn(metadata, key)) throw new Error("JSON metadata must not contain the array property");
  async function* json() {
    const header = JSON.stringify(metadata);
    yield `${header.slice(0, -1)}${header.length > 2 ? "," : ""}${JSON.stringify(key)}:[`;
    let first = true;
    for (const entry of entries) {
      yield `${first ? "" : ","}${JSON.stringify(entry) ?? "null"}`;
      first = false;
    }
    yield "]}";
  }
  const chunks = [];
  let bytes = 0;
  await pipeline(Readable.from(json()), zlib.createGzip({ level: 1 }), async compressed => {
    for await (const chunk of compressed) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error("Compressed JSON exceeds limit");
      chunks.push(chunk);
    }
  });
  return Buffer.concat(chunks, bytes);
}

module.exports = { parseJsonArray, readGzipJsonArray, gzipJsonArray };
