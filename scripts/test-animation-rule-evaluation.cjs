const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const ts = require('typescript');
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const exports = {}; cache.set(file, exports);
  const native = createRequire(file);
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  new Function('exports', 'require', compiled)(exports, id => id.startsWith('./') ? load(path.resolve(path.dirname(file), id + '.ts')) : native(id));
  return exports;
}
const { evaluateUnifiedAnimationRules, loadAnimationRuleReference } = load(path.resolve(__dirname, '../src/ui/animationRuleEvaluation.ts'));

test('the shared import/detail evaluator contains monster checks and removes hero/template rows', () => {
  const checks = evaluateUnifiedAnimationRules({ assetName: 'AS_Executor_Alert_Walk_Start', animationAffiliation: '怪物', animationType: '基础移动', filePath: 'D:/start.fbx', stats: null }, { error: 'missing' });
  assert.deepEqual(checks.slice(0, 2).map(row => row.id), ['name', 'fps']);
  assert.equal(checks.find(row => row.id === 'loop-reference').status, 'skip');
  assert.equal(checks.find(row => row.id === 'ramp').status, 'warn');
  assert.ok(!checks.some(row => ['template', 'steps', 'root'].includes(row.id)));
});

test('import pairing resolves planned archive path and prefers staged loop updates', async () => {
  const calls = [];
  const loadStats = async file => { calls.push(file); return { frameRate: 60 }; };
  const assets = [{ assetType: 'animation', modelFiles: ['Z:/Monster/AS_Executor_Alert_Walk.fbx'], meta: {} }];
  const fromLibrary = await loadAnimationRuleReference('D:/Drop/AS_Executor_Alert_Walk_Start.fbx', 'Z:/Monster', assets, [], loadStats);
  assert.equal(fromLibrary.stats.frameRate, 60);
  assert.equal(calls.pop(), assets[0].modelFiles[0]);
  await loadAnimationRuleReference('D:/Drop/AS_Executor_Alert_Walk_Start.fbx', 'Z:/Monster', assets, [{ sourcePath: 'D:/Drop/AS_Executor_Alert_Walk.fbx', destinationPath: 'Z:/Monster' }], loadStats);
  assert.equal(calls.pop(), 'D:/Drop/AS_Executor_Alert_Walk.fbx');
  const missing = await loadAnimationRuleReference('D:/Drop/AS_Executor_Alert_Walk_Stop.fbx', 'Z:/OtherMonster', assets, [], loadStats);
  assert.equal(missing.error, 'missing');
});

const { folderPickerPath } = require('../electron/services/folderPickerPath');
test('picker enters the filled directory or its nearest existing ancestor, preserving UNC roots', async () => {
  const stat = async file => ({ isDirectory: () => file === 'Z:\\Artist\\Animation' });
  assert.equal(await folderPickerPath('Z:\\Artist\\Animation', stat, path.win32), 'Z:\\Artist\\Animation\\');
  assert.equal(await folderPickerPath('Z:\\Artist\\Animation\\Monster\\New', stat, path.win32), 'Z:\\Artist\\Animation\\');
  assert.equal(await folderPickerPath('\\\\fileshare\\share\\Animation', async () => ({ isDirectory: () => true }), path.win32), '\\\\fileshare\\share\\Animation\\');
});

const { focusUnrealEditor } = require('../electron/services/unrealFocus');
test('foreground request validates PID, uses a hidden process, and reports refusal without throwing', async () => {
  let calls = 0;
  const run = (exe, args, options, callback) => {
    calls++;
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /Get-Process -Id 123/);
    assert.match(script, /ProcessName -ne 'UnrealEditor'/);
    assert.equal(options.windowsHide, true);
    callback(new Error('foreground refused'));
  };
  assert.equal(await focusUnrealEditor('123; command', run, 'win32'), false);
  assert.equal(calls, 0);
  assert.equal(await focusUnrealEditor(123, run, 'win32'), false);
  assert.equal(calls, 1);
});
