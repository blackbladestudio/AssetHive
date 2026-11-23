const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { normalizeUnrealFolder } = require('../../shared/animationUnrealExport.mjs');
const execute = promisify(execFile);
const normalized = value => path.resolve(value).replaceAll('\\', '/').toLowerCase();

function animationPackageFilename(projectPath, targetPath) {
  if (!/\.uproject$/i.test(projectPath) || !normalizeUnrealFolder(targetPath) || normalizeUnrealFolder(targetPath) !== targetPath || targetPath === '/Game') throw new Error('UE 工程或资产路径不合法');
  return path.join(path.dirname(projectPath), 'Content', ...targetPath.slice('/Game/'.length).split('/')) + '.uasset';
}

async function existingAnimationTargets(projectPath, animations) {
  if (!animations.length) return [];
  const content = await fs.realpath(path.join(path.dirname(projectPath), 'Content')).catch(error => { if (error.code === 'ENOENT') return path.resolve(path.dirname(projectPath), 'Content'); throw error; });
  return Promise.all(animations.map(async entry => {
    const filename = animationPackageFilename(projectPath, entry.targetPath);
    const stat = await fs.stat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && !stat.isFile()) throw new Error(`目标不是资产文件：${filename}`);
    // A junction must not redirect checkout outside the selected project's Content.
    let ancestor = stat ? filename : path.dirname(filename);
    let actual = '';
    while (!actual) {
      actual = await fs.realpath(ancestor).catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      if (actual || normalized(ancestor) === normalized(content) || path.dirname(ancestor) === ancestor) break;
      ancestor = path.dirname(ancestor);
    }
    if (actual && normalized(actual) !== normalized(content) && !normalized(actual).startsWith(normalized(content) + '/')) throw new Error('UE 目标目录的实际路径位于工程 Content 外');
    return { key: entry.key, targetPath: entry.targetPath, filename, exists: Boolean(stat) };
  }));
}

async function perforceSettings(projectPath) {
  const config = path.join(path.dirname(projectPath), 'Saved', 'Config', 'WindowsEditor', 'SourceControlSettings.ini');
  const text = await fs.readFile(config, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const values = {};
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const heading = line.trim().match(/^\[(.+)\]$/);
    if (heading) { section = heading[1]; continue; }
    const pair = line.match(/^\s*(Provider|UseP4Config|Port|UserName|Workspace)\s*=\s*(.*?)\s*$/);
    if (pair && ['SourceControl.SourceControlSettings', 'PerforceSourceControl.PerforceSourceControlSettings'].includes(section)) values[pair[1]] = pair[2];
  }
  if (values.Provider !== 'Perforce') return null;
  if (values.UseP4Config?.toLowerCase() === 'true') return [];
  if (!values.Port || !values.UserName || !values.Workspace) throw new Error('UE 的 P4 配置不完整，请先配置工程源代码管理');
  return ['-p', values.Port, '-u', values.UserName, '-c', values.Workspace];
}

async function runP4(args, cwd) {
  let executable = 'p4.exe';
  if (await fs.stat('D:/Secure/p4.exe').catch(() => null)) executable = 'D:/Secure/p4.exe';
  let stdout;
  try { ({ stdout } = await execute(executable, args, { cwd, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })); }
  catch (error) {
    if (!error.stdout) throw new Error(error.code === 'ENOENT' ? '未找到 p4.exe，请安装 P4 命令行客户端' : 'P4 命令执行失败，请检查登录和连接');
    stdout = error.stdout;
  }
  return stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

async function checkoutAnimationTargets(projectPath, animations, onProgress, dependencies = {}) {
  const targets = await (dependencies.existingTargets || existingAnimationTargets)(projectPath, animations);
  const existing = targets.filter(entry => entry.exists);
  if (!existing.length) return new Map();
  const settings = await (dependencies.settings || perforceSettings)(projectPath);
  const run = dependencies.runP4 || runP4;
  const notes = new Map();
  const pending = [];
  const content = await fs.realpath(path.join(path.dirname(projectPath), 'Content')).catch(() => '');
  // Validate the whole batch before any checkout. Never change file attributes.
  for (const target of existing) {
    for (const extension of ['.uasset', '.uexp', '.ubulk']) {
      const filename = target.filename.replace(/\.uasset$/i, extension);
      if (extension !== '.uasset' && !await fs.stat(filename).catch(() => null)) continue;
      if (content) {
        const actual = await fs.realpath(filename);
        if (!normalized(actual).startsWith(normalized(content) + '/')) throw new Error('UE 资产关联文件的实际路径位于工程 Content 外');
      }
      if (!settings) {
        await fs.access(filename, require('node:fs').constants.W_OK).catch(() => { throw new Error(`目标资产只读，且 UE 未配置 P4：${target.targetPath}`); });
        notes.set(target.key, '已有动画将重新导入；工程未配置 P4');
        continue;
      }
      const records = await run([...settings, '-ztag', '-Mj', 'fstat', filename], path.dirname(projectPath));
      const state = records.find(record => record.depotFile);
      if (!state) {
        const error = records.find(record => record.code === 'error');
        if (!error || !/no such file\(s\)/i.test(error.data || '')) throw new Error(`P4 无法核验目标：${target.targetPath} · ${error?.data || '未返回文件状态'}`);
        await fs.access(filename, require('node:fs').constants.W_OK).catch(() => { throw new Error(`目标未受 P4 管理且只读：${target.targetPath}`); });
        notes.set(target.key, '已有动画未受 P4 管理，将重新导入');
        continue;
      }
      if (!Object.hasOwn(state, 'isMapped') || !state.clientFile || normalized(state.clientFile) !== normalized(filename)) throw new Error(`P4 工作区与 UE 目标不一致：${target.targetPath}`);
      const user = settings.includes('-u') ? settings[settings.indexOf('-u') + 1] : '';
      if (Number(state.otherOpen) || Object.keys(state).some(key => /^other(?:Open|Lock)\d+$/.test(key)) || (user && state.actionOwner && state.actionOwner.toLowerCase() !== user.toLowerCase())) throw new Error(`目标已被他人迁出，未覆盖：${target.targetPath}`);
      if (Number(state.unresolved) > 0 || (state.headRev && state.haveRev !== state.headRev && state.action !== 'add')) throw new Error(`目标有未解决冲突或不是最新版本，请先处理 P4：${target.targetPath}`);
      if (state.action && !['edit', 'add'].includes(state.action)) throw new Error(`目标处于 P4 ${state.action} 操作中，未覆盖：${target.targetPath}`);
      if (state.action) notes.set(target.key, '目标已在当前 P4 工作区迁出，将重新导入');
      else pending.push({ ...target, filename });
    }
  }
  for (const target of pending) {
    onProgress?.({ percent: 0, message: `已有资产，正在 P4 迁出：${target.targetPath}` });
    const records = await run([...settings, '-ztag', '-Mj', 'edit', target.filename], path.dirname(projectPath));
    const error = records.find(record => record.code === 'error');
    if (error || !records.some(record => record.action === 'edit' && normalized(record.clientFile || '') === normalized(target.filename))) throw new Error(`P4 迁出失败，未发送动画：${target.targetPath} · ${error?.data || '未确认迁出结果'}`);
    notes.set(target.key, '已自动在 P4 中迁出本次目标，将重新导入；未提交');
  }
  return notes;
}

module.exports = { animationPackageFilename, existingAnimationTargets, perforceSettings, checkoutAnimationTargets };
