const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const { createRequire } = require("node:module");

const sourcePath = path.join(__dirname, "../src/ui/animationRules.ts");
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
}).outputText;
const moduleShim = { exports: {} };
new Function("exports", "module", "require", compiled)(moduleShim.exports, moduleShim, createRequire(sourcePath));
const {
  getMissingAnimationFields,
  getAnimationAssetNameIssue,
  evaluateAnimationImportRules,
  isHeroAnimationPath,
  getLocomotionStepKind
} = moduleShim.exports;
const { suggestAnimationArchiveRelativePath } = moduleShim.exports;
const { animationPlanningLabels } = moduleShim.exports;
const { inferAnimationPlanning, syncAnimationPlanning } = moduleShim.exports;

test('planning reads context, gait and phase from animation names without guessing unrelated names', () => {
  assert.deepEqual(inferAnimationPlanning('AS_ShangExecutor_Alert_Walk_Start.fbx'), { animationMotionContext: '警戒', animationGait: '走', animationPhase: '起步' });
  assert.deepEqual(inferAnimationPlanning('AS_ShangExecutor_Battle_Run_Stop'), { animationMotionContext: '战斗', animationGait: '跑', animationPhase: '循环' });
  assert.deepEqual(inferAnimationPlanning('AS_ShangExecutor_Idle_Stand'), { animationMotionContext: '巡逻', animationGait: '站立', animationPhase: '循环' });
  assert.deepEqual(inferAnimationPlanning('AS_Unarm01_M01_WalkStop_L'), { animationMotionContext: '', animationGait: '走', animationPhase: '停步' });
  assert.deepEqual(inferAnimationPlanning('AS_ShangExecutor_Alert_Run'), { animationMotionContext: '警戒', animationGait: '跑', animationPhase: '循环' });
  assert.deepEqual(inferAnimationPlanning('AS_AlertBeast_Attack_01'), { animationMotionContext: '', animationGait: '', animationPhase: '' });
});

test('name defaults refresh per draft and preserve manual choices including empty selections', () => {
  const first = syncAnimationPlanning({ assetName: 'AS_Wolf_Alert_Walk_Start' });
  assert.equal(syncAnimationPlanning(first), first);
  const renamed = syncAnimationPlanning({ ...first, assetName: 'AS_Wolf_Idle_Stand' });
  assert.equal(renamed.animationMotionContext, '巡逻');
  assert.equal(renamed.animationGait, '站立');
  assert.equal(renamed.animationPhase, '循环');
  const manual = syncAnimationPlanning({ ...first, assetName: 'AS_Wolf_Idle_Run_Stop', animationGait: '', animationPlanningManualFields: ['animationGait'] });
  assert.equal(manual.animationGait, '');
  assert.equal(manual.animationMotionContext, '巡逻');
  assert.equal(manual.animationPhase, '停步');
  const oldDraft = syncAnimationPlanning({ assetName: 'AS_Wolf_Alert_Walk_Start', animationGait: '跑' });
  assert.equal(oldDraft.animationGait, '跑');
});

test('locomotion planning remains optional and produces existing action labels', () => {
  assert.deepEqual(animationPlanningLabels({ subCategory: '基础移动' }), []);
  assert.deepEqual(animationPlanningLabels({ subCategory: '基础移动', animationMotionContext: '警戒', animationGait: '走', animationPhase: '起步' }), ['警戒', '走', '起步']);
  assert.deepEqual(animationPlanningLabels({ zionTags: ['基础移动'], animationMotionContext: '战斗', animationGait: '跑', animationPhase: '停步' }), ['战斗', '跑', '循环']);
  assert.deepEqual(animationPlanningLabels({ subCategory: '攻击', animationMotionContext: '战斗', animationGait: '跑', animationPhase: '停步' }), []);
  assert.deepEqual(animationPlanningLabels({ subCategory: '基础移动', animationMotionContext: '无效', animationGait: '飞', animationPhase: '跳' }), []);
});

