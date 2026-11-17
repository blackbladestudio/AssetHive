const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('actual login helper renews expired/rejected credentials and follows the saved Epic session buttons', { timeout: 60000 }, async t => {
  const parent = path.resolve(__dirname, '../.cache/quixel-login-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'run-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(parent));
    await fs.rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  for (const mode of ['expired', 'refresh', 'manual', 'epic-sso']) {
    const refresh = mode !== 'expired', manual = mode === 'manual';
    const sso = mode === 'epic-sso';
    const authRoot = path.join(root, mode);
    await fs.mkdir(authRoot);
    const bootstrap = path.join(authRoot, 'fixture.cjs');
    await fs.writeFile(bootstrap, String.raw`
const {app,safeStorage,session}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path');
app.setPath('userData',path.join(process.env.ASSETHIVE_QUIXEL_AUTH_ROOT,'browser'));
app.whenReady().then(async()=>{
  const old=${refresh ? "'rejected-old-token'" : "'header.eyJleHAiOjF9.signature'"};
  await fs.writeFile(path.join(process.env.ASSETHIVE_QUIXEL_AUTH_ROOT,'auth.enc'),safeStorage.encryptString(JSON.stringify({token:old})));
  await session.defaultSession.cookies.set({url:'https://quixel.com',name:'auth',value:encodeURIComponent(JSON.stringify({token:old})),path:'/'});
  ${manual ? "app.on('browser-window-created',(_event,win)=>win.webContents.on('did-finish-load',()=>{if(!win.isVisible())app.exit(8);else process.stdout.write('FIXTURE_VISIBLE\\n');}));" : ''}
  const sso=${sso};
  await session.defaultSession.protocol.handle('https',request=>{
    const url=new URL(request.url);
    let html='<html><script>setTimeout(()=>{document.cookie="auth="+encodeURIComponent(JSON.stringify({token:"fresh-fixture-token"}))+"; path=/";},500);</script></html>';
    if(sso){
      if(url.pathname==='/megascans/home') html='<html><body><a href="/login">SIGN IN</a><div id="migration" style="position:fixed;inset:0;background:white"><h1>A NEW HOME FOR MEGASCANS</h1><button onclick="document.getElementById(\'migration\').remove()">STAY HERE</button><a href="https://fab.com">VISIT FAB.COM</a></div></body></html>';
      else if(url.pathname==='/login') html='<html><body><a href="https://www.epicgames.com/id/login">SIGN IN WITH EPIC GAMES</a><input type="email"><input type="password"><button onclick="document.title=\'WRONG_PASSWORD_FORM\'">SIGN IN</button></body></html>';
      else if(url.hostname==='www.epicgames.com') html='<html><script>location.href="https://quixel.com/legacy-auth";</script></html>';
      else if(url.pathname==='/legacy-auth') html='<html><script>document.cookie="auth="+encodeURIComponent(JSON.stringify({token:"fresh-fixture-token"}))+"; path=/";</script></html>';
    }
    return new Response(html,{headers:{'content-type':'text/html'}});
  });
  process.argv.push(${JSON.stringify(refresh ? '--refresh' : '--auto-login')});
  ${manual ? "process.argv.push('--login');" : ''}
  require(${JSON.stringify(path.join(__dirname, 'quixel-login.cjs'))});
}).catch(error=>{process.stdout.write('FIXTURE_ERROR:'+error.message+'\n',()=>app.exit(9));});
`);
    const env = { ...process.env, ASSETHIVE_QUIXEL_AUTH_ROOT: authRoot };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [bootstrap], { env, windowsHide: false, stdio: ['ignore', 'pipe', 'ignore'] });
    t.after(() => { if (child.exitCode == null) child.kill(); });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, output.replace(/ASSETHIVE_AUTH:[^\r\n]+/g, 'ASSETHIVE_AUTH:[hidden]'));
    assert.ok(output.includes(manual ? 'ASSETHIVE_LOGIN_STATUS:window' : 'ASSETHIVE_LOGIN_STATUS:restoring'));
    if (manual) assert.ok(output.includes('FIXTURE_VISIBLE'), '手动重新登录必须显示窗口');
    if (sso) assert.equal((output.match(/ASSETHIVE_LOGIN_STATUS:continuing/g) || []).length, 3, '迁移提示、首页登录和Epic登录应各点击一次');
    const prefix = 'ASSETHIVE_AUTH:', line = output.split(/\r?\n/).find(item => item.startsWith(prefix));
    assert.ok(line, '没有返回更新后的凭证');
    assert.equal(JSON.parse(line.slice(prefix.length)).token, 'fresh-fixture-token');
    assert.ok(!output.includes('ASSETHIVE_LOGIN_STATUS:needsLogin'), '保存的会话应自动恢复');
  }
});

