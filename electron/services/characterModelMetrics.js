"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { inspectCharacterModel } = require("./characterFileInspection");
const { CHARACTER_MODEL_EXTENSIONS } = require("../../shared/characterFilePolicy.mjs");

const execFileAsync = promisify(execFile);
const MAYA_SOURCE_EXTENSIONS = new Set([".ma", ".mb"]);

function primitiveTriangles(primitive, accessors) {
  const accessor = accessors[primitive.indices ?? primitive.attributes?.POSITION];
  const count = Math.max(0, Number(accessor?.count) || 0);
  const mode = primitive.mode ?? 4;
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

function gltfJsonFromGlb(bytes) {
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "glTF") return null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    if (type === 0x4E4F534A) return JSON.parse(bytes.toString("utf8", offset + 8, offset + 8 + length).replace(/\0+$/, ""));
    offset += 8 + length;
  }
  return null;
}

async function analyzeCharacterModelTriangles(filePath) {
  try {
    const ext = path.extname(String(filePath || "")).toLowerCase();
    if (!CHARACTER_MODEL_EXTENSIONS.has(ext)) return null;
    if (ext === ".fbx") {
      const result = await inspectCharacterModel(filePath);
      return Number.isFinite(result.triangleCount) ? Math.max(0, Math.floor(result.triangleCount)) : null;
    }
    if (ext === ".obj") {
      const text = await fs.readFile(filePath, "utf8");
      let count = 0;
      for (const line of text.split(/\r?\n/)) if (/^\s*f\s+/.test(line)) count += Math.max(0, line.trim().split(/\s+/).length - 3);
      return count;
    }
    if (ext === ".gltf" || ext === ".glb") {
      const bytes = await fs.readFile(filePath);
      const json = ext === ".gltf" ? JSON.parse(bytes.toString("utf8")) : gltfJsonFromGlb(bytes);
      if (!json) return null;
      return (json.meshes || []).flatMap(mesh => mesh.primitives || []).reduce((sum, primitive) => sum + primitiveTriangles(primitive, json.accessors || []), 0);
    }
  } catch {}
  return null;
}

function mayaAsciiTriangleCount(text) {
  let count = 0;
  let found = false;
  const blocks = String(text || "").matchAll(/setAttr\b[\s\S]*?["']\.fc(?:\[[^\]]+\])?["'][\s\S]*?-type\s+["']polyFaces["']([\s\S]*?);/g);
  for (const block of blocks) {
    for (const face of block[1].matchAll(/(?:^|\s)f\s+(\d+)(?=\s)/gm)) {
      count += Math.max(0, Number(face[1]) - 2);
      found = true;
    }
  }
  return found ? count : null;
}

async function mayaPythonCandidates() {
  const candidates = [];
  if (process.env.MAYA_LOCATION) candidates.push(path.join(process.env.MAYA_LOCATION, "bin", "mayapy.exe"));
  for (let year = 2030; year >= 2020; year -= 1) candidates.push(`C:\\Program Files\\Autodesk\\Maya${year}\\bin\\mayapy.exe`);
  const available = [];
  for (const candidate of candidates) {
    try { await fs.access(candidate); available.push(candidate); } catch {}
  }
  available.push("mayapy.exe");
  return [...new Set(available)];
}

async function analyzeMayaBinaryTriangles(filePath) {
  const script = [
    "import maya.standalone, maya.cmds as cmds",
    "maya.standalone.initialize(name='python')",
    `cmds.file(${JSON.stringify(filePath)}, open=True, force=True, prompt=False)`,
    "print('__ASSETHIVE_TRIANGLES__=' + str(int(cmds.polyEvaluate(triangle=True))))"
  ].join(";");
  for (const executable of await mayaPythonCandidates()) {
    try {
      const { stdout } = await execFileAsync(executable, ["-c", script], { timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      const value = /__ASSETHIVE_TRIANGLES__=(\d+)/.exec(stdout)?.[1];
      if (value !== undefined) return Number(value);
    } catch {}
  }
  return null;
}

async function analyzeCharacterMayaTriangles(filePath, allowProcess = true) {
  try {
    const ext = path.extname(String(filePath || "")).toLowerCase();
    if (!MAYA_SOURCE_EXTENSIONS.has(ext)) return null;
    if (ext === ".ma") {
      const direct = mayaAsciiTriangleCount(await fs.readFile(filePath, "utf8"));
      if (direct !== null) return direct;
    }
    return allowProcess ? await analyzeMayaBinaryTriangles(filePath) : null;
  } catch {
    return null;
  }
}

function summarizeCharacterTriangles(files) {
  const primary = files.filter(file => ["model", "skeletalMesh", "staticMesh"].includes(file.role)
    && !/_LOD\d+(?=\.[^.]+$)/i.test(file.normalizedName || file.storedPath || "")
    && CHARACTER_MODEL_EXTENSIONS.has(path.extname(file.normalizedName || file.storedPath || "").toLowerCase()));
  const known = primary.filter(file => Number.isFinite(file.triangleCount));
  const knownTriangleCount = known.reduce((sum, file) => sum + Math.max(0, Math.floor(file.triangleCount)), 0);
  const unknownModelCount = primary.length - known.length;
  return { modelCount: primary.length, knownTriangleCount, unknownModelCount,
    totalTriangleCount: unknownModelCount ? null : knownTriangleCount, overBudget: knownTriangleCount > 300000 };
}

async function refreshCharacterTriangleMetrics(files, root = "") {
  for (const file of files) {
    if (!["model", "skeletalMesh", "staticMesh"].includes(file.role)) continue;
    const candidate = file.sourcePath || file.destination || (file.storedPath ? path.resolve(root, file.storedPath) : "");
    file.triangleCount = candidate ? await analyzeCharacterModelTriangles(candidate) : null;
  }
  const summary = summarizeCharacterTriangles(files);
  let mayaTriangleCount = null;
  let mayaSourceName = "";
  for (const file of files) {
    const name = file.normalizedName || file.storedPath || file.sourcePath || "";
    if (!MAYA_SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
    const candidate = file.sourcePath || file.destination || (file.storedPath ? path.resolve(root, file.storedPath) : "");
    if (!candidate) continue;
    // FBX analysis already supplies the actual counts. Starting Maya solely to
    // obtain a redundant fallback can stall an otherwise complete import.
    const count = await analyzeCharacterMayaTriangles(candidate, summary.totalTriangleCount === null);
    if (count === null) continue;
    mayaTriangleCount = (mayaTriangleCount || 0) + count;
    mayaSourceName = mayaSourceName ? `${mayaSourceName}, ${path.basename(name)}` : path.basename(name);
  }
  const mayaFallback = summary.totalTriangleCount === null && mayaTriangleCount !== null;
  return {
    ...summary,
    totalTriangleCount: mayaFallback ? mayaTriangleCount : summary.totalTriangleCount,
    overBudget: (mayaFallback ? mayaTriangleCount : summary.knownTriangleCount) > 300000,
    measurementSource: mayaFallback ? "maya" : (summary.modelCount ? "models" : "unknown"),
    mayaTriangleCount,
    mayaSourceName,
    analyzedAt: new Date().toISOString()
  };
}

module.exports = { analyzeCharacterModelTriangles, analyzeCharacterMayaTriangles, mayaAsciiTriangleCount, refreshCharacterTriangleMetrics, summarizeCharacterTriangles };
