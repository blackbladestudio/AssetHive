import patterns from "./characterFilePatterns.json" with { type: "json" };

const identityPattern = new RegExp(patterns.monsterIdentity, "i");
const mapPattern = new RegExp(patterns.textureSuffix, "i");
const revisionPattern = /_(?:final\d*|clean\d*|new\d*|old\d*|backup\d*|copy\d*|v\d+|ver\d+|version\d+|rev\d+|\(\d+\))$/i;
const imagePattern = /^(png|jpe?g|tiff?|tga|webp|bmp|exr|hdr)$/i;
const projectPattern = /^(ma|mb|blend|max|spp|psd|ztl|swatches)$/i;

export function displayMonsterFormNumbers(formIds = []) {
  return [...new Set(formIds.map(form => form === 'base' ? '01' : form))].join(' / ');
}

export function buildMonsterAssetName(name, formIds = []) {
  const subject = String(name || "").trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(subject) || formIds.length !== 1) return "";
  const form = formIds[0];
  if (form !== "base" && !/^\d{2}$/.test(form)) return "";
  return `SK_${subject}${form === "base" ? "" : `_${form}`}`;
}

// Revision words are comparison hints, never an instruction to discard a file.
export function normalizeMonsterSourceStem(value) {
  let stem = String(value || "").replace(/[\s\-\u2013\u2014]+/g, "_").replace(/_+/g, "_");
  const stripRevisions = (text) => {
    let next = text;
    while (revisionPattern.test(next)) next = next.replace(revisionPattern, "");
    return next;
  };
  stem = stripRevisions(stem);
  const map = stem.match(mapPattern)?.[1];
  if (map && /^T_/i.test(stem)) {
    return `${stripRevisions(stem.replace(mapPattern, ""))}_${patterns.textureMapCodes[map.toLowerCase()]}`;
  }
  return stem;
}

export function classifyMonsterSource(file) {
  const parts = String(file).replace(/\\/g, "/").split("/");
  const filename = parts.at(-1) || "";
  const ext = filename.split(".").at(-1).toLowerCase();
  const stem = normalizeMonsterSourceStem(filename.replace(/\.[^.]+$/, ""));
  const folders = parts.slice(0, -1).map((part) => part.toLowerCase());
  if (projectPattern.test(ext)) return { role: "other", folder: "OtherFiles" };
  if (imagePattern.test(ext)) return /(?:^|_)(?:preview|thumb|thumbnail|render|beauty)(?:_|$)/i.test(stem)
    ? { role: "other", folder: "OtherFiles" } : { role: "texture", folder: "Texture" };
  if (folders.includes("actionfiles")) return { role: "actionFile", folder: "ActionFiles" };
  if (folders.includes("animation")) return { role: "animation", folder: "Animation" };
  if (ext === "uasset") {
    for (const [prefix, role, folder] of [
      ["SKEL_", "skeleton", "Mesh/SkeletalMesh"], ["MI_", "material", "Material"],
      ["T_", "texture", "Texture"], ["ABP_", "animationBlueprint", "ABP"], ["BP_", "blueprint", "BP"]
    ]) if (stem.toUpperCase().startsWith(prefix)) return { role, folder };
    if (/^SK_.+_Physics$/i.test(stem)) return { role: "physicsAsset", folder: "Mesh/SkeletalMesh" };
  }
  if (patterns.meshExtensions.includes(ext) && !/^SKEL_|_Physics$/i.test(stem)) {
    if (/^SM_/i.test(stem) || folders.includes("staticmesh")) return { role: "staticMesh", folder: "Mesh/StaticMesh" };
    if (ext !== "uasset" || /^SK_/i.test(stem) || folders.includes("skeletalmesh")) return { role: "skeletalMesh", folder: "Mesh/SkeletalMesh" };
  }
  return { role: "other", folder: "OtherFiles" };
}

function inspectFile(file) {
  const parts = String(file).replace(/\\/g, "/").split("/").filter(Boolean);
  const name = parts.at(-1) || "";
  const ext = name.split(".").at(-1).toLowerCase();
  const stem = normalizeMonsterSourceStem(name.replace(/\.[^.]+$/, "").replace(/\.(?:ma|mb)$/i, ""));
  const match = stem.match(identityPattern);
  const parent = parts.slice(0, -1).reverse().map((part) => normalizeMonsterSourceStem(part).match(identityPattern)).find(Boolean);
  const { role, folder } = classifyMonsterSource(file);
  const weapon = /(?:^|_)(?:WP|Weapon)(?:_|$)/i.test(stem);
  return { path: file, name, ext, stem, role, folder, weapon, match, parent,
    mesh: ["skeletalMesh", "staticMesh"].includes(role),
    owner: match?.[1] || "", form: match?.[2] || "" };
}

