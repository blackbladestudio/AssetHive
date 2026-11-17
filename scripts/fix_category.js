// 通用批量改分类：按 name/slug 正则匹配，把 category 从 --from 改为 --to。
// 同步改写 category / tags / categories / semanticTags.theme / subject_matter / contains，
// 并重算 json.contentLength。
// 用法：
//   node scripts/fix_category.js --match SLZB --from Building --to Nature            # dry-run
//   node scripts/fix_category.js --match SLZB --from Building --to Nature --apply    # 实际写回
//   node scripts/fix_category.js --match SLZB --from Building --to Nature --root "//host/share/..." [--apply]
const { Buffer } = require("node:buffer");
const fs = require("fs");
const path = require("path");

const DEFAULT_ROOT = "//fileshare/share/Artist/AssetLibrary/Environment/3D Assets";

function parseArgs(argv) {
  const result = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = String(argv[i + 1] || "");
    if (next && !next.startsWith("--")) {
      result[key] = next;
      i += 1;
    } else {
      result[key] = "1";
    }
  }
  return result;
}

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
    if (!meta.json || typeof meta.json !== "object") meta.json = {};
    meta.json.contentLength = contentLength;
    text = JSON.stringify(meta, null, 2);
    const actualLength = Buffer.byteLength(text, "utf8");
    if (actualLength === contentLength) return text;
    contentLength = actualLength;
  }
  meta.json.contentLength = Buffer.byteLength(text, "utf8");
  return JSON.stringify(meta, null, 2);
}

function readMeta(metaPath) {
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv);
  const root = String(args.root || DEFAULT_ROOT);
  const match = new RegExp(String(args.match || ""), "i");
  const from = String(args.from || "").trim();
  const to = String(args.to || "").trim();
  const apply = Boolean(args.apply);

  if (!args.match || !from || !to) {
    console.error("用法: node fix_category.js --match <regex> --from <旧分类> --to <新分类> [--root <路径>] [--apply]");
    process.exit(1);
  }

  const oldLower = from.toLowerCase();
  const newLower = to.toLowerCase();
  const caseMap = { [from]: to, [oldLower]: newLower };

  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  const targets = [];
  for (const d of dirs) {
    const metaPath = path.join(root, d.name, "asset_info.json");
    const meta = readMeta(metaPath);
    if (!meta) continue;
    const haystack = `${String(meta.name || "")} ${d.name}`;
    if (!match.test(haystack)) continue;
    if (String(meta.category || "") !== from) continue;
    targets.push({ slug: d.name, metaPath, meta });
  }

  console.log(`匹配 --match=/${args.match}/i 且 category="${from}" 的资产：${targets.length} 个${apply ? "" : " [dry-run]"}`);

  if (!apply) {
    for (const t of targets) {
      const changes = remapCategoryTokens(t.meta, caseMap, oldLower, newLower);
      console.log(`\n${t.slug}`);
      for (const c of changes) console.log(`    ${c}`);
    }
    console.log("\n(dry-run：未写回。加 --apply 执行)");
    return;
  }

  let written = 0;
  for (const t of targets) {
    const fresh = readMeta(t.metaPath);
    if (!fresh) continue;
    remapCategoryTokens(fresh, caseMap, oldLower, newLower);
    const text = finalizeContentLength(fresh);
    fs.writeFileSync(t.metaPath, text, "utf8");
    written += 1;
  }
  console.log(`[完成] 已写回 ${written} 个 asset_info.json`);
}

main();
