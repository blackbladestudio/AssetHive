const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { detectTextureTypeFromFileName } = require("../electron/services/textureTypes");

const sourcePath = path.join(__dirname, "batch_import_assets.js");
const source = fs.readFileSync(sourcePath, "utf8");

function loadFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in batch_import_assets.js`);
  const endMatch = /\r?\n}\r?\n/g;
  endMatch.lastIndex = start;
  const end = endMatch.exec(source);
  assert.ok(end, `${name} must have a complete function body`);
  return source.slice(start, end.index + end[0].length);
}

const identifyTextureSlot = new Function("detectTextureTypeFromFileName", `${loadFunction("identifyTextureSlot")}\nreturn identifyTextureSlot;`)(detectTextureTypeFromFileName);
const buildTextureEntries = new Function(
  "path",
  "detectTextureTypeFromFileName",
  `${loadFunction("detectTextureAreaIndex")}\n${loadFunction("identifyTextureSlot")}\n${loadFunction("buildTextureEntries")}\nreturn buildTextureEntries;`
)(path, detectTextureTypeFromFileName);

test("batch import recognizes Megascans Surface Gloss and Cavity maps", () => {
  assert.equal(identifyTextureSlot("sbbihkp_4K_Gloss.jpg"), "Gloss");
  assert.equal(identifyTextureSlot("sbbihkp_4K_Glossiness.png"), "Gloss");
  assert.equal(identifyTextureSlot("sbbihkp_4K_Cavity.jpg"), "Cavity");
  assert.equal(identifyTextureSlot("sbbihkp_4K_Albedo.jpg"), "Albedo");
  assert.equal(identifyTextureSlot("T_Asset_AL.png"), "Albedo");
  assert.equal(identifyTextureSlot("T_Asset_Dis.png"), "Displacement");
  assert.equal(identifyTextureSlot("T_Asset_O.png"), "Opacity");
  assert.equal(identifyTextureSlot("T_Asset_R.png"), "Roughness");

  const records = [
    "sbbihkp_4K_Albedo.jpg",
    "sbbihkp_4K_Normal.jpg",
    "sbbihkp_4K_Gloss.jpg",
    "sbbihkp_4K_Cavity.jpg"
  ].map((name) => ({ name, fullPath: path.join("D:\\BridgeLibrary\\Downloaded\\surface", name) }));
  const built = buildTextureEntries(records, "dx");
  assert.deepEqual(built.textureEntries.map((entry) => entry.textureType), ["Albedo", "Normal", "Gloss", "Cavity"]);
});

test("batch import uses PNG > EXR > JPG for displacement", () => {
  const root = "D:\\BridgeLibrary\\Downloaded\\surface";
  const records = [
    "stone_4K_Displacement.png",
    "stone_4K_Displacement.exr",
    "stone_4K_Displacement.jpg"
  ].map((name) => ({ name, fullPath: path.join(root, name) }));
  const built = buildTextureEntries(records, "dx");
  const displacement = built.textureEntries.find((entry) => entry.textureType === "Displacement");
  assert.match(displacement?.sourcePath || "", /_Displacement\.png$/i, "PNG wins when present");

  const exrOnly = buildTextureEntries(records.slice(1), "dx");
  const exrEntry = exrOnly.textureEntries.find((entry) => entry.textureType === "Displacement");
  assert.match(exrEntry?.sourcePath || "", /_Displacement\.exr$/i, "EXR wins over JPG when PNG is absent");

  const jpgOnly = buildTextureEntries(records.slice(2), "dx");
  const jpgEntry = jpgOnly.textureEntries.find((entry) => entry.textureType === "Displacement");
  assert.match(jpgEntry?.sourcePath || "", /_Displacement\.jpg$/i, "JPG is used only when PNG and EXR are absent");
});
