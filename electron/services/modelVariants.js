const path = require("node:path");

const NON_VARIANT_TOKENS = new Set([
  "base", "default", "high", "highpoly", "low", "lod", "mid", "preview", "render", "thumb", "thumbnail"
]);

function fileStem(filePath) {
  const raw = String(filePath || "").trim();
  if (!raw) return "";
  const extension = path.extname(raw);
  return path.basename(raw, extension);
}

function normalizeModelVariantKey(value, fallback = "") {
  let raw = String(value ?? "").trim();
  if (!raw) return String(fallback || "");
  const prefixed = raw.match(/^(?:variation|variant|var)[\s._-]*(.+)$/i);
  if (prefixed) raw = prefixed[1];
  raw = raw.replace(/[^A-Za-z0-9]+/g, "");
  if (!raw) return String(fallback || "");
  const numericKey = raw.match(/^(\d+)(opaque)?$/i);
  if (numericKey) {
    const numeric = Number(numericKey[1]);
    if (!Number.isFinite(numeric) || numeric <= 0) return String(fallback || "");
    const number = String(Math.floor(numeric)).padStart(2, "0");
    return numericKey[2] ? number + OPAQUE_VARIANT_SUFFIX : number;
  }
  return raw.toUpperCase().slice(0, 32);
}

