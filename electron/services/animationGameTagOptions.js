const fs = require("node:fs/promises");
const path = require("node:path");
const { readDataTableRows } = require("./unrealDataTable");
const {
  MONSTER_PROTOTYPE_TABLE, WEAPON_CATEGORY_TABLE, monsterOptionsFromRows, weaponOptionsFromRows
} = require("../../shared/animationGameTags.mjs");

const SNAPSHOT_PATH = path.join(__dirname, "animationGameTags.snapshot.json");

async function projectDirectory(candidate) {
  const value = String(candidate || "").trim();
  if (!value) return "";
  const resolved = path.resolve(value);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) return "";
  return stat.isFile() ? path.dirname(resolved) : resolved;
}

async function readProjectOptions(projectDir) {
  const [weaponRows, monsterRows] = await Promise.all([
    readDataTableRows(path.join(projectDir, WEAPON_CATEGORY_TABLE)).catch(() => null),
    readDataTableRows(path.join(projectDir, MONSTER_PROTOTYPE_TABLE)).catch(() => null)
  ]);
  if (!weaponRows && !monsterRows) return null;
  return {
    weapons: weaponOptionsFromRows(weaponRows || []),
    monsters: monsterOptionsFromRows(monsterRows || []),
    source: projectDir,
    partial: !weaponRows || !monsterRows
  };
}

async function readSnapshot() {
  try {
    const snapshot = JSON.parse(await fs.readFile(SNAPSHOT_PATH, "utf8"));
    return {
      weapons: Array.isArray(snapshot.weapons) ? snapshot.weapons : [],
      monsters: Array.isArray(snapshot.monsters) ? snapshot.monsters : [],
      source: "",
      partial: false
    };
  } catch {
    return { weapons: [], monsters: [], source: "", partial: true };
  }
}

// Candidates are .uproject files or project folders, in priority order.
async function loadAnimationGameTagOptions(candidates = []) {
  const seen = new Set();
  for (const candidate of candidates) {
    const dir = await projectDirectory(candidate);
    if (!dir || seen.has(dir.toLowerCase())) continue;
    seen.add(dir.toLowerCase());
    const options = await readProjectOptions(dir);
    if (options) return options;
  }
  return readSnapshot();
}

module.exports = { loadAnimationGameTagOptions, readProjectOptions };
