const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const ts = require('typescript');
const THREE = require('three');
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  let source = fs.readFileSync(file, 'utf8');
  if (file.endsWith('animationFbxStats.ts')) source += '\nexport { countClipSteps };';
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const native = createRequire(file);
  new Function('exports', 'require', compiled)(exports, id => id === './previewUrl' ? { getPreviewUrl: value => value } : id.startsWith('./') ? load(path.resolve(path.dirname(file), id + '.ts')) : native(id));
  return exports;
}
const { countClipSteps } = load(path.resolve(__dirname, '../src/ui/animationFbxStats.ts'));

function fixture(upAxis, cycles = 2) {
  const object = new THREE.Group();
  const root = new THREE.Bone(); root.name = 'root'; object.add(root);
  const times = Array.from({ length: 121 }, (_, i) => i / 60);
  const tracks = ['ball_l', 'ball_r', 'ik_foot_l', 'ik_foot_r'].map(name => {
    const bone = new THREE.Bone(); bone.name = name; root.add(bone);
    const values = times.flatMap(time => {
      const coord = [0, 0, 0];
      coord[upAxis] = name.startsWith('ik_') ? 8 : 10 * (1 - Math.cos(2 * Math.PI * (cycles * time / 2 + (name.endsWith('_r') ? .5 : 0))));
      coord[(upAxis + 1) % 3] = 300 * time;
      return coord;
    });
    return new THREE.VectorKeyframeTrack(`${name}.position`, times, values);
  });
  return { object, clip: new THREE.AnimationClip('RunF', 2, tracks) };
}

test('world foot plants use the FBX up axis and exclude horizontal root travel for all three axes', () => {
  for (const upAxis of [0, 1, 2]) {
    const { object, clip } = fixture(upAxis);
    assert.equal(countClipSteps(object, clip, 1, null, upAxis), 4, `up axis ${upAxis}`);
  }
});
test('a genuine two-step cycle is not multiplied into four steps', () => {
  const { object, clip } = fixture(2, 1);
  assert.equal(countClipSteps(object, clip, 1, null, 2), 2);
});

test('unknown or invalid vertical axes do not produce a guessed step result', () => {
  const { object, clip } = fixture(2);
  for (const axis of [null, -1, 3]) assert.equal(countClipSteps(object, clip, 1, null, axis), null);
});
