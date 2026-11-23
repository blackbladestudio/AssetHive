import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import type { AnimationFbxStats } from "./animationRules";
import {
  countFootPlants,
  inferFrameRateFromTrackTimes,
  isAsciiFbxBuffer,
  pickBestFootName,
  readAsciiFbxFrameRate,
  resolveAnimationFrameRate,
  scoreFootName
} from "./animationFbxAnalyze";
import { getPreviewUrl } from "./previewUrl";
import { readFbxUnitScale, readFbxUpAxis, sampleMonsterRoot } from './animationMonsterRules';

const statsCache = new Map<string, Promise<AnimationFbxStats>>();

export function loadAnimationFbxStats(filePath: string, skeletonPath = "", revision = "") {
  const key = `${String(filePath || "").trim()}|${String(skeletonPath || "").trim()}|${revision}`;
  if (!String(filePath || "").trim()) {
    return Promise.resolve(emptyStats());
  }
  const cached = statsCache.get(key);
  if (cached) {
    return cached;
  }
  const pending = readAnimationFbxStats(filePath, skeletonPath).catch(() => emptyStats());
  statsCache.set(key, pending);
  return pending;
}

function emptyStats(): AnimationFbxStats {
  return {
    frameRate: null,
    frameRateSource: null,
    rootHorizontalRangeCm: null,
    rootTravelCm: null,
    stepCount: null
  };
}

async function readAnimationFbxStats(filePath: string, skeletonPath = ""): Promise<AnimationFbxStats> {
  const buffer = await fetchBuffer(filePath);
  const object = new FBXLoader().parse(buffer, "");
  const clips = object.animations || [];
  const clip = clips[0] || null;
  const unitScale = readFbxUnitScale(buffer) ?? Number(object.userData?.unitScaleFactor);
  const centimetersPerUnit = Number.isFinite(unitScale) && unitScale > 0 ? unitScale : 1;
  const asciiRate = isAsciiFbxBuffer(buffer) ? readAsciiFbxFrameRate(new TextDecoder("latin1").decode(buffer)) : { timeModeFps: null, customFps: null };
  const inferredFps = clip ? inferFrameRateFromTrackTimes(clip.tracks) : null;
  const resolved = resolveAnimationFrameRate({
    headerFps: asciiRate.timeModeFps,
    customFps: asciiRate.customFps,
    inferredFps
  });
  if (!clip) {
    return {
      frameRate: resolved.frameRate,
      frameRateSource: resolved.source,
      rootHorizontalRangeCm: 0,
      rootTravelCm: 0,
      stepCount: null
    };
  }

  const rootSamples = sampleRootWorldOrTrack(object, clip, centimetersPerUnit);
  const monsterRoot = sampleMonsterRoot(object, clip, readFbxUnitScale(buffer) ?? centimetersPerUnit, readFbxUpAxis(buffer), resolved.frameRate);
  const rootHorizontalRangeCm = rootSamples.length
    ? Math.max(
      Math.max(...rootSamples.map((item) => item.x)) - Math.min(...rootSamples.map((item) => item.x)),
      Math.max(...rootSamples.map((item) => item.z)) - Math.min(...rootSamples.map((item) => item.z))
    )
    : 0;
  const rootTravelCm = rootSamples.length
    ? Math.hypot(rootSamples[rootSamples.length - 1].x - rootSamples[0].x, rootSamples[rootSamples.length - 1].z - rootSamples[0].z)
    : 0;

  let skeletonObject: THREE.Group | null = null;
  if (String(skeletonPath || "").trim() && !hasUsableSkeleton(object)) {
    try {
      skeletonObject = new FBXLoader().parse(await fetchBuffer(skeletonPath), "");
    } catch {
      skeletonObject = null;
    }
  }
  const stepCount = countClipSteps(object, clip, centimetersPerUnit, skeletonObject, readFbxUpAxis(buffer));

  return {
    frameRate: resolved.frameRate,
    frameRateSource: resolved.source,
    rootHorizontalRangeCm,
    rootTravelCm,
    stepCount,
    monsterRoot
  };
}

async function fetchBuffer(filePath: string) {
  const response = await fetch(getPreviewUrl(filePath));
  if (!response.ok) {
    throw new Error(`failed to read animation fbx: ${response.status}`);
  }
  return response.arrayBuffer();
}

function hasUsableSkeleton(object: THREE.Object3D) {
  let bones = 0;
  object.traverse((child) => {
    if (isBoneLike(child)) bones += 1;
  });
  return bones >= 8;
}

