const fs = require("node:fs/promises");
const path = require("node:path");
const { classifyBridgePlantWind } = require("../../electron/services/plantWindPreset");

async function main(library, output) {
  if (!library || !output) throw new Error("Usage: node catalog.cjs <3dplant directory> <catalog.json>");
  const catalog = [];
  for (const entry of await fs.readdir(library, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = path.join(library, entry.name);
    const children = await fs.readdir(root, { withFileTypes: true });
    if (!children.some(child => child.isDirectory() && /^Var\d+$/i.test(child.name))) continue;
    const id = entry.name.split("_").at(-1);
    const metadata = JSON.parse((await fs.readFile(path.join(root, id + ".json"), "utf8")).replace(/^\uFEFF/, ""));
    if (metadata.id && metadata.id.toLowerCase() !== id.toLowerCase()) throw new Error("Bridge ID mismatch: " + root);
    catalog.push({ id: metadata.id || id, name: metadata.name || id, form: classifyBridgePlantWind(metadata), dir: entry.name });
  }
  catalog.sort((a, b) => a.dir.localeCompare(b.dir, "en"));
  await fs.writeFile(output, JSON.stringify(catalog, null, 2));
}
main(...process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
