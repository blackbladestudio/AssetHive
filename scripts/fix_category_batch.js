// 一次性批量修正 2026-10-10 导入批次里 3D 资产的分类：
//   1) 道具段（03:13–03:38）里被误标为 Building 的资产 -> Props
//   2) 墙体段里被误标为 Historical 的 Qiangti 墙 -> Building
// 用法：
//   node scripts/fix_category_batch.js           # dry-run，只打印将发生的变化
//   node scripts/fix_category_batch.js --apply   # 实际写回
const { Buffer } = require("node:buffer");
const fs = require("fs");
const path = require("path");

const LIB_ROOT = "//fileshare/share/Artist/AssetLibrary/Environment/3D Assets";
const APPLY = process.argv.includes("--apply");

// 分类字段里需要同步改写 token 的位置（大小写敏感映射）
const CATEGORY_FIELDS_STRING = ["category", "semanticTags.subject_matter"];
const CATEGORY_FIELDS_ARRAY = ["tags", "categories", "semanticTags.theme", "semanticTags.contains"];

function getPath(obj, dottedPath) {
  return dottedPath.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}
function setPath(obj, dottedPath, value) {
  const keys = dottedPath.split(".");
  let cursor = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (cursor[keys[i]] == null || typeof cursor[keys[i]] !== "object") cursor[keys[i]] = {};
    cursor = cursor[keys[i]];
  }
  cursor[keys[keys.length - 1]] = value;
}

function remapToken(value, caseMap, oldLower, newLower) {
  if (typeof value !== "string") return value;
  const lower = value.toLowerCase();
  if (lower !== oldLower) return value;
  if (Object.prototype.hasOwnProperty.call(caseMap, value)) return caseMap[value];
  return newLower;
}

function remapCategoryTokens(meta, caseMap, oldLower, newLower) {
  const changes = [];
  for (const dotted of CATEGORY_FIELDS_STRING) {
    const current = getPath(meta, dotted);
    if (typeof current !== "string") continue;
    const next = remapToken(current, caseMap, oldLower, newLower);
    if (next !== current) {
      setPath(meta, dotted, next);
      changes.push(`${dotted}: ${JSON.stringify(current)} -> ${JSON.stringify(next)}`);
    }
  }
  for (const dotted of CATEGORY_FIELDS_ARRAY) {
    const current = getPath(meta, dotted);
    if (!Array.isArray(current)) continue;
    let touched = false;
    const next = current.map((item) => {
      const mapped = remapToken(item, caseMap, oldLower, newLower);
      if (mapped !== item) touched = true;
      return mapped;
    });
    if (touched) {
      setPath(meta, dotted, next);
      changes.push(`${dotted}: ${JSON.stringify(current)} -> ${JSON.stringify(next)}`);
    }
  }
  return changes;
}

function finalizeContentLength(meta) {
  let contentLength = 0;
  let text = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    meta.json = meta.json && typeof meta.json === "object" ? meta.json : {};
    meta.json.contentLength = contentLength;
    text = JSON.stringify(meta, null, 2);
    const actualLength = Buffer.byteLength(text, "utf8");
    if (actualLength === contentLength) return text;
    contentLength = actualLength;
  }
  meta.json.contentLength = Buffer.byteLength(text, "utf8");
  return JSON.stringify(meta, null, 2);
}

function readMeta(slug) {
  const metaPath = path.join(LIB_ROOT, slug, "asset_info.json");
  if (!fs.existsSync(metaPath)) return null;
  try {
    return { slug, metaPath, meta: JSON.parse(fs.readFileSync(metaPath, "utf8")) };
  } catch {
    return null;
  }
}

function listAssets() {
  const dirs = fs.readdirSync(LIB_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  const assets = [];
  for (const d of dirs) {
    const read = readMeta(d.name);
    if (read) assets.push(read);
  }
  return assets;
}

function main() {
  const assets = listAssets();
  const jobs = []; // { slug, action, changes }

  // 道具段：10-10 当天、03:44 之前导入、category === "Building" -> Props
  const propsCaseMap = { Building: "Props", building: "props" };
  const wallCaseMap = { Historical: "Building", historical: "building" };

  for (const asset of assets) {
    const { slug, meta } = asset;
    const createdAt = String(meta.createdAt || "");
    if (!createdAt.startsWith("2026-10-10")) continue;

    const isPropsPhase = createdAt <= "2026-10-10T03:44:00Z";
    const category = String(meta.category || "");

    if (isPropsPhase && category === "Building") {
      const changes = remapCategoryTokens(meta, propsCaseMap, "building", "props");
      if (changes.length > 0) jobs.push({ slug, action: "Building->Props", changes });
    } else if (category === "Historical" && /qiangti/i.test(String(meta.name || ""))) {
      const changes = remapCategoryTokens(meta, wallCaseMap, "historical", "building");
      if (changes.length > 0) jobs.push({ slug, action: "Historical->Building", changes });
    }
  }

  const propsCount = jobs.filter((j) => j.action === "Building->Props").length;
  const wallCount = jobs.filter((j) => j.action === "Historical->Building").length;
  console.log(`目标：${jobs.length} 个资产（道具 ${propsCount} + 墙体 ${wallCount}）${APPLY ? "" : " [dry-run]"} `);

  for (const job of jobs) {
    console.log(`\n[${job.action}] ${job.slug}`);
    for (const change of job.changes) {
      console.log(`    ${change}`);
    }
  }

  if (APPLY) {
    let written = 0;
    for (const job of jobs) {
      const asset = readMeta(job.slug);
      if (!asset) continue;
      // 重新计算（readMeta 会重新读盘，这里基于 job 的 changes 重新应用到新读取的对象）
      const caseMap = job.action === "Building->Props" ? propsCaseMap : wallCaseMap;
      const oldLower = job.action === "Building->Props" ? "building" : "historical";
      const newLower = job.action === "Building->Props" ? "props" : "building";
      remapCategoryTokens(asset.meta, caseMap, oldLower, newLower);
      const text = finalizeContentLength(asset.meta);
      fs.writeFileSync(asset.metaPath, text, "utf8");
      written += 1;
    }
    console.log(`\n[完成] 已写回 ${written} 个 asset_info.json`);
  } else {
    console.log("\n(dry-run：未写回。加 --apply 执行)");
  }
}

main();
