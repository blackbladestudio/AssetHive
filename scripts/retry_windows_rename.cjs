const fs = require("node:fs");
const { setTimeout } = require("node:timers/promises");

if (process.platform === "win32") {
  const retryableCodes = new Set(["EACCES", "EBUSY", "EPERM"]);
  const originalRename = fs.promises.rename.bind(fs.promises);

  fs.promises.rename = async (source, destination) => {
    const deadline = Date.now() + 60_000;
    let delayMs = 20;

    while (true) {
      try {
        return await originalRename(source, destination);
      } catch (error) {
        if (!retryableCodes.has(error?.code) || Date.now() >= deadline) {
          throw error;
        }
        await setTimeout(delayMs);
        delayMs = Math.min(delayMs + 20, 500);
      }
    }
  };
}
