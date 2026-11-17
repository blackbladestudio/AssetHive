const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const pending = new Map();
const views = ['front', 'left', 'right', 'back'];

async function resolveBlender(configured) {
  if (configured) { await fs.access(configured); return configured; }
  const base = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Blender Foundation');
  const folders = await fs.readdir(base).catch(() => []);
  for (const folder of folders.sort((a,b) => b.localeCompare(a, undefined, { numeric: true }))) {
    const exe = path.join(base, folder, 'blender.exe');
    if (await fs.access(exe).then(() => true, () => false)) return exe;
  }
  throw new Error('Groom 自动预览需要 Blender，请在设置中指定 Blender 路径，或手动上传预览图');
}

async function renderGroomPreview(source, { cacheRoot, blenderExecutablePath = '' }) {
  if (!path.isAbsolute(source) || !/\.abc$/i.test(source)) throw new Error('Groom 预览只接受 ABC 文件');
  const stat = await fs.stat(source);
  if (!stat.isFile()) throw new Error('Groom 源文件不存在');
  const key = crypto.createHash('sha256').update(JSON.stringify([4, path.resolve(source), stat.size, stat.mtimeMs])).digest('hex');
  const directory = path.join(cacheRoot, 'GroomPreviews', key);
  const paths = Object.fromEntries(views.map(view => [view, path.join(directory, view + '.png')]));
  if (await Promise.all(Object.values(paths).map(p => fs.stat(p).then(s => s.size > 100, () => false))).then(found => found.every(Boolean))) return paths;
  if (pending.has(key)) return pending.get(key);
  const job = (async () => {
    const executable = await resolveBlender(blenderExecutablePath);
    await fs.mkdir(directory, { recursive: true });
    // Blender cannot read Electron's virtual app.asar filesystem. Materialize
    // the bundled script beside this job's cached output before launching it.
    const renderScript = path.join(directory, 'render_groom_preview.py');
    await fs.writeFile(renderScript, await fs.readFile(path.join(__dirname, '../scripts/render_groom_preview.py')));
    await new Promise((resolve, reject) => execFile(executable,
      ['--background', '--factory-startup', '--python-exit-code', '1', '--python', renderScript, '--', source, directory],
      { windowsHide: true, timeout: 240000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => error ? reject(new Error(`Groom 拍摄失败：${String(stderr || stdout || error.message).slice(-1600)}`)) : resolve()));
    const after = await fs.stat(source);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Groom 文件在拍摄期间已变化，请重试');
    for (const file of Object.values(paths)) if ((await fs.stat(file)).size <= 100) throw new Error('Groom 预览图生成失败');
    return paths;
  })().finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}
module.exports = { renderGroomPreview };
