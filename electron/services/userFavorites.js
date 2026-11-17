const fs = require("node:fs/promises");
const path = require("node:path");

function libraryKey(root) {
  return path.resolve(root || ".").replace(/\\/g, "/").toLowerCase();
}

// Only this user's file is authoritative. Never import shared favorites on startup.
function createUserFavorites(filePath) {
  let queue = Promise.resolve();
  async function read() {
    try {
      const data = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (data.version !== 1 || !data.libraries || typeof data.libraries !== "object") {
        throw new Error("Invalid favorites file");
      }
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, libraries: {} };
      throw error;
    }
  }
  async function load(root) {
    await queue;
    const data = await read();
    return data.libraries[libraryKey(root)] || [];
  }
  function update(root, asset, favorite) {
    const operation = queue.then(async () => {
      const data = await read();
      const key = libraryKey(root);
      const entries = (data.libraries[key] || []).filter(entry =>
        entry.id !== asset.id && !(asset.metaPath && libraryKey(entry.metaPath || ".") === libraryKey(asset.metaPath)));
      if (favorite) entries.push({ id: asset.id, metaPath: asset.metaPath || "" });
      data.libraries[key] = entries;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(data, null, 2), "utf8");
      await fs.rename(temporary, filePath);
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return { load, update };
}

module.exports = { createUserFavorites, libraryKey };
