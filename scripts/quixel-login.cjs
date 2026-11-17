// Run by the downloader with the bundled Electron runtime. Tokens only travel
// over the private child stdout pipe and are encrypted on disk with Windows DPAPI.
const { app, BrowserWindow, safeStorage, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { usable: validAuth } = require('./lib/quixel-auth-state.cjs');
const { createSavedSessionAdvancer } = require('./lib/quixel-session-continue.cjs');
const authRoot = path.resolve(process.env.ASSETHIVE_QUIXEL_AUTH_ROOT);
app.setPath('userData', path.join(authRoot, 'browser'));
if (!app.isReady()) app.disableHardwareAcceleration();
const authFile = path.join(authRoot, 'auth.enc');
let finished = false;
let rejectedToken;
function status(value) { process.stdout.write(`ASSETHIVE_LOGIN_STATUS:${value}\n`); }
function usable(auth) { return validAuth(auth, { rejectedToken }); }
async function cookieAuth() {
  const cookies = await session.defaultSession.cookies.get({ url: 'https://quixel.com/megascans/home', name: 'auth' });
  for (const cookie of cookies) {
    for (const value of [cookie.value, (() => { try { return decodeURIComponent(cookie.value); } catch { return ''; } })()]) {
      try { const auth = JSON.parse(value); if (usable(auth)) return auth; } catch { /* Not a Quixel auth JSON cookie. */ }
    }
  }
  return null;
}
async function finish(auth) {
  if (finished) return;
  finished = true;
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭证加密不可用');
  await fs.mkdir(authRoot, { recursive: true });
  await fs.writeFile(authFile, safeStorage.encryptString(JSON.stringify({ token: auth.token })), { mode: 0o600 });
  await session.defaultSession.cookies.flushStore();
  process.stdout.write(`ASSETHIVE_AUTH:${JSON.stringify({ token: auth.token })}\n`, () => app.exit(0));
}
app.whenReady().then(async () => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭证加密不可用');
  let auth;
  try { auth = JSON.parse(safeStorage.decryptString(await fs.readFile(authFile))); } catch { /* Recover from browser cookies or the official page below. */ }
  const refresh = process.argv.includes('--refresh');
  const automatic = !process.argv.includes('--login') && (refresh || process.argv.includes('--auto-login'));
  if (refresh) rejectedToken = auth?.token;
  if (!process.argv.includes('--login') && !refresh) {
    if (!usable(auth)) auth = await cookieAuth();
    if (usable(auth)) { await finish(auth); return; }
    if (!automatic) throw new Error('没有可用登录');
  }
  const win = new BrowserWindow({ width: 1200, height: 850, show: false, title: '登录领取过 Megascans 的 Quixel 账号', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  const revealWindow = () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.center();
    win.show();
    win.focus();
  };
  let reveal;
  if (automatic) {
    status('restoring');
    reveal = globalThis.setTimeout(() => { if (!finished && !win.isDestroyed()) { revealWindow(); status('needsLogin'); } }, 15000);
  } else { revealWindow(); status('window'); }
  let reloadTimer, reloadAttempt = 0;
  const home = 'https://quixel.com/megascans/home';
  const load = () => win.loadURL(home).catch(() => {});
  const reload = () => {
    if (reloadTimer || finished || win.isDestroyed()) return;
    reloadTimer = globalThis.setTimeout(() => { reloadTimer = null; if (!finished && !win.isDestroyed()) load(); }, Math.min(120000, 5000 * 2 ** Math.min(reloadAttempt++, 5)));
  };
  win.webContents.on('render-process-gone', () => { status('crashed'); app.exit(3); });
  win.webContents.on('did-finish-load', () => { reloadAttempt = 0; status('loaded'); });
  win.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3) { status('loadFailed'); reload(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => ({ action: url.startsWith('https://') ? 'allow' : 'deny', overrideBrowserWindowOptions: { webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } } }));
  let polling = false;
  const advanceSavedSession = createSavedSessionAdvancer();
  const timer = globalThis.setInterval(async () => {
    if (finished || win.isDestroyed() || polling) return;
    polling = true;
    try {
      let auth = await cookieAuth();
      if (!auth && new globalThis.URL(win.webContents.getURL()).origin === 'https://quixel.com') {
        const raw = await win.webContents.executeJavaScript('window.localStorage.getItem("auth")');
        auth = raw ? JSON.parse(raw) : null;
      }
      if (usable(auth)) {
        await finish(auth).catch(() => { status('saveFailed'); app.exit(1); });
        globalThis.clearInterval(timer);
      } else if (automatic && await advanceSavedSession(win.webContents)) {
        status('continuing');
      }
    } catch { /* Login redirects and unloaded pages are expected. */ }
    finally { polling = false; }
  }, 1500);
  win.on('closed', () => { globalThis.clearInterval(timer); globalThis.clearTimeout(reveal); globalThis.clearTimeout(reloadTimer); if (!finished) { status('closed'); app.exit(2); } });
  // Interactive login has no deadline: MFA and account recovery can take time.
  // Keep the window open until credentials are saved or the user closes it.
  await load();
}).catch(() => { status('failed'); app.exit(1); });
app.on('window-all-closed', () => { if (!finished) app.exit(2); });
