import { heroTextureChannel, heroMaterialRole } from './heroMaterialRules.mjs';
// Hero subtypes share storage infrastructure, not outfit slot rules.
export const heroPartKind = fields => /^(Hair|Face)$/.test(fields?.variant || "") ? fields.variant : "";
export function inferHeroPart(values) {
  const matches = values.map(value => String(value).replace(/\\/g, "/").split("/").pop()
    .match(/^(?:SK_|SM_|MI_|T_)?([MF])(\d{2})_(Hair|Face)(\d{3})(?:[_.]|$)/i)).filter(Boolean);
  const identities = new Set(matches.map(m => `${m[1]}${m[2]}_${m[3]}${m[4]}`.toLowerCase()));
  if (identities.size !== 1) return null;
  const m = matches[0];
  return { gender: m[1].toUpperCase() === "F" ? "Female" : "Male", bodyCode: m[2], variant: m[3].toLowerCase() === "hair" ? "Hair" : "Face", serial: m[4] };
}
export function heroPartName(fields) {
  const kind = heroPartKind(fields);
  const gender = fields?.gender === "Male" ? "M" : fields?.gender === "Female" ? "F" : "";
  return kind && gender && /^\d{2}$/.test(fields.bodyCode) && /^\d{3}$/.test(fields.serial)
    ? `${gender}${fields.bodyCode}_${kind}${fields.serial}` : "";
}
export function heroPartModelKind(fields, source) {
  if (heroPartKind(fields) !== "Hair") return heroPartKind(fields) === "Face" ? "mesh" : "";
  return /\.abc$/i.test(String(source || "")) ? "groom" : "cards";
}
export const isHeroCache = path => /\.(?:ma|mb)\.swatches$/i.test(String(path));
const heroFileStem = file => String(file || "").replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") || "";
export function heroSuitPart(file) {
  const suffix = heroFileStem(file).replace(/_LOD\d+$/i, '').match(/(?:^|_)(Head|Upbody|Upperbody|Downbody|Arm)(?:_(?:v?\d+))*$/i)?.[1]?.toLowerCase();
  return ({ head: 'Head', upbody: 'Upbody', upperbody: 'Upbody', downbody: 'Downbody', arm: 'Arm' })[suffix] || '';
}
const heroWeaponToken = /(?:^|[_\-\s])(wp|weapon|longsword|pairedswords|shieldaxe|greataxe|sword|blade|spear|shield|axe|bow|arrow|jade|gun|dagger|staff|hammer)(?:[_\-\s\d]|$)/i;
// An unsuffixed reference mesh is not a fifth outfit part. Keep weapons for
// the separate-asset scope review; never guess that a reference mesh is Head.
export function partitionHeroSuitFiles(files = [], fields = {}, { includeWeapons = true } = {}) {
  if (heroPartKind(fields)) return { accepted: [...files], excluded: [] };
  const accepted = [], excluded = [];
  for (const file of files) {
    const model = /\.(fbx|obj|abc|gltf|glb)$/i.test(String(file));
    const allowed = !model || heroSuitPart(file) || includeWeapons && heroWeaponToken.test(heroFileStem(file));
    (allowed ? accepted : excluded).push(file);
  }
  return { accepted, excluded };
}
export function heroPackageModelFiles(files = []) {
  return files.filter(file => /\.(fbx|obj|abc|gltf|glb)$/i.test(String(file || "")) && !/_LOD\d+\.[^.]+$/i.test(String(file || "")) && !isHeroCache(file));
}
export function heroPackageNeedsScopeReview(files = [], confirmed = false) {
  const models = heroPackageModelFiles(files);
  return !confirmed && (models.length > 4 || models.some(file => heroWeaponToken.test(heroFileStem(file))));
}
export function inferHeroPackageFileScopes(files = []) {
  const models = heroPackageModelFiles(files);
  if (!heroPackageNeedsScopeReview(files)) return {};
  return Object.fromEntries(models.filter(file => /\.fbx$/i.test(String(file || ""))).map(file => {
    const value = heroFileStem(file).replace(/^(?:SK|SM)_/i, "");
    return [file, heroWeaponToken.test(value) ? "weapon" : "suit"];
  }));
}

function heroAssociationTokens(file) {
  const stem = heroFileStem(file)
    .replace(/^(?:SK|SM|MI|T)_/i, "")
    .replace(/_LOD\d+$/i, "")
    .replace(/_(?:ORM|D|N|A|Emissive|Emission|E|OpacityMask|Opacity)$/i, "")
    .toLowerCase();
  return stem.split(/[^a-z0-9]+/).filter(token => token && !["sk", "sm", "mi", "t", "char", "character"].includes(token));
}

function relatedHeroModel(file, models) {
  const fileTokens = heroAssociationTokens(file);
  let best = null;
  let bestScore = 0;
  for (const model of models) {
    const modelTokens = heroAssociationTokens(model);
    const overlap = modelTokens.filter(token => fileTokens.includes(token));
    const score = overlap.reduce((total, token) => total + (/^\d+$/.test(token) ? 1 : 3), 0);
    if (score > bestScore) { best = model; bestScore = score; }
  }
  return bestScore > 0 ? best : null;
}

