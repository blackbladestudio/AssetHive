const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');

// Explicit, user-run manual login. The downloader never opens this window.
async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { cache: { type: 'string', default: path.resolve(__dirname, '../.cache/fab-megascans') } } });
  const root = path.join(path.resolve(values.cache), 'fab-session');
  await fs.mkdir(root, { recursive: true });
  const env = { ...process.env, ASSETHIVE_PREVIEW_USER_DATA: path.join(root, 'worker-runtime') };
  delete env.ELECTRON_RUN_AS_NODE;
  console.log('请在 Fab 官方页面登录，并在 Content Preferences 中允许显示 Mature content。完成后关闭网页窗口，将自动验证访问权限。');
  const child = spawn(require('electron'), [path.join(__dirname, 'fab-session-electron.cjs'), '--login'], {
    cwd: path.resolve(__dirname, '..'), env, windowsHide: false, stdio: ['ignore', 'inherit', 'ignore']
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0) throw new Error('Fab 登录或内容可见性验证尚未完成；可重新运行登录入口。');
  console.log('Fab 登录和所列商品的访问验证完成。');
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
