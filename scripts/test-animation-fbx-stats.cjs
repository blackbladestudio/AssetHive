const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "../src/ui/animationFbxAnalyze.ts");
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;
const moduleShim = { exports: {} };
new Function("exports", "module", compiled)(moduleShim.exports, moduleShim);
const {
  FBX_TIME_MODE_FPS,
  readAsciiFbxFrameRate,
  inferFrameRateFromTrackTimes,
  resolveAnimationFrameRate,
  countFootPlants,
  pickBestFootName
} = moduleShim.exports;

test("FBX TimeMode 9 is NTSC 29.97, not PAL 25", () => {
  assert.equal(FBX_TIME_MODE_FPS[3], 60);
  assert.equal(FBX_TIME_MODE_FPS[9], 29.97);
  assert.equal(FBX_TIME_MODE_FPS[10], 25);
  assert.equal(FBX_TIME_MODE_FPS[11], 24);
});

test("ASCII TimeMode 9 is read as 29.97, not 25", () => {
  const ascii = `
    P: "TimeMode", "enum", "", "",9
    P: "CustomFrameRate", "double", "Number", "",-1
  `;
  const parsed = readAsciiFbxFrameRate(ascii);
  assert.equal(parsed.timeModeFps, 29.97);
  assert.equal(parsed.customFps, null);
});

test("animation FPS prefers 60fps keyframes over a 29.97 TimeMode header", () => {
  const times = Float32Array.from({ length: 61 }, (_, index) => index / 60);
  const inferred = inferFrameRateFromTrackTimes([{ times }]);
  assert.equal(inferred, 60);
  const resolved = resolveAnimationFrameRate({
    headerFps: 29.97,
    customFps: null,
    inferredFps: inferred
  });
  assert.equal(resolved.frameRate, 60);
  assert.equal(resolved.source, "keyframes");
});

test("binary-like TimeMode noise is not treated as ASCII 25fps", () => {
  const parsed = readAsciiFbxFrameRate("TimeMode\x00\x00\x00\x09Properties70 25");
  assert.equal(parsed.timeModeFps, null);
});

test("a two-step loop is one plant per foot, not zero", () => {
  const left = walkCycleHeights(48, 0);
  const right = walkCycleHeights(48, 0.5);
  assert.equal(countFootPlants(left), 1);
  assert.equal(countFootPlants(right), 1);
  assert.equal(countFootPlants(left) + countFootPlants(right), 2);
  assert.equal(countFootPlants(new Array(48).fill(5)), 0);
});

test("foot bone names cover UE and Mixamo", () => {
  const names = ["Hips.position", "mixamorigLeftFoot.position", "mixamorigRightFoot.position", "foot_l.position", "ik_foot_r.position"];
  assert.equal(pickBestFootName(names, "left"), "mixamorigLeftFoot.position");
  assert.equal(pickBestFootName(["Root.position", "foot_l.position", "foot_r.position"], "right"), "foot_r.position");
});

function walkCycleHeights(count, phase) {
  return Array.from({ length: count }, (_, index) => {
    const t = (index / count + phase) % 1;
    return (1 - Math.cos(2 * Math.PI * t)) * 10;
  });
}
