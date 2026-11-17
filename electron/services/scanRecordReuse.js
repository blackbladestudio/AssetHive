const { createHash } = require("node:crypto");
const { setImmediate } = require("node:timers/promises");

function scanRecordSignature(record) {
  // Favorites are personal state applied by the parent, not scanned content.
  const content = { ...record };
  delete content.favorite;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

async function createScanSeeds(records) {
  const seeds = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record?.id) seeds.push([record.id, scanRecordSignature(record), -(i + 1)]);
    // Hash bounded batches, allowing UI/IPC and scan cancellation to run.
    if ((i + 1) % 128 === 0) await setImmediate();
  }
  return seeds;
}

function createScanRecordSender({ seeds = [], project, send }) {
  const baseline = new Map(seeds.map(([id, signature, token]) => [id, { signature, token }]));
  const tokens = new WeakMap();
  const stats = { sent: 0, reused: 0 };
  let nextToken = 0;
  return {
    stats,
    token(record) {
      if (tokens.has(record)) return tokens.get(record);
      const resident = project(record);
      const previous = baseline.get(resident.id);
      if (previous && previous.signature === scanRecordSignature(resident)) {
        tokens.set(record, previous.token); stats.reused++;
        return previous.token;
      }
      const token = ++nextToken;
      tokens.set(record, token); stats.sent++;
      send({ type: "record", token, payload: resident });
      return token;
    }
  };
}

module.exports = { scanRecordSignature, createScanSeeds, createScanRecordSender };
