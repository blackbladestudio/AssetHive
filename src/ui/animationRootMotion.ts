import * as THREE from "three";

export type RootMotionSample = { time: number; position: [number, number, number]; displacement: number; speed: number };
export type RootMotionAnalysis = { duration: number; boneName: string; samples: RootMotionSample[]; distance: number; maxDisplacement: number; maxSpeed: number };

export function findRootMotionBone(visual: THREE.Object3D, clip: THREE.AnimationClip) {
  const bones: THREE.Bone[] = [];
  visual.traverse(node => { if ((node as THREE.Bone).isBone) bones.push(node as THREE.Bone); });
  const depth = (bone: THREE.Bone) => { let value = 0; for (let node = bone.parent; node; node = node.parent) value++; return value; };
  bones.sort((a, b) => depth(a) - depth(b));
  // Do not substitute pelvis travel for root motion on rigs with a static root.
  const root = bones.find(bone => /^root$/i.test(bone.name)) || bones[0];
  return root && clip.tracks.some(track => track.name === `${root.name}.position`) ? root : null;
}

export function analyzeRootMotion(mixer: THREE.AnimationMixer, action: THREE.AnimationAction, root: THREE.Object3D, visual: THREE.Object3D): RootMotionAnalysis {
  const duration = action.getClip().duration;
  const count = Math.max(1, Math.min(3600, Math.ceil(duration * 60)));
  const samples: RootMotionSample[] = [];
  const loop = action.loop, repetitions = action.repetitions, clamp = action.clampWhenFinished;
  const origin = new THREE.Vector3();
  let distance = 0;
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.reset().play();
  try {
    for (let i = 0; i <= count; i++) {
      const time = duration * i / count;
      mixer.setTime(time);
      visual.updateMatrixWorld(true);
      const point = root.getWorldPosition(new THREE.Vector3());
      if (i === 0) origin.copy(point);
      point.sub(origin);
      if (point.lengthSq() < 1e-18) point.set(0, 0, 0);
      const previous = samples[i - 1];
      const rawStep = previous ? point.distanceTo(new THREE.Vector3(...previous.position)) : 0;
      const step = rawStep < 1e-9 ? 0 : rawStep;
      distance += step;
      samples.push({ time, position: point.toArray() as [number, number, number], displacement: point.length(), speed: previous && time > previous.time ? step / (time - previous.time) : 0 });
    }
    if (samples.length > 1) samples[0].speed = samples[1].speed;
  } finally {
    action.setLoop(loop, repetitions);
    action.clampWhenFinished = clamp;
    action.reset().play();
    mixer.setTime(0);
    visual.updateMatrixWorld(true);
  }
  return { duration, boneName: root.name, samples, distance, maxDisplacement: Math.max(...samples.map(sample => sample.displacement)), maxSpeed: Math.max(...samples.map(sample => sample.speed)) };
}

export function rootMotionAt(analysis: RootMotionAnalysis, time: number) {
  const samples = analysis.samples;
  const value = Math.max(0, Math.min(analysis.duration, time));
  const fraction = analysis.duration > 0 ? value / analysis.duration * (samples.length - 1) : 0;
  const left = samples[Math.floor(fraction)], right = samples[Math.min(samples.length - 1, Math.ceil(fraction))];
  const alpha = fraction - Math.floor(fraction);
  return { time: value, displacement: THREE.MathUtils.lerp(left.displacement, right.displacement, alpha), speed: THREE.MathUtils.lerp(left.speed, right.speed, alpha) };
}
