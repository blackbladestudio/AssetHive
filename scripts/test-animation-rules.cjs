const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "../src/ui/animationRules.ts");
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;
const moduleShim = { exports: {} };
new Function("exports", "module", compiled)(moduleShim.exports, moduleShim);
const {
  getAnimationAssetNameIssue,
  evaluateAnimationImportRules,
  isHeroAnimationPath,
  getLocomotionStepKind
} = moduleShim.exports;

test("AS_Unarm01_M01_AttackA_01 is a valid animation name", () => {
  assert.equal(getAnimationAssetNameIssue("AS_Unarm01_M01_AttackA_01"), null);
});

test("animation names reject spaces and missing prefixes", () => {
  assert.match(getAnimationAssetNameIssue("AS Unarm").zh, /空格|中文|特殊/);
  assert.match(getAnimationAssetNameIssue("Walk_F").zh, /AS_/);
});

test("hero animation path is any folder under Hero", () => {
  assert.equal(isHeroAnimationPath("Z:/Artist/AssetLibrary/Animation/Hero/Male_01/WP00_Unarm/Locomotion", ""), true);
  assert.equal(isHeroAnimationPath("Z:/Artist/AssetLibrary/Animation/Hero/Male_01/WP00_Unarm/Hit", ""), true);
  assert.equal(isHeroAnimationPath("Z:/Artist/AssetLibrary/Animation/NPC/Guard", ""), false);
  assert.equal(getLocomotionStepKind("AS_Unarm01_M01_WalkStart_L"), "start");
  assert.equal(getLocomotionStepKind("AS_Unarm01_M01_Walk_F"), "loop");
  assert.equal(getLocomotionStepKind("AS_Unarm01_M01_WalkStop_L"), "stop");
});

test("import rules flag 30 FPS, hit root span, and wrong start steps", () => {
  const fps = evaluateAnimationImportRules({
    assetName: "AS_Unarm01_M01_AttackA_01",
    filePath: "D:\\\\clip.fbx",
    stats: { frameRate: 30, rootHorizontalRangeCm: 0, rootTravelCm: 0, stepCount: null }
  });
  assert.equal(fps.find((item) => item.id === "fps")?.status, "fail");
  assert.match(fps.find((item) => item.id === "root")?.zh, /不适用.*Hit_|WalkStop|RunStop/);

  const hit = evaluateAnimationImportRules({
    assetName: "AS_Unarm01_M01_Hit_A",
    filePath: "D:\\\\hit.fbx",
    stats: { frameRate: 60, rootHorizontalRangeCm: 14, rootTravelCm: 4, stepCount: null }
  });
  assert.equal(hit.find((item) => item.id === "root")?.status, "fail");

  const start = evaluateAnimationImportRules({
    assetName: "AS_Unarm01_M01_WalkStart_L",
    destinationPath: "Animation/Hero/Male_01/WP00_Unarm",
    filePath: "D:/walkstart.fbx",
    stats: { frameRate: 60, rootHorizontalRangeCm: 0, rootTravelCm: 0, stepCount: 4 }
  });
  assert.equal(start.find((item) => item.id === "steps")?.status, "fail");
});

test("empty animation names skip until filled", () => {
  const checks = evaluateAnimationImportRules({
    assetName: "",
    filePath: "D:/clip.fbx",
    stats: { frameRate: 60, rootHorizontalRangeCm: 0, rootTravelCm: 0, stepCount: 4 }
  });
  assert.equal(checks.find((item) => item.id === "name")?.status, "skip");
});

test("monster affiliation skips hero step checks", () => {
  const checks = evaluateAnimationImportRules({
    assetName: "AS_Unarm01_M01_Walk_F",
    destinationPath: "Animation/Hero/Male_01/WP00_Unarm/Locomotion",
    filePath: "D:/walk.fbx",
    animationType: "基础移动",
    animationAffiliation: "怪物",
    stats: { frameRate: 60, rootHorizontalRangeCm: 0, rootTravelCm: 0, stepCount: 2 }
  });
  assert.equal(checks.find((item) => item.id === "steps")?.status, "skip");
  assert.match(checks.find((item) => item.id === "steps")?.zh, /怪物/);
});

test("hero step checks apply outside Locomotion, with skip reasons", () => {
  const heroHit = evaluateAnimationImportRules({
    assetName: "AS_Unarm01_M01_Walk_F",
    destinationPath: "Animation/Hero/Male_01/WP00_Unarm/Hit",
    filePath: "D:/walk.fbx",
    animationType: "基础移动",
    stats: { frameRate: 60, rootHorizontalRangeCm: 0, rootTravelCm: 0, stepCount: 4 }
  });
  assert.equal(heroHit.find((item) => item.id === "steps")?.status, "ok");

  const attack = evaluateAnimationImportRules({
    assetName: "AS_Unarm01_M01_AttackA_01",
    destinationPath: "Animation/Hero/Male_01/WP00_Unarm",
    filePath: "D:/attack.fbx",
    animationType: "攻击",
    stats: { frameRate: 60, rootHorizontalRangeCm: 0, rootTravelCm: 0, stepCount: 2 }
  });
  assert.equal(attack.find((item) => item.id === "steps")?.status, "skip");
  assert.match(attack.find((item) => item.id === "steps")?.zh, /攻击/);
  assert.match(attack.find((item) => item.id === "root")?.zh, /不适用/);

  const knock = evaluateAnimationImportRules({
    assetName: "AS_Unarm01_M01_HitFly_A",
    destinationPath: "Animation/Hero/Male_01/WP00_Unarm/Hit",
    filePath: "D:/hitfly.fbx",
    animationType: "受击",
    stats: { frameRate: 60, rootHorizontalRangeCm: 80, rootTravelCm: 80, stepCount: 0 }
  });
  assert.match(knock.find((item) => item.id === "root")?.zh, /击飞|倒地/);
  assert.match(knock.find((item) => item.id === "steps")?.zh, /受击/);

  const npc = evaluateAnimationImportRules({
    assetName: "AS_Unarm01_M01_Walk_F",
    destinationPath: "Animation/NPC/Guard",
    filePath: "D:/npc.fbx",
    stats: { frameRate: 60, rootHorizontalRangeCm: 0, rootTravelCm: 0, stepCount: 2 }
  });
  assert.match(npc.find((item) => item.id === "steps")?.zh, /Hero/);
});
