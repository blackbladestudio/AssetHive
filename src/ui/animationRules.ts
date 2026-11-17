export const ANIMATION_ASSET_NAME_PREFIXES = ["AS_", "BS_", "ABP_", "AM_", "AC_"] as const;

export type AnimationRuleStatus = "ok" | "fail" | "skip" | "warn";

export type AnimationRuleCheck = {
  id: "name" | "fps" | "root" | "steps";
  status: AnimationRuleStatus;
  zh: string;
  en: string;
};

export type AnimationFbxStats = {
  frameRate: number | null;
  frameRateSource?: "keyframes" | "header" | "custom" | null;
  rootHorizontalRangeCm: number | null;
  rootTravelCm: number | null;
  stepCount: number | null;
};

export type AnimationRuleInput = {
  assetName: string;
  destinationPath?: string;
  filePath?: string;
  animationType?: string;
  animationAffiliation?: string;
  stats?: AnimationFbxStats | null;
};

const NAME_SEGMENT = /^(?:[A-Z][A-Za-z0-9]*|[0-9]+)$/;
const HERO_FOLDER = /(?:^|[\\/])hero(?:[\\/]|$)/i;
const HIT_NAME = /(?:^|_)hit(?:_|$|[a-z])/i;
const KNOCKAWAY_HIT = /knock(?:down|back)?|hit(?:fly|down|launch)|ragdoll|death|launch/i;
const WALK_STOP = /(?:lock)?walkstop/i;
const RUN_STOP = /(?:lock)?runstop/i;
const SPRINT_OR_CROUCH_STOP = /sprintstop|crouch(?:walk|run)?stop/i;

export function getAnimationAssetNameIssue(name: string): { zh: string; en: string } | null {
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    return { zh: "请填写资产名", en: "Enter an asset name" };
  }
  if (/\s/.test(trimmed) || [...trimmed].some((char) => char.charCodeAt(0) > 127)) {
    return { zh: "资产名不能包含空格、中文或特殊符号", en: "Asset names cannot contain spaces, Chinese, or special characters" };
  }
  if (!/^[A-Za-z0-9_]+$/.test(trimmed)) {
    return { zh: "资产名仅允许字母、数字和下划线", en: "Asset names can only use letters, numbers, and underscores" };
  }
  const prefix = ANIMATION_ASSET_NAME_PREFIXES.find((item) => trimmed.startsWith(item));
  if (!prefix) {
    return { zh: "动画资产名需以 AS_ / BS_ / ABP_ / AM_ / AC_ 开头", en: "Animation names must start with AS_, BS_, ABP_, AM_, or AC_" };
  }
  const rest = trimmed.slice(prefix.length);
  if (!rest) {
    return { zh: "前缀后需要逻辑名", en: "A logical name is required after the prefix" };
  }
  const parts = rest.split("_").filter(Boolean);
  if (parts.length === 0 || !/^[A-Z]/.test(parts[0]) || !parts.every((part) => NAME_SEGMENT.test(part))) {
    return { zh: "前缀后的逻辑名需为 PascalCase，多词用下划线分段", en: "The name after the prefix must be PascalCase, with words separated by underscores" };
  }
  return null;
}

export function getAnimationRuleName(assetName: string, filePath = "") {
  const fromName = String(assetName || "").trim();
  const fromFile = String(filePath || "").replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") || "";
  return fromName || fromFile;
}

export function isHeroAnimationPath(destinationPath = "", filePath = "") {
  const combined = [destinationPath, filePath].map((item) => String(item || "").replace(/\\/g, "/")).filter(Boolean).join("/");
  return HERO_FOLDER.test(combined);
}

export function isHeroLocomotionPath(destinationPath = "", filePath = "") {
  return isHeroAnimationPath(destinationPath, filePath);
}

export function getLocomotionStepKind(name: string): "start" | "loop" | "stop" | null {
  const token = String(name || "");
  if (!token) return null;
  if (/start/i.test(token)) return "start";
  if (/stop/i.test(token)) return "stop";
  return "loop";
}

export function isHitRootRuleName(name: string) {
  return HIT_NAME.test(name) && !KNOCKAWAY_HIT.test(name);
}

export function isWalkStopName(name: string) {
  return WALK_STOP.test(name) && !SPRINT_OR_CROUCH_STOP.test(name);
}

export function isRunStopName(name: string) {
  return RUN_STOP.test(name) && !SPRINT_OR_CROUCH_STOP.test(name);
}

