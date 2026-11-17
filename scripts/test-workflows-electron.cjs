const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

async function runElectron() {
  const { app, BrowserWindow } = require("electron");
  const directory = process.argv[2];
  app.setPath("userData", path.join(directory, "profile"));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1280, height: 800,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, webSecurity: false } });
  try {
    await win.loadFile(path.join(directory, "index.html"));
    const first = await win.webContents.executeJavaScript("window.runWorkflowTests()");
    fs.writeFileSync(path.join(directory, "workflows.png"), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript("document.querySelector('.search-presets').open = true");
    await new Promise(resolve => globalThis.setTimeout(resolve, 100));
    fs.writeFileSync(path.join(directory, "filters.png"), (await win.webContents.capturePage()).toPNG());
    const reloaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
    win.reload();
    await reloaded;
    const restored = await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 100; i++) {
        if (document.querySelector('[data-draft]')?.textContent === 'Edited after recovery') return true;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error('Draft did not survive renderer reload');
    })()`);
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ ok: true, checks: first, restored }, null, 2));
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ ok: false, error: String(error) }));
    app.exit(1);
  }
}

async function launch() {
  const { build } = require("esbuild");
  const { spawn } = require("node:child_process");
  const { setTimeout, clearTimeout } = require("node:timers");
  const root = path.resolve(__dirname, "..");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-workflow-ui-"));
  await build({ entryPoints: [path.join(root, "src/ui/assetSearchWorker.ts")], bundle: true, format: "esm", platform: "browser", outfile: path.join(directory, "worker.js"), logLevel: "silent" });
  const renderer = `
