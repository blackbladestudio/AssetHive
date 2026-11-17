// This function executes inside the isolated official Quixel page. Only the
// three observed saved-session steps are eligible; it never submits credentials.
function clickSavedSessionStep(allowed, activate = true) {
  const { document, location } = globalThis;
  if (location.protocol !== 'https:' || !['quixel.com', 'www.quixel.com'].includes(location.hostname)) return null;
  const home = /^\/megascans(?:\/home)?\/?$/.test(location.pathname);
  const login = /^\/login\/?$/.test(location.pathname);
  if (!home && !login) return null;
  const visible = element => {
    const style = globalThis.getComputedStyle(element);
    if (element.disabled || element.getAttribute('aria-disabled') === 'true' || style.visibility !== 'visible' || style.display === 'none' || style.pointerEvents === 'none') return false;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const x = Math.max(0, Math.min(globalThis.innerWidth - 1, rect.x + rect.width / 2));
    const y = Math.max(0, Math.min(globalThis.innerHeight - 1, rect.y + rect.height / 2));
    const top = document.elementFromPoint(x, y);
    return top && (top === element || element.contains(top));
  };
  const label = element => (element.innerText || element.value || element.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').toUpperCase();
  const elements = [...document.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]')].filter(visible);
  const click = (action, text) => {
    if (!allowed.includes(action)) return null;
    const candidates = elements.filter(element => label(element) === text);
    if (candidates.length !== 1) return null;
    const element = candidates[0];
    if (element.tagName === 'A' && element.getAttribute('href')) {
      const target = new globalThis.URL(element.getAttribute('href'), location.href);
      if (target.protocol !== 'https:' || !['quixel.com', 'www.quixel.com', 'epicgames.com', 'www.epicgames.com', 'accounts.epicgames.com'].includes(target.hostname)) return null;
    }
    if (activate) element.click();
    return action;
  };
  if (home && /A NEW HOME FOR MEGASCANS/i.test(document.body.innerText)) {
    const dismissed = click('dismissMigration', 'STAY HERE');
    if (dismissed) return dismissed;
  }
  // The Quixel login page also has an email/password SIGN IN form. The Epic
  // provider is the only action allowed there, even when those fields exist.
  if (login) return click('epicSignIn', 'SIGN IN WITH EPIC GAMES');
  return click('openSignIn', 'SIGN IN');
}

function createSavedSessionAdvancer() {
  const actions = new Set(['dismissMigration', 'openSignIn', 'epicSignIn']);
  return async contents => {
    if (!actions.size || contents.isDestroyed() || contents.isLoadingMainFrame()) return null;
    const url = new globalThis.URL(contents.getURL());
    if (url.protocol !== 'https:' || !['quixel.com', 'www.quixel.com'].includes(url.hostname)) return null;
    const source = `(${clickSavedSessionStep.toString()})`;
    const action = await contents.executeJavaScript(`${source}(${JSON.stringify([...actions])},false)`);
    if (!actions.has(action)) return null;
    // Consume before clicking: navigation may destroy the JS context before its
    // result reaches us. That must never cause the same step to be clicked again.
    actions.delete(action);
    await contents.executeJavaScript(`${source}(${JSON.stringify([action])})`).catch(() => {});
    return action;
  };
}

module.exports = { clickSavedSessionStep, createSavedSessionAdvancer };