function countClipSteps(animObject: THREE.Object3D, clip: THREE.AnimationClip, centimetersPerUnit: number, skeletonObject: THREE.Object3D | null, upAxis: number | null) {
  if (upAxis === null || ![0, 1, 2].includes(upAxis)) return null;
  const worlds: Array<{ left: number[]; right: number[] }> = [];
  const fromAnim = sampleFootWorldHeights(animObject, clip, centimetersPerUnit, upAxis);
  if (fromAnim && (fromAnim.left.length || fromAnim.right.length)) worlds.push(fromAnim);
  if (skeletonObject) {
    const fromSkeleton = sampleFootWorldHeights(skeletonObject, clip, centimetersPerUnit, upAxis);
    if (fromSkeleton && (fromSkeleton.left.length || fromSkeleton.right.length)) worlds.push(fromSkeleton);
  }
  const ranked = worlds
    .map((item) => ({
      item,
      range: Math.max(extent(item.left), extent(item.right))
    }))
    .sort((a, b) => b.range - a.range);
  const bestWorld = ranked[0] && ranked[0].range >= 1.5 ? ranked[0].item : null;
  if (bestWorld) {
    const leftSteps = bestWorld.left.length ? countFootPlants(bestWorld.left) : 0;
    const rightSteps = bestWorld.right.length ? countFootPlants(bestWorld.right) : 0;
    if (bestWorld.left.length || bestWorld.right.length) {
      return leftSteps + rightSteps;
    }
  }

  const positionTracks = clip.tracks.filter((track) => track.name.endsWith(".position") && track.getValueSize() === 3);
  const names = positionTracks.map((track) => track.name);
  const leftName = pickBestFootName(names, "left");
  const rightName = pickBestFootName(names, "right");
  const leftTrack = positionTracks.find((track) => track.name === leftName);
  const rightTrack = positionTracks.find((track) => track.name === rightName);
  if (!leftTrack && !rightTrack) return null;
  const leftSteps = leftTrack ? countFootPlants(sampleVerticalTrack(leftTrack, clip.duration, centimetersPerUnit, upAxis)) : 0;
  const rightSteps = rightTrack ? countFootPlants(sampleVerticalTrack(rightTrack, clip.duration, centimetersPerUnit, upAxis)) : 0;
  return leftSteps + rightSteps;
}

function sampleFootWorldHeights(root: THREE.Object3D, clip: THREE.AnimationClip, centimetersPerUnit: number, upAxis: number) {
  const nodes: THREE.Object3D[] = [];
  root.traverse((child) => nodes.push(child));
  const leftCandidates = nodes.filter((node) => scoreFootName(node.name, "left") > 0);
  const rightCandidates = nodes.filter((node) => scoreFootName(node.name, "right") > 0);
  if (leftCandidates.length === 0 && rightCandidates.length === 0) {
    return null;
  }
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.reset().play();
  const left = pickMostMobileFoot(root, mixer, clip, leftCandidates, centimetersPerUnit, upAxis);
  const right = pickMostMobileFoot(root, mixer, clip, rightCandidates, centimetersPerUnit, upAxis);
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  if ((!left || extent(left) < 1.5) && (!right || extent(right) < 1.5)) {
    return null;
  }
  return { left: left || [], right: right || [] };
}

function pickMostMobileFoot(
  root: THREE.Object3D,
  mixer: THREE.AnimationMixer,
  clip: THREE.AnimationClip,
  candidates: THREE.Object3D[],
  centimetersPerUnit: number,
  upAxis: number
) {
  let best: number[] | null = null;
  let bestRange = 0;
  candidates.forEach((node) => {
    const heights = sampleNodeHeights(root, mixer, clip, node, centimetersPerUnit, upAxis);
    const range = extent(heights);
    if (range > bestRange) {
      best = heights;
      bestRange = range;
    }
  });
  return best;
}

function sampleNodeHeights(
  root: THREE.Object3D,
  mixer: THREE.AnimationMixer,
  clip: THREE.AnimationClip,
  node: THREE.Object3D,
  centimetersPerUnit: number,
  upAxis: number
) {
  const sampleCount = Math.min(240, Math.max(36, Math.round(Math.max(clip.duration, 0.2) * 60)));
  const heights: number[] = [];
  const world = new THREE.Vector3();
  for (let index = 0; index < sampleCount; index += 1) {
    mixer.setTime(clip.duration * (index / sampleCount));
    root.updateMatrixWorld(true);
    node.getWorldPosition(world);
    heights.push(world.getComponent(upAxis) * centimetersPerUnit);
  }
  return heights;
}