export function evaluateAnimationImportRules(input: AnimationRuleInput): AnimationRuleCheck[] {
  const name = getAnimationRuleName(input.assetName, input.filePath);
  const stats = input.stats || null;
  const checks: AnimationRuleCheck[] = [];

  const filledName = String(input.assetName || "").trim();
  if (!filledName) {
    checks.push({ id: "name", status: "skip", zh: "命名：填写资产名后检查", en: "Name: checked after an asset name is entered" });
  } else {
    const nameIssue = getAnimationAssetNameIssue(filledName);
    checks.push(nameIssue
      ? { id: "name", status: "fail", zh: nameIssue.zh, en: nameIssue.en }
      : { id: "name", status: "ok", zh: `命名 ${name}`, en: `Name ${name}` });
  }

  if (!String(input.filePath || "").trim()) {
    checks.push({ id: "fps", status: "skip", zh: "帧率：选择动画 FBX 后检查", en: "Frame rate: checked after an animation FBX is chosen" });
    checks.push({ id: "root", status: "skip", zh: "Root 位移：选择动画 FBX 后检查", en: "Root motion: checked after an animation FBX is chosen" });
    checks.push({ id: "steps", status: "skip", zh: "步数：选择动画 FBX 后检查", en: "Steps: checked after an animation FBX is chosen" });
    return checks;
  }

  if (stats?.frameRate != null && Number.isFinite(stats.frameRate)) {
    const source = frameRateSourceLabel(stats.frameRateSource);
    if (Math.abs(stats.frameRate - 60) <= 0.5) {
      checks.push({ id: "fps", status: "ok", zh: `帧率 ${formatNumber(stats.frameRate)} FPS${source.zh}`, en: `Frame rate ${formatNumber(stats.frameRate)} FPS${source.en}` });
    } else {
      checks.push({
        id: "fps",
        status: "fail",
        zh: `帧率 ${formatNumber(stats.frameRate)} FPS，要求 60 FPS${source.zh}`,
        en: `Frame rate is ${formatNumber(stats.frameRate)} FPS; 60 FPS is required${source.en}`
      });
    }
  } else {
    checks.push({ id: "fps", status: "warn", zh: "未能读取 FBX 帧率，请确认按 60 FPS 导出", en: "Could not read the FBX frame rate. Export at 60 FPS" });
  }

  if (isWalkStopName(name)) {
    checks.push(rootDistanceCheck(stats, 0, 1, "WalkStop Root 位移应为 0", "WalkStop root displacement must be 0"));
  } else if (isRunStopName(name)) {
    checks.push(rootDistanceCheck(stats, 30, 3, "RunStop Root 位移应为 0.3m", "RunStop root displacement must be 0.3m"));
  } else if (isHitRootRuleName(name)) {
    const range = stats?.rootHorizontalRangeCm;
    if (range == null) {
      checks.push({ id: "root", status: "warn", zh: "未能读取受击 Root 位移", en: "Could not read hit-react root motion" });
    } else if (range <= 10.5) {
      checks.push({ id: "root", status: "ok", zh: `受击 Root 水平幅度 ${formatNumber(range)} cm`, en: `Hit root horizontal span ${formatNumber(range)} cm` });
    } else {
      checks.push({
        id: "root",
        status: "fail",
        zh: `受击 Root 水平幅度 ${formatNumber(range)} cm，要求不超过 10cm`,
        en: `Hit root horizontal span is ${formatNumber(range)} cm; it must stay within 10cm`
      });
    }
  } else {
    const reason = getRootSkipReason(name);
    checks.push({ id: "root", status: "skip", zh: `Root 位移：不适用（${reason.zh}）`, en: `Root motion: not applicable (${reason.en})` });
  }

  const affiliation = String(input.animationAffiliation || "").trim();
  const isHero = affiliation ? affiliation === "主角" : isHeroAnimationPath(input.destinationPath, input.filePath);
  if (!isHero) {
    checks.push({
      id: "steps",
      status: "skip",
      zh: affiliation
        ? `步数：不适用（${affiliation}不验步数，步数规则只针对主角移动）`
        : "步数：不适用（归档不在 Hero 主角目录下）",
      en: affiliation
        ? `Steps: not applicable (${affiliation === "怪物" ? "Monster" : affiliation === "NPC" ? "NPC" : affiliation} clips are not step-checked)`
        : "Steps: not applicable (archive is not under Hero)"
    });
    return checks;
  }
  const animationType = String(input.animationType || "").trim();
  if (animationType === "攻击" || animationType === "受击") {
    checks.push({ id: "steps", status: "skip", zh: `步数：不适用（${animationType}不验步数，步数规则只针对主角移动）`, en: `Steps: not applicable (${animationType === "攻击" ? "Attack" : "Hit"} clips are not step-checked)` });
    return checks;
  }
  const kind = getLocomotionStepKind(name);
  if (kind === "stop") {
    checks.push({ id: "steps", status: "skip", zh: "步数：不适用（Stop 不验步数，Root 按停步规则检查）", en: "Steps: not applicable (Stop clips skip step count; root motion is checked instead)" });
    return checks;
  }
  if (kind !== "start" && !/(?:lock)?(?:walk|run|sprint|crouch)/i.test(name)) {
    checks.push({
      id: "steps",
      status: "skip",
      zh: "步数：不适用（非走跑循环；Start=3、循环=4 只检查主角移动）",
      en: "Steps: not applicable (not a locomotion cycle; Start=3 / loop=4 apply to hero movement)"
    });
    return checks;
  }
  const expected = kind === "start" ? 3 : 4;
  if (stats?.stepCount == null) {
    checks.push({
      id: "steps",
      status: "warn",
      zh: `未能识别落脚，请确认是 ${expected} 步`,
      en: `Could not detect foot plants. This clip should have ${expected} steps`
    });
    return checks;
  }
  if (stats.stepCount === expected) {
    checks.push({ id: "steps", status: "ok", zh: `${kind === "start" ? "Start" : "循环"} ${stats.stepCount} 步`, en: `${kind === "start" ? "Start" : "Loop"} ${stats.stepCount} steps` });
  } else {
    checks.push({
      id: "steps",
      status: "fail",
      zh: `${kind === "start" ? "Start" : "循环"} 测到 ${stats.stepCount} 步，要求 ${expected} 步`,
      en: `${kind === "start" ? "Start" : "Loop"} has ${stats.stepCount} steps; ${expected} are required`
    });
  }
  return checks;
}

