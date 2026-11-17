const { parentPort, workerData } = require("node:worker_threads");
const { scanLibrary } = require("./assetScanner");
const { toAssetIndexRecord } = require("./assetListRecord");
const { createScanRecordSender } = require("./scanRecordReuse");

async function run() {
  try {
    const { customPath, options, reuseSeeds } = workerData;
    const sender = createScanRecordSender({ seeds: reuseSeeds, project: toAssetIndexRecord,
      send: message => parentPort.postMessage(message) });
    const sendRecord = record => {
      if (!options.residentIndex) {
        parentPort.postMessage({ type: "record", payload: record });
        return;
      }
      return sender.token(record);
    };

    const result = await scanLibrary(customPath, {
      ...options,
      onProgress: (payload) => {
        parentPort.postMessage({ type: "progress", payload });
      },
      onRecord: (record) => {
        sendRecord(record);
      },
      onTiming: (payload) => {
        const { heapUsed, external, arrayBuffers } = process.memoryUsage();
        parentPort.postMessage({ type: "timing", payload: { ...payload,
          transport: { ...sender.stats }, workerMemory: { heapUsed, external, arrayBuffers } } });
      },
      onWarning: (payload) => {
        parentPort.postMessage({ type: "warning", payload });
      }
    });
    
    // Reuse the exact objects already streamed to the parent. Sending all full
    // records a second time used to double the end-of-scan allocation peak.
    if (options.residentIndex) parentPort.postMessage({ type: "done", tokens: result.map(sendRecord) });
    else parentPort.postMessage({ type: "done", payload: result });
    parentPort.close();
  } catch (error) {
    parentPort.postMessage({ type: "error", payload: error.message });
  }
}

run();
