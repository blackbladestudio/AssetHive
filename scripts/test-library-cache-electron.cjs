// Exercise the built App in a hidden renderer, with no production-library I/O.
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout, clearTimeout } = require("node:timers");

async function runElectron() {
  const { app, BrowserWindow } = require("electron");
  const directory = process.argv[2];
  app.setPath("userData", path.join(directory, "profile"));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
    preload: path.join(directory, "preload.cjs"), sandbox: false, contextIsolation: true, offscreen: true, backgroundThrottling: false
  } });
  try {
    const started = Date.now();
    await window.loadFile(path.join(__dirname, "../dist/index.html"));
    const report = await window.webContents.executeJavaScript(`(async () => {
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
      const count = () => Number((document.querySelector('.root-count')?.textContent || '').replace(/[^0-9]/g, ''));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const wait = async (predicate, message) => { for (let i = 0; i < 400; i++) { if (await predicate()) return; await pause(25); } throw new Error(message); };
      await wait(() => count() === 20000 && document.querySelector('.card'), '20,000 cached cards did not appear');
      const firstCardsAt = Date.now();
      const searchInput = document.querySelector('.search-input');
      const setSearch = value => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(searchInput, value);
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setSearch('aitest');
      await wait(() => ['apg0erw', '7whmhcc', '9yzo6ux'].every(id => document.querySelector('#asset-card-' + id)), 'Cached aitest assets were not searchable before scan completion');
      check(!(await window.fixture.state()).completed, 'Search must not wait for scan completion');
      document.querySelector('#asset-card-apg0erw').click();
      await wait(() => document.querySelector('.right-panel.open .resolution-badge')?.textContent === '4K', 'Selected detail lost the full texture metadata');
      document.querySelector('#asset-card-7whmhcc').click();
      await wait(() => document.querySelector('.right-panel.open .resolution-badge')?.textContent === '2K', 'Changing selection retained the previous full detail');
      check((await window.fixture.state()).detailReads === 2, 'Each selection should read full details only once');
      document.querySelector('.right-panel .preview-overlay-actions .action-btn:last-child').click();
      await wait(() => !document.querySelector('.right-panel.open'), 'Detail panel did not close');
      setSearch('');
      const observed = [];
      const observer = new MutationObserver(() => observed.push(count()));
      observer.observe(document.querySelector('.root-count'), { childList: true, subtree: true, characterData: true });
      await window.fixture.holdRead();
      await wait(async () => (await window.fixture.state()).waiting, 'Delayed read did not start');
      await window.fixture.batch();
      await wait(() => count() === 20001, 'Scan batch replaced cached cards');
      await window.fixture.release();
      await pause(250);
      check(count() === 20001, 'Older full response replaced newer cards');
      check(observed.every(value => value >= 20000), 'Visible list shrank during scanning: ' + observed);
      await window.fixture.complete();
      await wait(() => count() === 20000, 'Confirmed deletion did not reconcile');
      document.querySelector('.settings-trigger').click();
      const clearButton = () => [...document.querySelectorAll('.about-cache-btn')].find(button => button.textContent === '清理缓存');
      await wait(() => clearButton() && !clearButton().disabled, 'Cache button unavailable');
      clearButton().click();
      await wait(async () => (await window.fixture.state()).cleared, 'Cache clear did not run');
      await pause(100);
      check(count() === 20000, 'Clearing disk caches hid the current cards');
      observer.disconnect();
      return { ok: true, firstCardsAt, finalCount: count(), observed, checks: ['20,000 cached cards despite a scan racing startup', 'aitest finds apg0erw, 7whmhcc, 9yzo6ux before scan completion', 'full texture detail switches without duplicate reads', 'partial batches preserve the base', 'late full reply merges with newer cards', 'confirmed deletion reconciled', 'cache clear keeps cards'] };
    })()`);
    report.firstCardsMs = report.firstCardsAt - started;
    delete report.firstCardsAt;
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(directory, "cache-ui.png"), (await window.webContents.capturePage()).toPNG());
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ ok: false, error: String(error) }));
    app.exit(1);
  }
}

