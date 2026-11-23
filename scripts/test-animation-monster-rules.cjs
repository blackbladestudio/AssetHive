const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const ts = require('typescript');
const THREE = require('three');
const { Buffer } = require('node:buffer');
const { TextEncoder } = require('node:util');
const source = path.join(__dirname, '../src/ui/animationMonsterRules.ts');
const compiled = ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
const exportsShim = {};
new Function('exports', 'require', compiled)(exportsShim, createRequire(source));
const { readFbxUpAxis, readFbxUnitScale, sampleMonsterRoot, analyzeMonsterTrajectory, evaluateMonsterRules, fitMonsterRamp, findMonsterLoop } = exportsShim;
const rules = require('../shared/animation-import-rules.json').monsterLoco;

test('tag snapshot includes all 34 leaves without Hive grade settings', () => {
  assert.equal(rules.tags.length, 34);
  assert.equal(rules.grades, undefined);
  assert.equal(new Set(rules.tags).size, 34);
});

test('FBX axis reads ASCII and safely rejects absent/malformed settings', () => {
  const buffer = text => new TextEncoder().encode(text).buffer;
  assert.equal(readFbxUpAxis(buffer('P: "UpAxis", "int", "Integer", "",2')), 2);
  assert.equal(readFbxUpAxis(buffer('P: "UpAxis", "int", "Integer", "",1')), 1);
  assert.equal(readFbxUpAxis(buffer('')), null);
  assert.equal(readFbxUpAxis(buffer('Kaydara FBX Binary')), null);
  assert.equal(readFbxUnitScale(buffer('P: "UnitScaleFactor", "double", "Number", "",100')), 100);
  assert.equal(readFbxUpAxis(buffer('P: "UpAxis", "int", "Integer", "",4')), null);
});

