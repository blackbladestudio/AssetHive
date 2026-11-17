export type FrameRateSource = "keyframes" | "header" | "custom";

export type ResolvedFrameRate = {
  frameRate: number | null;
  source: FrameRateSource | null;
};

const STANDARD_FPS = [24, 25, 30, 48, 50, 60, 72, 96, 100, 120];

// Autodesk FBX SDK FbxTime.EMode. Index 9 is NTSC 29.97, 10 is PAL 25.
export const FBX_TIME_MODE_FPS: Record<number, number | null> = {
  1: 120,
  2: 100,
  3: 60,
  4: 50,
  5: 48,
  6: 30,
  7: 30,
  8: 29.97,
  9: 29.97,
  10: 25,
  11: 24,
  12: 1000,
  13: null,
  14: 96,
  15: 72,
  16: 59.94,
  17: 119.88
};

export function isAsciiFbxBuffer(buffer: ArrayBuffer) {
  const head = new TextDecoder("latin1").decode(buffer.slice(0, 24));
  return !head.startsWith("Kaydara FBX Binary");
}

export function readAsciiFbxFrameRate(text: string): { timeModeFps: number | null; customFps: number | null } {
  const timeModeMatch = text.match(/"TimeMode"\s*,\s*"enum"[^0-9]{0,40}(\d{1,2})/)
    || text.match(/(?:^|[\s,])TimeMode:\s*(\d{1,2})\b/);
  const customMatch = text.match(/"CustomFrameRate"\s*,\s*"double"[^0-9-]{0,40}(-?\d+(?:\.\d+)?)/)
    || text.match(/(?:^|[\s,])CustomFrameRate:\s*(-?\d+(?:\.\d+)?)/);
  const timeMode = timeModeMatch ? Number(timeModeMatch[1]) : NaN;
  const custom = customMatch ? Number(customMatch[1]) : NaN;
  const customFps = Number.isFinite(custom) && custom > 1 ? custom : null;
  if (timeMode === 13) {
    return { timeModeFps: customFps, customFps };
  }
  if (Number.isFinite(timeMode) && timeMode in FBX_TIME_MODE_FPS) {
    return { timeModeFps: FBX_TIME_MODE_FPS[timeMode], customFps };
  }
  return { timeModeFps: null, customFps };
}

export function inferFrameRateFromTrackTimes(tracks: Array<{ times?: ArrayLike<number> | null }>): number | null {
  const densities: number[] = [];
  const deltas: number[] = [];
  tracks.forEach((track) => {
    const times = track.times;
    if (!times || times.length < 2) return;
    const span = Number(times[times.length - 1]) - Number(times[0]);
    if (span > 0 && times.length >= 8) {
      densities.push((times.length - 1) / span);
    }
    for (let index = 1; index < times.length; index += 1) {
      const delta = Number(times[index]) - Number(times[index - 1]);
      if (delta > 1e-4) deltas.push(delta);
    }
  });
  const fromDensity = densities.length ? median(densities) : null;
  const fromDelta = deltas.length ? 1 / median(deltas) : null;
  const raw = fromDensity && fromDensity >= 12 ? fromDensity : fromDelta;
  return snapFrameRate(raw);
}

export function resolveAnimationFrameRate(input: {
  headerFps?: number | null;
  customFps?: number | null;
  inferredFps?: number | null;
}): ResolvedFrameRate {
  const custom = snapFrameRate(input.customFps ?? null);
  const inferred = snapFrameRate(input.inferredFps ?? null);
  const header = snapFrameRate(input.headerFps ?? null);
  if (inferred != null && isStandardFps(inferred)) {
    if (custom != null && Math.abs(custom - inferred) <= 1.2) {
      return { frameRate: inferred, source: "custom" };
    }
    if (header != null && Math.abs(header - inferred) <= 1.2) {
      return { frameRate: inferred, source: "header" };
    }
    return { frameRate: inferred, source: "keyframes" };
  }
  if (custom != null) return { frameRate: custom, source: "custom" };
  if (header != null) return { frameRate: header, source: "header" };
  if (inferred != null) return { frameRate: inferred, source: "keyframes" };
  return { frameRate: null, source: null };
}

export function countFootPlants(height: number[], loop = true) {
  const samples = height.filter((value) => Number.isFinite(value));
  const count = samples.length;
  if (count < 8) return 0;
  const minY = Math.min(...samples);
  const maxY = Math.max(...samples);
  const range = maxY - minY;
  if (range < 1.5) return 0;
  const cutoff = minY + Math.max(1.2, range * 0.35);
  const planted = samples.map((value) => value <= cutoff);
  if (planted.every(Boolean) || planted.every((value) => !value)) return 0;
  let segments = 0;
  let inPlant = false;
  for (let index = 0; index < count; index += 1) {
    if (planted[index] && !inPlant) {
      segments += 1;
      inPlant = true;
    } else if (!planted[index]) {
      inPlant = false;
    }
  }
  if (loop && planted[0] && planted[count - 1] && segments > 0) {
    segments -= 1;
  }
  return segments;
}

export function pickBestFootName(names: string[], side: "left" | "right") {
  let best = "";
  let bestScore = 0;
  names.forEach((name) => {
    const score = scoreFootName(name, side);
    if (score > bestScore) {
      best = name;
      bestScore = score;
    }
  });
  return bestScore > 0 ? best : "";
}

export function scoreFootName(name: string, side: "left" | "right") {
  const bone = String(name || "").replace(/\.position$/i, "").split(/[\\/.:]/).pop() || "";
  if (!/(foot|toe|ball|ankle)/i.test(bone)) return 0;
  if (/(hand|arm|calf|thigh|leg|knee|shoulder|finger|thumb|root|pelvis|hip|spine)/i.test(bone) && !/(foot|toe|ball|ankle)/i.test(bone)) {
    return 0;
  }
  const isLeft = /(left|^l_|_l$|_l_|lfoot|ltoe|lball|lankle|footl|toel)/i.test(bone);
  const isRight = /(right|^r_|_r$|_r_|rfoot|rtoe|rball|rankle|footr|toer)/i.test(bone);
  if (side === "left" && (isRight && !isLeft)) return 0;
  if (side === "right" && (isLeft && !isRight)) return 0;
  if (side === "left" && !isLeft) return 0;
  if (side === "right" && !isRight) return 0;
  let score = 10;
  if (/toe|ball/i.test(bone)) score += 40;
  if (/foot/i.test(bone)) score += 30;
  if (/ankle/i.test(bone)) score += 20;
  return score;
}

function snapFrameRate(raw: number | null) {
  if (raw == null || !Number.isFinite(raw) || raw < 8 || raw > 240) return null;
  let best = raw;
  let bestDist = Infinity;
  STANDARD_FPS.forEach((item) => {
    const dist = Math.abs(raw - item);
    if (dist < bestDist && dist <= 1.2) {
      best = item;
      bestDist = dist;
    }
  });
  return Math.round(best * 100) / 100;
}

function isStandardFps(value: number) {
  return STANDARD_FPS.some((item) => Math.abs(item - value) <= 0.6);
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
