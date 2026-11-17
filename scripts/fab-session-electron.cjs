const { app, BrowserWindow, session, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { serveImportWorker } = require('./lib/megascans-import-worker.cjs');
const { listingApiUrl, readListingResponse } = require('./lib/fab-session.cjs');
const { atomicJson } = require('./lib/megascans-transfer.cjs');

const profile = process.env.ASSETHIVE_PREVIEW_USER_DATA;
if (!profile || !path.isAbsolute(profile)) throw new Error('缺少独立 Fab 会话目录');
app.setPath('userData', profile);
app.disableHardwareAcceleration();
const login = process.argv.includes('--login');
const statusFile = path.join(path.dirname(profile), 'status.json');
app.on('window-all-closed', () => {});
if (!app.requestSingleInstanceLock()) app.exit(2);
else app.whenReady().then(async () => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统会话加密不可用');
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  if (!login) {
    serveImportWorker({ run: job => readListingResponse(ses, job.url), shutdown: code => app.exit(code) });
    return;
  }
  const probes = JSON.parse(await fs.readFile(path.join(path.dirname(profile), 'probes.json'), 'utf8'));
  if (!Array.isArray(probes.listingIds) || !probes.listingIds.length || probes.listingIds.length > 20) throw new Error('缺少待验证的成熟内容商品');
  const urls = probes.listingIds.map(id => listingApiUrl(`https://www.fab.com/i/listings/${id}`));
  await atomicJson(statusFile, { ready: false, state: 'manual_login', at: new Date().toISOString() });
  // The user opens this helper and operates the official site themselves.
  // No page scripts, clicks, credential extraction or preference changes.
  const preferences = { nodeIntegration: false, contextIsolation: true, sandbox: true };
  const win = new BrowserWindow({ width: 1200, height: 850, title: 'Fab 登录：完成内容确认后关闭窗口',
    autoHideMenuBar: true, webPreferences: preferences });
  win.webContents.setWindowOpenHandler(({ url }) => ({ action: url.startsWith('https://') ? 'allow' : 'deny',
    overrideBrowserWindowOptions: { webPreferences: preferences } }));
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('https://')) event.preventDefault(); });
  ses.on('will-download', event => event.preventDefault());
  let closing = false;
  win.on('close', event => {
    event.preventDefault();
    if (closing) return;
    closing = true;
    win.hide();
    (async () => {
      const results = [];
      for (const url of urls) {
        const result = await readListingResponse(ses, url);
        let detail;
        try { detail = JSON.parse(result.body); } catch { /* A login/challenge HTML response is not success. */ }
        results.push({ listingId: url.split('/').at(-1), status: result.status,
          accessible: result.status === 200 && detail?.uid === url.split('/').at(-1)
            && detail?.user?.uid === '45ea3429-f62c-4f17-aa15-5bb9dfcd0079' });
      }
      ses.flushStorageData();
      await ses.cookies.flushStore();
      const ready = results.every(result => result.accessible);
      await atomicJson(statusFile, { ready, state: ready ? 'ready' : 'needs_user_action', at: new Date().toISOString(), results });
      process.stdout.write(ready ? 'Fab session ready.\n' : 'Fab access still restricted; check login and content preferences.\n');
      app.exit(ready ? 0 : 2);
    })().catch(() => { process.stdout.write('Fab access check failed.\n'); app.exit(1); });
  });
  // A failed navigation remains visible for the user to retry themselves.
  await win.loadURL(`https://www.fab.com/listings/${probes.listingIds[0]}`).catch(() => {});
}).catch(() => { process.stdout.write('Fab session helper failed.\n'); app.exit(1); });
