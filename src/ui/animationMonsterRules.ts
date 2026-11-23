import * as THREE from 'three';
import rules from '../../shared/animation-import-rules.json';
import type { AnimationFbxStats, AnimationRuleStatus } from './animationRules';
import type { AssetRecord } from '../types';

const spec = rules.monsterLoco;
export type MonsterRuleCheck = { id: string; status: AnimationRuleStatus; zh: string; en: string };

// Read only GlobalSettings scalar properties; skip geometry/array payloads by node offsets.
export function readFbxUpAxis(buffer: ArrayBuffer): number | null {
  const value = readFbxGlobalScalar(buffer, 'UpAxis');
  return value !== null && [0, 1, 2].includes(value) ? value : null;
}

export function readFbxUnitScale(buffer: ArrayBuffer): number | null {
  const value = readFbxGlobalScalar(buffer, 'UnitScaleFactor');
  return value !== null && value > 0 ? value : null;
}

function readFbxGlobalScalar(buffer: ArrayBuffer, property: 'UpAxis' | 'UnitScaleFactor'): number | null {
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();
  if (!decoder.decode(bytes.subarray(0, 18)).startsWith('Kaydara FBX Binary')) {
    const value = decoder.decode(bytes).match(new RegExp(`P:\\s*"${property}"\\s*,\\s*"(?:int|double)"\\s*,\\s*"(?:Integer|Number)"\\s*,\\s*""\\s*,\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`));
    return value ? Number(value[1]) : null;
  }
  try {
    const view = new DataView(buffer);
    const wide = view.getUint32(23, true) >= 7500;
    const size = wide ? 8 : 4;
    const number = (offset: number) => wide ? Number(view.getBigUint64(offset, true)) : view.getUint32(offset, true);
    const visit = (start: number, limit: number, inSettings = false): number | null => {
      for (let offset = start; offset + size * 3 + 1 <= limit;) {
        const end = number(offset);
        if (!end) break;
        if (end <= offset || end > limit) return null;
        const count = number(offset + size);
        const propertyBytes = number(offset + size * 2);
        const nameLength = view.getUint8(offset + size * 3);
        const nameStart = offset + size * 3 + 1;
        const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
        let cursor = nameStart + nameLength;
        const childStart = cursor + propertyBytes;
        if (childStart > end) return null;
        if (inSettings && name === 'P') {
          const values: Array<string | number> = [];
          for (let i = 0; i < count && cursor < childStart; i++) {
            const type = String.fromCharCode(view.getUint8(cursor++));
            if (type === 'S') {
              const length = view.getUint32(cursor, true); cursor += 4;
              if (cursor + length > childStart) return null;
              values.push(decoder.decode(bytes.subarray(cursor, cursor + length))); cursor += length;
            } else if (type === 'I') { values.push(view.getInt32(cursor, true)); cursor += 4; }
            else if (type === 'D') { values.push(view.getFloat64(cursor, true)); cursor += 8; }
            else break;
          }
          if (values[0] === property && typeof values[4] === 'number' && Number.isFinite(values[4])) return values[4];
        }
        if (name === 'GlobalSettings' || (inSettings && name === 'Properties70')) {
          const found = visit(childStart, end, true);
          if (found !== null) return found;
        }
        offset = end;
      }
      return null;
    };
    return visit(27, bytes.length);
  } catch { return null; }
}