export function splitHeroPackageByScope(files = [], scopes = {}) {
  const suit = [], weapon = [], unassigned = [];
  const partition = partitionHeroSuitFiles(files);
  files = partition.accepted;
  const models = heroPackageModelFiles(files);
  for (const file of files) {
    const isPrimaryModel = models.includes(file) && /\.fbx$/i.test(String(file || ""));
    const related = isPrimaryModel ? file : relatedHeroModel(file, models.filter(model => /\.fbx$/i.test(String(model || ""))));
    const fallback = heroWeaponToken.test(heroFileStem(file).replace(/^(?:SK|SM|MI|T)_/i, "")) ? "weapon" : "suit";
    const scope = scopes[related || ""] || fallback;
    if (isPrimaryModel && !scopes[file]) {
      unassigned.push(file);
      continue;
    }
    if (scope === "suit") suit.push(file);
    else if (scope === "weapon") weapon.push(file);
    else if (isPrimaryModel) unassigned.push(file);
    else suit.push(file);
  }
  return { suit, weapon, unassigned, excluded: partition.excluded };
}
export function heroModelStem(assetName, source, fields = {}, meshKind = "staticMesh") {
  if (heroPartKind(fields)) return heroPartModelKind(fields, source) === "groom" ? `${assetName}_Groom` : `${meshKind === "skeletalMesh" ? "SK" : "SM"}_${assetName}`;
  const slot = heroSuitPart(source);
  if (!slot) return "";
  const canonical = { head: "Head", upbody: "Upbody", downbody: "Downbody", arm: "Arm" }[slot.toLowerCase()];
  return `${meshKind === "skeletalMesh" ? "SK" : "SM"}_${assetName}_${canonical}`;
}
export function cleanSuitName(value) {
  // The package identity has no revision/part suffix. Keep the original in the manifest.
  return String(value || "").trim().split(/[_\s]+/)[0].replace(/[^A-Za-z]/g, "");
}
export function auditHeroPackage(files, fields = {}, { partial = false, modelAnalyses = {} } = {}) {
  const models = files.filter(file => /\.(fbx|obj|abc|gltf|glb)$/i.test(file) && !/_LOD\d+\.[^.]+$/i.test(file));
  const errors = [];
  if (heroPartKind(fields)) {
    if (heroPartKind(fields) === "Hair") {
      const groom = models.filter(file => heroPartModelKind(fields, file) === "groom");
      const cards = models.filter(file => heroPartModelKind(fields, file) === "cards");
      if (groom.length > 1) errors.push(`头发 Groom 只能有一个 ABC，当前 ${groom.length} 个：\n${groom.join("\n")}`);
      if (cards.length > 1) errors.push(`头发插片只能有一个主模型，当前 ${cards.length} 个：\n${cards.join("\n")}`);
      if (!partial && groom.length + cards.length === 0) errors.push("头发包至少需要一个 Groom ABC 或插片模型");
    } else if (models.length > 1 || (!partial && models.length !== 1)) {
      errors.push(`脸部每包必须只有一个主体模型，当前 ${models.length} 个：\n${models.join("\n")}`);
    }
    const identity = inferHeroPart(models);
    // Compare sources to each other, never to the user-confirmed destination.
    const sourceIdentities = new Set(models.map(file => inferHeroPart([file])).filter(Boolean).map(heroPartName));
    if (sourceIdentities.size > 1) errors.push("模型来自多个不同的源资产，请分别整理");
    const maps = new Map();
    for (const file of files.filter(file => /\.(png|tga|tiff?|jpg|jpeg|webp)$/i.test(file))) {
      const base = String(file).replace(/\\/g, "/").split("/").pop();
      if (/preview|thumb|render|beauty/i.test(base)) continue;
      const textureIdentity = inferHeroPart([file]);
      const channel = heroTextureChannel(base);
      const map = channel ? `${heroMaterialRole(base, fields.variant)}:${channel}` : '';
      if ((textureIdentity && identity && heroPartName(textureIdentity) !== heroPartName(identity)) || !map) {
        errors.push(`贴图归属或类型无法确认，请整理：${file}`);
      } else if (maps.has(map)) errors.push(`同一贴图类型存在多个候选：\n${maps.get(map)}\n${file}`);
      else maps.set(map, file);
    }
  } else {
    if (!partial && !models.length) errors.push('套装至少需要一个带部件后缀的模型');
    const slots = new Map();
    for (const file of models) {
      const slot = heroSuitPart(file);
      if (!slot) {
        errors.push(`无法确认套装部件：${file}\n模型文件名必须以 _Head、_Upbody（或 _Upperbody）、_Downbody、_Arm 结尾；请确认它是部件还是整套参考模型后整理文件。缺少贴图不影响模型入库。`);
        continue;
      }
      const kind = modelAnalyses[file]?.meshKind || 'unknown';
      const key = `${slot}:${kind}`;
      const previous = slots.get(key);
      if (previous) errors.push(`同一部件存在多个候选，不能自动选版本：\n${previous}\n${file}`);
      slots.set(key, file);
    }
  }
  return errors;
}
