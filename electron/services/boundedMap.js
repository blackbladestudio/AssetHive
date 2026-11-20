// Keep network I/O bounded and result order stable. On failure, stop starting
// new work and drain in-flight tasks before returning control to the caller.
async function boundedMap(items, concurrency, operation) {
  const results = new Array(items.length);
  let cursor = 0, failed = false, failure;
  const workers = Array.from({ length: Math.min(items.length, Math.max(1, Math.min(16, Math.trunc(concurrency) || 1))) }, async () => {
    while (!failed && cursor < items.length) {
      const index = cursor++;
      try { results[index] = await operation(items[index], index); }
      catch (error) { if (!failed) failure = error; failed = true; }
    }
  });
  await Promise.all(workers);
  if (failed) throw failure;
  return results;
}
module.exports = { boundedMap };