import { useState, useMemo, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useAssetSearch } from './src/ui/hooks/useAssetSearch';
import { useImportQueuePersistence } from './src/ui/hooks/useImportQueuePersistence';
import { SearchPresets } from './src/ui/SearchPresets';
import { defaultSearchState, defaultImportForm } from './src/ui/hooks/types';
import './src/ui/styles.css';
const errors = [];
const initial = { drafts: [{ form: { ...defaultImportForm, queueId: 'recovered', assetName: 'Recovered draft', assetType: 'surface' }, tagInput: 'unfinished tag' }], activeIndex: 0, selectedIndexes: [0] };
window.arkhive = {
  loadImportQueue: async () => JSON.parse(localStorage.getItem('test.queue') || JSON.stringify(initial)),
  saveImportQueue: async snapshot => { localStorage.setItem('test.queue', JSON.stringify(snapshot)); return snapshot; }
};
const records = [
  { id: 'granite', name: 'Granite Rock', tags: ['forest', 'Megascans'], meta: {} },
  { id: 'basalt', name: 'Basalt Rock', tags: ['desert', 'PBRMAX'], meta: {} },
  { id: 'tree', name: '杉树', tags: ['植物', 'forest'], meta: {} },
  { id: 'tagged', name: 'Stone', tags: ['Temp'], meta: {} },
  { id: 'named', name: 'Env_Temp_stone', tags: [], meta: {} },
  { id: 'ruin', name: 'Ancient Temple Stone', tags: ['temple'], meta: { slug: 'ancienttemplestone' } },
  { id: 'mushroom', name: 'Spotted Red Mushrooms', tags: ['temperate'], meta: {} },
  { id: 'chinese', name: '蘑菇', tags: ['temperate'], meta: {} },
  { id: 'lookup', assetID: 'legacy987key', name: 'Lookup Model', tags: [], meta: {} },
  ...['apg0erw', '7whmhcc', '9yzo6ux'].map((id, i) => ({ id, name: 'SM_Env_ZGNC_AItest_' + i, tags: [], meta: {} })),
  ...Array.from({ length: 20000 }, (_, i) => ({ id: 'fixture-' + i, name: 'Fixture ' + i, tags: ['background'], meta: {} }))
];
function Harness() {
  const [assets, setAssets] = useState(records);
  const [text, setText] = useState('');
  const [tags, setTags] = useState([]);
  const [snapshot, setSnapshot] = useState({ drafts: [], activeIndex: 0, selectedIndexes: [] });
  const [applied, setApplied] = useState('');
  const search = useMemo(() => ({ ...defaultSearchState, text, tags }), [text, tags]);
  const matches = useAssetSearch(assets, text, search.tags);
  const queue = useImportQueuePersistence('test-library', true, snapshot, setSnapshot, error => errors.push(error));
  useEffect(() => { window.workflowControls = { setText, setTags,
    scanBatch: () => setAssets(previous => previous.map((asset, i) => i === previous.length - 1 ? { ...asset, name: asset.name + '.' } : asset)),
    editDraft: () => setSnapshot(previous => ({ ...previous, drafts: previous.drafts.map(draft => ({ ...draft, form: { ...draft.form, assetName: 'Edited after recovery' } })) })), flush: queue.flush }; }, [queue.flush]);
  return <main style={{ minHeight: '100vh', background: '#1b1b1b', color: '#ddd', fontFamily: 'sans-serif' }}>
    <header className='top-strip'><div className='search-wrap'><input className='search-input' value={text} onChange={event => setText(event.target.value)} placeholder='搜索资产...' /></div>
      <div className='top-right-actions'><SearchPresets search={search} menu='environment' english={false} onApply={saved => { setText(saved.text); setApplied(saved.text); }} onError={error => errors.push(error)} /></div></header>
    <section style={{ padding: 24 }}><h2>AssetHive 工作流回归</h2><p data-draft>{snapshot.drafts[0]?.form.assetName}</p><p data-matches>{matches.ids ? [...matches.ids].join(',') : 'all'}</p><p data-query>{JSON.stringify([text, tags])}</p><p data-busy>{String(matches.busy)}</p><p data-ready>{String(queue.ready)}</p><p data-applied>{applied}</p></section>
  </main>;
}
createRoot(document.getElementById('root')).render(<Harness />);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (predicate, description) => { for (let i = 0; i < 200; i++) { if (predicate()) return; await pause(25); } throw new Error(description); };
window.runWorkflowTests = async () => {
  await wait(() => document.querySelector('[data-ready]')?.textContent === 'true', 'Queue did not restore');
  if (document.querySelector('[data-draft]').textContent !== 'Recovered draft') throw new Error('Pending draft missing');
  window.workflowControls.setText('temp');
  await wait(() => document.querySelector('[data-matches]')?.textContent === 'tagged,named' && document.querySelector('[data-busy]')?.textContent === 'false', 'Temp search included temple or temperate');
  window.workflowControls.setText('');
  window.workflowControls.setTags(['Temp']);
  await wait(() => document.querySelector('[data-query]')?.textContent === JSON.stringify(['', ['Temp']]) && document.querySelector('[data-matches]')?.textContent === 'tagged,named' && document.querySelector('[data-busy]')?.textContent === 'false', 'Committed Temp term differs from typing');
  window.workflowControls.setText('temp');
  window.workflowControls.setTags(['temperate']);
  await wait(() => document.querySelector('[data-matches]')?.textContent === '' && document.querySelector('[data-busy]')?.textContent === 'false', 'AND terms broadened Temp search');
  window.workflowControls.setText('acy987');
  window.workflowControls.setTags([]);
  await wait(() => document.querySelector('[data-matches]')?.textContent === 'lookup', 'Source ID fragment search failed');
  window.workflowControls.setText('shanshu');
  await wait(() => document.querySelector('[data-matches]')?.textContent === 'tree', 'Real worker pinyin search failed');
  window.workflowControls.setText('graniet');
  await pause(110);
  window.workflowControls.setText('basalt desert');
  await wait(() => document.querySelector('[data-matches]')?.textContent === 'basalt' && document.querySelector('[data-busy]')?.textContent === 'false', 'Latest search did not win');
  await pause(150);
  if (document.querySelector('[data-matches]').textContent !== 'basalt') throw new Error('Stale result replaced latest search');
  window.workflowControls.setText('aitest');
  const scanning = setInterval(() => window.workflowControls.scanBatch(), 40);
  try {
    await wait(() => document.querySelector('[data-matches]')?.textContent === 'apg0erw,7whmhcc,9yzo6ux', 'Continuous scan batches postponed cached aitest search until completion');
  } finally { clearInterval(scanning); }
  window.workflowControls.setText('basalt desert');
  await wait(() => document.querySelector('[data-matches]')?.textContent === 'basalt' && document.querySelector('[data-busy]')?.textContent === 'false', 'Search did not settle after scanning stopped');
  document.querySelector('.search-presets').open = true;
  const input = document.querySelector('.search-presets input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '沙漠岩石');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await pause(30);
  document.querySelector('.search-presets form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await wait(() => document.querySelector('.search-preset-row'), 'Saved filter not shown');
  window.workflowControls.setText('forest');
  await pause(30);
  document.querySelector('.search-preset-row button').click();
  await wait(() => document.querySelector('[data-applied]').textContent === 'basalt desert', 'Saved filter did not apply');
  window.workflowControls.editDraft();
  await pause(350);
  if (JSON.parse(localStorage.getItem('test.queue')).drafts[0].form.assetName !== 'Edited after recovery') throw new Error('Draft edit was not persisted');
  if (errors.length) throw new Error(errors.join('; '));
  return [records.length + ' documents in real search worker', 'Temp typing + committed term + AND exclusion', 'source ID fragments', 'pinyin + latest query', 'save and apply filter', 'draft autosave and reload'];
};
`;
  await build({ stdin: { contents: renderer, resolveDir: root, loader: "tsx" }, bundle: true, format: "esm", platform: "browser", jsx: "automatic",
    outfile: path.join(directory, "renderer.js"), define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
    plugins: [{ name: "fixture-worker-url", setup(bundler) {
      bundler.onLoad({ filter: /useAssetSearch\.ts$/ }, args => ({ contents: fs.readFileSync(args.path, "utf8").replace('new URL("../assetSearchWorker.ts", import.meta.url)', 'new URL("./worker.js", import.meta.url)'), loader: "ts", resolveDir: path.dirname(args.path) }));
    } }] });
  fs.writeFileSync(path.join(directory, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [path.join(__dirname, "test-workflows-electron.cjs"), directory], { env, windowsHide: true, stdio: "inherit" });
  const timer = setTimeout(() => child.kill(), 45000);
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  clearTimeout(timer);
  const resultPath = path.join(directory, "result.json");
  console.log(fs.existsSync(resultPath) ? fs.readFileSync(resultPath, "utf8") : "Electron did not produce a result");
  console.log(`Artifacts: ${directory}`);
  process.exitCode = code === 0 ? 0 : 1;
}

if (process.versions.electron) void runElectron();
else void launch().catch(error => { console.error(error); process.exitCode = 1; });
