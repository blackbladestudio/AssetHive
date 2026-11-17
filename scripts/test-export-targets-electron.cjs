// Hidden, isolated renderer exercising the real App and settings persistence contract.
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout, clearTimeout } = require("node:timers");

async function runElectron() {
  const { app, BrowserWindow } = require("electron");
  const directory = process.argv[2];
  app.setPath("userData", path.join(directory, "profile"));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: {
    preload: path.join(directory, "preload.cjs"), sandbox: false, contextIsolation: true, offscreen: true, backgroundThrottling: false
  } });
  try {
    await window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
    const run = source => window.webContents.executeJavaScript(`(async () => {
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
      const wait = async (predicate, message) => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await pause(25); } throw new Error(message); };
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const targetButton = () => document.querySelector('[aria-label="目标软件"]');
      const detailTargetButton = () => document.querySelector('[aria-label="切换导出软件"]');
      const chooseDetail = async name => {
        detailTargetButton().click();
        await wait(() => document.querySelector('.detail-export-target-menu'), 'Detail software menu did not open');
        const option = [...document.querySelectorAll('.detail-export-target-menu [role="option"]')].find(node => node.textContent === name);
        check(option, 'Detail software option missing: ' + name);
        option.click();
        await wait(() => document.querySelector('.detail-export-btn')?.textContent.includes(name), 'Detail target did not switch to ' + name);
        check(!document.querySelector('.detail-export-target-menu'), 'Detail software menu must close after selection');
      };
      const choose = async name => { targetButton().click(); await wait(() => [...document.querySelectorAll('[role="option"]')].some(node => node.textContent === name), 'Target menu did not open'); [...document.querySelectorAll('[role="option"]')].find(node => node.textContent === name).click(); await wait(() => targetButton().textContent === name, 'Target did not switch'); };
      const checkAssetContextMenu = async assetId => {
        document.querySelector('#asset-card-' + assetId).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
        await wait(() => document.querySelector('.context-menu'), 'Asset context menu missing');
        const menu = document.querySelector('.context-menu');
        const labels = [...menu.querySelectorAll('button')].map(button => button.textContent.trim());
        check(!menu.querySelector('[data-export-entry="menu"]') && !labels.some(label => /^(发送到 |Send To )/.test(label)), 'Asset context menu must not offer software export');
        check(labels.includes('复制资产 ID') && labels.includes('在资源管理器中打开'), 'Asset context menu must retain its other actions');
        document.body.click();
        await wait(() => !document.querySelector('.context-menu'), 'Context menu did not close');
      };
      const expectExport = async (assetId, target) => {
        const before = (await window.fixture.state()).exports.length;
        document.querySelector('#asset-card-' + assetId + ' .card-export-btn').click();
        await wait(async () => (await window.fixture.state()).exports.length === before + 1, 'Card export did not run');
        const state = await window.fixture.state();
        check(state.exports.at(-1) === target && state.exportAssetIds.at(-1).join() === assetId, 'Card must send the clicked asset to ' + target);
        check(!document.querySelector('.three-dcoat-dialog'), 'Unreal/Blender must not open the 3DCoat dialog');
        await wait(() => !document.querySelector('.detail-export-btn').disabled, 'Export did not finish');
      };
      ${source}
    })()`);
    await run(`
      await wait(() => document.querySelector('.card'), 'Asset card missing');
      document.querySelector('#asset-card-surface').click();
      await wait(() => document.querySelector('.detail-export-btn')?.textContent.includes('Unreal Engine'), 'Unreal detail target missing');
      window.unrealLogo = document.querySelector('.detail-export-btn img').src;
      const mainRect = document.querySelector('.detail-export-btn').getBoundingClientRect();
      const toggleRect = detailTargetButton().getBoundingClientRect();
      check(Math.abs(toggleRect.left - mainRect.right) < 1 && toggleRect.height === mainRect.height && toggleRect.width === 32, 'Software switch must share the right edge and height of the import button');
      const divider = getComputedStyle(detailTargetButton().parentElement, '::before');
      check(divider.width === '1px' && divider.top === '8px' && divider.bottom === '8px', 'A vertical divider must separate import from software switching');
      detailTargetButton().click();
      await wait(() => document.querySelector('.detail-export-target-menu'), 'Detail software menu missing');
      const detailMenu = document.querySelector('.detail-export-target-menu');
      const detailMenuRect = detailMenu.getBoundingClientRect();
      const splitRect = document.querySelector('.detail-export-split').getBoundingClientRect();
      check(Math.abs(detailMenuRect.width - splitRect.width) < 1 && Math.abs(detailMenuRect.left - splitRect.left) < 1, 'Software menu must match the full split button width and align to its edges');
      for (const option of detailMenu.querySelectorAll('[role="option"]')) {
        const rect = option.getBoundingClientRect();
        check(rect.height >= 30 && rect.top >= detailMenuRect.top && rect.bottom <= detailMenuRect.bottom && rect.left >= detailMenuRect.left && rect.right <= detailMenuRect.right, 'Every software option must be fully visible within the menu: ' + option.textContent);
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        check(hit === option, 'Every software option must receive pointer clicks: ' + option.textContent);
      }
      check([...detailMenu.querySelectorAll('[role="option"]')].map(node => node.textContent).join() === 'Unreal Engine,Blender,3DCoat', 'Detail software menu must expose all supported targets');
      check(detailMenu.querySelector('[aria-selected="true"]').textContent === 'Unreal Engine', 'Detail software menu must mark the current target');
      check(detailMenuRect.bottom <= toggleRect.top && detailMenuRect.left >= 0 && detailMenuRect.right <= document.documentElement.clientWidth, 'Bottom-bar software menu must open above the button within the viewport');
      await pause(150);
    `);
    fs.writeFileSync(path.join(directory, "detail-software-menu.png"), (await window.webContents.capturePage()).toPNG());
    await run(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(() => !document.querySelector('.detail-export-target-menu'), 'Escape must dismiss the software menu');
      detailTargetButton().click();
      await wait(() => document.querySelector('.detail-export-target-menu'), 'Detail software menu did not reopen');
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await wait(() => !document.querySelector('.detail-export-target-menu'), 'Clicking outside must dismiss the software menu');
      const exportsBeforeSwitch = (await window.fixture.state()).exports.length;
      await chooseDetail('Blender');
      check(document.querySelector('.detail-export-btn').disabled && !detailTargetButton().disabled, 'An unconfigured target must still allow software switching');
      check((await window.fixture.state()).settings.exportTarget === 'blender', 'Detail choice must persist the shared export target');
      await chooseDetail('3DCoat');
      check(document.querySelector('.detail-export-btn').disabled && !detailTargetButton().disabled, 'Unsupported assets must still allow software switching');
      await chooseDetail('Unreal Engine');
      check((await window.fixture.state()).exports.length === exportsBeforeSwitch, 'Switching software must not start an export');
      await checkAssetContextMenu('model');
      await expectExport('model', 'unreal');
      await expectExport('surface', 'unreal');
      check(!document.querySelector('[aria-label="减面"]'), 'Unreal must not expose Blender reduction');
      check(!document.querySelector('.three-dcoat-import-button') && !document.querySelector('[data-three-dcoat-entry="detail"]'), 'The detail panel must not duplicate the 3DCoat import entry');
      document.querySelector('.settings-trigger').click();
      await wait(() => targetButton(), 'Target selector missing');
      targetButton().scrollIntoView({ block: 'center' });
      targetButton().click();
      await pause(100);
      const trigger = targetButton().getBoundingClientRect();
      const menu = document.querySelector('.export-target-select [role="listbox"]').getBoundingClientRect();
      check(Math.abs(menu.x - trigger.x) < 1, 'Menu must align to the left of its control');
      check(Math.abs(menu.width - trigger.width) < 1, 'Menu width must equal its control');
      check(menu.y >= trigger.bottom && menu.y - trigger.bottom < 10, 'Menu must open immediately below its control');
    `);
    fs.writeFileSync(path.join(directory, "dropdown.png"), (await window.webContents.capturePage()).toPNG());
    await run(`
      [...document.querySelectorAll('[role="option"]')].find(node => node.textContent === 'Blender').click();
      await wait(() => targetButton().textContent === 'Blender', 'Blender did not activate');
      check(document.querySelector('input[aria-label="目标路径"]').value === '', 'A new Blender target must not inherit the Unreal path');
      check(document.querySelector('.export-plugin-install').disabled, 'Install must require a Blender path');
      check(document.querySelectorAll('.export-plugin-install').length === 1 && document.querySelector('.export-plugin-install').closest('.path-display-row'), 'Install must share the path row with the existing status button');
      check(![...document.querySelectorAll('.settings-label')].some(node => node.textContent === 'AssetHive 插件'), 'Separate plugin row must be removed');
      check(targetButton().title.includes('Blender 3.6') && !document.querySelector('.plugin-install-message'), 'Blender guidance must be a software tooltip');
      document.querySelector('input[aria-label="目标路径"]').parentElement.querySelector('button').click();
      await wait(() => document.querySelector('input[aria-label="目标路径"]').value.includes('blender.exe'), 'Blender executable was not saved');
      check(document.querySelector('.export-plugin-install').classList.contains('target-install-btn'), 'Missing plugin must display the download action');
      const inputRect = document.querySelector('input[aria-label="目标路径"]').getBoundingClientRect();
      const installRect = document.querySelector('.export-plugin-install').getBoundingClientRect();
      check(installRect.left >= inputRect.right && installRect.width === 34 && Math.abs(installRect.top + installRect.height / 2 - inputRect.top - inputRect.height / 2) < 1, 'Merged button must retain the compact position after the path');
      document.querySelector('.export-plugin-install').click();
      await wait(async () => (await window.fixture.state()).installs.includes('blender'), 'Blender install did not route to its installer');
      await wait(() => document.querySelector('.export-plugin-install').getAttribute('aria-busy') === 'true', 'Install must show its busy state');
      check(document.querySelector('.export-plugin-install').disabled && document.querySelector('.export-plugin-install .check-spinner'), 'Installing must show a disabled spinner');
      check(targetButton().disabled && document.querySelector('input[aria-label="目标路径"]').parentElement.querySelector('button').disabled, 'Installing must lock target and browse controls');
      check(detailTargetButton().disabled, 'Installing must also lock the detail software switch');
      document.querySelector('.export-plugin-install').click();
      check((await window.fixture.state()).installs.length === 1, 'Installing must reject duplicate clicks');
    `);
    fs.writeFileSync(path.join(directory, "installing.png"), (await window.webContents.capturePage()).toPNG());
    await run(`
      await window.fixture.completeInstall({ ok: true, path: 'C:\\\\Fixture\\\\scripts\\\\addons\\\\assethive' });
      await wait(() => !document.querySelector('.export-plugin-install').disabled, 'Install lock did not release');
      await wait(() => document.querySelector('.export-plugin-install').classList.contains('installed'), 'Successful install must restore the green check');
      check(targetButton().title.includes('scripts') && targetButton().title.includes('Blender'), 'Installed path and restart guidance must move to the software tooltip');
      check(!targetButton().closest('.settings-card').textContent.includes('插件已安装到'), 'Installed path must not occupy an inline row');
      check(document.querySelector('.export-plugin-install .icon-check') && document.querySelector('.export-plugin-install .icon-refresh'), 'Installed button must offer check and reinstall states');
    `);
    // Hidden windows do not own desktop focus; ask Chromium to exercise its CSS states.
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("DOM.enable");
    await window.webContents.debugger.sendCommand("CSS.enable");
    const { root } = await window.webContents.debugger.sendCommand("DOM.getDocument");
    const { nodeId } = await window.webContents.debugger.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: ".export-plugin-install" });
    try {
      for (const state of ["hover", "focus-visible"]) {
        await window.webContents.debugger.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [state] });
        await run(`
          await pause(250);
          check(getComputedStyle(document.querySelector('.export-plugin-install .icon-refresh')).opacity === '1'
            && getComputedStyle(document.querySelector('.export-plugin-install .icon-check')).opacity === '0', 'Hover and focus must expose the reinstall icon');
        `);
        if (state === "hover") fs.writeFileSync(path.join(directory, "reinstall-hover.png"), (await window.webContents.capturePage()).toPNG());
      }
    } finally {
      await window.webContents.debugger.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
      window.webContents.debugger.detach();
    }
    await run(`
      document.querySelector('.export-plugin-install').click();
      await wait(async () => (await window.fixture.state()).installing === 'blender', 'Installed button must allow reinstalling');
      await window.fixture.completeInstall({ ok: false, message: 'Fixture install failed' });
      await wait(() => targetButton().title.includes('Fixture install failed'), 'Install failure must remain available in the software tooltip');
      await wait(() => !document.querySelector('.export-plugin-install').disabled, 'Failure must allow retry');
      await choose('Unreal Engine');
      check(document.querySelector('input[aria-label="目标路径"]').value === 'D:\\\\UE\\\\Original.uproject', 'Unreal path was overwritten by Blender');
      document.querySelector('input[aria-label="目标路径"]').parentElement.querySelector('button').click();
      await wait(() => document.querySelector('input[aria-label="目标路径"]').value.includes('Changed.uproject'), 'Unreal path was not updated');
      document.querySelector('.export-plugin-install').click();
      await wait(async () => (await window.fixture.state()).installing === 'unreal', 'Unreal merged button must route to the Unreal installer');
      check((await window.fixture.state()).installPaths.at(-1).includes('Changed.uproject'), 'Unreal installer must receive the selected path');
      await window.fixture.completeInstall({ ok: true });
      await wait(() => !document.querySelector('.export-plugin-install').disabled, 'Unreal install lock did not release');
      await choose('Blender');
      check(document.querySelector('input[aria-label="目标路径"]').value === 'C:\\\\Blender\\\\blender.exe', 'Blender path was overwritten by Unreal');
      const state = await window.fixture.state();
      check(state.settings.unrealProjectPath.includes('Changed.uproject') && state.settings.blenderExecutablePath.includes('blender.exe'), 'Both target paths must persist independently');
    `);
    fs.writeFileSync(path.join(directory, "blender-settings.png"), (await window.webContents.capturePage()).toPNG());
    await run(`
      document.querySelector('.settings-close').click();
      await wait(() => document.querySelector('.detail-export-btn')?.textContent.includes('Blender'), 'Blender detail label missing');
      window.blenderLogo = document.querySelector('.detail-export-btn img').src;
      check(document.querySelector('.detail-export-btn img').src !== window.unrealLogo, 'Target logo did not switch');
      for (const id of ['surface', 'plant', 'animation', 'hdri']) {
        document.querySelector('#asset-card-' + id).click();
        await pause(100);
        check(!document.querySelector('[aria-label="减面"]'), id + ' must not expose 3D Assets reduction');
        if (id === 'animation' || id === 'hdri') {
          check(document.querySelector('.detail-export-btn').disabled && document.querySelector('#asset-card-' + id + ' .card-export-btn').disabled, id + ' cannot export to Blender');
          await checkAssetContextMenu(id);
        }
      }
      document.querySelector('#asset-card-model').click();
      await wait(() => document.querySelector('[aria-label="减面"]'), '3D Assets reduction missing');
      const reduction = document.querySelector('[aria-label="减面"]');
      check(reduction.textContent.trim() === '' && reduction.querySelector('svg'), 'Reduction is an icon button without a percentage label');
      check(reduction.title.includes('保留 100% 三角面'), 'New settings must default to no reduction and expose it in the tooltip');
      await wait(() => !document.querySelector('.detail-export-btn').disabled, 'Blender export did not enable for the default percentage');
      await expectExport('model', 'blender');
      check((await window.fixture.state()).exportOptions.at(-1).blenderDecimationRatio === 1, 'Default export must retain the original mesh');
      const resolutionRect = document.querySelector('[aria-label="导出分辨率"]').getBoundingClientRect();
      const reductionRect = reduction.getBoundingClientRect();
      check(reductionRect.left >= resolutionRect.right && Math.abs(reductionRect.top - resolutionRect.top) < 1, 'Reduction must sit to the right of resolution');
      check(reductionRect.width >= 32 && reductionRect.width <= 44 && reductionRect.right <= document.documentElement.clientWidth, 'Reduction icon must match the compact detail controls and fit the panel');
      reduction.click();
      await wait(() => document.querySelectorAll('.blender-decimation-select [role="option"]').length === 5, 'Reduction must offer exactly five descending percentages');
      check(document.querySelector('.blender-decimation-select [aria-selected="true"]').textContent === '100%', 'The default selected percentage must be 100%');
      check([...document.querySelectorAll('.blender-decimation-select [role="option"]')].map(node => node.textContent).join() === '100%,75%,50%,25%,10%', 'Reduction must offer exactly five descending percentages');
    `);
    fs.writeFileSync(path.join(directory, "blender-reduction.png"), (await window.webContents.capturePage()).toPNG());
    await run(`
      document.querySelector('.blender-decimation-select [role="option"][aria-selected="true"]').click();
      const options = () => [...document.querySelectorAll('.blender-decimation-select [role="option"]')];
      for (const ratio of [0.75, 0.5, 0.25, 1, 0.1]) {
        document.querySelector('[aria-label="减面"]').click();
        await wait(() => options().some(node => node.textContent === (ratio * 100) + '%'), 'Reduction option missing');
        options().find(node => node.textContent === (ratio * 100) + '%').click();
        await wait(async () => (await window.fixture.state()).settings.blenderDecimationRatio === ratio, 'Reduction selection was not saved');
        await wait(() => document.querySelector('[aria-label="减面"]').title.includes('保留 ' + (ratio * 100) + '% 三角面'), 'Reduction tooltip must show the current percentage');
      }
      await wait(() => !document.querySelector('.detail-export-btn').disabled, 'Blender export did not enable');
      await expectExport('surface', 'blender');
      await expectExport('model', 'blender');
      await window.fixture.holdNextExport();
      document.querySelector('.detail-export-btn').click();
      await wait(async () => (await window.fixture.state()).exportPending, 'Export used the wrong software');
      check(detailTargetButton().disabled, 'An ongoing import must lock the detail software switch');
      check((await window.fixture.state()).exportOptions.at(-1).blenderDecimationRatio === 0.1, 'Selected reduction must reach Blender export');
      await window.fixture.progress({ percent: 80, message: '导入模型：model.fbx' });
      await wait(() => document.querySelector('.detail-export-stage')?.textContent.includes('Blender 导入中'), 'Progress must name the current software');
      await checkAssetContextMenu('surface');
      await window.fixture.progress({ percent: 100, message: 'waiting for the export receipt' });
      await pause(15500);
      check(document.querySelector('.detail-export-btn').disabled && detailTargetButton().disabled, '100% progress must keep controls locked until the actual request completes');
      await window.fixture.completeExport();
      await wait(() => !document.querySelector('.detail-export-btn').disabled, 'Export did not finish');
      await window.fixture.progress({ percent: 80, message: 'late progress from the completed export' });
      await pause(100);
      check(!document.querySelector('.detail-export-btn').disabled && !detailTargetButton().disabled, 'Late progress must not relock export or target controls');
      for (const outcome of ['failed', 'rejected']) {
        const before = (await window.fixture.state()).exports.length;
        await window.fixture.failNextExport(outcome);
        document.querySelector('.detail-export-btn').click();
        await wait(async () => (await window.fixture.state()).exports.length === before + 1, 'Failed export request was not dispatched');
        await wait(() => !document.querySelector('.detail-export-btn').disabled, outcome + ' must release the export lock');
        await window.fixture.progress({ percent: 80, message: 'late progress after failure' });
        await window.fixture.progress({ percent: 100, message: 'late completion after failure' });
        await pause(100);
        check(!document.querySelector('.detail-export-btn').disabled && !detailTargetButton().disabled, outcome + ' late progress must not lock controls');
      }
      document.querySelector('.settings-trigger').click();
      await wait(() => targetButton(), 'Settings did not reopen');
      check(!targetButton().disabled, 'Late progress must not lock the settings software selector');
      await choose('Unreal Engine');
      document.querySelector('.settings-close').click();
      await wait(() => document.querySelector('.detail-export-btn')?.textContent.includes('Unreal Engine'), 'Unreal target did not restore');
      check(!document.querySelector('[aria-label="减面"]'), 'Unreal must never show the reduction button');
      for (const id of ['animation', 'hdri']) {
        document.querySelector('#asset-card-' + id).click();
        await pause(100);
        check(!document.querySelector('.detail-export-btn').disabled, id + ' must remain exportable to Unreal');
      }
      document.querySelector('#asset-card-model').click();
      await pause(100);
      document.querySelector('.detail-export-btn').click();
      await wait(async () => (await window.fixture.state()).exports.includes('unreal'), 'Unreal export routing broke');
      await wait(() => !document.querySelector('.detail-export-btn').disabled, 'Unreal export did not finish');
      document.querySelector('.settings-trigger').click();
      await wait(() => targetButton(), 'Settings did not reopen for disconnect check');
      await choose('Blender');
      document.querySelector('.settings-close').click();
      await wait(() => document.querySelector('[aria-label="减面"]')?.title.includes('10%'), 'Blender reduction must survive switching targets');
      await window.fixture.setConnected(false);
      await wait(() => document.querySelector('.detail-export-btn').classList.contains('dimmed'), 'Disconnected target must dim export');
      check(getComputedStyle(document.querySelector('.detail-export-btn > span')).opacity === '0.5', 'Dimmed label must be translucent');
      check(getComputedStyle(document.querySelector('.detail-export-btn img')).opacity === '0.5', 'Dimmed logo must be translucent');
      await checkAssetContextMenu('model');
      check(!detailTargetButton().disabled, 'A disconnected target must allow switching software');
      await chooseDetail('Unreal Engine');
      await chooseDetail('Blender');
    `);
    fs.writeFileSync(path.join(directory, "disabled-export.png"), (await window.webContents.capturePage()).toPNG());
    await run(`
      document.querySelector('.settings-trigger').click();
      await wait(() => targetButton(), 'Settings did not reopen for 3DCoat');
      check(targetButton().textContent === 'Blender', 'Settings must reflect the last software chosen in asset details');
      await choose('3DCoat');
      let exportCard = targetButton().closest('.settings-card');
      const program = () => exportCard.querySelector('input[aria-label="3DCoat 程序"]');
      const browses = () => [...exportCard.querySelectorAll('.slot-input-wrap .browse-icon-btn')];
      check(program() && !program().readOnly && program().tagName === 'INPUT', '3DCoat must expose one editable application path');
      check(!exportCard.textContent.includes('3DCoat 数据目录'), 'The data directory row must be removed');
      check(browses().length === 1, '3DCoat needs a browse button inside the application field');
      check(!exportCard.querySelector('.export-plugin-install'), '3DCoat must not offer a plugin install');
      check(targetButton().title.includes('AppLink') && exportCard.textContent.includes('无需安装插件'), '3DCoat must explain that AppLink needs no plugin');
      document.querySelector('.settings-close').click();
      await checkAssetContextMenu('model');
      document.querySelector('.settings-trigger').click();
      await wait(() => targetButton(), 'Settings did not reopen for 3DCoat configuration');
      exportCard = targetButton().closest('.settings-card');
      browses()[0].click();
      await wait(() => program().value.includes('3DCoatGL64.exe'), '3DCoat application was not saved from the picker');
      await wait(() => document.querySelector('[data-three-dcoat-config="data-directory"]'), 'Missing data directory must be configurable without the disabled export dialog');
      document.querySelector('[data-three-dcoat-config="data-directory"]').click();
      await wait(() => targetButton().closest('.settings-card').textContent.includes('已就绪'), 'Configured 3DCoat must report ready without a plugin');
      check(!document.querySelector('[data-three-dcoat-config="data-directory"]'), 'Fallback data directory action must hide once configured');
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setValue.call(program(), 'E:\\\\3DCoat\\\\3DCoatGL64.exe');
      program().dispatchEvent(new Event('input', { bubbles: true }));
      program().focus();
      program().dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await wait(() => program().value.includes('E:\\\\3DCoat'), 'A typed 3DCoat application path was not saved');
    `);
    fs.writeFileSync(path.join(directory, "three-dcoat-settings.png"), (await window.webContents.capturePage()).toPNG());
    await run(`
      document.querySelector('.settings-close').click();
      document.querySelector('#asset-card-model').click();
      await wait(() => document.querySelector('.detail-export-btn')?.textContent.includes('3DCoat'), '3DCoat detail label missing');
      const button = document.querySelector('.detail-export-btn');
      check(button.querySelector('img').src !== window.blenderLogo && button.querySelector('img').src !== window.unrealLogo, '3DCoat logo must replace the target logo');
      await wait(() => button.querySelector('img').complete && button.querySelector('img').naturalWidth > 0, '3DCoat logo must load successfully');
      check(!document.querySelector('[aria-label="导出分辨率"]') && !document.querySelector('[aria-label="减面"]') && !document.querySelector('.three-dcoat-import-button'), '3DCoat must hide resolution, reduction and the duplicate import button');
      button.click();
      await wait(() => document.querySelector('.three-dcoat-dialog'), '3DCoat dialog did not open');
      await wait(() => !document.querySelector('.three-dcoat-primary').disabled, '3DCoat dialog did not become ready');
      document.querySelector('.three-dcoat-primary').click();
      await wait(async () => (await window.fixture.state()).threeDCoatImports.length === 1, '3DCoat import was not sent');
      check((await window.fixture.state()).threeDCoatImports[0].mode === 'ppp', 'The selected 3DCoat mode must reach the backend');
      await wait(() => document.querySelector('.three-dcoat-primary').textContent === '完成' && !document.querySelector('.three-dcoat-primary').disabled, '3DCoat dialog did not report success');
      document.querySelector('.three-dcoat-primary').click();
      await wait(() => !document.querySelector('.three-dcoat-dialog'), '3DCoat dialog did not close');
      document.querySelector('#asset-card-surface').click();
      await checkAssetContextMenu('model');
      document.querySelector('#asset-card-model .card-export-btn').click();
      await wait(() => document.querySelector('.three-dcoat-dialog'), '3DCoat card export did not open its dialog');
      await wait(() => document.querySelector('.three-dcoat-asset-name')?.textContent === 'Test model', 'Card export must open the clicked model, not the selected surface');
      document.querySelector('.three-dcoat-actions .three-dcoat-secondary').click();
      await wait(() => !document.querySelector('.three-dcoat-dialog'), 'Card dialog did not close');
      document.querySelector('#asset-card-model').click();
      await pause(150);
    `);
    fs.writeFileSync(path.join(directory, "three-dcoat-export.png"), (await window.webContents.capturePage()).toPNG());
    await run(`
      await pause(150);
      document.querySelector('#asset-card-surface').click();
      await pause(150);
      check(document.querySelector('.detail-export-btn').disabled && document.querySelector('.detail-export-btn').title.includes('FBX'), 'Assets without supported models must be blocked for 3DCoat');
      await checkAssetContextMenu('surface');
      document.querySelector('.settings-trigger').click();
      await wait(() => targetButton(), 'Settings did not reopen after 3DCoat export');
      await choose('Unreal Engine');
      document.querySelector('.settings-close').click();
      await expectExport('surface', 'unreal');
    `);
    const report = { ok: true, checks: ["dropdown aligned below control", "independent target paths on first use and repeated switching", "single compact install/status button after the path", "missing, installing, installed and retry states", "installation guidance in software tooltip", "Blender and Unreal installer routing", "target label and logo", "detail and card route to all three targets", "card export sends the clicked asset rather than the selected asset", "asset context menu omits software export and retains other actions for every target", "import progress names the current target", "no duplicate 3DCoat entry beside the export button", "3D Assets only reduction after resolution", "compact icon-only reduction with 100% default, original mesh export and five persistent percentage options", "animation/HDRI disabled only for Blender", "3DCoat target without plugin rows or installer", "single editable 3DCoat path with automatic data directory", "missing 3DCoat data directory can be configured without exporting", "Send to 3DCoat routing through the AppLink dialog", "switching back from 3DCoat restores Unreal card export"] };
    report.checks.unshift("detail import button has a separate software switch and vertical divider", "detail software menu matches the full button width and every option is visible and clickable", "detail software switching persists the shared target without starting an import", "disconnected or unsupported targets allow switching; installation and imports lock switching", "Escape and outside clicks dismiss the software menu");
    report.checks.push("100% progress waits for the actual export receipt beyond the old 15-second timer", "success, failed results and rejected requests release export controls", "late progress after success or failure never locks export or either software selector");
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify(report, null, 2));
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ ok: false, error: String(error) }));
    try { fs.writeFileSync(path.join(directory, "failure.png"), (await window.webContents.capturePage()).toPNG()); } catch { /* Keep the assertion failure if Chromium cannot paint. */ }
    app.exit(1);
  }
}

async function launch() {
  const { spawn } = require("node:child_process");
  const directory = path.resolve(__dirname, "..", ".tmp", `export-targets-ui-${Date.now()}-${process.pid}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "preload.cjs"), `
const { contextBridge } = require('electron');
let settings = { customLibraryPath: 'D:\\\\Fixture', exportTarget: 'unreal', unrealProjectPath: 'D:\\\\UE\\\\Original.uproject', unrealEditorPath: '', blenderExecutablePath: '', uiLanguage: 'zh', exportResolution: '4k' };
if (process.env.ASSETHIVE_TEST_LEGACY_BLENDER) delete settings.blenderExecutablePath;
const installs = [], sentTargets = [];
const exportOptions = [];
const exportAssetIds = [];
let holdExport = false, pendingExport = null, exportProgress = null, nextExportOutcome = '';
const installPaths = [];
const threeDCoatImports = [];
let blenderConnected = true;
let blenderInstalled = false;
let threeDCoatReady = false;
let threeDCoatExecutableExists = false;
let threeDCoatExecutable = 'C:\\\\3DCoat\\\\3DCoatGL64.exe';
let pendingInstall = null;
const asset = { id: 'surface', name: 'Test Stone', assetType: 'surface', source: 'custom', path: 'D:\\\\Fixture', metaPath: '', meta: {}, modelFiles: [], textureFiles: [], tags: [], preview: null };
const assets = [asset, ...[['model', '3d'], ['plant', '3dplant'], ['animation', 'animation'], ['hdri', 'hdri']].map(([id, assetType]) => ({ ...asset, id, assetType, name: 'Test ' + id }))];
assets.find(item => item.id === 'model').modelFiles = ['D:\\\\Fixture\\\\model.fbx'];
const threeDCoatState = () => ({ executable: threeDCoatExecutable, dataDirectory: 'D:\\\\Documents\\\\3DCoat2026',
  executableExists: threeDCoatExecutableExists, dataDirectoryExists: threeDCoatReady, ready: threeDCoatReady, mode: 'ppp', language: 'zh' });
contextBridge.exposeInMainWorld('fixture', { state: async () => ({ settings, installs, installPaths, installing: pendingInstall?.target, exports: sentTargets, exportOptions, exportAssetIds, exportPending: Boolean(pendingExport), threeDCoatImports }), setConnected: async value => { blenderConnected = value; },
 holdNextExport: async () => { holdExport = true; }, failNextExport: async outcome => { nextExportOutcome = outcome; }, completeExport: async () => { pendingExport(); pendingExport = null; }, progress: async payload => { exportProgress?.(payload); },
 completeInstall: async result => { const pending = pendingInstall; pendingInstall = null; if (result.ok && pending.target === 'blender') blenderInstalled = true; pending.resolve(result); } });
const install = (target, targetPath) => { installs.push(target); installPaths.push(targetPath); return new Promise(resolve => { pendingInstall = { target, resolve }; }); };
const send = async (target, payload) => {
 sentTargets.push(target); exportOptions.push(payload.options); exportAssetIds.push(payload.assetIds);
 if (holdExport) { holdExport = false; await new Promise(resolve => { pendingExport = resolve; }); }
 const outcome = nextExportOutcome; nextExportOutcome = '';
 if (outcome === 'rejected') throw new Error('simulated export rejection');
 if (outcome === 'failed') return { ok: false, message: 'simulated export failure' };
 return { ok: true, results: payload.assetIds.map(assetId => ({ assetId, status: 'success' })) };
};
const noop = () => () => {};
contextBridge.exposeInMainWorld('arkhive', {
 getSettings: async () => settings, updateSettings: async patch => (settings = { ...settings, ...patch }),
 getAssetIndex: async () => assets, getAssetById: async id => ({ ok: true, asset: assets.find(asset => asset.id === id) }), getAppVersion: async () => ({ ok: true, version: '2.2.9' }),
 getUnrealConnectionStatus: async () => ({ connected: true, targetName: 'Fixture UE' }), getPluginStatus: async () => ({ installed: true, enabled: true, resolvedProjectPath: settings.unrealProjectPath }),
 getBlenderStatus: async () => ({ installed: blenderInstalled, connected: blenderInstalled && blenderConnected, targetName: 'Fixture Blender' }),
 getThreeDCoatStatus: async () => ({ ok: true, ...threeDCoatState() }),
 configureThreeDCoat: async patch => { if (patch.executable) threeDCoatExecutable = patch.executable; threeDCoatReady = /\\.exe$/i.test(patch.executable || ''); return { ok: true, ...threeDCoatState() }; },
 pickThreeDCoatProgram: async () => { threeDCoatExecutableExists = true; return { ok: true, ...threeDCoatState() }; },
 pickThreeDCoatDataDirectory: async () => { threeDCoatReady = true; return { ok: true, ...threeDCoatState() }; },
 getThreeDCoatImportInfo: async assetId => ({ ok: true, assetId, assetName: 'Test ' + assetId, files: [{ path: 'D:\\\\Fixture\\\\model.fbx', label: 'model.fbx' }], ...threeDCoatState(), ready: true, executableExists: true, dataDirectoryExists: true }),
 importToThreeDCoat: async payload => { threeDCoatImports.push(payload); return { ok: true, status: 'queued', modelFile: payload.modelFile, mode: payload.mode, alreadyRunning: true }; },
 ...(process.env.ASSETHIVE_TEST_LEGACY_BLENDER ? {} : { pickBlenderExecutable: async () => 'C:\\\\Blender\\\\blender.exe' }),
 pickAssetFolder: async () => 'C:\\\\Blender', pickTargetPath: async () => ({ type: 'project', path: 'D:\\\\UE\\\\Changed.uproject' }),
 installBlenderPlugin: async () => install('blender', settings.blenderExecutablePath),
 installPlugin: async (_repo, targetPath) => install('unreal', targetPath),
 exportToBlender: async payload => send('blender', payload),
 exportToUnreal: async payload => send('unreal', payload),
 checkAppUpdate: async () => ({ ok: true, hasUpdate: false }), setTaskbarProgress: async () => ({ ok: true }),
 onAssetChange: noop, onExportProgress: callback => { exportProgress = callback; return () => { exportProgress = null; }; }, onScanProgress: noop, onCustomSaveProgress: noop,
 onCalculateBoundsRequest: noop, onResolveDroppedItemsProgress: noop,
 loadImportQueue: async () => ({ drafts: [], activeIndex: 0, selectedIndexes: [] }), saveImportQueue: async value => value,
 foliageOpaqueStatus: async () => ({ available: false }), pathExists: async () => true
});
`);
  const child = spawn(require("electron"), [path.join(__dirname, "test-export-targets-electron.cjs"), directory], { stdio: "inherit", windowsHide: true });
  const timeout = setTimeout(() => child.kill(), 60000);
  const code = await new Promise(resolve => child.on("exit", resolve));
  clearTimeout(timeout);
  const report = fs.existsSync(path.join(directory, "result.json")) ? fs.readFileSync(path.join(directory, "result.json"), "utf8") : "No UI test result";
  console.log(report);
  console.log("Screenshots:", directory);
  process.exitCode = code === 0 ? 0 : 1;
}

if (process.versions.electron) runElectron();
else launch().catch(error => { console.error(error); process.exitCode = 1; });
