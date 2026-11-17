// Color-only background removal. No model or network dependency.
const { Buffer } = require("node:buffer");
function opaqueBounds(data, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let i = 0; i < width * height; i++) {
    if (data[i * 4 + 3] === 0) continue;
    const x = i % width, y = Math.floor(i / width);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

function autoCutout(data, width, height, tolerance = 12, filterNoise = true) {
  const size = width * height;
  const border = [];
  for (let x = 0; x < width; x++) { border.push(x); if (height > 1) border.push((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y++) { border.push(y * width); if (width > 1) border.push(y * width + width - 1); }
  // A mostly transparent border already identifies the background. Opaque
  // samples here can belong to a subject touching the canvas edge.
  const transparentBorder = border.filter(i => data[i * 4 + 3] === 0).length > border.length * 0.5;
  const samples = transparentBorder ? [] : border.filter(i => data[i * 4 + 3] > 240);
  const limit = Math.max(1, Math.min(64, Number(tolerance) || 12));
  const distance = (i, color) => color.reduce((sum, c, k) => sum + (data[i * 4 + k] - c) ** 2, 0);
  // Bounded sampling keeps color estimation cheap even on large previews.
  let color = null, support = 0;
  const stride = Math.max(1, Math.ceil(samples.length / 256));
  const points = samples.filter((_, i) => i % stride === 0);
  for (const i of points) {
    const candidate = Array.from(data.subarray(i * 4, i * 4 + 3));
    const count = points.filter(j => distance(j, candidate) <= limit * limit * 3).length;
    if (count > support) { support = count; color = candidate; }
  }
  if (points.length && support < points.length * 0.6) {
    return { ok: false, message: "边缘颜色较复杂，请使用吸管手动抠像或调节容差" };
  }
  const globalLimitSq = limit * limit * 3;
  // Background gradients, vignettes and JPEG noise drift away from the sampled
  // color in small steps. A pixel is therefore also accepted while it stays
  // close to an already removed neighbor and inside a looser band around the
  // background color; the band stops the fill from crossing a subject edge.
  // A sudden step into a shaded subject must not be accepted merely because
  // the new color is still inside the broad background band.
  const localLimitSq = Math.max(4, Math.min(limit * 0.5, 8)) ** 2 * 3;
  const bandLimitSq = Math.min(limit * 2, 48) ** 2 * 3;
  const colorLimitSq = i => (data[i * 4] - color[0]) ** 2 + (data[i * 4 + 1] - color[1]) ** 2 + (data[i * 4 + 2] - color[2]) ** 2;
  const neighborLimitSq = (i, j) => (data[i * 4] - data[j * 4]) ** 2 + (data[i * 4 + 1] - data[j * 4 + 1]) ** 2 + (data[i * 4 + 2] - data[j * 4 + 2]) ** 2;
  // A narrow shaded recess can share the background color and remain connected
  // to it through the silhouette. Preserve pixels flanked by clear subject
  // colors instead of letting the border flood run down that recess.
  const shadowGuard = new Uint8Array(size);
  if (color) {
    const radius = Math.max(3, Math.min(16, Math.round(Math.min(width, height) * 0.015)));
    const enclosureRadius = Math.max(radius, Math.min(256, Math.round(Math.min(width, height) * 0.35)));
    const shadowMinSq = Math.max(2, limit * 0.25) ** 2 * 3;
    const solid = new Uint8Array(size), previous = new Uint16Array(size);
    const horizontalBoth = new Uint8Array(size), horizontalOne = new Uint8Array(size);
    for (let i = 0; i < size; i++) solid[i] = Number(data[i * 4 + 3] > 0 && colorLimitSq(i) > bandLimitSq);
    for (let y = 0; y < height; y++) {
      let last = -enclosureRadius - 1;
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (solid[i]) last = x;
        previous[i] = Math.min(65535, x - last);
      }
      let next = width + enclosureRadius;
      for (let x = width - 1; x >= 0; x--) {
        const i = y * width + x;
        if (solid[i]) next = x;
        else {
          const left = previous[i], right = next - x;
          horizontalBoth[i] = Number(left <= enclosureRadius && right <= enclosureRadius);
          horizontalOne[i] = Number(left <= enclosureRadius || right <= enclosureRadius);
          if (left <= radius && right <= radius && colorLimitSq(i) > shadowMinSq) shadowGuard[i] = 1;
        }
      }
    }
    for (let x = 0; x < width; x++) {
      let last = -enclosureRadius - 1;
      for (let y = 0; y < height; y++) {
        const i = y * width + x;
        if (solid[i]) last = y;
        previous[i] = Math.min(65535, y - last);
      }
      let next = height + enclosureRadius;
      for (let y = height - 1; y >= 0; y--) {
        const i = y * width + x;
        if (solid[i]) next = y;
        else if (colorLimitSq(i) > shadowMinSq) {
          const top = previous[i], bottom = next - y;
          if ((top <= radius && bottom <= radius)
            || (horizontalBoth[i] && (top <= enclosureRadius || bottom <= enclosureRadius))
            || (top <= enclosureRadius && bottom <= enclosureRadius && horizontalOne[i])) shadowGuard[i] = 1;
        }
      }
    }
  }
  const visited = new Uint8Array(size), queue = new Int32Array(size);
  let head = 0, tail = 0, removed = 0;
  const enqueue = (i, from) => {
    if (visited[i]) return;
    if (data[i * 4 + 3] !== 0) {
      if (!color) return;
      if (shadowGuard[i] || (from >= 0 && neighborLimitSq(i, from) > localLimitSq)) return;
      if (colorLimitSq(i) > globalLimitSq) {
        if (from < 0 || colorLimitSq(i) > bandLimitSq) return;
      }
    }
    visited[i] = 1;
    queue[tail++] = i;
  };
  border.forEach(i => enqueue(i, -1));
  const neighbors = (i, visit) => {
    if (i % width) visit(i - 1);
    if (i % width < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i < size - width) visit(i + width);
  };
  let totalOpaque = 0;
  for (let i = 0; i < size; i++) if (data[i * 4 + 3]) totalOpaque++;
  while (head < tail) {
    const i = queue[head++];
    if (data[i * 4 + 3]) removed++;
    data[i * 4 + 3] = 0;
    neighbors(i, j => enqueue(j, i));
  }
  const remaining = opaqueBounds(data, width, height);
  if (!remaining) return { ok: false, message: "未能区分主体和背景，请降低容差或使用吸管" };
  // If the flood fill consumed most of the image and the leftover still touches
  // the edge, the estimated "background" color was almost certainly the subject
  // itself (a large subject spanning several borders). Report ambiguity instead
  // of silently deleting the subject.
  if (totalOpaque > 0 && removed / totalOpaque > 0.6
    && (remaining.minX === 0 || remaining.minY === 0 || remaining.maxX === width - 1 || remaining.maxY === height - 1)) {
    return { ok: false, message: "背景颜色识别不确定，请使用吸管手动抠除背景" };
  }
  let filtered = 0;
  if (filterNoise) {
    // Peel leftover background noise: a still opaque pixel that sits inside
    // the background color band and is surrounded by removed pixels is noise or
    // a soft fringe, never a solid subject edge (those keep opaque neighbours).
    if (color) {
      for (let pass = 0; pass < 2; pass++) {
        const fringe = [];
        for (let i = 0; i < size; i++) {
          if (!data[i * 4 + 3] || shadowGuard[i] || colorLimitSq(i) > bandLimitSq) continue;
          const x = i % width;
          let inBounds = 0, removedNeighbors = 0;
          if (x > 0) { inBounds++; if (!data[(i - 1) * 4 + 3]) removedNeighbors++; }
          if (x < width - 1) { inBounds++; if (!data[(i + 1) * 4 + 3]) removedNeighbors++; }
          if (i >= width) { inBounds++; if (!data[(i - width) * 4 + 3]) removedNeighbors++; }
          if (i < size - width) { inBounds++; if (!data[(i + width) * 4 + 3]) removedNeighbors++; }
          if (removedNeighbors >= Math.min(3, inBounds)) fringe.push(i);
        }
        if (!fringe.length) break;
        for (const i of fringe) data[i * 4 + 3] = 0;
        filtered += fringe.length;
      }
    }
    const labels = new Int32Array(size), regions = [];
    for (let start = 0; start < size; start++) {
      if (labels[start] || !data[start * 4 + 3]) continue;
      const id = regions.length + 1;
      head = 0; tail = 1; queue[0] = start; labels[start] = id;
      const region = { id, count: 0, minX: width, minY: height, maxX: 0, maxY: 0, sr: 0, sg: 0, sb: 0 };
      while (head < tail) {
        const i = queue[head++], x = i % width, y = Math.floor(i / width);
        region.count++; region.minX = Math.min(region.minX, x); region.maxX = Math.max(region.maxX, x);
        region.minY = Math.min(region.minY, y); region.maxY = Math.max(region.maxY, y);
        region.sr += data[i * 4]; region.sg += data[i * 4 + 1]; region.sb += data[i * 4 + 2];
        neighbors(i, j => { if (!labels[j] && data[j * 4 + 3]) { labels[j] = id; queue[tail++] = j; } });
      }
      regions.push(region);
    }
    const main = regions.reduce((best, r) => !best || r.count > best.count ? r : best, null);
    const mainR = main.sr / main.count, mainG = main.sg / main.count, mainB = main.sb / main.count;
    const sameColor = r => {
      const dr = r.sr / r.count - mainR, dg = r.sg / r.count - mainG, db = r.sb / r.count - mainB;
      return dr * dr + dg * dg + db * db <= limit * limit * 3 * 4;
    };
    // Only isolated specks are safe to discard. A percentage of the largest
    // region can still be thousands of pixels in a preview and may be a real
    // detached part of the asset.
    const maxNoisePixels = Math.min(128, Math.max(24, Math.floor(main.count * 0.001)));
    const discarded = new Set();
    for (const r of regions) {
      const dx = Math.max(0, main.minX - r.maxX, r.minX - main.maxX);
      const dy = Math.max(0, main.minY - r.maxY, r.minY - main.maxY);
      const peripheral = r.maxX < width * 0.18 || r.minX > width * 0.82 || r.maxY < height * 0.18 || r.minY > height * 0.82;
      // A detached part shares the subject's color; only drop peripheral
      // specks of a different color (watermarks, corner marks).
      if (r !== main && r.count <= maxNoisePixels && peripheral && Math.hypot(dx / width, dy / height) > 0.08 && !sameColor(r)) discarded.add(r.id);
    }
    for (let i = 0; i < size; i++) if (discarded.has(labels[i])) { data[i * 4 + 3] = 0; filtered++; }
  }
  return { ok: true, removed, filtered, message: `已自动去背景${filtered ? "并清理背景噪点" : ""}，请检查主体边缘和分离零件` };
}

// The model can recognize the top of an asset while dropping a large, equally
// visible lower section. On a plain background, the border-connected color
// cutout is a useful independent check before accepting that loss.
function recoverModelCutout(modelRgba, sourceRgb, width, height) {
  const size = width * height;
  const colorRgba = Buffer.alloc(size * 4);
  for (let i = 0; i < size; i++) {
    colorRgba[i * 4] = sourceRgb[i * 3];
    colorRgba[i * 4 + 1] = sourceRgb[i * 3 + 1];
    colorRgba[i * 4 + 2] = sourceRgb[i * 3 + 2];
    colorRgba[i * 4 + 3] = 255;
  }
  const result = autoCutout(colorRgba, width, height);
  if (!result.ok || result.removed < size * 0.2) return false;
  const bounds = opaqueBounds(colorRgba, width, height);
  if (!bounds || bounds.minX === 0 || bounds.minY === 0 || bounds.maxX === width - 1 || bounds.maxY === height - 1) return false;
  let modelCount = 0, colorCount = 0, overlap = 0;
  for (let i = 0; i < size; i++) {
    const model = modelRgba[i * 4 + 3] > 0;
    const color = colorRgba[i * 4 + 3] > 0;
    if (model) modelCount++;
    if (color) colorCount++;
    if (model && color) overlap++;
  }
  // Restore missing exterior parts, without filling enclosed openings that the
  // model already removed. Small bases can be lost below the old 25% threshold.
  if (!modelCount || colorCount < modelCount * 1.05 || colorCount > size * 0.75
    || overlap < modelCount * 0.9) return false;
  const visited = new Uint8Array(size), queue = new Int32Array(size);
  let head = 0, tail = 0, added = 0;
  const enqueue = i => {
    if (!visited[i] && !modelRgba[i * 4 + 3]) { visited[i] = 1; queue[tail++] = i; }
  };
  for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
  while (head < tail) {
    const i = queue[head++];
    if (colorRgba[i * 4 + 3]) added++;
    if (i % width) enqueue(i - 1);
    if (i % width < width - 1) enqueue(i + 1);
    if (i >= width) enqueue(i - width);
    if (i < size - width) enqueue(i + width);
  }
  if (added < modelCount * 0.02) return false;
  for (let i = 0; i < size; i++) {
    if (!colorRgba[i * 4 + 3]) continue;
    const contrast = (sourceRgb[i * 3] - sourceRgb[0]) ** 2
      + (sourceRgb[i * 3 + 1] - sourceRgb[1]) ** 2 + (sourceRgb[i * 3 + 2] - sourceRgb[2]) ** 2;
    // The accepted color silhouette is inside every border, so its corner is
    // background. Contrasting interior pixels repair model-created pinholes.
    if (visited[i] || contrast > 30 ** 2 * 3) modelRgba[i * 4 + 3] = 255;
  }
  return true;
}

// Refine at full resolution on a plain background. Repeated, exactly matching
// enclosed regions can expose openings that the coarse model filled in.
function refineModelCutout(rgba, sourceRgb, modelAlpha, width, height) {
  const size = width * height;
  const border = [];
  for (let x = 0; x < width; x++) { border.push(x); if (height > 1) border.push((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y++) { border.push(y * width); if (width > 1) border.push(y * width + width - 1); }
  const samples = border.filter(i => modelAlpha[i] <= 5);
  if (samples.length < border.length * 0.6) return false;
  const stride = Math.max(1, Math.ceil(samples.length / 128));
  const points = samples.filter((_, i) => i % stride === 0);
  const distance = (i, color) => (sourceRgb[i * 3] - color[0]) ** 2
    + (sourceRgb[i * 3 + 1] - color[1]) ** 2 + (sourceRgb[i * 3 + 2] - color[2]) ** 2;
  let background = null, support = 0;
  for (const i of points) {
    const color = sourceRgb.subarray(i * 3, i * 3 + 3);
    const count = points.filter(j => distance(j, color) <= 12 ** 2 * 3).length;
    if (count > support) { background = color; support = count; }
  }
  if (!background || samples.filter(i => distance(i, background) <= 12 ** 2 * 3).length < samples.length * 0.9) return false;

  const close = new Uint8Array(size);
  const visited = new Uint8Array(size), queue = new Int32Array(size);
  const inner = 8 * Math.sqrt(3), outer = 30 * Math.sqrt(3);
  for (let i = 0; i < size; i++) {
    const m = modelAlpha[i], d = Math.sqrt(distance(i, background));
    close[i] = Number(m < 250 && d <= inner);
    // Recover thin, contrasting details in the model's uncertain edge band.
    // RGB is never changed; intermediate alpha retains antialiased edges.
    if (m > 5 && m < 250 && d > inner) {
      const alpha = Math.round(255 * Math.min(1, (d - inner) / (outer - inner)));
      rgba[i * 4 + 3] = Math.max(rgba[i * 4 + 3], alpha);
    }
  }
  for (let start = 0; start < size; start++) {
    if (!close[start] || visited[start]) continue;
    let head = 0, tail = 1, confidence = 0, seeds = 0;
    queue[0] = start; visited[start] = 1;
    const enqueue = i => {
      if (!visited[i] && close[i]) { visited[i] = 1; queue[tail++] = i; }
    };
    while (head < tail) {
      const i = queue[head++];
      confidence += modelAlpha[i];
      if (modelAlpha[i] <= 32) seeds++;
      if (i % width) enqueue(i - 1);
      if (i % width < width - 1) enqueue(i + 1);
      if (i >= width) enqueue(i - width);
      if (i < size - width) enqueue(i + width);
    }
    if (seeds < Math.max(1, tail * 0.02) || confidence >= tail * 128) continue;
    for (let j = 0; j < tail; j++) rgba[queue[j] * 4 + 3] = 0;
  }

  // Model confidence alone cannot veto repeated air gaps on a flat studio
  // backdrop. Use a much stricter color match than the uncertain-edge pass.
  const strictLimitSq = 2 ** 2 * 3;
  if (samples.filter(i => distance(i, background) <= strictLimitSq).length < samples.length * 0.95) return true;
  // Tiny enclosed transparent flecks with textured source colors are model
  // damage, unlike openings that actually match the flat backdrop.
  visited.fill(0);
  const maxPitSize = Math.max(4, Math.min(128, Math.round(size * 0.001)));
  for (let start = 0; start < size; start++) {
    if (rgba[start * 4 + 3] || visited[start]) continue;
    let head = 0, tail = 1, edge = false, flat = 0;
    queue[0] = start; visited[start] = 1;
    const enqueue = i => {
      if (!visited[i] && !rgba[i * 4 + 3]) { visited[i] = 1; queue[tail++] = i; }
    };
    while (head < tail) {
      const i = queue[head++], x = i % width, y = Math.floor(i / width);
      if (!x || !y || x === width - 1 || y === height - 1) edge = true;
      if (distance(i, background) <= strictLimitSq) flat++;
      if (x) enqueue(i - 1);
      if (x < width - 1) enqueue(i + 1);
      if (y) enqueue(i - width);
      if (y < height - 1) enqueue(i + width);
    }
    if (!edge && tail <= maxPitSize && flat < tail * 0.2) {
      for (let j = 0; j < tail; j++) rgba[queue[j] * 4 + 3] = 255;
    }
  }
  const interior = new Uint8Array(size);
  visited.fill(0);
  for (let i = 0; i < size; i++) close[i] = Number(distance(i, background) <= strictLimitSq);
  let openings = 0;
  for (let start = 0; start < size; start++) {
    if (!close[start] || visited[start]) continue;
    let head = 0, tail = 1, edge = false, minX = width, minY = height, maxX = 0, maxY = 0;
    queue[0] = start; visited[start] = 1;
    const enqueue = i => {
      if (!visited[i] && close[i]) { visited[i] = 1; queue[tail++] = i; }
    };
    while (head < tail) {
      const i = queue[head++], x = i % width, y = Math.floor(i / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      if (!x || !y || x === width - 1 || y === height - 1) edge = true;
      if (x) enqueue(i - 1);
      if (x < width - 1) enqueue(i + 1);
      if (y) enqueue(i - width);
      if (y < height - 1) enqueue(i + width);
    }
    if (edge || tail < 12 || maxX - minX < 3 || maxY - minY < 3 || tail > size * 0.08) continue;
    openings++;
    for (let j = 0; j < tail; j++) interior[queue[j]] = 1;
  }
  // shortcut: a single same-colored panel is ambiguous; require repeated
  // matching gaps before overriding the model, and leave isolated gaps to review.
  if (openings < 3) return true;
  let head = 0, tail = 0;
  for (let i = 0; i < size; i++) if (interior[i]) { rgba[i * 4 + 3] = 0; queue[tail++] = i; }
  // Feather only two pixels from confirmed cores; never flood through the
  // object's dark texture just because it falls in the wider edge tolerance.
  for (let pass = 0; pass < 2; pass++) {
    const end = tail;
    const feather = i => {
      if (interior[i]) return;
      const d = Math.sqrt(distance(i, background));
      if (d > inner) return;
      interior[i] = 1; queue[tail++] = i;
      rgba[i * 4 + 3] = Math.min(rgba[i * 4 + 3], Math.round(255 * Math.max(0, (d - Math.sqrt(strictLimitSq)) / (inner - Math.sqrt(strictLimitSq)))));
    };
    while (head < end) {
      const i = queue[head++];
      if (i % width) feather(i - 1);
      if (i % width < width - 1) feather(i + 1);
      if (i >= width) feather(i - width);
      if (i < size - width) feather(i + width);
    }
  }
  return true;
}

async function softenCutoutEdges(rgba, width, height) {
  const sharp = require("sharp");
  const alpha = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .extractChannel(3).raw().toBuffer();
  const smooth = await sharp(alpha, { raw: { width, height, channels: 1 } })
    .median(5).blur(1).greyscale().raw().toBuffer();
  const directions = [1, width, width + 1, width - 1];
  const across = [width, 1, width - 1, width + 1];
  for (let i = 0; i < width * height; i++) {
    if (!alpha[i]) continue;
    let value = Math.min(alpha[i], Math.round(Math.max(0, (smooth[i] - alpha[i] * 0.2) / 0.8)));
    const x = i % width, y = Math.floor(i / width);
    // Preserve long thin rods; a global opacity floor would also preserve
    // the isolated edge spikes and specks that the median pass removes.
    if (x >= 2 && y >= 2 && x < width - 2 && y < height - 2) {
      for (let k = 0; k < directions.length; k++) {
        if (alpha[i - directions[k] * 2] > 200 && alpha[i + directions[k] * 2] > 200
          && alpha[i - across[k] * 2] < 64 && alpha[i + across[k] * 2] < 64) {
          value = Math.max(value, Math.round(alpha[i] * 0.85));
          break;
        }
      }
    }
    rgba[i * 4 + 3] = alpha[i] > 200 && value < 32 ? 0 : value;
  }
}

function cropPixelBounds(selection, width, height) {
  if (!selection || ![selection.x, selection.y, selection.width, selection.height].every(Number.isFinite)
    || selection.width <= 0 || selection.height <= 0) {
    throw new Error("请选择有效的裁剪区域");
  }
  const left = Math.floor(selection.x * width), top = Math.floor(selection.y * height);
  const right = Math.ceil((selection.x + selection.width) * width);
  const bottom = Math.ceil((selection.y + selection.height) * height);
  if (![left, top, right, bottom].every(Number.isSafeInteger) || (right - left) * (bottom - top) > 16777216) throw new Error("裁剪区域过大，请缩小选区（最多 1600 万像素）");
  if (right <= left || bottom <= top) throw new Error("裁剪区域过小");
  return { left, top, width: right - left, height: bottom - top };
}

module.exports = { autoCutout, recoverModelCutout, refineModelCutout, softenCutoutEdges, opaqueBounds, cropPixelBounds };
