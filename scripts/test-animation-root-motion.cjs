const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const THREE = require("three");
const moduleShim = { exports: {} };
const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/ui/animationRootMotion.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;
new Function("exports", "require", compiled)(moduleShim.exports, require);
const { findRootMotionBone, analyzeRootMotion, rootMotionAt } = moduleShim.exports;

function fixture({ values = [0, 0, 0, 100, 0, 0, 200, 0, 0], rotate = false, rootTrack = true } = {}) {
  const visual = new THREE.Group();
  visual.scale.setScalar(.01);
  if (rotate) visual.rotation.y = Math.PI / 2;
  const root = new THREE.Bone(); root.name = "root";
  const pelvis = new THREE.Bone(); pelvis.name = "pelvis";
  visual.add(root); root.add(pelvis);
  const clip = new THREE.AnimationClip("Motion", 2, [new THREE.VectorKeyframeTrack(`${rootTrack ? "root" : "pelvis"}.position`, [0, 1, 2], values)]);
  const mixer = new THREE.AnimationMixer(visual);
  const action = mixer.clipAction(clip).play();
  return { visual, root, clip, mixer, action };
}

test("root analysis uses displayed metre units, rotation, and exact last frame without loop wrap", () => {
  const f = fixture({ rotate: true });
  assert.equal(findRootMotionBone(f.visual, f.clip), f.root);
  const data = analyzeRootMotion(f.mixer, f.action, f.root, f.visual);
  assert.ok(Math.abs(data.distance - 2) < 1e-6);
  assert.ok(Math.abs(data.samples.at(-1).position[2] + 2) < 1e-6);
  assert.ok(Math.abs(data.maxSpeed - 1) < 1e-5);
  assert.ok(Math.abs(rootMotionAt(data, 1.5).displacement - 1.5) < 1e-5);
  assert.equal(f.action.loop, THREE.LoopRepeat);
  assert.equal(f.action.paused, false);
  assert.equal(f.action.time, 0);
});

test("returning root separates cumulative travel from displacement and has no loop speed spike", () => {
  const f = fixture({ values: [0, 0, 0, 100, 0, 0, 0, 0, 0] });
  const data = analyzeRootMotion(f.mixer, f.action, f.root, f.visual);
  assert.ok(Math.abs(data.distance - 2) < 1e-5);
  assert.equal(data.samples.at(-1).displacement, 0);
  assert.ok(data.maxSpeed < 1.0001);
  assert.equal(rootMotionAt(data, 99).time, 2);
});

test("pelvis motion never substitutes for an untracked root", () => {
  const f = fixture({ rootTrack: false });
  assert.equal(findRootMotionBone(f.visual, f.clip), null);
});

test("stationary root yields zero speed and displacement", () => {
  const f = fixture({ values: [20, 3, 0, 20, 3, 0, 20, 3, 0] });
  const data = analyzeRootMotion(f.mixer, f.action, f.root, f.visual);
  assert.ok(data.maxSpeed < 1e-10);
  assert.ok(data.maxDisplacement < 1e-10);
});