// Source-bone local transforms match the project's EvaluateBoneTrackTransform contract.
// A preview mesh, scene scale, pelvis fallback, or loop wrap must not alter rule results.
export function sampleMonsterRoot(object: THREE.Object3D, clip: THREE.AnimationClip, cmPerUnit: number, upAxis: number | null, frameRate: number | null = null): NonNullable<AnimationFbxStats['monsterRoot']> {
  const empty = { rotationDeg: 0, lateralCm: null, verticalCm: null, distanceCm: null, meanSpeed: null, speedDeviation: null, maxDisplacementCm: null, distanceTrack: null };
  const roots: THREE.Object3D[] = [];
  object.traverse(node => {
    if (!(node as THREE.Bone).isBone) return;
    for (let parent = node.parent; parent; parent = parent.parent) if ((parent as THREE.Bone).isBone) return;
    roots.push(node);
  });
  // Animation-only FBX often exports joints as Null/Group nodes instead of Bone.
  // Accept only an unambiguous explicit root with its own track, never a pelvis fallback.
  if (!roots.length) object.traverse(node => {
    if (/^root$/i.test(node.name) && clip.tracks.some(track => track.name === `${node.name}.position` || track.name === `${node.name}.quaternion`)) roots.push(node);
  });
  if (roots.length !== 1) return { ...empty, error: 'root' };
  const root = roots[0];
  const position = clip.tracks.find(track => track.name === `${root.name}.position`);
  const rotation = clip.tracks.find(track => track.name === `${root.name}.quaternion`);
  if ((position && (position.getValueSize() !== 3 || Array.from(position.values).some(v => !Number.isFinite(v)))) || (rotation && (rotation.getValueSize() !== 4 || Array.from(rotation.values).some(v => !Number.isFinite(v))))) return { ...empty, error: 'keys' };
  const keys = Math.max(...clip.tracks.map(track => track.times.length), 0);
  if (keys < spec.minSourceKeys || !Number.isFinite(clip.duration) || clip.duration <= 0) return { ...empty, error: 'keys' };
  const count = Math.min(spec.maxResampleCount, Math.max(keys, spec.minResampleCount, Math.ceil(clip.duration * spec.resampleHz) + 1));
  const dt = clip.duration / (count - 1);
  const pi = position ? new THREE.LinearInterpolant(position.times, position.values, 3) : null;
  const qi = rotation ? new THREE.QuaternionLinearInterpolant(rotation.times, rotation.values, 4) : null;
  const first = new THREE.Quaternion();
  const horizontal = [0, 1, 2].filter(axis => axis !== upAxis);
  const points: Array<[number, number]> = [];
  const heights: number[] = [];
  let rotationDeg = 0;
  let origin: number[] = [];
  let maxDisplacementCm = 0;
  for (let i = 0; i < count; i++) {
    const time = clip.duration * i / (count - 1);
    const quaternion = qi ? new THREE.Quaternion().fromArray(qi.evaluate(time)).normalize() : root.quaternion;
    if (!i) first.copy(quaternion);
    rotationDeg = Math.max(rotationDeg, first.angleTo(quaternion) * 180 / Math.PI);
    const value = pi ? pi.evaluate(time) : root.position.toArray();
    if (!i) origin = Array.from(value);
    maxDisplacementCm = Math.max(maxDisplacementCm, Math.hypot(value[0] - origin[0], value[1] - origin[1], value[2] - origin[2]) * cmPerUnit);
    if (upAxis !== null) {
      points.push([value[horizontal[0]] * cmPerUnit, value[horizontal[1]] * cmPerUnit]);
      heights.push(value[upAxis] * cmPerUnit);
    }
  }
  if (upAxis === null) return { ...empty, rotationDeg, maxDisplacementCm };
  const metrics = analyzeMonsterTrajectory(points, heights, dt);
  if (metrics.distanceTrack) metrics.distanceTrack.sourceDt = frameRate && Number.isFinite(frameRate) && frameRate > 0 ? 1 / frameRate : null;
  return { ...metrics, rotationDeg, maxDisplacementCm };
}

