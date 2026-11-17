const fs = require("node:fs");
const path = require("node:path");
const { parseModelVariantKey, toOpaqueVariantFileStem } = require("./modelVariants");

function basenameOf(value) {
  const raw = String(value || "").replace(/\\/g, "/");
  return raw.slice(raw.lastIndexOf("/") + 1);
}

function replaceBasename(value, renameByBasename) {
  if (typeof value !== "string") return value;
  const base = basenameOf(value);
  if (!base) return value;
  const replacement = renameByBasename.get(base.toLowerCase());
  if (!replacement || replacement === base) return value;
  return value.slice(0, value.length - base.length) + replacement;
}

function rewriteOpaqueFileReferences(value, renameByBasename) {
  if (typeof value === "string") return replaceBasename(value, renameByBasename);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = rewriteOpaqueFileReferences(value[index], renameByBasename);
    }
    return value;
  }
  if (!value || typeof value !== "object") return value;
  for (const key of Object.keys(value)) {
    value[key] = rewriteOpaqueFileReferences(value[key], renameByBasename);
  }
  return value;
}

function repairOpaqueVariantRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return;
  const file = record.file || record.uri || record.path || "";
  const base = basenameOf(file);
  if (!/\.fbx$/i.test(base)) return;
  const stem = base.slice(0, -path.extname(base).length);
  if (!/OPAQUE$/i.test(stem)) return;
  const variantKey = parseModelVariantKey(base);
  if (!variantKey || !/OPAQUE$/i.test(variantKey)) return;
  record.variantKey = variantKey;
  delete record.variantNumber;
}

function repairOpaqueVariantRecords(metadata) {
  for (const key of ["modelVariants", "modelLods", "components"]) {
    const list = Array.isArray(metadata?.[key]) ? metadata[key] : [];
    for (const record of list) repairOpaqueVariantRecord(record);
  }
}

function collectOpaqueRenamePlan(assetDir) {
  const directory = String(assetDir || "").trim();
  if (!directory || !fs.existsSync(directory)) return [];
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const namesOnDisk = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry.name]));
  const plan = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.fbx$/i.test(entry.name)) continue;
    const extension = path.extname(entry.name);
    const stem = entry.name.slice(0, -extension.length);
    const canonicalStem = toOpaqueVariantFileStem(stem);
    if (!canonicalStem || canonicalStem === stem) continue;
    const targetName = canonicalStem + extension;
    const existing = namesOnDisk.get(targetName.toLowerCase());
    if (existing && existing !== entry.name) {
      throw new Error("Target already exists, refusing to overwrite: " + path.join(directory, existing));
    }
    plan.push({ from: entry.name, to: targetName });
  }
  return plan.sort((left, right) => left.from.localeCompare(right.from, undefined, { numeric: true }));
}

function rollbackOpaqueRenamePlan(assetDir, renames) {
  const plan = Array.isArray(renames) ? renames : [];
  const errors = [];
  for (let index = plan.length - 1; index >= 0; index -= 1) {
    const item = plan[index];
    try {
      fs.renameSync(path.join(assetDir, item.to), path.join(assetDir, item.from));
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    const error = new Error("Failed to roll back " + errors.length + " OPAQUE rename(s)");
    error.cause = errors[0];
    throw error;
  }
}

function applyOpaqueRenamePlan(assetDir, renames) {
  const applied = [];
  try {
    for (const item of Array.isArray(renames) ? renames : []) {
      const fromPath = path.join(assetDir, item.from);
      const toPath = path.join(assetDir, item.to);
      if (!fs.existsSync(fromPath)) throw new Error("Source file disappeared: " + fromPath);
      if (fs.existsSync(toPath) && path.resolve(fromPath).toLowerCase() !== path.resolve(toPath).toLowerCase()) {
        throw new Error("Target already exists, refusing to overwrite: " + toPath);
      }
      fs.renameSync(fromPath, toPath);
      applied.push(item);
    }
  } catch (error) {
    try {
      rollbackOpaqueRenamePlan(assetDir, applied);
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  }
  return applied;
}

function prepareOpaqueFilenameMigration(assetDir, metadata) {
  const renames = collectOpaqueRenamePlan(assetDir);
  const sourceMetadata = metadata && typeof metadata === "object" ? metadata : {};
  const nextMetadata = JSON.parse(JSON.stringify(sourceMetadata));
  if (renames.length > 0) {
    const renameByBasename = new Map(renames.map((item) => [item.from.toLowerCase(), item.to]));
    rewriteOpaqueFileReferences(nextMetadata, renameByBasename);
  }
  repairOpaqueVariantRecords(nextMetadata);
  const changed = renames.length > 0 || JSON.stringify(nextMetadata) !== JSON.stringify(sourceMetadata);
  return { changed, renames, metadata: changed ? nextMetadata : metadata };
}

module.exports = {
  basenameOf,
  replaceBasename,
  rewriteOpaqueFileReferences,
  repairOpaqueVariantRecord,
  repairOpaqueVariantRecords,
  collectOpaqueRenamePlan,
  rollbackOpaqueRenamePlan,
  applyOpaqueRenamePlan,
  prepareOpaqueFilenameMigration
};
