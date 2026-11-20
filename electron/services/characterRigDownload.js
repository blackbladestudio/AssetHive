const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { activeCharacterFiles, characterModelPreviewComponents: listCharacterComponents } = require('../../shared/characterComponents.mjs');
const { loadParent } = require('./characterComponents');
const { safePath, withRecycleLock } = require('./libraryRecycle');

async function downloadCharacterRigFiles({ root, asset, slot, destination, onProgress = () => {} }) {
  onProgress(0);
  return withRecycleLock(root, async () => {
    const loaded = await loadParent(root, asset, ['suit', 'monster', 'npc', 'weapon', 'item']);
    const parent = loaded.parent;
    const targetRoot = await fs.realpath(destination);
    const library = await fs.realpath(loaded.root);
    const relative = path.relative(library, targetRoot);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('请选择 AssetHive 资源库以外的保存位置');
    const part = slot ? listCharacterComponents(parent).find(item => item.slot === slot) : null;
    if (slot && !part) throw new Error('目标部件不存在，请刷新');
    const files = (part ? part.files : activeCharacterFiles(parent))
      .filter(file => ['model', 'staticMesh', 'skeletalMesh'].includes(file.role));
    if (!files.length) throw new Error('当前没有可下载的模型');
    const names = new Set();
    const plan = [];
    for (const file of files) {
      const source = path.resolve(parent.path, file.storedPath);
      const within = path.relative(parent.path, source);
      if (!within || within === '..' || within.startsWith('..' + path.sep) || path.isAbsolute(within)) throw new Error('模型文件不在当前资产管理目录');
      await safePath(loaded.root, source);
      if (!(await fs.lstat(source)).isFile()) throw new Error('文件不可读取：' + file.normalizedName);
      let name = path.basename(file.normalizedName || file.storedPath);
      if (parent.assetType === 'weapon') {
        const ext = path.extname(name);
        name = require('../../shared/weaponRules.mjs').weaponPackageOutput(name.slice(0, -ext.length), parent.meta.name || parent.name) + ext;
      }
      const folder = 'Models';
      const key = `${folder}/${name}`.toLowerCase();
      if (names.has(key)) throw new Error('下载文件重名，请先检查资产：' + name);
      names.add(key);
      plan.push({ source, folder, name });
    }
    const name = String(parent.meta.name || parent.name).replace(/[^\p{L}\p{N}_-]/gu, '_');
    const output = await fs.mkdtemp(path.join(targetRoot, `${name}${part ? '_' + part.slot.split('_').at(-1) : ''}_Rig_`));
    try {
      await fs.mkdir(path.join(output, 'Models'));
      onProgress(10);
      for (const [index, file] of plan.entries()) {
        await fs.copyFile(file.source, path.join(output, file.folder, file.name), constants.COPYFILE_EXCL);
        onProgress(10 + Math.round(85 * (index + 1) / plan.length));
      }
      await fs.writeFile(path.join(output, '绑定说明.txt'), [
        `资产：${parent.meta.name || parent.name}`, `范围：${part ? part.name : '当前资产'}`,
        'Models：当前版本模型，不含贴图。这里是独立工作副本，可以用于外部绑定。',
        '完成绑定后导出带骨骼与蒙皮的 FBX。',
        '回到 AssetHive 的同一资产或部件，点击“上传绑定”，选择 FBX，检查后填写备注并确认更新。',
        '这会新增或更新骨骼模型，保留静态模型。'
      ].join('\r\n'), 'utf8');
      onProgress(100);
      return { ok: true, path: output, count: plan.length, message: `已下载 ${plan.length} 个模型文件` };
    } catch (error) {
      throw new Error(`下载未完成：${error.message}。已复制的文件保留在 ${output}`);
    }
  });
}

module.exports = { downloadCharacterRigFiles };
