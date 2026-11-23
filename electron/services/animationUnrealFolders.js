const fs = require('node:fs/promises');
const path = require('node:path');

// Read only the selected project's Content directory. Do not follow junctions
// or symlinks, and bound traversal in large productions.
async function listAnimationUnrealFolders(projectPath) {
  if (!projectPath || !/\.uproject$/i.test(projectPath)) throw new Error('未识别目标 UE 工程');
  const content = path.join(path.dirname(projectPath), 'Content');
  const root = await fs.realpath(content);
  const folders = ['/Game'];
  const queue = [{ disk: root, unreal: '/Game', depth: 0 }];
  let truncated = false;
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (current.depth >= 12) { truncated = true; continue; }
    const entries = await fs.readdir(current.disk, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[A-Za-z0-9_-]+$/.test(entry.name)) continue;
      const disk = path.join(current.disk, entry.name);
      const actual = await fs.realpath(disk).catch(() => '');
      if (!actual || actual.toLowerCase() !== disk.toLowerCase() || !actual.toLowerCase().startsWith(root.toLowerCase() + path.sep)) continue;
      const unreal = `${current.unreal}/${entry.name}`;
      folders.push(unreal);
      if (folders.length >= 20000) return { projectPath, folders, truncated: true };
      queue.push({ disk, unreal, depth: current.depth + 1 });
    }
  }
  return { projectPath, folders, truncated };
}

async function unrealFolderFromDirectory(projectPath, directory) {
  const content = await fs.realpath(path.join(path.dirname(projectPath), 'Content'));
  const chosen = await fs.realpath(directory);
  const relative = path.relative(content, chosen);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('请选择当前 UE 工程 Content 内的文件夹');
  const folder = ['/Game', ...relative.split(path.sep).filter(Boolean)].join('/');
  if (!require('../../shared/animationUnrealExport.mjs').normalizeUnrealFolder(folder)) throw new Error('目录名不符合 UE 路径规范');
  return folder;
}

module.exports = { listAnimationUnrealFolders, unrealFolderFromDirectory };
