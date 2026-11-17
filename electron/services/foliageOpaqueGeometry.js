"use strict";

// The UV-space part of the foliage cutter has no FBX or application runtime
// dependency. Coordinates use the same bottom-left image origin as FBX UVs.
const MAX_CUTS_PER_TRIANGLE = 2048;
const MAX_PIECES_PER_TRIANGLE = 4096;

function area(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum * 0.5;
}

function traceContours(values, width, height, threshold = 0.5) {
  if (width < 2 || height < 2) return [];
  const paddedWidth = width + 2;
  const padded = new Float32Array(paddedWidth * (height + 2));
  for (let y = 0; y < height; y += 1) {
    padded.set(values.subarray(y * width, (y + 1) * width), (y + 1) * paddedWidth + 1);
  }
  const get = (x, y) => padded[y * paddedWidth + x];
  const edges = [];
  const crossing = (a, b) => Math.max(0, Math.min(1, Math.abs(b - a) > 1e-12 ? (threshold - a) / (b - a) : 0.5));
  for (let y = 0; y <= height; y += 1) {
    for (let x = 0; x <= width; x += 1) {
      const a = get(x, y), b = get(x + 1, y), c = get(x + 1, y + 1), d = get(x, y + 1);
      const code = (a >= threshold ? 1 : 0) | (b >= threshold ? 2 : 0) |
        (c >= threshold ? 4 : 0) | (d >= threshold ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const center = (a + b + c + d) * 0.25 >= threshold;
      const edge = {
        B: { key: `h:${x}:${y}`, point: [x + crossing(a, b), y] },
        R: { key: `v:${x + 1}:${y}`, point: [x + 1, y + crossing(b, c)] },
        T: { key: `h:${x}:${y + 1}`, point: [x + crossing(d, c), y + 1] },
        L: { key: `v:${x}:${y}`, point: [x, y + crossing(a, d)] }
      };
      const pairs = {
        1: [["L", "B"]], 2: [["B", "R"]], 3: [["L", "R"]],
        4: [["R", "T"]], 5: center ? [["B", "R"], ["L", "T"]] : [["L", "B"], ["R", "T"]],
        6: [["B", "T"]], 7: [["L", "T"]], 8: [["L", "T"]], 9: [["B", "T"]],
        10: center ? [["L", "B"], ["R", "T"]] : [["B", "R"], ["L", "T"]],
        11: [["R", "T"]], 12: [["L", "R"]], 13: [["B", "R"]], 14: [["L", "B"]]
      }[code];
      for (const [first, second] of pairs) edges.push([edge[first], edge[second]]);
    }
  }
  const adjacency = new Map();
  edges.forEach((pair, index) => pair.forEach((endpoint, side) => {
    const list = adjacency.get(endpoint.key) || [];
    list.push(index * 2 + side);
    adjacency.set(endpoint.key, list);
  }));
  const used = new Uint8Array(edges.length * 2);
  const loops = [];
  for (let start = 0; start < used.length; start += 1) {
    if (used[start]) continue;
    const startKey = edges[start >> 1][start & 1].key;
    const points = [];
    let current = start;
    let closed = false;
    while (true) {
      used[current] = 1;
      const partner = current ^ 1;
      used[partner] = 1;
      points.push(edges[current >> 1][current & 1].point);
      const nextKey = edges[partner >> 1][partner & 1].key;
      if (nextKey === startKey) { closed = true; break; }
      const next = (adjacency.get(nextKey) || []).find((entry) => !used[entry]);
      if (next === undefined) break;
      current = next;
    }
    if (closed && points.length >= 3) {
      loops.push(points.map(([x, y]) => [(x - 1) / (width - 1), (y - 1) / (height - 1)]));
    }
  }
  return loops;
}

function simplifyPolyline(points, epsilon) {
  if (points.length < 3 || epsilon <= 0) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    if (last <= first + 1) continue;
    const [ax, ay] = points[first], [bx, by] = points[last];
    const dx = bx - ax, dy = by - ay, lengthSq = dx * dx + dy * dy;
    let worst = epsilon * epsilon, worstIndex = -1;
    for (let i = first + 1; i < last; i += 1) {
      const [px, py] = points[i];
      const factor = lengthSq <= 1e-18 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
      const ox = px - (ax + dx * factor), oy = py - (ay + dy * factor);
      const distance = ox * ox + oy * oy;
      if (distance > worst) { worst = distance; worstIndex = i; }
    }
    if (worstIndex >= 0) {
      keep[worstIndex] = 1;
      stack.push([first, worstIndex], [worstIndex, last]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

function simplifyLoops(loops, tolerance, minArea) {
  return loops.map((loop) => tolerance > 0 ? simplifyPolyline([...loop, loop[0]], tolerance).slice(0, -1) : loop)
    .filter((loop) => loop.length >= 3 && Math.abs(area(loop)) >= minArea);
}

class ContourIndex {
  constructor(loops, cells = 64) {
    this.cells = Math.max(4, cells | 0);
    this.segments = [];
    this.cellMap = new Map();
    this.rowMap = new Map();
    const clampCell = (value) => Math.max(0, Math.min(this.cells - 1, Math.floor(value * this.cells)));
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i += 1) {
        const [ax, ay] = loop[i], [bx, by] = loop[(i + 1) % loop.length];
        if (ax === bx && ay === by) continue;
        const index = this.segments.push([ax, ay, bx, by]) - 1;
        for (let cy = clampCell(Math.min(ay, by)); cy <= clampCell(Math.max(ay, by)); cy += 1) {
          if (!this.rowMap.has(cy)) this.rowMap.set(cy, new Set());
          this.rowMap.get(cy).add(index);
          for (let cx = clampCell(Math.min(ax, bx)); cx <= clampCell(Math.max(ax, bx)); cx += 1) {
            const key = `${cx}:${cy}`;
            if (!this.cellMap.has(key)) this.cellMap.set(key, []);
            this.cellMap.get(key).push(index);
          }
        }
      }
    }
  }

  segmentsInBox(umin, vmin, umax, vmax) {
    const cell = (value) => Math.max(0, Math.min(this.cells - 1, Math.floor(value * this.cells)));
    const found = new Set();
    for (let cy = cell(vmin); cy <= cell(vmax); cy += 1) {
      for (let cx = cell(umin); cx <= cell(umax); cx += 1) {
        for (const index of this.cellMap.get(`${cx}:${cy}`) || []) found.add(index);
      }
    }
    return found;
  }

  pointInside(u, v) {
    const cy = Math.max(0, Math.min(this.cells - 1, Math.floor(v * this.cells)));
    let inside = false;
    for (const index of this.rowMap.get(cy) || []) {
      const [ax, ay, bx, by] = this.segments[index];
      if ((ay > v) !== (by > v) && ax + (bx - ax) * (v - ay) / (by - ay) > u) inside = !inside;
    }
    return inside;
  }
}

function clipSegment(a, b, polygon) {
  const points = area(polygon) < 0 ? [...polygon].reverse() : polygon;
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (let i = 0; i < points.length; i += 1) {
    const [px, py] = points[i], [qx, qy] = points[(i + 1) % points.length];
    const nx = -(qy - py), ny = qx - px;
    const numerator = nx * (a[0] - px) + ny * (a[1] - py);
    const denominator = nx * dx + ny * dy;
    if (Math.abs(denominator) < 1e-15) {
      if (numerator < 0) return null;
      continue;
    }
    const t = -numerator / denominator;
    if (denominator > 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  if (t1 - t0 <= 1e-12) return null;
  return [[a[0] + dx * t0, a[1] + dy * t0], [a[0] + dx * t1, a[1] + dy * t1]];
}

function clipHalfplane(points, a, b, positive) {
  if (points.length < 3) return [];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const signed = (p) => (dx * (p[1] - a[1]) - dy * (p[0] - a[0])) * (positive ? 1 : -1);
  const result = [];
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i], previous = points[(i + points.length - 1) % points.length];
    const cs = signed(current), ps = signed(previous);
    const ci = cs >= -1e-12, pi = ps >= -1e-12;
    if (ci !== pi && Math.abs(ps - cs) > 1e-18) {
      const t = ps / (ps - cs);
      result.push([previous[0] + (current[0] - previous[0]) * t, previous[1] + (current[1] - previous[1]) * t]);
    }
    if (ci) result.push(current);
  }
  return result;
}

function cutTriangle(triangle, contours, minArea = 0, onWarning = () => {}) {
  const us = triangle.map((p) => p[0]), vs = triangle.map((p) => p[1]);
  const box = [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)];
  const cuts = [];
  for (const index of contours.segmentsInBox(...box)) {
    const [ax, ay, bx, by] = contours.segments[index];
    const clipped = clipSegment([ax, ay], [bx, by], triangle);
    if (clipped) cuts.push(clipped);
  }
  if (!cuts.length) {
    const center = triangle.reduce((sum, p) => [sum[0] + p[0] / 3, sum[1] + p[1] / 3], [0, 0]);
    return { pieces: contours.pointInside(...center) ? [triangle] : [], cut: false };
  }
  if (cuts.length > MAX_CUTS_PER_TRIANGLE) {
    onWarning(`单个三角面的轮廓段过多，已截断到 ${MAX_CUTS_PER_TRIANGLE} 段`);
    cuts.length = MAX_CUTS_PER_TRIANGLE;
  }
  let pieces = [{ polygon: triangle, box }];
  for (const [a, b] of cuts) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (dx * dx + dy * dy <= 1e-18) continue;
    const low = [Math.min(a[0], b[0]) - 1e-12, Math.min(a[1], b[1]) - 1e-12];
    const high = [Math.max(a[0], b[0]) + 1e-12, Math.max(a[1], b[1]) + 1e-12];
    const updated = [];
    for (const item of pieces) {
      if (item.box[2] < low[0] || item.box[0] > high[0] || item.box[3] < low[1] || item.box[1] > high[1]) {
        updated.push(item);
        continue;
      }
      let positive = false, negative = false;
      for (const p of item.polygon) {
        const side = dx * (p[1] - a[1]) - dy * (p[0] - a[0]);
        if (side > 1e-12) positive = true;
        else if (side < -1e-12) negative = true;
      }
      if (!positive || !negative) { updated.push(item); continue; }
      const candidates = [clipHalfplane(item.polygon, a, b, true), clipHalfplane(item.polygon, a, b, false)]
        .filter((candidate) => candidate.length >= 3 && Math.abs(area(candidate)) > minArea);
      if (candidates.length !== 2) { updated.push(item); continue; }
      for (const polygon of candidates) {
        const ux = polygon.map((p) => p[0]), vy = polygon.map((p) => p[1]);
        updated.push({ polygon, box: [Math.min(...ux), Math.min(...vy), Math.max(...ux), Math.max(...vy)] });
      }
      if (updated.length >= MAX_PIECES_PER_TRIANGLE) break;
    }
    pieces = updated;
    if (pieces.length >= MAX_PIECES_PER_TRIANGLE) {
      onWarning("单个三角面的裁切碎片过多，已提前停止细分");
      break;
    }
  }
  const kept = [];
  for (const item of pieces) {
    const cleaned = [];
    for (const point of item.polygon) {
      const last = cleaned.at(-1);
      if (last && Math.abs(point[0] - last[0]) <= 1e-12 && Math.abs(point[1] - last[1]) <= 1e-12) continue;
      cleaned.push(point);
    }
    if (cleaned.length > 1 && cleaned[0].every((value, axis) => Math.abs(value - cleaned.at(-1)[axis]) <= 1e-12)) cleaned.pop();
    if (cleaned.length < 3) continue;
    const center = cleaned.reduce((sum, p) => [sum[0] + p[0] / cleaned.length, sum[1] + p[1] / cleaned.length], [0, 0]);
    if (contours.pointInside(...center)) kept.push(cleaned);
  }
  return { pieces: kept, cut: true };
}

function barycentric(point, triangle) {
  const [[x0, y0], [x1, y1], [x2, y2]] = triangle;
  const denominator = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
  if (Math.abs(denominator) < 1e-18) return [1, 0, 0];
  const w0 = ((y1 - y2) * (point[0] - x2) + (x2 - x1) * (point[1] - y2)) / denominator;
  const w1 = ((y2 - y0) * (point[0] - x2) + (x0 - x2) * (point[1] - y2)) / denominator;
  return [w0, w1, 1 - w0 - w1];
}

module.exports = { area, traceContours, simplifyLoops, ContourIndex, cutTriangle, barycentric };
