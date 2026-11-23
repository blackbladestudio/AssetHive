"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const RIG_CATEGORIES = ["Monster", "Character"];
const CACHE_MS = 5 * 60 * 1000;
const rigCache = new Map();

async function listDirectories(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

async function listRigFiles(rigRoot) {
  const cached = rigCache.get(rigRoot);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.files;
  const files = [];
  for (const category of RIG_CATEGORIES) {
    for (const folder of await listDirectories(path.join(rigRoot, category))) {
      try {
        for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
          if (entry.isFile() && /^SK_.+\.fbx$/i.test(entry.name)) files.push(path.join(folder, entry.name));
        }
      } catch {
        // Unreadable rig folders are skipped.
      }
    }
  }
  rigCache.set(rigRoot, { at: Date.now(), files });
  return files;
}

// Character tokens in priority order: the game tag id (Monster_<Name>) and
// the segment after the AS_ prefix of the animation file name.
function animationRigTokens({ animationPath = "", gameTagId = "" } = {}) {
  const tokens = [];
  const tagToken = String(gameTagId || "").trim().replace(/^Monster_/i, "");
  if (tagToken) tokens.push(tagToken);
  const stem = path.basename(String(animationPath || "").replace(/\\/g, "/")).replace(/\.fbx$/i, "");
  const nameToken = stem.match(/^AS_([^_]+)/i)?.[1];
  if (nameToken) tokens.push(nameToken);
  return [...new Set(tokens.map((token) => token.toLowerCase()))];
}

async function resolveAnimationPreviewRig({ rigRoot, animationPath, gameTagId } = {}) {
  const root = String(rigRoot || "").trim();
  const tokens = animationRigTokens({ animationPath, gameTagId });
  if (!root || !tokens.length) return "";
  const files = await listRigFiles(root);
  for (const token of tokens) {
    const match = files.find((file) => path.basename(file, path.extname(file)).toLowerCase() === `sk_${token}`);
    if (match) return match;
  }
  return "";
}

module.exports = { animationRigTokens, resolveAnimationPreviewRig };
