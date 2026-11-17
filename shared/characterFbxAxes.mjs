// FBXLoader leaves source axes unchanged. Read FBX GlobalSettings without
// rewriting source bytes; both import inspection and preview use this result.
export function readCharacterFbxAxes(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  const text = new globalThis.TextDecoder('latin1').decode(bytes.subarray(0, 131072));
  const start = text.indexOf('GlobalSettings');
  if (start < 0) return { upAxis: null, upSign: 1 };
  const binary = text.startsWith('Kaydara FBX Binary');
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  function property(name) {
    if (!binary) return Number(new RegExp(`P:\\s*"${name}"\\s*,[^\\r\\n]*?,\\s*(-?\\d+)\\s*(?:\\r?\\n|$)`).exec(text.slice(start))?.[1] ?? NaN);
    const index = text.indexOf(`S${String.fromCharCode(name.length)}\0\0\0${name}`, start);
    if (index < 0) return NaN;
    let pos = index + 5 + name.length;
    for (let i = 0; i < 3; i++) {
      if (pos + 5 > data.byteLength || data.getUint8(pos) !== 83) return NaN;
      pos += 5 + data.getUint32(pos + 1, true);
    }
    return pos + 5 <= data.byteLength && data.getUint8(pos) === 73 ? data.getInt32(pos + 1, true) : NaN;
  }
  const axis = property('UpAxis');
  return { upAxis: [0, 1, 2].includes(axis) ? axis : null, upSign: property('UpAxisSign') === -1 ? -1 : 1 };
}