test('saved-session clicks are bounded and cannot submit password forms or operate unrelated pages', { timeout: 25000 }, async t => {
  const parent = path.resolve(__dirname, '../.cache/quixel-login-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'controls-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode == null) {
      const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed;
    }
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(parent));
    await fs.rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  const button = (label, attributes = '') => `<button ${attributes} onclick="window.count++">${label}</button>`;
  const home = 'https://quixel.com/megascans/home', login = 'https://quixel.com/login';
  const cases = [
    { url: home, controls: button('SIGN IN'), expected: 'openSignIn' },
    { url: home, controls: '<h1>A NEW HOME FOR MEGASCANS</h1>' + button('STAY HERE') + button('VISIT FAB.COM'), expected: 'dismissMigration' },
    { url: login, controls: button('SIGN IN WITH EPIC GAMES') + '<input type="email"><input type="password">' + button('SIGN IN'), expected: 'epicSignIn' },
    { url: login, controls: '<input type="password">' + button('SIGN IN') + button('Continue'), expected: null },
    { url: login, controls: button('SIGN IN WITH EPIC GAMES', 'disabled'), expected: null },
    { url: login, controls: button('SIGN IN WITH EPIC GAMES') + button('SIGN IN WITH EPIC GAMES'), expected: null },
    { url: home, controls: button('SIGN IN', 'style="display:none"'), expected: null },
    { url: home, controls: button('SIGN IN') + '<div style="position:fixed;inset:0;background:black"></div>', expected: null },
    { url: login, controls: '<a href="https://quixel.com.evil.test/login" onclick="window.count++;event.preventDefault()">SIGN IN WITH EPIC GAMES</a>', expected: null },
    { url: 'https://unrelated.test/login', controls: button('SIGN IN WITH EPIC GAMES'), expected: null },
    { url: 'http://quixel.com/login', controls: button('SIGN IN WITH EPIC GAMES'), expected: null },
    { url: 'https://quixel.com/checkout', controls: button('SIGN IN') + button('Continue'), expected: null },
    { url: 'https://www.epicgames.com/id/login', controls: button('Continue'), expected: null }
  ];
  const bootstrap = path.join(root, 'controls.cjs');
  await fs.writeFile(bootstrap, String.raw`
const {app,BrowserWindow,session}=require('electron');
const assert=require('node:assert/strict');
const {createSavedSessionAdvancer}=require(${JSON.stringify(path.join(__dirname, 'lib/quixel-session-continue.cjs'))});
app.setPath('userData',${JSON.stringify(path.join(root, 'browser'))});
app.whenReady().then(async()=>{
  let html='';
  for(const scheme of ['http','https'])await session.defaultSession.protocol.handle(scheme,()=>new Response(html,{headers:{'content-type':'text/html'}}));
  const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  for(const c of ${JSON.stringify(cases)}){
    html='<html><body><script>window.count=0</script>'+c.controls+'</body></html>';
    await win.loadURL(c.url);
    await new Promise(resolve=>globalThis.setTimeout(resolve,100));
    const advance=createSavedSessionAdvancer();
    assert.equal(await advance(win.webContents),c.expected,c.url);
    assert.equal(await advance(win.webContents),null,'同一步骤不得重复点击');
    assert.equal(await win.webContents.executeJavaScript('window.count'),c.expected?1:0,c.url);
  }
  process.stdout.write('CONTROLS_PASSED\n',()=>app.exit(0));
}).catch(e=>process.stdout.write(e.message+'\n',()=>app.exit(1)));
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require('electron'), [bootstrap], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, output); assert.match(output, /CONTROLS_PASSED/);
});
