const fs = require("fs");
const path = require("path");
const os = require("os");
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
    } else {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !String(next).startsWith("--")) {
        result[key] = next;
        i += 1;
      } else {
        result[key] = "1";
      }
    }
  }
  return result;
}
function parseBool(value) {
  const t = String(value || "").trim().toLowerCase();
  if (!t) return false;
  if (t === "0" || t === "false" || t === "no" || t === "off") return false;
  return true;
}
function findMetaFiles(rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  const out = [];
  const stack = [resolvedRoot];
  const skipNames = new Set([
    "index.json",
    "assetsdata.json",
    "arkhive_data.json",
    "hivecache.json",
    "hivedata.json",
    "desktop.ini",
    "thumbs.db"
  ]);
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirBase = path.basename(current).toLowerCase();
    const jsonFiles = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((name) => path.extname(name).toLowerCase() === ".json")
      .filter((name) => !skipNames.has(name.toLowerCase()));
    let picked = "";
    if (jsonFiles.length > 0) {
      // Prefer asset_info.json
      const preferInfo = jsonFiles.find((n) => n.toLowerCase() === "asset_info.json" || n.toLowerCase() === "asset_info.jason");
      // Prefer id.json (basename match)
      const preferId = jsonFiles.find((n) => path.basename(n, ".json").toLowerCase() === dirBase);
      picked = preferInfo || preferId || jsonFiles[0];
      if (picked) {
        out.push(path.join(current, picked));
        // Do not descend further from an asset directory
        continue;
      }
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const name = e.name.toLowerCase();
      if (name.startsWith(".") || name.startsWith("$")) continue;
      stack.push(path.join(current, e.name));
    }
  }
  return out;
}
function normalizeFormat(value) {
  const t = String(value || "").trim().toLowerCase();
  if (t === "opengl" || t === "ogl") return "opengl";
  if (t === "dx" || t === "directx") return "dx";
  return "opengl";
}
function processMeta(metaPath, targetFormat) {
  try {
    const raw = fs.readFileSync(metaPath, "utf-8");
    const meta = JSON.parse(raw);
    const fmt = normalizeFormat(targetFormat);
    const current = meta.normalMapFormats && typeof meta.normalMapFormats === "object" ? meta.normalMapFormats : {};
    const next = {};
    const keys = Object.keys(current);
    if (keys.length > 0) {
      for (const k of keys) {
        next[k] = fmt;
      }
    } else {
      next["1"] = fmt;
    }
    meta.normalMapFormats = next;
    meta.normalMapFormat = fmt;
    const tmp = path.join(os.tmpdir(), "assethive-normalfmt-" + Math.random().toString(36).slice(2) + ".json");
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), "utf-8");
    const len = fs.statSync(tmp).size;
    fs.writeFileSync(metaPath, fs.readFileSync(tmp));
    try { fs.unlinkSync(tmp); } catch { void 0; }
    return { ok: true, bytes: len };
  } catch (error) {
    return { ok: false, message: error.message || String(error) };
  }
}
async function main() {
  const args = parseArgs(process.argv);
  const library = String(args.library || args.path || "").trim();
  const format = normalizeFormat(args.format || args.normal || "opengl");
  const dryRun = parseBool(args.dry || args["dry-run"]);
  if (!library) {
    process.stderr.write("Usage: node batch_set_normal_format.js --library <library-dir> [--format opengl|dx]\n");
    process.exit(2);
  }
  if (!fs.existsSync(library) || !fs.statSync(library).isDirectory()) {
    process.stderr.write(`[错误] 路径无效: ${library}\n`);
    process.exit(2);
  }
  process.stdout.write(`[开始] 扫描自定义库: ${path.resolve(library)}\n`);
  const metas = findMetaFiles(library);
  process.stdout.write(`[发现] 资产数量(按 meta): ${metas.length}\n`);
  let updated = 0;
  let failed = 0;
  let skipped = 0;
  for (let i = 0; i < metas.length; i += 1) {
    const p = metas[i];
    const dir = path.dirname(p);
    const percent = Math.round(((i + 1) / metas.length) * 100);
    if (dryRun) {
      process.stdout.write(`[预览] ${percent}% ${dir}\n`);
      skipped += 1;
      continue;
    }
    const res = processMeta(p, format);
    if (res.ok) {
      updated += 1;
      if (updated <= 6 || updated % 250 === 0) {
        process.stdout.write(`[更新] ${percent}% ${dir}\n`);
      }
    } else {
      failed += 1;
      process.stdout.write(`[失败] ${dir} -> ${res.message}\n`);
    }
  }
  process.stdout.write(`[完成] 设置 normalMapFormat=${format} 更新 ${updated} 跳过 ${skipped} 失败 ${failed}\n`);
}
main().catch((e) => {
  process.stderr.write(`[错误] ${e.message || String(e)}\n`);
  process.exit(1);
});
