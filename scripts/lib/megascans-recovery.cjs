const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
function transient(error) {
  if (!error) return false;
  return error.transient === true || [408, 429].includes(error.status) || (error.status >= 500 && error.status <= 599)
    || NETWORK_CODES.has(error.code) || ['TimeoutError', 'AbortError'].includes(error.name)
    || (error.name === 'TypeError' && error.message === 'fetch failed') || transient(error.cause);
}
function paused() { return Object.assign(new Error('已暂停，当前缓存已保留'), { code: 'MEGASCANS_PAUSED' }); }
async function recover(operation, { refreshAuth, shouldDefer, shouldStop = async () => false, onState = async () => {}, sleep = ms => new Promise(resolve => globalThis.setTimeout(resolve, ms)), now = Date.now } = {}) {
  let attempt = 0, authAttempts = 0, refreshedLinks = false;
  for (;;) {
    if (await shouldStop()) throw paused();
    try { return await operation(); }
    catch (error) {
      if (await shouldStop()) throw paused();
      if (error.code === 'QUIXEL_AUTH' && refreshAuth && authAttempts < 1) {
        authAttempts++;
        await onState({ stage: 'reauthenticating', retryAttempt: authAttempts, retryAt: null, retryReason: '登录会话失效，正在尝试恢复' });
        await refreshAuth();
        continue;
      }
      if (error.code === 'QUIXEL_AUTH' && authAttempts) throw Object.assign(new Error(`自动恢复登录后 Quixel 仍拒绝请求（HTTP ${error.status}）；缓存已保留，请确认账号或该资产的下载权限`), { code: error.code, status: error.status });
      // Refresh the officially signed plan once for an expired CDN link. Never
      // keep opening login windows for a genuinely forbidden asset.
      if (error.status === 403 && error.code !== 'QUIXEL_AUTH' && !refreshedLinks) { refreshedLinks = true; continue; }
      // Only the asset runner supplies this policy. Listing, authentication,
      // rate limits and a generally unavailable service must never skip assets.
      const candidate = error.code !== 'QUIXEL_AUTH' && ([403, 404, 410].includes(error.status) || (error.status >= 500 && error.status <= 599 && attempt >= 2));
      if (candidate && shouldDefer && await shouldDefer(error)) {
        if (await shouldStop()) throw paused();
        throw Object.assign(new Error(error.message), { code: 'MEGASCANS_DEFER_ASSET', status: error.status, source: error.source, endpoint: error.endpoint, file: error.file, retryAttempts: attempt + (refreshedLinks ? 2 : 1) });
      }
      if (!transient(error)) throw error;
      attempt++;
      const delay = Math.max(Math.min(120000, 5000 * 2 ** Math.min(attempt - 1, 5)), Math.min(120000, error.retryMs || 0));
      await onState({ stage: 'retrying', retryAttempt: attempt, retryAt: new Date(now() + delay).toISOString(), retryReason: `${error.status ? `HTTP ${error.status}：` : ''}网络中断或服务器暂时不可用，保留当前缓存后重试` });
      // Short slices let pause work while offline, without waiting two minutes.
      for (let remaining = delay; remaining > 0; remaining -= 1000) {
        if (await shouldStop()) throw paused();
        await sleep(Math.min(1000, remaining));
      }
    }
  }
}
module.exports = { transient, paused, recover };
