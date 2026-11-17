const { QuixelClient, trustedDownload } = require('./megascans-transfer.cjs');
const { paused } = require('./megascans-recovery.cjs');

// A different completed asset must still work before an individual HTTP error
// may be deferred. Never interpret a timeout, rate limit or auth failure as one.
async function isolatedAssetFailure({ client, id, error, controlIds, resolution, shouldStop = async () => false }) {
  if (!['quixel', 'cdn'].includes(error.source) || error.code === 'QUIXEL_AUTH'
    || !([403, 404, 410].includes(error.status) || error.status >= 500 && error.status <= 599)) return false;
  const probe = new QuixelClient(client.token, { retries: 1,
    fetchImpl: (url, settings) => client.fetch(url, { ...settings, signal: globalThis.AbortSignal.timeout(10000) }) });
  for (const control of [...controlIds].reverse().filter(value => value !== id).slice(0, 2)) {
    if (await shouldStop()) throw paused();
    try {
      const plan = await probe.plan(control, resolution);
      if (error.source === 'cdn') {
        const file = plan.files.find(file => /\.fbx$/i.test(file.file)) || plan.files.find(file => /\.(png|jpe?g)$/i.test(file.file));
        if (!file) continue;
        const response = await client.fetch(trustedDownload(file.url), { headers: { Range: 'bytes=0-0' }, redirect: 'error', signal: globalThis.AbortSignal.timeout(10000) });
        const ok = response.ok;
        await response.body?.cancel();
        if (!ok) continue;
      }
      if (await shouldStop()) throw paused();
      return true;
    } catch (failure) {
      if (failure.code === 'MEGASCANS_PAUSED') throw failure;
      // A failed control is no proof of an isolated failure. Normal recovery
      // remains in charge and no pending asset is marked complete or deferred.
    }
  }
  return false;
}

module.exports = { isolatedAssetFailure };
