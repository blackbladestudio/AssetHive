const { createHash } = require("node:crypto");

function clientFraction(clientId, kind) {
  return createHash("sha256").update(`${clientId}|${kind}`).digest().readUInt32LE(0) / 0x100000000;
}

function startupScanDelay(clientId, hasCache) {
  // First-time users still get cards quickly; restored libraries can spread
  // their reconciliation over a wider window after the UI has already opened.
  return 1200 + Math.floor(clientFraction(clientId, "startup") * (hasCache ? 30000 : 3000));
}

function periodicScanDelay(clientId, intervalMs, random = Math.random) {
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 300000;
  const spread = Math.min(30000, interval * 0.1);
  const sample = Number(random());
  const jitter = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5;
  const fraction = clientFraction(clientId, "periodic") * 0.75 + jitter * 0.25;
  return Math.max(1, Math.round(interval + (fraction * 2 - 1) * spread));
}

module.exports = { startupScanDelay, periodicScanDelay };