function binaryAxis(version, axis) {
  const wide = version >= 7500, size = wide ? 8 : 4;
  const integer = n => { const b = Buffer.alloc(size); if (wide) b.writeBigUInt64LE(BigInt(n)); else b.writeUInt32LE(n); return b; };
  const string = s => { const b = Buffer.from(s); const length = Buffer.alloc(4); length.writeUInt32LE(b.length); return Buffer.concat([Buffer.from('S'), length, b]); };
  const value = Buffer.alloc(5); value[0] = 73; value.writeInt32LE(axis, 1);
  const props = Buffer.concat([string('UpAxis'), string('int'), string('Integer'), string(''), value]);
  const node = (name, offset, properties, count, child) => {
    const nameBytes = Buffer.from(name), start = offset + size * 3 + 1 + nameBytes.length + properties.length;
    const children = child ? child(start) : Buffer.alloc(0);
    const end = start + children.length + (child ? size * 3 + 1 : 0);
    return Buffer.concat([integer(end), integer(count), integer(properties.length), Buffer.from([nameBytes.length]), nameBytes, properties, children, ...(child ? [Buffer.alloc(size * 3 + 1)] : [])]);
  };
  const header = Buffer.alloc(27); header.write('Kaydara FBX Binary  \0\x1a\0', 'binary'); header.writeUInt32LE(version, 23);
  const data = Buffer.concat([header, node('GlobalSettings', 27, Buffer.alloc(0), 0, start => node('Properties70', start, Buffer.alloc(0), 0, start2 => node('P', start2, props, 5))), Buffer.alloc(size * 3 + 1)]);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

test('FBX binary GlobalSettings supports 32 and 64-bit node headers', () => {
  assert.equal(readFbxUpAxis(binaryAxis(7400, 2)), 2);
  assert.equal(readFbxUpAxis(binaryAxis(7500, 1)), 1);
});

function trajectory(distance, sideways = () => 0, height = () => 0) {
  const times = Array.from({ length: 241 }, (_, i) => i / 120);
  return analyzeMonsterTrajectory(times.map(t => [distance(t), sideways(t)]), times.map(height), 1 / 120);
}

test('uniform diagonal motion uses trajectory axis; stationary root cannot pass speed', () => {
  const diagonal = trajectory(t => t * 100, t => t * 100);
  assert.ok(Math.abs(diagonal.meanSpeed - Math.sqrt(2) * 100) < 1e-6);
  assert.ok(diagonal.lateralCm < 1e-6);
  assert.ok(diagonal.speedDeviation < 1e-6);
  assert.equal(trajectory(() => 0).meanSpeed, null);
  assert.equal(trajectory(t => t * .1).meanSpeed, null);
});

test('loop windows expose speed surges, PCA exposes side drift and vertical motion', () => {
  assert.ok(trajectory(t => t * 100 + 20 * Math.sin(2 * Math.PI * t)).speedDeviation > .1);
  const data = trajectory(t => t * 100, t => 3 * Math.sin(Math.PI * t), t => t);
  assert.ok(data.lateralCm > 1);
  assert.equal(data.verticalCm, 2);
});

function rootFixture() {
  const object = new THREE.Group(); object.scale.setScalar(.01); object.rotation.y = 1;
  const root = new THREE.Bone(); root.name = 'root'; object.add(root);
  const pelvis = new THREE.Bone(); pelvis.name = 'pelvis'; root.add(pelvis);
  return { object, root, pelvis };
}

test('sampling uses root local cm and exact final frame, ignores preview transforms', () => {
  const { object } = rootFixture();
  const clip = new THREE.AnimationClip('walk', 2, [new THREE.VectorKeyframeTrack('root.position', [0, 1, 2], [0, 0, 0, 100, 0, 0, 200, 0, 0])]);
  const data = sampleMonsterRoot(object, clip, 1, 2);
  assert.ok(Math.abs(data.distanceCm - 200) < 1e-6);
  assert.ok(Math.abs(data.meanSpeed - 100) < 1e-5);
  assert.ok(data.speedDeviation < 1e-4);
  assert.equal(sampleMonsterRoot(object, clip, 1, null).distanceCm, null);
});

test('pelvis travel does not substitute for static root; rotations use relative first frame', () => {
  const { object } = rootFixture();
  const q = angle => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle).toArray();
  const clip = new THREE.AnimationClip('walk', 2, [
    new THREE.VectorKeyframeTrack('pelvis.position', [0, 1, 2], [0, 0, 0, 100, 0, 0, 200, 0, 0]),
    new THREE.QuaternionKeyframeTrack('root.quaternion', [0, 1, 2], [...q(.5), ...q(.5), ...q(.5 + Math.PI / 180)])
  ]);
  const data = sampleMonsterRoot(object, clip, 1, 2);
  assert.equal(data.distanceCm, 0);
  assert.equal(data.meanSpeed, null);
  assert.ok(Math.abs(data.rotationDeg - 1) < 1e-4);
});

test('animation-only FBX Group root is recognized without mistaking pelvis as root', () => {
  const object = new THREE.Group(); object.name = 'root';
  const pelvis = new THREE.Group(); pelvis.name = 'pelvis'; object.add(pelvis);
  const clip = new THREE.AnimationClip('walk', 2, [new THREE.VectorKeyframeTrack('root.position', [0, 1, 2], [0, 0, 0, 0, 0, 1, 0, 0, 2])]);
  assert.ok(Math.abs(sampleMonsterRoot(object, clip, 100, 1).distanceCm - 200) < 1e-6);
  object.name = 'pelvis'; clip.tracks[0].name = 'pelvis.position';
  assert.equal(sampleMonsterRoot(object, clip, 100, 1).error, 'root');
});

test('strict suffix detects incorrect case, maps Patrol and transition names', () => {
  const checks = name => evaluateMonsterRules(name, null);
  assert.equal(checks('AS_Executor_idle_walk')[0].status, 'fail');
  assert.equal(checks('AS_Executor_Idle_Walk')[0].status, 'ok');
  assert.equal(checks('AS_Executor_Alert_To_Idle')[0].status, 'ok');
  assert.equal(checks('AS_Executor_AlertToIdle')[0].status, 'fail');
  assert.equal(checks('AS_Executor_Alert_Run')[0].status, 'warn');
});

