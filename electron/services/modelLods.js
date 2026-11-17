const path = require("node:path");
const {
  parseModelVariantKey,
  normalizeModelVariantKey,
  modelVariantNumberFromKey,
  compareModelVariantKeys
} = require("./modelVariants");

function isLodFile(filePath) {
  const base = path.basename(String(filePath || ""), path.extname(String(filePath || ""))).toLowerCase();
  return Boolean(base) && /(?:^|[_.-])lod(?:[_-]?\d+)?(?:$|[_.-])/.test(base);
}

function getLodOrder(filePath) {
  const base = path.basename(String(filePath || ""), path.extname(String(filePath || ""))).toLowerCase();
  const match = base.match(/(?:^|[_.-])lod[_-]?(\d+)(?=$|[_.-])/i);
  return match ? Math.max(0, Number(match[1]) || 0) : Number.MAX_SAFE_INTEGER;
}

function normalizeEntry(entry) {
  if (typeof entry === "string") {
    return { filePath: entry, variantKey: "" };
  }
  return {
    filePath: String(entry?.filePath || entry?.file || entry?.path || "").trim(),
    variantKey: String(entry?.variantKey || "").trim()
  };
}

function entryVariantKey(entry) {
  const explicit = normalizeModelVariantKey(entry.variantKey, "");
  if (explicit) return explicit;
  const parsed = parseModelVariantKey(entry.filePath);
  if (parsed) return parsed;
  const base = path.basename(entry.filePath, path.extname(entry.filePath))
    .replace(/(?:[_\-. ]+lod[_\-. ]*\d*)(?:[_\-. ].*)?$/i, "");
  return normalizeModelVariantKey(parseModelVariantKey(base), "01");
}

function choosePreferredExtension(entries) {
  const extensions = new Set(entries.map((entry) => path.extname(entry.filePath).toLowerCase()));
  if (extensions.has(".fbx")) return ".fbx";
  if (extensions.has(".st9")) return ".st9";
  if (extensions.has(".obj")) return ".obj";
  return entries[0] ? path.extname(entries[0].filePath).toLowerCase() : "";
}

function buildModelLodPlan(entries) {
  const normalized = (Array.isArray(entries) ? entries : [])
    .map(normalizeEntry)
    .filter((entry) => entry.filePath)
    .filter((entry, index, list) => list.findIndex((item) => item.filePath.toLowerCase() === entry.filePath.toLowerCase()) === index);
  if (!normalized.some((entry) => isLodFile(entry.filePath))) {
    return {
      primaryFiles: normalized.map((entry) => entry.filePath),
      modelVariants: [],
      modelLods: []
    };
  }

  const groups = new Map();
  for (const entry of normalized) {
    const variantKey = entryVariantKey(entry);
    const group = groups.get(variantKey) || [];
    group.push({ ...entry, variantKey });
    groups.set(variantKey, group);
  }

  const primaryFiles = [];
  const modelVariants = [];
  const modelLods = [];
  const orderedGroups = [...groups.entries()].sort(([left], [right]) => compareModelVariantKeys(left, right));
  for (const [variantKey, groupEntries] of orderedGroups) {
    const preferredExtension = choosePreferredExtension(groupEntries);
    const preferredEntries = groupEntries.filter((entry) => path.extname(entry.filePath).toLowerCase() === preferredExtension);
    const nonLodEntries = preferredEntries.filter((entry) => !isLodFile(entry.filePath));
    const lodEntries = preferredEntries.filter((entry) => isLodFile(entry.filePath));
    const primary = (nonLodEntries.length > 0 ? nonLodEntries : lodEntries)
      .sort((left, right) => {
        const lodDelta = getLodOrder(left.filePath) - getLodOrder(right.filePath);
        return lodDelta || left.filePath.localeCompare(right.filePath, undefined, { numeric: true, sensitivity: "base" });
      })[0];
    if (!primary) continue;

    const variantNumber = modelVariantNumberFromKey(variantKey);
    primaryFiles.push(primary.filePath);
    modelVariants.push({
      file: primary.filePath,
      variantKey,
      ...(variantNumber > 0 ? { variantNumber } : {})
    });

    const lodsByOrder = new Map();
    for (const entry of lodEntries) {
      const lod = getLodOrder(entry.filePath);
      if (lod === Number.MAX_SAFE_INTEGER) continue;
      if (!lodsByOrder.has(lod)) lodsByOrder.set(lod, entry);
    }
    if (!isLodFile(primary.filePath) && !lodsByOrder.has(0)) {
      lodsByOrder.set(0, primary);
    }
    for (const [lod, entry] of [...lodsByOrder.entries()].sort(([left], [right]) => left - right)) {
      modelLods.push({
        file: entry.filePath,
        variantKey,
        ...(variantNumber > 0 ? { variantNumber } : {}),
        lod
      });
    }
  }

  return { primaryFiles, modelVariants, modelLods };
}

module.exports = {
  isLodFile,
  getLodOrder,
  buildModelLodPlan
};