function sampleRootWorldOrTrack(object: THREE.Object3D, clip: THREE.AnimationClip, centimetersPerUnit: number) {
  const nodes: THREE.Object3D[] = [];
  object.traverse((child) => nodes.push(child));
  const rootNode = nodes.find((node) => /^root$/i.test(node.name))
    || nodes.find((node) => /root/i.test(node.name))
    || nodes.find((node) => /hips|pelvis/i.test(node.name))
    || null;
  if (rootNode && hasUsableSkeleton(object)) {
    const mixer = new THREE.AnimationMixer(object);
    mixer.clipAction(clip).reset().play();
    const samples = sampleNodePositions(object, mixer, clip, rootNode, centimetersPerUnit);
    mixer.stopAllAction();
    mixer.uncacheRoot(object);
    return samples;
  }
  const positionTracks = clip.tracks.filter((track) => track.name.endsWith(".position") && track.getValueSize() === 3);
  const names = positionTracks.map((track) => track.name);
  const rootName = names.find((name) => /^root\.position$/i.test(name))
    || names.find((name) => /root/i.test(name))
    || names.find((name) => /hips|pelvis/i.test(name))
    || names[0];
  const track = positionTracks.find((item) => item.name === rootName);
  return track ? samplePositionTrack(track, clip.duration).map((item) => ({
    x: item.x * centimetersPerUnit,
    y: item.y * centimetersPerUnit,
    z: item.z * centimetersPerUnit
  })) : [];
}

function sampleNodePositions(
  root: THREE.Object3D,
  mixer: THREE.AnimationMixer,
  clip: THREE.AnimationClip,
  node: THREE.Object3D,
  centimetersPerUnit: number
) {
  const sampleCount = Math.min(240, Math.max(24, Math.round(Math.max(clip.duration, 0.1) * 60)));
  const samples: Array<{ x: number; y: number; z: number }> = [];
  const world = new THREE.Vector3();
  for (let index = 0; index <= sampleCount; index += 1) {
    mixer.setTime(clip.duration * (index / sampleCount));
    root.updateMatrixWorld(true);
    node.getWorldPosition(world);
    samples.push({
      x: world.x * centimetersPerUnit,
      y: world.y * centimetersPerUnit,
      z: world.z * centimetersPerUnit
    });
  }
  return samples;
}

function samplePositionTrack(track: THREE.KeyframeTrack, duration: number) {
  const times = track.times;
  const values = track.values;
  const count = Math.min(240, Math.max(24, Math.round(Math.max(duration, 0.1) * 60)));
  const samples: Array<{ x: number; y: number; z: number }> = [];
  for (let index = 0; index <= count; index += 1) {
    const value = sampleVectorAt(times, values, 3, duration * (index / count));
    samples.push({ x: value[0], y: value[1], z: value[2] });
  }
  return samples;
}

function sampleVectorAt(times: ArrayLike<number>, values: ArrayLike<number>, stride: number, time: number) {
  if (times.length === 0) {
    return [0, 0, 0];
  }
  if (time <= times[0]) {
    return [Number(values[0]) || 0, Number(values[1]) || 0, Number(values[2]) || 0];
  }
  const last = times.length - 1;
  if (time >= times[last]) {
    const offset = last * stride;
    return [Number(values[offset]) || 0, Number(values[offset + 1]) || 0, Number(values[offset + 2]) || 0];
  }
  let next = 1;
  while (next < times.length && times[next] < time) next += 1;
  const prev = next - 1;
  const span = times[next] - times[prev] || 1;
  const mix = (time - times[prev]) / span;
  const a = prev * stride;
  const b = next * stride;
  return [0, 1, 2].map((axis) => {
    const start = Number(values[a + axis]) || 0;
    const end = Number(values[b + axis]) || 0;
    return start + (end - start) * mix;
  });
}

function sampleVerticalTrack(track: THREE.KeyframeTrack, duration: number, centimetersPerUnit: number, upAxis: number) {
  const samples = samplePositionTrack(track, duration);
  const axis = (['x', 'y', 'z'] as const)[upAxis];
  return samples.map((item) => item[axis] * centimetersPerUnit);
}

function extent(values: number[]) {
  if (!values.length) return 0;
  return Math.max(...values) - Math.min(...values);
}

function isBoneLike(object: THREE.Object3D) {
  return Boolean((object as THREE.Bone).isBone) || object.type === "Bone";
}
