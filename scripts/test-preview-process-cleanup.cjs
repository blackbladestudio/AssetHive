const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { selectPreviewTargets } = require('./kill-stale-electron.cjs');

test('preview cleanup preserves download monitor, login, import worker and all their children', () => {
  const root = path.resolve(__dirname, '..');
  const executablePath = path.join(root, 'node_modules/electron/dist/electron.exe');
  const process = (pid, parentPid, commandLine, name = 'electron.exe') => ({ pid, parentPid, commandLine, executablePath, name });
  const processes = [
    process(1, 0, `${executablePath} .`),
    process(2, 1, `${executablePath} --type=renderer`),
    process(3, 0, `${executablePath} ${root}/scripts/megascans-monitor.cjs`),
    process(4, 3, `${executablePath} --type=renderer`),
    process(5, 4, `${executablePath} --type=utility`),
    process(6, 0, `node ${root}/scripts/download-megascans.cjs --run`, 'node.exe'),
    process(7, 6, `${executablePath} ${root}/electron/main.js`),
    process(8, 7, `${executablePath} --type=utility`),
    process(9, 0, `${executablePath} ${root}/scripts/quixel-login.cjs`),
    process(10, 9, `${executablePath} --type=renderer`),
    { ...process(11, 0, 'C:/OtherApp/electron.exe .'), executablePath: 'C:/OtherApp/electron.exe' },
    process(12, 0, ''),
    process(13, 0, 'node scripts/download-megascans.cjs --run', 'node.exe'),
    process(14, 13, `${executablePath} ${root}/electron/main.js`)
  ];
  assert.deepEqual(selectPreviewTargets(processes, root).map(entry => entry.pid), [1, 2]);
});

test('preview cleanup preserves Fab runners, sessions and login helpers with their descendants', () => {
  const root = path.resolve(__dirname, '..');
  const executablePath = path.join(root, 'node_modules/electron/dist/electron.exe');
  for (const entry of ['fab-megascans-runner', 'fab-session-electron', 'fab-login']) {
    for (const name of ['node.exe', 'electron.exe']) {
      const processes = [
        { pid: 4, parentPid: 3, name: 'electron.exe', executablePath, commandLine: `${executablePath} --type=utility` },
        { pid: 3, parentPid: 2, name: 'electron.exe', executablePath, commandLine: `${executablePath} --type=renderer` },
        { pid: 2, parentPid: 1, name: 'electron.exe', executablePath, commandLine: `${executablePath} "${root}/electron/main.js"` },
        { pid: 1, parentPid: 0, name, executablePath, commandLine: `"${executablePath}" "${root}/scripts/${entry}.cjs" --run` },
        { pid: 5, parentPid: 0, name: 'electron.exe', executablePath, commandLine: `${executablePath} .` }
      ];
      assert.deepEqual(selectPreviewTargets(processes, root).map(process => process.pid), [5], `${entry} (${name})`);
      processes.find(process => process.pid === 1).commandLine = `node scripts/${entry}.cjs --run`;
      assert.deepEqual(selectPreviewTargets(processes, root).map(process => process.pid), [5], `relative ${entry} (${name})`);
    }
  }
});
