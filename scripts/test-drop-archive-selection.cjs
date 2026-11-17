const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const sevenZip = require("7zip-bin").path7za;
const { isDropCandidateFile, parse7zTechnicalListing, selectDropArchiveEntries } = require("../electron/services/dropArchiveSelection");

function run7z(args, cwd) {
  const result = spawnSync(sevenZip, args, { encoding: "utf8", windowsHide: true, cwd });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test("ZIP extraction skips files that dropped-item recognition already ignores", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-drop-selection-"));
  try {
    const source = path.join(root, "source");
    const selectedOut = path.join(root, "selected");
    const fullOut = path.join(root, "full");
    const archive = path.join(root, "样例.zip");
    const files = [
      "PBRMAX_Stone/Stone.fbx",
      "PBRMAX_Stone/Stone_LOD0.fbx",
      "PBRMAX_Stone/Stone.ZTL",
      "PBRMAX_Stone/Stone.jpg",
      "PBRMAX_Stone/T_Stone_Normal_8K.png",
      "PBRMAX_Stone/T_Stone_Normal_8K_LOD0.png",
      "PBRMAX_Stone/Models/LOD/T_Stone_Roughness.png",
      "PBRMAX_Stone/Thumbs/T_Stone_Albedo.png",
      "PBRMAX_Stone/asset.json",
      "PBRMAX_Stone/readme.txt"
    ];
    for (const file of files) {
      const target = path.join(source, ...file.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file);
    }
    run7z(["a", "-tzip", archive, "PBRMAX_Stone"], source);
    const listing = parse7zTechnicalListing(run7z(["l", "-slt", "-sccUTF-8", archive]));
    assert.ok(listing);
    const selection = selectDropArchiveEntries(listing);
    assert.equal(selection.skippedCount, 3);
    assert.ok(selection.skippedPackedBytes > 0);
    assert.deepEqual(selection.selected.map((entry) => entry.path.replace(/\\/g, "/")).sort(), [
      "PBRMAX_Stone/Stone.fbx",
      "PBRMAX_Stone/Stone_LOD0.fbx",
      "PBRMAX_Stone/Stone.ZTL",
      "PBRMAX_Stone/Stone.jpg",
      "PBRMAX_Stone/T_Stone_Normal_8K.png",
      "PBRMAX_Stone/Models/LOD/T_Stone_Roughness.png",
      "PBRMAX_Stone/asset.json"
    ].sort());
    fs.mkdirSync(selectedOut);
    fs.mkdirSync(fullOut);
    const includeList = path.join(root, "include.txt");
    fs.writeFileSync(includeList, selection.selected.map((entry) => entry.path).join("\n") + "\n", "utf8");
    run7z(["x", "-y", `-o${selectedOut}`, archive, "-scsUTF-8", `-i@${includeList}`]);
    run7z(["x", "-y", `-o${fullOut}`, archive]);
    const scan = (directory) => {
      const result = [];
      const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (isDropCandidateFile(full)) result.push(path.relative(directory, full).replace(/\\/g, "/"));
        }
      };
      walk(directory);
      return result.sort();
    };
    assert.deepEqual(scan(selectedOut), scan(fullOut));
    assert.equal(fs.existsSync(path.join(selectedOut, "PBRMAX_Stone", "T_Stone_Normal_8K_LOD0.png")), false);
    assert.equal(fs.existsSync(path.join(selectedOut, "PBRMAX_Stone", "Stone_LOD0.fbx")), true);
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  }
});
