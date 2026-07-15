const Fuse = require("fuse.js");

const FUSE_OPTIONS = {
  includeScore: true,
  threshold: 0.35,
  keys: ["id", "slug", "name", "tags", "path"]
};

const RESULT_CACHE_LIMIT = 200;
const RESULT_CACHE_TTL_MS = 30_000;

let baselineIndexRef = null;
let baselineIndexLen = 0;
let baselineFuse = null;
let baselineVersion = 0;

const resultCache = new Map();

function lruGet(key) {
  const hit = resultCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.time > RESULT_CACHE_TTL_MS) {
    resultCache.delete(key);
    return null;
  }
  resultCache.delete(key);
  resultCache.set(key, hit);
  return hit.value;
}

function lruSet(key, value) {
  if (resultCache.has(key)) {
    resultCache.delete(key);
  } else if (resultCache.size >= RESULT_CACHE_LIMIT) {
    const oldestKey = resultCache.keys().next().value;
    if (oldestKey !== undefined) {
      resultCache.delete(oldestKey);
    }
  }
  resultCache.set(key, { time: Date.now(), value });
}

function ensureBaseline(index) {
  if (baselineIndexRef === index && baselineFuse && baselineIndexLen === index.length) {
    return baselineFuse;
  }
  baselineIndexRef = index;
  baselineIndexLen = index.length;
  baselineFuse = new Fuse(index, FUSE_OPTIONS);
  baselineVersion++;
  resultCache.clear();
  return baselineFuse;
}

function setIndex(index) {
  if (!Array.isArray(index)) return;
  baselineIndexRef = index;
  baselineIndexLen = index.length;
  baselineFuse = new Fuse(index, FUSE_OPTIONS);
  baselineVersion++;
  resultCache.clear();
}

function invalidate() {
  resultCache.clear();
}

function notifyMutation() {
  baselineFuse = null;
  resultCache.clear();
}

function buildCacheKey(indexLength, query) {
  return `${baselineVersion}|${indexLength}|${JSON.stringify(query || {})}`;
}

function fuseSearch(text, candidate, index) {
  if (candidate === index) {
    return ensureBaseline(index).search(text).map((item) => item.item);
  }
  const scoped = new Fuse(candidate, FUSE_OPTIONS);
  return scoped.search(text).map((item) => item.item);
}

module.exports = {
  setIndex,
  invalidate,
  notifyMutation,
  ensureBaseline,
  lruGet,
  lruSet,
  buildCacheKey,
  fuseSearch,
  get baselineVersion() {
    return baselineVersion;
  }
};