export function auditMonsterPackage(files, options = {}) {
  const rows = [...new Set(files)].map(inspectFile);
  const analysisKey = value => String(value).replace(/\\/g, '/').toLowerCase();
  const analyses = new Map((options.modelAnalyses instanceof Map ? [...options.modelAnalyses] : Object.entries(options.modelAnalyses || {}))
    .map(([file, analysis]) => [analysisKey(file), analysis]));
  for (const row of rows.filter(row => row.mesh)) {
    row.analysis = analyses.get(analysisKey(row.path));
    if (['staticMesh', 'skeletalMesh'].includes(row.analysis?.meshKind)) row.role = row.analysis.meshKind;
  }
  // Unnumbered rig exports can have a different filename. Only join them to a
  // unique complementary mesh when the inspected material slots prove ownership.
  const modelAliases = {};
  const anchors = rows.filter(row => row.mesh && row.match && row.analysis?.meshKind && !row.analysis.error && row.analysis.ok !== false);
  const proposals = rows.filter(row => row.mesh && !row.match && row.analysis?.meshKind && !row.analysis.error && row.analysis.ok !== false).map(row => {
    const slots = row.analysis.materialNames || [];
    const matches = anchors.filter(target => {
      if (target.weapon !== row.weapon || target.role === row.role) return false;
      const targetSlots = (target.analysis.materialNames || []).map(name => name.toLowerCase());
      return slots.length && targetSlots.length && slots.every(name => {
        const slot = name.toLowerCase();
        return targetSlots.some(base => slot === base || (slot.startsWith(base + '_') && /^\d+$/.test(slot.slice(base.length + 1))));
      });
    });
    return { row, target: matches.length === 1 ? matches[0] : null };
  });
  for (const { row, target } of proposals) {
    if (!target || proposals.filter(p => p.target === target && p.row.role === row.role).length !== 1) continue;
    if (anchors.some(other => other.role === row.role && other.stem.replace(/^(SM|SK)_/i, '').toLowerCase() === target.stem.replace(/^(SM|SK)_/i, '').toLowerCase())) continue;
    row.stem = target.stem.replace(/^(SM|SK)_/i, row.role === 'skeletalMesh' ? 'SK_' : 'SM_');
    row.match = row.stem.match(identityPattern);
    row.owner = row.match[1];
    row.form = row.match[2];
    modelAliases[row.path] = row.stem;
  }
  const body = rows.filter((row) => row.mesh && !row.weapon);
  const names = [...new Set(body.map((row) => row.owner.toLowerCase()).filter(Boolean))];
  const sourceName = body.find((row) => row.owner)?.owner || String(options.expectedName || "");
  const formIds = [...new Set(body.map((row) => row.form || "base"))].sort();
  const issues = [];
  const add = (code, message, affected) => {
    if (!affected.length) return;
    issues.push({ code, message, files: [...new Set(affected.map((row) => row.path))] });
  };
  if (!body.length && rows.length) add("missing-body", "未识别到主体模型；武器、贴图或工程不能代替主体模型", rows);
  if (names.length > 1) add("mixed-monsters", "发现不同怪物名称的主体模型，请按资产分别整理", body);
  if (formIds.length > 1) add("multiple-forms", `发现多个主体形态（${formIds.join(" / ")}），请分别导入`, body);

  const wrongOwner = [], wrongForm = [], unknown = [], pathConflicts = [];
  for (const row of rows) {
    const inferred = row.match || row.parent;
    if (inferred && names.length <= 1 && sourceName && inferred[1].toLowerCase() !== sourceName.toLowerCase()) wrongOwner.push(row);
    if (inferred && formIds.length === 1 && inferred[2] !== formIds[0]) wrongForm.push(row);
    if (row.match && row.parent && (row.owner.toLowerCase() !== row.parent[1].toLowerCase() || row.form !== row.parent[2])) pathConflicts.push(row);
    if (!row.match && /^(SK|SM|SKEL|MI|T|ABP|BP)_/i.test(row.stem) && sourceName) {
      const subject = row.stem.replace(/^(SK|SM|SKEL|MI|T|ABP|BP)_/i, "").toLowerCase();
      const owner = sourceName.toLowerCase();
      if (subject !== owner && !subject.startsWith(`${owner}_`)) wrongOwner.push(row);
    }
    const map = row.stem.match(mapPattern)?.[1];
    if (row.role === "texture" && (!map || !/^T_/i.test(row.stem) || (!row.match && !sourceName))) unknown.push(row);
    if (row.role === "other" && !projectPattern.test(row.ext)
      && !/^(txt|md|json|csv|pdf)$/i.test(row.ext) && !imagePattern.test(row.ext)) unknown.push(row);
  }
  add("wrong-owner", `资源名称与主体 ${sourceName || "当前怪物"} 不一致，请核对是否混包`, wrongOwner);
  add("wrong-form", `资源编号与主体形态 ${formIds[0] || "未确定"} 不一致，请整理归属后重新扫描`, wrongForm);
  add("path-conflict", "文件名与所在资产目录的身份不一致，请核对归属", pathConflicts);
  add("unrecognized-resource", "以下资源的用途或命名无法可靠识别，请整理后重新扫描", unknown);

  const candidates = new Map();
  for (const row of rows) {
    // An editable source project and its exported mesh are complementary, not duplicates.
    const kind = row.role === "other" ? `source:${row.ext}` : row.role;
    if (!["skeletalMesh", "staticMesh", "texture", "material", "skeleton", "physicsAsset"].includes(row.role)
      && !projectPattern.test(row.ext)) continue;
    const key = `${kind}:${row.stem.toLowerCase()}`;
    const group = candidates.get(key) || [];
    group.push(row);
    candidates.set(key, group);
  }
  for (const group of candidates.values()) if (group.length > 1) {
    add("competing-versions", "疑似同一资源的多个版本或重复副本；系统不会按 final、clean、格式或修改时间替你选择", group);
  }
  // Relationship checks are independent of revision vocabulary. Several meshes for
  // one owner/form/type need evidence of separate parts or an explicit LOD chain.
  const meshGroups = new Map();
  const partEvidence = new Set(rows.filter((row) => ["texture", "material"].includes(row.role) && row.match)
    .map((row) => `${row.owner}:${row.form}:${String(row.match[3] || "").replace(/(?:^|_)(ORM|D|N|A|Emissive)$/i, "")}`.toLowerCase()));
  for (const row of body.filter((row) => row.match)) {
    const key = `${row.role}:${row.owner}:${row.form}`.toLowerCase();
    const group = meshGroups.get(key) || [];
    group.push(row);
    meshGroups.set(key, group);
  }
  for (const group of meshGroups.values()) {
    const parts = new Set(group.map((row) => String(row.match[3] || "").replace(/(?:^|_)LOD\d+$/i, "").toLowerCase()));
    if (parts.size <= 1) continue;
    const explained = group.every((row) => {
      const part = String(row.match[3] || "").replace(/(?:^|_)LOD\d+$/i, "");
      return part && partEvidence.has(`${row.owner}:${row.form}:${part}`.toLowerCase());
    });
    if (!explained) add("ambiguous-model-relationship", "同一怪物形态存在多个模型，无法确认是独立部件还是多个版本；请明确部件归属和配套资源后重新扫描", group);
  }
  // Detect overlapping texture groups without interpreting arbitrary suffixes as
  // either revisions or parts. Explicit material/mesh ownership resolves the overlap.
  const textureSets = new Map();
  const explicitParts = new Set(rows.filter((row) => (row.mesh || row.role === "material") && row.match)
    .map((row) => `${row.owner}:${row.form}:${row.match[3] || ""}`.toLowerCase()));
  for (const row of rows.filter((row) => row.role === "texture" && row.match)) {
    const part = String(row.match[3] || "").replace(/(?:^|_)(ORM|D|N|A|Emissive)$/i, "").toLowerCase();
    const key = `${row.owner}:${row.form}:${part}`.toLowerCase();
    const entry = textureSets.get(key) || { key, owner: row.owner.toLowerCase(), form: row.form, part, files: [] };
    entry.files.push(row);
    textureSets.set(key, entry);
  }
  const sets = [...textureSets.values()];
  for (let i = 0; i < sets.length; i += 1) for (let j = i + 1; j < sets.length; j += 1) {
    const a = sets[i], b = sets[j];
    if (a.owner !== b.owner || a.form !== b.form || (explicitParts.has(a.key) && explicitParts.has(b.key))) continue;
    const aa = a.part.split("_").filter(Boolean), bb = b.part.split("_").filter(Boolean);
    let common = 0;
    while (common < aa.length && common < bb.length && aa[common] === bb[common]) common += 1;
    const numericParts = aa.slice(common).every((token) => /^\d+$/.test(token)) && bb.slice(common).every((token) => /^\d+$/.test(token));
    const channels = new Set(a.files.map((row) => row.stem.match(mapPattern)?.[1]?.toLowerCase()));
    if (common && !numericParts && b.files.some((row) => channels.has(row.stem.match(mapPattern)?.[1]?.toLowerCase()))) {
      add("overlapping-texture-groups", "发现同一名称分支下的多套同用途贴图，缺少可确认的独立部件 / 材质归属；请明确各组用途后重新扫描", [...a.files, ...b.files]);
    }
  }
  const unnamedModels = body.filter((row) => !row.match);
  if (unnamedModels.length > 1) add("ambiguous-models", "多个模型缺少可识别的主体 / 部件归属，请明确本次提交内容", unnamedModels);
  return { ok: issues.length === 0, sourceName, formIds, issues, modelAliases,
    problemFileCount: new Set(issues.flatMap((issue) => issue.files)).size };
}