export function analyzeMonsterTrajectory(points: Array<[number, number]>, heights: number[], dt: number) {
  const invalid = { lateralCm: null, verticalCm: null, distanceCm: null, meanSpeed: null, speedDeviation: null, distanceTrack: null };
  if (points.length < 3 || heights.length !== points.length || dt <= 0 || !Number.isFinite(dt) || points.some(p => p.some(v => !Number.isFinite(v))) || heights.some(v => !Number.isFinite(v))) return invalid;
  const n = points.length;
  const mean = points.reduce((sum, p) => [sum[0] + p[0] / n, sum[1] + p[1] / n], [0, 0]);
  let xx = 0, xy = 0, yy = 0;
  for (const p of points) { const x = p[0] - mean[0], y = p[1] - mean[1]; xx += x * x; xy += x * y; yy += y * y; }
  const delta = Math.hypot(xx - yy, 2 * xy), l1 = (xx + yy + delta) / 2, l2 = (xx + yy - delta) / 2;
  let axis = Math.abs(xy) > 1e-12 ? [l1 - yy, xy] : xx >= yy ? [1, 0] : [0, 1];
  const length = Math.hypot(...axis); axis = axis.map(v => v / length);
  const net = [points[n - 1][0] - points[0][0], points[n - 1][1] - points[0][1]];
  if (net[0] * axis[0] + net[1] * axis[1] < 0) axis = axis.map(v => -v);
  const lateralCm = Math.max(...points.map(p => Math.abs((p[0] - mean[0]) * axis[1] - (p[1] - mean[1]) * axis[0])));
  const verticalCm = Math.max(...heights.map(v => Math.abs(v - heights[0])));
  const straight = l1 > 1e-12 && 1 - l2 / l1 >= spec.straightnessThreshold;
  const distance = [0];
  for (let i = 1; i < n; i++) distance.push(straight ? (points[i][0] - points[0][0]) * axis[0] + (points[i][1] - points[0][1]) * axis[1] : distance[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  const distanceCm = Math.max(...distance) - Math.min(...distance);
  const distanceTrack = { distance, dt, sourceDt: null as number | null };
  if (distanceCm < spec.minTotalDistanceCm) return { lateralCm, verticalCm, distanceCm, meanSpeed: null, speedDeviation: null, distanceTrack };
  let st = 0, sd = 0, stt = 0, std = 0;
  distance.forEach((d, i) => { const t = i * dt; st += t; sd += d; stt += t * t; std += t * d; });
  const speed = (n * std - st * sd) / (n * stt - st * st);
  if (!(speed > 1e-4)) return { lateralCm, verticalCm, distanceCm, meanSpeed: null, speedDeviation: null, distanceTrack };
  // Check every sampled interval across the full clip, including its endpoints.
  const window = 1;
  let deviation = 0;
  for (let i = 0; i + window < n; i++) deviation = Math.max(deviation, Math.abs((distance[i + window] - distance[i]) / (window * dt) - speed) / speed);
  return { lateralCm, verticalCm, distanceCm, meanSpeed: speed, speedDeviation: deviation, distanceTrack };
}

export function animationRulesRevision(asset: AssetRecord) {
  return `${asset.animationContentFingerprint || (asset.meta.identity as { contentFingerprint?: string })?.contentFingerprint || ''}|${asset.meta.updatedAt || ''}`;
}

export function findMonsterLoop(filePath: string, assets: AssetRecord[]) {
  const normalize = (value: string) => value.replaceAll('\\', '/').toLowerCase();
  const paired = filePath.replace(/_(Start|Stop)(\.fbx)$/i, '$2');
  const name = paired.replaceAll('\\', '/').split('/').at(-1)?.replace(/\.fbx$/i, '') || '';
  if (paired === filePath) return { name, filePath: '', revision: '', error: undefined };
  const matches = assets.filter(asset => String(asset.assetType || '').trim().toLowerCase() === 'animation' && (asset.modelFiles || []).some(file => normalize(file) === normalize(paired)));
  const versions = new Set(matches.map(animationRulesRevision));
  if (!matches.length) return { name, filePath: '', revision: '', error: 'missing' as const };
  if (versions.size > 1) return { name, filePath: '', revision: '', error: 'ambiguous' as const };
  const asset = matches[0];
  return { name, filePath: asset.modelFiles.find(file => normalize(file) === normalize(paired))!, revision: animationRulesRevision(asset), error: undefined };
}

export type MonsterDistanceTrack = { distance: number[]; dt: number; sourceDt: number | null };

// Fixed loop speed follows ZionMonsterLocoChecker. With no loop, fit speed too,
// so the selected clip's own ramp can be checked without claiming speed continuity.
export function fitMonsterRamp(track: MonsterDistanceTrack, isStop: boolean, loopSpeed: number | null = null) {
  const { distance, dt, sourceDt } = track;
  const n = distance.length;
  if (n < 4 || !Number.isFinite(dt) || dt <= 0 || sourceDt === null || !Number.isFinite(sourceDt) || sourceDt <= 0 || distance.some(v => !Number.isFinite(v)) || (loopSpeed !== null && (!Number.isFinite(loopSpeed) || loopSpeed <= 1e-4))) return null;
  const shape = (time: number, transient: number) => isStop ? time < transient ? time - time * time / (2 * transient) : transient / 2 : time < transient ? time * time / (2 * transient) : time - transient / 2;
  const d = distance.map(value => value - distance[0]);
  const minIndex = Math.max(3, Math.ceil(spec.rampMinTransientSeconds / dt));
  let bestError = Infinity, bestTime = 0, bestSpeed = 0;
  const sdd = d.reduce((sum, value) => sum + value * value, 0);
  for (let index = minIndex; index < n; index++) {
    const transient = index * dt;
    let sdg = 0, sgg = 0;
    for (let i = 0; i < n; i++) { const g = shape(i * dt, transient); sdg += d[i] * g; sgg += g * g; }
    const speed = loopSpeed ?? sdg / sgg;
    if (!(speed > 1e-4)) continue;
    const error = Math.max(0, sdd - 2 * speed * sdg + speed * speed * sgg);
    if (error < bestError) { bestError = error; bestTime = transient; bestSpeed = speed; }
  }
  if (!bestTime) return null;
  const distanceDeviation = Math.max(...d.map((value, i) => Math.abs(value - bestSpeed * shape(i * dt, bestTime)))) / Math.max(bestSpeed * bestTime, spec.minTotalDistanceCm);
  const window = Math.min(n - 1, Math.max(1, Math.round(sourceDt / dt)));
  const windowTime = window * dt;
  let speedDeviation = 0;
  for (let i = 0; i + window < n; i++) {
    const measured = (d[i + window] - d[i]) / windowTime;
    const target = bestSpeed * (shape((i + window) * dt, bestTime) - shape(i * dt, bestTime)) / windowTime;
    speedDeviation = Math.max(speedDeviation, Math.abs(measured - target) / bestSpeed);
  }
  const initialSpeed = (d[window] - d[0]) / windowTime;
  return { transientSeconds: bestTime, referenceSpeed: bestSpeed, distanceDeviation, speedDeviation, initialSpeed,
    ok: distanceDeviation <= spec.rampMaxDeviationRatio && speedDeviation <= spec.rampMaxSpeedDeviationRatio };
}

export type MonsterLoopReference = { stats?: AnimationFbxStats | null; name?: string; error?: 'missing' | 'ambiguous' };

export function evaluateMonsterRules(name: string, stats: AnimationFbxStats | null, reference: MonsterLoopReference = {}): MonsterRuleCheck[] {
  const checks: MonsterRuleCheck[] = [];
  const add = (id: string, status: AnimationRuleStatus, zh: string, en: string) => checks.push({ id, status, zh, en });
  const suffix = (tag: string) => tag.startsWith('IdleTransition.') ? tag.slice(15).replace(/To/g, '_To_').replace(/Patrol/g, 'Idle') : tag.replace(/\./g, '_').replace(/^Patrol_/, 'Idle_');
  const tags = spec.tags.map(tag => ({ tag, suffix: suffix(tag) })).sort((a, b) => b.suffix.length - a.suffix.length);
  const match = tags.find(item => name.toLowerCase().replace(/_/g, '').endsWith(item.suffix.toLowerCase().replace(/_/g, '')));
  if (match) add('tag', name.endsWith(`_${match.suffix}`) ? 'ok' : 'fail', `Tag后缀：_${match.suffix}`, `Tag suffix must be _${match.suffix} (case-sensitive)`);
  else add('tag', 'warn', '未匹配项目 MonsterLoco Tag，怪物运动规则待核对', 'No project MonsterLoco tag matched; review locomotion rules');
  const data = stats?.monsterRoot;
  const usable = data && !data.error;
  if (match?.tag.endsWith('.Stand') || /(?:^|_)Stand(?:_|$)/i.test(name)) {
    const displacement = usable ? data.maxDisplacementCm : null;
    const known = displacement != null && Number.isFinite(displacement);
    add('stand', !known ? 'warn' : displacement <= spec.standRootToleranceCm ? 'ok' : 'fail', known ? `Stand Root 最大位移 ${displacement.toFixed(3)} cm，应静止（噪声容差 ${spec.standRootToleranceCm} cm）` : 'Stand Root 静止：无法读取 Root，待核对', known ? `Stand root max displacement ${displacement.toFixed(3)} cm; must stay still (noise tolerance ${spec.standRootToleranceCm} cm)` : 'Stand root: unavailable; review required');
  }
  if (!match) return checks;
  add('rotation', !usable ? 'warn' : data.rotationDeg <= spec.rootRotationToleranceDeg ? 'ok' : 'fail', usable ? `Root旋转：Root偏转${data.rotationDeg.toFixed(2)}°，上限${spec.rootRotationToleranceDeg}°` : 'Root旋转：骨骼或关键帧不足，待核对', usable ? `Root rotation: deviation ${data.rotationDeg.toFixed(2)}°, limit ${spec.rootRotationToleranceDeg}°` : 'Root rotation: missing skeleton or keyframes; review required');
  const moving = !match.tag.endsWith('.Stand') && !match.tag.startsWith('IdleTransition.');
  if (moving) {
    const known = usable && data.lateralCm !== null && data.verticalCm !== null;
    add('direction', !known ? 'warn' : data.lateralCm! <= spec.offAxisToleranceCm && data.verticalCm! <= spec.offAxisToleranceCm ? 'ok' : 'fail', known ? `移动方向：只沿移动方向位移${data.lateralCm! > spec.offAxisToleranceCm || data.verticalCm! > spec.offAxisToleranceCm ? `（侧漂 ${data.lateralCm!.toFixed(2)}cm，竖直 ${data.verticalCm!.toFixed(2)}cm）` : ""}` : '移动方向：无法确认 FBX 坐标轴或 Root，待核对', known ? `Lateral ${data.lateralCm!.toFixed(2)} cm · vertical ${data.verticalCm!.toFixed(2)} cm, limit ${spec.offAxisToleranceCm} cm` : 'Movement direction: FBX axes or root unavailable; review required');
  }
  const loop = spec.tags.includes(`${match.tag}_Start`) || spec.tags.includes(`${match.tag}_Stop`);
  if (loop) {
    const known = usable && data.distanceCm !== null;
    const valid = known && data.meanSpeed !== null && data.speedDeviation !== null;
    add('speed', !known ? 'warn' : valid && data.speedDeviation! <= spec.loopSpeedTolerance ? 'ok' : 'fail', !known ? '循环匀速：未能读取 Root 运动，待核对' : !valid ? '循环匀速：Root 未烘焙或净速度非正' : `整体速度：应为匀速，当前均速 ${data.meanSpeed!.toFixed(1)}cm/s（最大偏差 ${(data.speedDeviation! * 100).toFixed(1)}%）`, !known ? 'Loop speed: root motion unavailable; review required' : !valid ? 'Loop speed: root motion missing or non-positive net speed' : `Loop mean ${data.meanSpeed!.toFixed(1)} cm/s, maximum interval deviation ${(data.speedDeviation! * 100).toFixed(1)}% (≤10%)`);
  }
  if (/_Start$|_Stop$/.test(match.tag)) {
    const stop = /_Stop$/.test(match.tag);
    const labelEn = stop ? 'Stop deceleration' : 'Start acceleration';
    const loopData = reference.stats?.monsterRoot;
    const loopSpeed = loopData && !loopData.error && loopData.meanSpeed != null && Number.isFinite(loopData.meanSpeed) && loopData.meanSpeed > 1e-4 ? loopData.meanSpeed : null;
    const loopKnown = loopSpeed !== null;
    if (loopKnown) add('loop-reference', loopData!.speedDeviation != null && loopData!.speedDeviation <= spec.loopSpeedTolerance ? 'ok' : 'fail', `loop速度：${loopSpeed.toFixed(1)}cm/s，应为匀速`, `Loop speed: ${loopSpeed.toFixed(1)}cm/s; must be uniform`);
    const track = usable ? data.distanceTrack : null;
    const motionMissing = usable && data.distanceCm !== null && data.distanceCm < spec.minTotalDistanceCm;
    const fit = track && !motionMissing ? fitMonsterRamp(track, stop, loopSpeed) : null;
    const canFit = track && track.sourceDt !== null && Number.isFinite(track.sourceDt) && track.sourceDt > 0;
    const speeds = track ? track.distance.slice(1).map((value, i) => (value - track.distance[i]) / track.dt) : [];
    const current = speeds.length ? `${Math.min(...speeds).toFixed(1)}–${Math.max(...speeds).toFixed(1)}cm/s` : '不可读取';
    if (!loopKnown) add('loop-reference', 'skip', reference.error === 'ambiguous' ? '初始速度：loop资源记录冲突，暂不检查' : reference.error === 'missing' || !reference.name ? '初始速度：未找到loop资源，暂不检查' : '初始速度：loop速度不可读取，暂不检查', 'Initial speed: loop unavailable; skipped');
    add('ramp', motionMissing || (!fit && canFit) ? 'fail' : !fit ? 'warn' : fit.ok ? 'ok' : 'fail', `整体速度：应为${stop ? '匀减速' : '匀加速'}，当前速度 ${current}`, `${labelEn}: ${current}${fit ? `; distance deviation ${(fit.distanceDeviation * 100).toFixed(1)}%, speed deviation ${(fit.speedDeviation * 100).toFixed(1)}%` : '; insufficient root samples'}`);
    if (stop) {
      const deviation = fit && loopKnown ? Math.abs(fit.initialSpeed - loopSpeed) / loopSpeed : null;
      if (loopKnown) add('stop-speed', deviation === null ? 'skip' : deviation <= spec.stopSpeedMatchTolerance ? 'ok' : 'fail', deviation === null ? '停步初速度与循环衔接：尚未核验' : `初始速度：${fit!.initialSpeed.toFixed(1)}cm/s，loop ${loopSpeed!.toFixed(1)}cm/s（偏差 ${(deviation * 100).toFixed(1)}%）`, deviation === null ? 'Stop initial speed continuity: not verified' : `Stop initial ${fit!.initialSpeed.toFixed(1)} cm/s · loop ${loopSpeed!.toFixed(1)} cm/s · deviation ${(deviation * 100).toFixed(1)}% (≤${spec.stopSpeedMatchTolerance * 100}%)`);
    }
  }
  if (/_Stop$/.test(match.tag)) add('curve', 'warn', 'Distance 曲线：需在 UE 确认存在且有关键帧', 'Distance curve: confirm presence and keys in UE');
  return checks;
}