test('starts and stops are always checked; unavailable data never passes', () => {
  const checks = evaluateMonsterRules('AS_Executor_Idle_Walk_Stop', null);
  for (const id of ['rotation', 'direction', 'ramp', 'curve']) assert.equal(checks.find(check => check.id === id).status, 'warn');
  assert.equal(checks.find(check => check.id === 'loop-reference').status, 'skip');
  assert.equal(checks.some(check => check.id === 'template'), false);
  const stationary = { monsterRoot: { rotationDeg: 0, lateralCm: 0, verticalCm: 0, distanceCm: 0, meanSpeed: null, speedDeviation: null } };
  assert.equal(evaluateMonsterRules('AS_Executor_Idle_Walk', stationary).find(check => check.id === 'speed').status, 'fail');
});

function rampFixture(isStop, speed = 100, transient = .6) {
  const distance = Array.from({ length: 241 }, (_, i) => {
    const t = i / 120;
    return speed * (isStop ? t < transient ? t - t * t / (2 * transient) : transient / 2 : t < transient ? t * t / (2 * transient) : t - transient / 2);
  });
  return { distance, dt: 1 / 120, sourceDt: 1 / 60 };
}

function rampStats(track) {
  const metrics = analyzeMonsterTrajectory(track.distance.map(d => [d, 0]), track.distance.map(() => 0), track.dt);
  return { monsterRoot: { ...metrics, rotationDeg: 0, distanceTrack: track } };
}

test('own acceleration and deceleration can pass without a loop, without claiming continuity', () => {
  for (const stop of [false, true]) {
    const track = rampFixture(stop);
    const fit = fitMonsterRamp(track, stop);
    assert.equal(fit.ok, true);
    assert.ok(Math.abs(fit.referenceSpeed - 100) < 1e-6);
    const checks = evaluateMonsterRules(`AS_Executor_Alert_Walk_${stop ? 'Stop' : 'Start'}`, rampStats(track), { error: 'missing', name: 'AS_Executor_Alert_Walk' });
    assert.equal(checks.find(check => check.id === 'ramp').status, 'ok');
    assert.equal(checks.find(check => check.id === 'loop-reference').status, 'skip');
    assert.match(checks.find(check => check.id === 'ramp').zh, /整体速度：应为匀/);
    if (stop) assert.equal(checks.some(check => check.id === 'stop-speed'), false);
  }
});

test('fixed loop speed detects incompatible ramps and stop entry speed', () => {
  const reference = { stats: { monsterRoot: { meanSpeed: 100, speedDeviation: 0 } }, name: 'AS_Executor_Alert_Walk' };
  for (const stop of [false, true]) {
    const good = evaluateMonsterRules(`AS_Executor_Alert_Walk_${stop ? 'Stop' : 'Start'}`, rampStats(rampFixture(stop)), reference);
    assert.equal(good.find(check => check.id === 'ramp').status, 'ok');
    assert.match(good.find(check => check.id === 'ramp').zh, /整体速度：应为匀/);
    const bad = evaluateMonsterRules(`AS_Executor_Alert_Walk_${stop ? 'Stop' : 'Start'}`, rampStats(rampFixture(stop, 200)), reference);
    assert.equal(bad.find(check => check.id === 'ramp').status, 'fail');
    if (stop) {
      assert.equal(good.find(check => check.id === 'stop-speed').status, 'ok');
      assert.equal(bad.find(check => check.id === 'stop-speed').status, 'fail');
    }
  }
});

