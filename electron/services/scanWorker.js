const { parentPort, workerData } = require("node:worker_threads");
const { scanLibrary } = require("./assetScanner");

async function run() {
  try {
    const { megascanPath, customPath, options } = workerData;
    
    const result = await scanLibrary(megascanPath, customPath, {
      ...options,
      onProgress: (payload) => {
        parentPort.postMessage({ type: "progress", payload });
      },
      onRecord: (record) => {
        parentPort.postMessage({ type: "record", payload: record });
      }
    });
    
    parentPort.postMessage({ type: "done", payload: result });
  } catch (error) {
    parentPort.postMessage({ type: "error", payload: error.message });
  }
}

run();