async function launch() {
  const { spawn } = require("node:child_process");
  const directory = path.resolve(__dirname, "../.tmp", `library-cache-ui-${Date.now()}-${process.pid}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "preload.cjs"), `
const { contextBridge } = require('electron');
let callback, pendingRead, hold = false, cleared = false, firstRead = true, completed = false, detailReads = 0;
const settings = { customLibraryPath: 'D:/Fixture', uiLanguage: 'zh', exportTarget: 'unreal' };
let assets = Array.from({ length: 20000 }, (_, i) => ({ id: 'asset_' + i, name: 'Rock ' + i, source: 'custom', assetType: 'surface', topCategory: 'environment', path: 'D:/Fixture/' + i, metaPath: '', tags: [], meta: {}, modelFiles: [], previewImage: null }));
['apg0erw', '7whmhcc', '9yzo6ux'].forEach((id, i) => { assets[16000 + i] = { ...assets[16000 + i], id, name: 'SM_Env_ZGNC_AItest_' + i, assetType: '3d', standardAssetTags: ['Dressing'], tags: ['temp'] }; });
const noop = () => () => {};
contextBridge.exposeInMainWorld('fixture', {
 state: async () => ({ waiting: Boolean(pendingRead), cleared, completed, detailReads }),
 holdRead: async () => { hold = true; callback?.(); },
 batch: async () => { assets[0] = { ...assets[0], name: 'Updated Rock' }; const added = { ...assets[0], id: 'new', name: 'New Rock' }; assets.push(added); callback?.({ incremental: true, count: assets.length, records: [assets[0], added] }); },
 release: async () => { pendingRead?.(); pendingRead = null; },
 complete: async () => { completed = true; assets = assets.filter(a => a.id !== 'asset_19999'); callback?.({ incremental: true, complete: true, ids: assets.map(a => a.id), favoriteIds: [] }); }
});
contextBridge.exposeInMainWorld('arkhive', {
 getSettings: async () => settings, updateSettings: async patch => Object.assign(settings, patch),
 getAssetById: async id => {
   detailReads++;
   const listAsset = assets.find(asset => asset.id === id);
   const size = id === 'apg0erw' ? 4096 : 2048;
   const asset = { ...listAsset, textureFiles: ['Diffuse.png'], meta: { ...listAsset.meta,
     textureEntries: [{ textureType: 'Diffuse', path: 'Diffuse.png', width: size, height: size }] } };
   return { ok: true, asset, listAsset };
 },
 getAssetIndex: async () => {
   if (firstRead) {
     firstRead = false; const cached = [...assets];
     setTimeout(() => { assets[0] = { ...assets[0], name: 'Early scan update' }; callback?.({ incremental: true, count: assets.length, records: [assets[0]] }); }, 20);
     await new Promise(resolve => setTimeout(resolve, 250)); return cached;
   }
   if (!hold) return assets; hold = false; const old = assets.slice(0, 1); await new Promise(resolve => { pendingRead = resolve; }); return old;
 },
 getAppVersion: async () => ({ ok: true, version: '2.2.9' }),
 onAssetChange: listener => { callback = listener; return () => { callback = null; }; },
 clearCaches: async () => { cleared = true; return { ok: true, removed: [] }; },
 getUnrealConnectionStatus: async () => ({ connected: false }), getPluginStatus: async () => ({ installed: false }),
 checkAppUpdate: async () => ({ ok: true, hasUpdate: false }), setTaskbarProgress: async () => ({ ok: true }),
 onExportProgress: noop, onScanProgress: noop, onCustomSaveProgress: noop, onCalculateBoundsRequest: noop, onResolveDroppedItemsProgress: noop,
 loadImportQueue: async () => ({ drafts: [], activeIndex: 0, selectedIndexes: [] }), saveImportQueue: async value => value,
 foliageOpaqueStatus: async () => ({ available: false }), pathExists: async () => true
});
`);
  const child = spawn(require("electron"), [path.join(__dirname, "test-library-cache-electron.cjs"), directory], { stdio: "inherit", windowsHide: true });
  const timeout = setTimeout(() => child.kill(), 60000);
  const code = await new Promise(resolve => { child.on("exit", resolve); child.on("error", error => { console.error(error); resolve(1); }); });
  clearTimeout(timeout);
  console.log(fs.existsSync(path.join(directory, "result.json")) ? fs.readFileSync(path.join(directory, "result.json"), "utf8") : "No renderer result");
  console.log("Artifacts:", directory);
  process.exitCode = code === 0 ? 0 : 1;
}

if (process.versions.electron) runElectron();
else launch().catch(error => { console.error(error); process.exitCode = 1; });
