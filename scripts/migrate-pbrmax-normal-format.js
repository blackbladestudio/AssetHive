// 一次性迁移：把库内 Environment 下 PBRMAX 资产的已保存法线格式统一改为 opengl。
//
// 背景：导入侧的法线格式自动检测已撤销（见 docs/prototype/assethive-extension-requirements.md 3.9），
// 新导入统一默认 dx。库内 PBRMAX 资产此前被自动检测写成了 dx，需要按人工结论改为 opengl；
// 撤销后软件不会再重算该字段（"更新元数据"保留已保存的 normalMapFormat / normalMapFormats）。
//
//   1) 目标范围：<库根>/Environment 下 standardAssetTags 命中 PBRMAX（或 identity.sourceKind
//      为 pbrmax）且带 Normal 贴图条目的资产
//   2) 改写字段：normalMapFormat、normalMapFormats[每个区域]、components[].normalMapFormat、
//      textureEntries[].normalMapFormat（仅 Normal 项），并按既有写法重算 json.contentLength
//   3) 不改模型 / 贴图文件，不改其它元数据字段（含 updatedAt），写前逐个备份
//
// 用法：
//   node scripts/migrate-pbrmax-normal-format.js                  # dry-run，只打印将发生的变化
//   node scripts/migrate-pbrmax-normal-format.js --apply          # 备份后写回
//   node scripts/migrate-pbrmax-normal-format.js --library <库根> --scope <子目录> --out <备份目录>
const fs = require("fs");
const path = require("path");
// scripts/ 的 lint 配置没有声明 Buffer 全局（既有 fix_category*.js 因此带着 no-undef），这里显式引入。
const { Buffer } = require("node:buffer");

const APPLY = process.argv.includes("--apply");
const TARGET_FORMAT = "opengl";
const DEFAULT_SCOPE_NAME = "Environment";
const ENVIRONMENT_ASSET_TYPES = new Set(["3d", "3dplant", "surface", "decal", "hdri"]);
const SKIP_DIR_NAMES = new Set([".assethive", "trash", "temp", "preview", "node_modules", "saved"]);

function readArgValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return String(process.argv[index + 1] || "").trim();
}

function resolveLibraryRoot() {
  const fromArg = readArgValue("--library");
  if (fromArg) return fromArg;
  const settingsPath = path.join(process.env.APPDATA || "", "AssetHive", "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const configured = String(settings.customLibraryPath || "").trim();
    if (configured) return configured;
  } catch {
    void 0;
  }
  throw new Error(`未找到库根目录：请用 --library <库根> 指定（已尝试 ${settingsPath}）`);
}

function walkAssetMetaFiles(root) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      console.log(`[跳过] 无法读取 ${dir}：${error.message}`);
      continue;
    }
    let hasMeta = false;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name.toLowerCase())) continue;
        stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === "asset_info.json") {
        hasMeta = true;
      }
    }
    if (hasMeta) found.push(path.join(dir, "asset_info.json"));
  }
  return found;
}