test('constant speed, nonlinear speed and jumps cannot masquerade as self ramps', () => {
  const cases = [t => t * 100, t => t ** 3 * 10, t => t < .8 ? 0 : 100];
  for (const position of cases) {
    const track = { distance: Array.from({ length: 241 }, (_, i) => position(i / 120)), dt: 1 / 120, sourceDt: 1 / 60 };
    for (const stop of [false, true]) assert.equal(fitMonsterRamp(track, stop)?.ok || false, false);
  }
  assert.equal(fitMonsterRamp({ ...rampFixture(false), sourceDt: null }, false), null);
});

test('stationary start or stop fails; unknown loop data still allows an independent check', () => {
  const stationary = rampStats({ distance: Array(241).fill(0), dt: 1 / 120, sourceDt: 1 / 60 });
  assert.equal(evaluateMonsterRules('AS_Executor_Alert_Walk_Start', stationary).find(check => check.id === 'ramp').status, 'fail');
  const own = evaluateMonsterRules('AS_Executor_Alert_Walk_Start', rampStats(rampFixture(false)), { stats: { monsterRoot: { meanSpeed: null, error: 'root' } } });
  assert.equal(own.find(check => check.id === 'ramp').status, 'ok');
  assert.equal(own.find(check => check.id === 'loop-reference').status, 'skip');
  const short = rampStats({ distance: Array.from({ length: 16 }, (_, i) => i * 2), dt: .05 / 15, sourceDt: 1 / 60 });
  assert.equal(evaluateMonsterRules('AS_Executor_Alert_Walk_Start', short).find(check => check.id === 'ramp').status, 'fail');
});

test('Stand checks full 3D excursion rather than only the final frame', () => {
  const { object } = rootFixture();
  const checks = values => {
    const clip = new THREE.AnimationClip('stand', 2, [new THREE.VectorKeyframeTrack('root.position', [0, 1, 2], values)]);
    const data = sampleMonsterRoot(object, clip, 1, null, 60);
    return evaluateMonsterRules('AS_Executor_Idle_Stand', { monsterRoot: data }).find(check => check.id === 'stand');
  };
  assert.equal(checks([5, 5, 5, 5, 5, 5, 5, 5, 5]).status, 'ok');
  assert.equal(checks([0, 0, 0, 0, 0, .5, 0, 0, 0]).status, 'fail');
  assert.equal(checks([0, 0, 0, 0, .5, 0, 0, 0, 0]).status, 'fail');
  assert.equal(evaluateMonsterRules('AS_Executor_Stand', { monsterRoot: { maxDisplacementCm: 10 } }).find(check => check.id === 'stand').status, 'fail');
  assert.equal(evaluateMonsterRules('AS_Executor_Idle_Stand', null).find(check => check.id === 'stand').status, 'warn');
});

test('paired loop stays in the same archive folder and exact motion family', () => {
  const file = 'Z:\\Animation\\Monster\\Executor\\Locomotion\\AS_Executor_Alert_Walk_Start.fbx';
  const loop = file.replace('_Start', '');
  const record = (path, id = 'loop') => ({ id, assetType: 'animation', name: 'AS_Executor_Alert_Walk', modelFiles: [path], meta: { updatedAt: '2026-11-20' } });
  assert.equal(findMonsterLoop(file, [record(loop)]).filePath, loop);
  assert.equal(findMonsterLoop(file, [record(loop.replace('Executor\\Locomotion', 'Other\\Locomotion'))]).error, 'missing');
  assert.equal(findMonsterLoop(file, [record(loop.replace('Alert_Walk', 'Battle_Walk'))]).error, 'missing');
  assert.equal(findMonsterLoop(file, [record(loop), { ...record(loop, 'conflict'), meta: { updatedAt: '2026-11-21' } }]).error, 'ambiguous');
});

test('whole-loop check catches fast oscillation hidden by a 0.2 second average', () => {
  const data = trajectory(t => t * 100 + 1 * Math.sin(20 * Math.PI * t));
  assert.ok(data.speedDeviation > .1);
  assert.equal(evaluateMonsterRules('AS_Executor_Alert_Walk', { monsterRoot: { ...data, rotationDeg: 0 } }).find(row => row.id === 'speed').status, 'fail');
});