test('archive suggestion preserves the monster name and follows animation type', () => {
  assert.equal(suggestAnimationArchiveRelativePath('AS_ShangExecutor_Alert_Walk_Start', '怪物', '基础移动'), 'Animation\\Monster\\ShangExecutor\\Locomotion');
  assert.equal(suggestAnimationArchiveRelativePath('AS_ShangExecutor_Attack_01.fbx', '怪物', '攻击'), 'Animation\\Monster\\ShangExecutor\\Attack');
  assert.equal(suggestAnimationArchiveRelativePath('AS_Wolf_Hit', '怪物', '受击'), 'Animation\\Monster\\Wolf\\Hit');
  assert.equal(suggestAnimationArchiveRelativePath('AS_Villager_Idle', 'NPC', '基础移动'), 'Animation\\NPC\\Villager\\Locomotion');
  assert.equal(suggestAnimationArchiveRelativePath('AS_Unarm01_F02_Attack', '主角', '攻击'), 'Animation\\Hero\\Female_02\\WP00_Unarm\\Attack');
  assert.equal(suggestAnimationArchiveRelativePath('AS_../Bad', '怪物', '基础移动'), 'Animation\\Monster\\Locomotion');
});

test("animation import requires action labels and matching gameplay identity, but no ordinary tags", () => {
  const fields = { assetName: "AS_ShangExecutor_Battle_Run_Stop", filePath: "D:/animation.fbx", destinationPath: "D:/Library/Animation/Monster", affiliation: "怪物", animationType: "基础移动", labels: ["跑停"], gameTag: { kind: "monster", id: "Monster_ShangExecutor" } };
  assert.deepEqual(getMissingAnimationFields(fields), []);
  assert.deepEqual(getMissingAnimationFields({ ...fields, labels: [" "], gameTag: { kind: "weapon", id: "WP00" } }).map(field => field.zh), ["动作标签", "怪物"]);
  assert.deepEqual(getMissingAnimationFields({ ...fields, affiliation: "主角", gameTag: null }).map(field => field.zh), ["武器类别"]);
  assert.deepEqual(getMissingAnimationFields({ ...fields, affiliation: "NPC", gameTag: null }), []);
});

test("animation import lists every missing required field before work starts", () => {
  assert.deepEqual(getMissingAnimationFields({ assetName: "", filePath: "", destinationPath: "", affiliation: "", animationType: "", labels: [] }).map(field => field.zh), ["资产名", "导入文件", "归档目录", "动画归属", "动画类型", "动作标签"]);
});

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

test('gait inference contains directional Walk Run Stand tokens without reading the character name', () => {
  assert.equal(inferAnimationPlanning('AS_Executor_Battle_WalkF').animationGait, '走');
  assert.equal(inferAnimationPlanning('AS_Executor_Alert_RunB').animationGait, '跑');
  assert.equal(inferAnimationPlanning('AS_Executor_Idle_StandRelax').animationGait, '站立');
  assert.equal(inferAnimationPlanning('AS_Walker_Attack_01').animationGait, '');
});

test('hero planning omits status and keeps start/stop phases independent of Battle', () => {
  const inferred = inferAnimationPlanning('AS_Unarm01_M01_Battle_Run_Stop', '主角');
  assert.deepEqual(inferred, { animationMotionContext: '', animationGait: '跑', animationPhase: '停步' });
  const synced = syncAnimationPlanning({ assetName: 'AS_Unarm01_M01_RunF', animationAffiliation: '主角', animationMotionContext: '战斗', animationPhase: '起步' });
  assert.equal(synced.animationMotionContext, '');
  assert.equal(synced.animationPhase, '起步');
  assert.deepEqual(animationPlanningLabels({ subCategory: '基础移动', animationAffiliation: '主角', animationMotionContext: '战斗', animationGait: '跑', animationPhase: '停步' }), ['跑', '停步']);
});