export function getAnimationRuleErrors(checks: AnimationRuleCheck[]) {
  return checks.filter((item) => item.status === "fail");
}

function getRootSkipReason(name: string): { zh: string; en: string } {
  if (KNOCKAWAY_HIT.test(name)) {
    return { zh: "击飞/倒地为单向位移，不按受击 10cm 来回规则", en: "launch/knockdown is one-way motion, not the 10cm hit-react range" };
  }
  if (SPRINT_OR_CROUCH_STOP.test(name)) {
    return { zh: "SprintStop / 下蹲停步不检查 Root 位移", en: "SprintStop and crouch stops are excluded from root-motion checks" };
  }
  return {
    zh: "只检查受击 Hit_*（水平来回≤10cm）、WalkStop（=0）、RunStop（=0.3m）",
    en: "only Hit_* (≤10cm horizontal), WalkStop (=0), and RunStop (=0.3m) are checked"
  };
}

function rootDistanceCheck(
  stats: AnimationFbxStats | null,
  expectedCm: number,
  toleranceCm: number,
  failZh: string,
  failEn: string
): AnimationRuleCheck {
  const travel = stats?.rootTravelCm;
  if (travel == null) {
    return { id: "root", status: "warn", zh: "未能读取 Root 位移", en: "Could not read root displacement" };
  }
  if (Math.abs(travel - expectedCm) <= toleranceCm) {
    return { id: "root", status: "ok", zh: `Root 位移 ${formatNumber(travel)} cm`, en: `Root displacement ${formatNumber(travel)} cm` };
  }
  return {
    id: "root",
    status: "fail",
    zh: `${failZh}（当前 ${formatNumber(travel)} cm）`,
    en: `${failEn} (currently ${formatNumber(travel)} cm)`
  };
}

function frameRateSourceLabel(source?: AnimationFbxStats["frameRateSource"]) {
  if (source === "keyframes") return { zh: "（按关键帧间隔）", en: " (from keyframe spacing)" };
  if (source === "header") return { zh: "（按 FBX TimeMode）", en: " (from FBX TimeMode)" };
  if (source === "custom") return { zh: "（按 CustomFrameRate）", en: " (from CustomFrameRate)" };
  return { zh: "", en: "" };
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}