function modelVariantNumberFromKey(value) {
  const normalized = normalizeModelVariantKey(value);
  if (!/^\d+$/.test(normalized)) return 0;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function isValidParsedVariantToken(value) {
  const token = String(value || "").trim();
  if (!token || NON_VARIANT_TOKENS.has(token.toLowerCase())) return false;
  if (/^lod[_-]?\d*$/i.test(token)) return false;
  if (/^(?:1|2|4|8|16|32)k$/i.test(token)) return false;
  return /^[A-Za-z0-9]{1,6}$/.test(token);
}

const OPAQUE_VARIANT_SUFFIX = "OPAQUE";
const OPAQUE_VARIANT_FILE_SUFFIX = "_OPAQUE";

// Transparency-cut foliage variants keep the source variant key plus an OPAQUE
// suffix. SM_x_01_OPAQUE.fbx is the canonical library name; the previous
// SM_x_01OPAQUE.fbx form is still parsed so unchanged libraries keep working.
// The suffix is part of the key, so a cut mesh is never renumbered as an
// implicit variant on a later metadata rewrite.
function matchOpaqueVariantToken(stem) {
  const raw = String(stem || "");
  const isBareOpaqueToken = (value) => /^\d{1,3}$/.test(value) ||
    /^[A-Za-z]$/.test(value) ||
    /^(?:[A-Za-z]\d{1,2}|\d{1,3}[A-Za-z])$/.test(value);
  const hasBaseBefore = (match) => Boolean(
    match && match.index > 0 && /[_\-. ]/.test(raw.slice(0, match.index))
  );
  // Prefer the explicit Var/Variant/Variation form so SM_x_VarB_OPAQUE is
  // interpreted as source variant B rather than as an unrelated token.
  const named = raw.match(/(?:^|[_\-. ])(?:variation|variant|var)[_\-.\s]*([A-Za-z0-9]{1,6})[_\-.\s]*OPAQUE$/i);
  if (hasBaseBefore(named) && isValidParsedVariantToken(named[1])) return named;
  const bare = raw.match(/(?:^|[_\-. ])([A-Za-z0-9]{1,6})[_\-.\s]*OPAQUE$/i);
  if (hasBaseBefore(bare) && isBareOpaqueToken(bare[1]) && isValidParsedVariantToken(bare[1])) return bare;
  return null;
}

function readOpaqueVariantToken(stem) {
  const match = matchOpaqueVariantToken(stem);
  const token = match?.[1] || "";
  if (!token) return "";
  const normalized = normalizeModelVariantKey(token);
  return normalized ? normalized + OPAQUE_VARIANT_SUFFIX : "";
}

function stripOpaqueVariantSuffix(stem) {
  const match = matchOpaqueVariantToken(stem);
  if (!match) return null;
  return String(stem).slice(0, match.index).replace(/[_\-.\s]+$/g, "").trim();
}

// Canonical cut mesh file stem: "SM_x_01OPAQUE" -> "SM_x_01_OPAQUE".
// Returns the canonical stem for either legacy or canonical cut-mesh names,
// and an empty string when the input is not a cut mesh.
function toOpaqueVariantFileStem(stem) {
  const raw = String(stem || "").trim();
  const match = matchOpaqueVariantToken(raw);
  if (!match) return "";
  const token = normalizeModelVariantKey(match[1]);
  if (!token) return "";
  const base = raw.slice(0, match.index).replace(/[_\-.\s]+$/g, "").trim();
  if (!base) return "";
  return base + "_" + token + OPAQUE_VARIANT_FILE_SUFFIX;
}

function parseModelVariantKey(filePath) {
  const stem = fileStem(filePath);
  if (!stem) return "";

  const opaqueToken = readOpaqueVariantToken(stem);
  if (opaqueToken) return opaqueToken;

  const namedMatches = [...stem.matchAll(/(?:^|[_\-. ])(?:variation|variant|var)[_\-.\s]*([A-Za-z0-9]{1,6})(?=$|[_\-. ])/gi)];
  const namedToken = namedMatches.at(-1)?.[1] || "";
  if (isValidParsedVariantToken(namedToken)) {
    return normalizeModelVariantKey(namedToken);
  }

  const trailingMatch = stem.match(/(?:^|[_\-. ])([A-Za-z0-9]{1,6})$/);
  const token = trailingMatch?.[1] || "";
  if (!isValidParsedVariantToken(token)) return "";

  if (/^\d{1,3}$/.test(token) || /^[A-Za-z]$/.test(token) || /^(?:[A-Za-z]\d{1,2}|\d{1,3}[A-Za-z])$/.test(token)) {
    return normalizeModelVariantKey(token);
  }
  return "";
}

function stripModelVariantKey(filePath) {
  const stem = fileStem(filePath);
  if (!stem) return "";

  const opaqueStripped = stripOpaqueVariantSuffix(stem);
  if (opaqueStripped !== null) return opaqueStripped;

  const namedStripped = stem
    .replace(/(?:^|[_\-. ])(?:variation|variant|var)[_\-.\s]*([A-Za-z0-9]{1,6})(?=$|[_\-. ])/gi, "")
    .replace(/[_\-.\s]+$/g, "")
    .trim();
  if (namedStripped !== stem) return namedStripped;

  const trailingMatch = stem.match(/(?:^|[_\-. ])([A-Za-z0-9]{1,6})$/);
  const token = trailingMatch?.[1] || "";
  if (!isValidParsedVariantToken(token)) return stem;
  if (/^\d{1,3}$/.test(token) || /^[A-Za-z]$/.test(token) || /^(?:[A-Za-z]\d{1,2}|\d{1,3}[A-Za-z])$/.test(token)) {
    return stem.slice(0, trailingMatch.index).replace(/[_\-.\s]+$/g, "").trim();
  }
  return stem;
}
function parseModelVariantNumber(filePath) {
  return modelVariantNumberFromKey(parseModelVariantKey(filePath));
}

function normalizeModelVariantNumber(value, fallback = 1) {
  const normalized = normalizeModelVariantKey(value);
  const parsed = modelVariantNumberFromKey(normalized);
  if (parsed > 0) return parsed;
  const fallbackNumber = Number(fallback);
  return Number.isFinite(fallbackNumber) && fallbackNumber > 0 ? Math.floor(fallbackNumber) : 1;
}

function formatModelVariantNumber(value) {
  return String(normalizeModelVariantNumber(value)).padStart(2, "0");
}

function normalizeVariantEntry(entry) {
  if (Array.isArray(entry)) {
    return { slot: String(entry[0] || ""), filePath: String(entry[1] || ""), explicit: entry[2] };
  }
  if (entry && typeof entry === "object") {
    return {
      slot: String(entry.slot || entry.key || ""),
      filePath: String(entry.filePath || entry.source || entry.file || ""),
      explicit: entry.variantKey ?? entry.variantNumber
    };
  }
  return { slot: "", filePath: "", explicit: undefined };
}

function buildModelVariantKeyMap(entries, explicitByKey = {}) {
  const explicitMap = explicitByKey && typeof explicitByKey === "object" ? explicitByKey : {};
  const normalizedEntries = (Array.isArray(entries) ? entries : []).map((entry) => {
    const parsed = normalizeVariantEntry(entry);
    const slotKey = parsed.slot.toLowerCase();
    const explicitValue = parsed.explicit ?? explicitMap[parsed.slot] ?? explicitMap[slotKey];
    return {
      slot: parsed.slot,
      filePath: parsed.filePath,
      explicit: normalizeModelVariantKey(explicitValue),
      parsed: parseModelVariantKey(parsed.filePath)
    };
  });
  const used = new Set(normalizedEntries.map((entry) => entry.explicit || entry.parsed).filter(Boolean));
  let nextImplicit = 1;
  const result = new Map();

  for (const entry of normalizedEntries) {
    let variantKey = entry.explicit || entry.parsed;
    if (!variantKey) {
      while (used.has(String(nextImplicit).padStart(2, "0"))) nextImplicit += 1;
      variantKey = String(nextImplicit).padStart(2, "0");
      used.add(variantKey);
      nextImplicit += 1;
    }
    result.set(entry.slot.toLowerCase(), variantKey);
  }

  return result;
}

function buildModelVariantNumberMap(entries) {
  const keyMap = buildModelVariantKeyMap(entries);
  const result = new Map();
  let fallback = 1;
  for (const [slot, key] of keyMap) {
    const numeric = modelVariantNumberFromKey(key);
    if (numeric > 0) {
      result.set(slot, numeric);
      fallback = Math.max(fallback, numeric + 1);
    } else {
      result.set(slot, fallback);
      fallback += 1;
    }
  }
  return result;
}

function compareModelVariantKeys(left, right) {
  const leftNumber = modelVariantNumberFromKey(left);
  const rightNumber = modelVariantNumberFromKey(right);
  if (leftNumber > 0 && rightNumber > 0 && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return normalizeModelVariantKey(left).localeCompare(normalizeModelVariantKey(right), undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

module.exports = {
  OPAQUE_VARIANT_SUFFIX,
  OPAQUE_VARIANT_FILE_SUFFIX,
  toOpaqueVariantFileStem,
  normalizeModelVariantKey,
  modelVariantNumberFromKey,
  parseModelVariantKey,
  stripModelVariantKey,
  parseModelVariantNumber,
  normalizeModelVariantNumber,
  formatModelVariantNumber,
  buildModelVariantKeyMap,
  buildModelVariantNumberMap,
  compareModelVariantKeys
};
