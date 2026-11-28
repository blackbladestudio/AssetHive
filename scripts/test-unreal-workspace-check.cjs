const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {createUnrealWorkspaceCheck} = require('../electron/services/unrealWorkspaceCheck');
async function setup(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ue-workspace-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100}));
  return {dir,options:{projectPath:'D:/Work/Game.uproject',libraryPath:'//server/Library',assets:[{id:'one'},{id:'two'}]}};
}
test('first local checkout checks every suit once; reopening uses the local marker',async t=>{
  const {dir,options}=await setup(t);let calls=0;
  const refresh=async()=>{calls++};
  assert.equal((await createUnrealWorkspaceCheck(dir)({...options,refresh})).checked,true);
  assert.equal(calls,2);
  assert.equal((await createUnrealWorkspaceCheck(dir)({...options,projectPath:'d:\\work\\Game.uproject',refresh})).checked,false);
  assert.equal(calls,2);
  await createUnrealWorkspaceCheck(dir)({...options,projectPath:'E:/Moved/Game.uproject',refresh});
  assert.equal(calls,4);
});
test('a colleague profile or different library must check independently',async t=>{
  const {dir,options}=await setup(t);let calls=0;const refresh=async()=>{calls++};
  await createUnrealWorkspaceCheck(dir)({...options,refresh});
  await createUnrealWorkspaceCheck(path.join(dir,'colleague'))({...options,refresh});
  await createUnrealWorkspaceCheck(dir)({...options,libraryPath:'//server/Other',refresh});
  assert.equal(calls,6);
});
test('failed and switched workspaces never get a completed marker',async t=>{
  const {dir,options}=await setup(t);const ensure=createUnrealWorkspaceCheck(dir);
  await assert.rejects(ensure({...options,refresh:async()=>{throw Error('offline')}}),/offline/);
  assert.deepEqual(await fs.readdir(dir),[]);
  await assert.rejects(ensure({...options,refresh:async()=>{},isCurrent:()=>false}),/切换/);
  assert.deepEqual(await fs.readdir(dir),[]);
  assert.equal((await ensure({...options,refresh:async()=>{}})).checked,true);
});
test('concurrent connection polls share the same initial check',async t=>{
  const {dir,options}=await setup(t);const ensure=createUnrealWorkspaceCheck(dir);let calls=0;
  await Promise.all([ensure({...options,refresh:async()=>{calls++}}),ensure({...options,refresh:async()=>{calls++}})]);
  assert.equal(calls,2);
});

test('main schedules workspace verification independently of UI polling and waits for active imports', async () => {
  const source = await fs.readFile(path.join(__dirname, '../electron/main.js'), 'utf8');
  const start = source.indexOf('let unrealWorkspaceCheckTimer;');
  const end = source.indexOf('async function getUnrealConnectionStatus', start);
  assert.ok(start >= 0 && end > start);
  let importing = true;
  let connected = 'D:/Work/First.uproject';
  const timers = [];
  const checked = [];
  const context = vm.createContext({
    quitting: false, scanIndexAuthoritative: true, scanInProgress: false, recycleInProgress: false, activeExportCalls: 0,
    librarySelectionGeneration: 1, index: [{ id: 'one' }],
    tcpClient: { findClient: () => ({ editorInfo: { projectPath: connected } }) },
    hasActiveBackgroundImport: () => importing, normalizeComparePath: input => input.toLowerCase(),
    setTimeout: (run, delay) => { timers.push({ run, delay }); return {}; },
    ensureCurrentUnrealWorkspace: async project => { checked.push(project); return { checked: true, count: 1 }; },
    writeLog: () => {}
  });
  vm.runInContext(source.slice(start, end), context);
  context.scheduleUnrealWorkspaceCheck();
  await timers.shift().run();
  assert.deepEqual(checked, []);
  assert.equal(timers[0].delay, 5000);
  importing = false;
  await timers.shift().run();
  assert.deepEqual(checked, [connected]);
  context.scheduleUnrealWorkspaceCheck();
  assert.equal(timers.length, 0);
  connected = 'D:/Work/Second.uproject';
  context.scheduleUnrealWorkspaceCheck();
  await timers.shift().run();
  assert.equal(checked.at(-1), connected);
  assert.equal(context.activeExportCalls, 0);
});
