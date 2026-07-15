const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const result = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq > 2) {
      const key = token.slice(2, eq);
      const value = token.slice(eq + 1);
      result[key] = value;
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !String(next).startsWith("--")) {
      result[key] = next;
      i += 1;
      continue;
    }
    result[key] = "1";
  }
  return result;
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function safeReadJson(filePath, maxBytes = 64 * 1024 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function walkCollectZipBasenames(rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  const out = [];
  const stack = [resolvedRoot];
  const skipDirNames = new Set([".git", ".svn", ".assethive", "uassets", "node_modules", "plugins"]);
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (!skipDirNames.has(lower) && !lower.startsWith(".")) {
          stack.push(fullPath);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (path.extname(entry.name).toLowerCase() !== ".zip") continue;
      out.push({ name: path.basename(entry.name, ".zip"), fullPath });
    }
  }
  return out;
}

function guessSourceAssetNames(sourceDir) {
  const zipFiles = walkCollectZipBasenames(sourceDir);
  const byNormalized = new Map();
  for (const item of zipFiles) {
    const norm = normalizeName(item.name);
    if (!norm) continue;
    if (!byNormalized.has(norm)) {
      byNormalized.set(norm, []);
    }
    byNormalized.get(norm).push(item);
  }
  return { byNormalized, zipFiles };
}

function collectLibraryAssetsFromIndex(libraryDir) {
  const indexPath = path.join(path.resolve(libraryDir), ".assethive", "custom-index.json");
  if (!fs.existsSync(indexPath)) return [];
  const json = safeReadJson(indexPath, 256 * 1024 * 1024);
  const assets = Array.isArray(json?.assets) ? json.assets : [];
  const out = [];
  for (const entry of assets) {
    const record = entry?.record;
    if (!record) continue;
    const id = String(record.id || "").trim();
    const name = String(record.name || "").trim();
    const dirPath = String(record.path || "").trim();
    if (!id || !name || !dirPath) continue;
    out.push({ id, name, dirPath, metaPath: String(record.metaPath || "").trim() });
  }
  return out;
}

function collectLibraryAssetsByScanning(libraryDir) {
  const resolvedRoot = path.resolve(libraryDir);
  const out = [];
  const stack = [resolvedRoot];
  const skipDirNames = new Set([".git", ".svn", ".assethive", "uassets", "node_modules", "plugins", "preview", "previews"]);
  const skipFileNames = new Set(["assetsdata.json", "index.json", "custom-index.json", "arkhive_data.json"]);
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirBase = path.basename(dir).toLowerCase();
    const jsonFiles = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((name) => path.extname(name).toLowerCase() === ".json")
      .filter((name) => !skipFileNames.has(name.toLowerCase()));
    if (jsonFiles.length > 0) {
      const preferId = jsonFiles.find((n) => path.basename(n, ".json").toLowerCase() === dirBase);
      const metaName = preferId || jsonFiles[0];
      const metaPath = path.join(dir, metaName);
      const meta = safeReadJson(metaPath);
      const id = String(meta?.assetID || meta?.assetId || meta?.id || path.basename(metaName, ".json") || "").trim();
      const name = String(meta?.name || meta?.semanticTags?.name || "").trim();
      if (id && name) {
        out.push({ id, name, dirPath: dir, metaPath });
        continue;
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const lower = entry.name.toLowerCase();
      if (skipDirNames.has(lower) || lower.startsWith(".")) continue;
      stack.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function collectLibraryAssets(libraryDir) {
  const indexed = collectLibraryAssetsFromIndex(libraryDir);
  if (indexed.length > 0) return { assets: indexed, source: "custom-index.json" };
  const scanned = collectLibraryAssetsByScanning(libraryDir);
  return { assets: scanned, source: "directory-scan" };
}

function buildNameIndex(items) {
  const byNormalized = new Map();
  for (const item of items) {
    const norm = normalizeName(item.name);
    if (!norm) continue;
    if (!byNormalized.has(norm)) byNormalized.set(norm, []);
    byNormalized.get(norm).push(item);
  }
  return byNormalized;
}

function main() {
  const args = parseArgs(process.argv);
  const sourceDir = String(args.source || args.sourceDir || args.path || "").trim();
  const libraryDir = String(args.library || args.libraryDir || "").trim();
  const outPath = String(args.out || "").trim();

  if (!sourceDir || !libraryDir) {
    process.stderr.write("Usage: node compare_imported_assets.js --source <source-dir> --library <library-dir>\n");
    process.exit(2);
  }
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    process.stderr.write(`[错误] sourceDir 无效: ${sourceDir}\n`);
    process.exit(2);
  }
  if (!fs.existsSync(libraryDir) || !fs.statSync(libraryDir).isDirectory()) {
    process.stderr.write(`[错误] libraryDir 无效: ${libraryDir}\n`);
    process.exit(2);
  }

  const source = guessSourceAssetNames(sourceDir);
  const library = collectLibraryAssets(libraryDir);
  const libraryByName = buildNameIndex(library.assets);

  const imported = [];
  const notImported = [];
  for (const [normName, sources] of source.byNormalized.entries()) {
    const hits = libraryByName.get(normName) || [];
    if (hits.length > 0) {
      imported.push({ name: normName, sourceCount: sources.length, libraryCount: hits.length, sources, hits });
    } else {
      notImported.push({ name: normName, sourceCount: sources.length, sources });
    }
  }

  imported.sort((a, b) => a.name.localeCompare(b.name));
  notImported.sort((a, b) => a.name.localeCompare(b.name));

  const report = {
    sourceDir: path.resolve(sourceDir),
    libraryDir: path.resolve(libraryDir),
    libraryDiscovery: library.source,
    sourceZipCount: source.zipFiles.length,
    sourceUniqueCount: source.byNormalized.size,
    libraryAssetCount: library.assets.length,
    libraryUniqueCount: libraryByName.size,
    importedCount: imported.length,
    notImportedCount: notImported.length,
    imported,
    notImported
  };

  process.stdout.write(
    [
      `[完成]`,
      `- source(zip): ${report.sourceZipCount}，去重后: ${report.sourceUniqueCount}`,
      `- library(assets): ${report.libraryAssetCount}，去重后: ${report.libraryUniqueCount}（来源: ${report.libraryDiscovery}）`,
      `- 已导入: ${report.importedCount}`,
      `- 未导入: ${report.notImportedCount}`
    ].join("\n") + "\n"
  );

  if (outPath) {
    const resolvedOut = path.resolve(outPath);
    fs.writeFileSync(resolvedOut, JSON.stringify(report, null, 2), "utf-8");
    process.stdout.write(`[输出] ${resolvedOut}\n`);
  } else {
    const sample = imported.slice(0, 15).map((i) => `  - ${i.name}`).join("\n");
    if (sample) {
      process.stdout.write(`[示例] 已导入(前 15):\n${sample}\n`);
    }
  }
}

main();