function lowerText(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

// 库内既有资产用 standardAssetTags: ["PBRMAX"] 标记来源，identity.sourceKind 为导入时写入的
// 来源键（pbrmax）。两者任一命中即算 PBRMAX；只在 tags / semanticTags 里出现时单独报告，不自动改写。
function classifySource(meta) {
  const standardTags = (Array.isArray(meta.standardAssetTags) ? meta.standardAssetTags : []).map(lowerText);
  const sourceKind = lowerText(meta.identity && meta.identity.sourceKind);
  if (standardTags.includes("pbrmax") || sourceKind === "pbrmax") return "pbrmax";
  const weakTags = [
    ...(Array.isArray(meta.tags) ? meta.tags : []),
    ...(Array.isArray(meta.categories) ? meta.categories : []),
    ...(meta.semanticTags && Array.isArray(meta.semanticTags.contains) ? meta.semanticTags.contains : [])
  ].map(lowerText);
  return weakTags.includes("pbrmax") ? "pbrmax-weak" : "";
}

function isEnvironmentAsset(meta) {
  const topCategory = lowerText(meta.topCategory);
  if (topCategory) return topCategory === "environment";
  return ENVIRONMENT_ASSET_TYPES.has(lowerText(meta.assetType || meta.asset_type));
}

function isNormalItem(item) {
  if (!item || typeof item !== "object") return false;
  return lowerText(item.textureType) === "normal" || lowerText(item.slot) === "normal";
}

// Normal 贴图按 UDIM 分区保存格式，区域号来自 components[].areaIndex / textureEntries[].areaIndex。
function collectNormalAreaIds(meta) {
  const areas = new Set();
  const visit = (list) => {
    for (const item of Array.isArray(list) ? list : []) {
      if (!isNormalItem(item)) continue;
      areas.add(Math.max(1, Number(item.areaIndex ?? item.areaId) || 1));
    }
  };
  visit(meta.components);
  visit(meta.textureEntries);
  return [...areas].sort((left, right) => left - right);
}

function setNormalFormatOnItems(list, changes, label) {
  for (const item of Array.isArray(list) ? list : []) {
    if (!isNormalItem(item)) continue;
    if (lowerText(item.normalMapFormat) === TARGET_FORMAT) continue;
    changes.push(`${label}[area ${Math.max(1, Number(item.areaIndex ?? item.areaId) || 1)}].normalMapFormat: ${JSON.stringify(item.normalMapFormat ?? null)} -> ${JSON.stringify(TARGET_FORMAT)}`);
    item.normalMapFormat = TARGET_FORMAT;
  }
}

// 与库内既有元数据写法一致：序列化长度会写进 json.contentLength，长度变化需要迭代收敛。
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

// 计算并（在写回模式下）应用法线格式改写；返回本次变化的描述，未变化时返回空数组。
function planNormalFormat(meta) {
  const changes = [];
  const areas = collectNormalAreaIds(meta);
  const currentFormat = lowerText(meta.normalMapFormat);
  if (currentFormat !== TARGET_FORMAT) {
    changes.push(`normalMapFormat: ${JSON.stringify(meta.normalMapFormat ?? null)} -> ${JSON.stringify(TARGET_FORMAT)}`);
    meta.normalMapFormat = TARGET_FORMAT;
  }
  const existing = meta.normalMapFormats && typeof meta.normalMapFormats === "object" && !Array.isArray(meta.normalMapFormats)
    ? meta.normalMapFormats
    : {};
  const before = JSON.stringify(existing);
  const nextFormats = {};
  const keys = [...new Set([...Object.keys(existing), ...areas.map((area) => String(area)), "1"])];
  for (const key of keys) {
    if (!key) continue;
    nextFormats[key] = TARGET_FORMAT;
  }
  if (JSON.stringify(nextFormats) !== before) {
    changes.push(`normalMapFormats: ${before} -> ${JSON.stringify(nextFormats)}`);
    meta.normalMapFormats = nextFormats;
  }
  setNormalFormatOnItems(meta.components, changes, "components");
  setNormalFormatOnItems(meta.textureEntries, changes, "textureEntries");
  return changes;
}

function main() {
  const libraryRoot = resolveLibraryRoot();
  const scopeRoot = readArgValue("--scope") || path.join(libraryRoot, DEFAULT_SCOPE_NAME);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = readArgValue("--out") || path.join(__dirname, "..", ".cache", "pbrmax-normal-format", stamp);
  const apply = APPLY;

  console.log(`库根：${libraryRoot}`);
  console.log(`范围：${scopeRoot}`);
  console.log(`目标法线格式：${TARGET_FORMAT}`);
  console.log(`模式：${apply ? "写回（先备份）" : "dry-run（不写盘）"}`);
  if (apply) console.log(`备份 / 报告目录：${outDir}`);
  console.log("");

  const metaFiles = walkAssetMetaFiles(scopeRoot);
  console.log(`发现 asset_info.json：${metaFiles.length} 个`);

  const stats = {
    scanned: 0,
    unreadable: 0,
    pbrmaxEnvironment: 0,
    pbrmaxWeak: [],
    noNormal: [],
    alreadyTarget: 0,
    changed: 0,
    byAssetType: {},
    byPreviousFormat: {},
    failures: []
  };
  const planned = [];

  for (const metaPath of metaFiles) {
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch (error) {
      stats.unreadable += 1;
      stats.failures.push({ metaPath, reason: `读取失败：${error.message}` });
      continue;
    }
    stats.scanned += 1;
    if (!meta || typeof meta !== "object") continue;

    const source = classifySource(meta);
    const assetLabel = path.relative(libraryRoot, path.dirname(metaPath)) || path.dirname(metaPath);
    if (source === "pbrmax-weak") {
      stats.pbrmaxWeak.push(assetLabel);
      continue;
    }
    if (source !== "pbrmax" || !isEnvironmentAsset(meta)) continue;
    stats.pbrmaxEnvironment += 1;

    const areas = collectNormalAreaIds(meta);
    if (areas.length === 0) {
      stats.noNormal.push(assetLabel);
      continue;
    }

    const previousFormat = lowerText(meta.normalMapFormat) || "(缺失)";
    const changes = planNormalFormat(meta);
    if (changes.length === 0) {
      stats.alreadyTarget += 1;
      continue;
    }
    stats.changed += 1;
    const assetType = lowerText(meta.assetType || meta.asset_type) || "(未知)";
    stats.byAssetType[assetType] = (stats.byAssetType[assetType] || 0) + 1;
    stats.byPreviousFormat[previousFormat] = (stats.byPreviousFormat[previousFormat] || 0) + 1;
    planned.push({ metaPath, assetLabel, assetType, areas, previousFormat, changes, text: apply ? finalizeContentLength(meta) : "" });
  }

  console.log(`可识别资产：${stats.scanned}（读取失败 ${stats.unreadable}）`);
  console.log(`PBRMAX 且属 Environment：${stats.pbrmaxEnvironment}`);
  console.log(`  其中带 Normal 贴图：${stats.pbrmaxEnvironment - stats.noNormal.length}（无 Normal 跳过 ${stats.noNormal.length}）`);
  console.log(`  已是 ${TARGET_FORMAT}：${stats.alreadyTarget}`);
  console.log(`  需要改写：${stats.changed}`);
  console.log(`按 Asset Type：${JSON.stringify(stats.byAssetType)}`);
  console.log(`按原格式：${JSON.stringify(stats.byPreviousFormat)}`);
  if (stats.pbrmaxWeak.length > 0) {
    console.log(`\n[需人工确认] 仅在 tags 里出现 PBRMAX、未命中标准 Asset Tag / sourceKind 的资产 ${stats.pbrmaxWeak.length} 个（未改写）：`);
    stats.pbrmaxWeak.slice(0, 20).forEach((item) => console.log(`    ${item}`));
    if (stats.pbrmaxWeak.length > 20) console.log(`    ...（另有 ${stats.pbrmaxWeak.length - 20} 个，见报告）`);
  }
  if (stats.noNormal.length > 0) {
    console.log(`\n[跳过] PBRMAX 但无 Normal 贴图条目的资产 ${stats.noNormal.length} 个：`);
    stats.noNormal.slice(0, 20).forEach((item) => console.log(`    ${item}`));
    if (stats.noNormal.length > 20) console.log(`    ...（另有 ${stats.noNormal.length - 20} 个，见报告）`);
  }
  console.log(`\n[将改写 ${planned.length} 个资产]`);
  planned.slice(0, 20).forEach((job) => {
    console.log(`\n  ${job.assetLabel}（${job.assetType}，区域 ${job.areas.join("/")}）`);
    job.changes.forEach((change) => console.log(`      ${change}`));
  });
  if (planned.length > 20) console.log(`\n  ...（另有 ${planned.length - 20} 个，见报告）`);

  let written = 0;
  if (apply) {
    const backupRoot = path.join(outDir, "backup");
    for (const job of planned) {
      const relative = path.relative(libraryRoot, job.metaPath);
      const backupPath = path.join(backupRoot, relative);
      try {
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(job.metaPath, backupPath);
        fs.writeFileSync(job.metaPath, job.text, "utf8");
        written += 1;
      } catch (error) {
        stats.failures.push({ metaPath: job.metaPath, reason: `写入失败：${error.message}` });
      }
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, apply ? "report-apply.json" : "report-dry-run.json");
  fs.writeFileSync(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: apply ? "apply" : "dry-run",
    libraryRoot,
    scopeRoot,
    targetFormat: TARGET_FORMAT,
    stats,
    planned: planned.map((job) => ({
      metaPath: job.metaPath,
      asset: job.assetLabel,
      assetType: job.assetType,
      areas: job.areas,
      previousFormat: job.previousFormat,
      changes: job.changes
    }))
  }, null, 2), "utf8");

  console.log("");
  if (apply) {
    console.log(`[完成] 已写回 ${written} 个 asset_info.json，失败 ${stats.failures.length} 个`);
    console.log(`备份：${path.join(outDir, "backup")}（按库内相对路径存放原始文件，需要回滚时逐个拷回）`);
  } else {
    console.log("(dry-run：未写回。加 --apply 执行)");
  }
  console.log(`报告：${reportPath}`);
  if (stats.failures.length > 0) {
    console.log("\n[失败明细]");
    stats.failures.slice(0, 20).forEach((item) => console.log(`    ${item.metaPath}：${item.reason}`));
  }
}

main();
