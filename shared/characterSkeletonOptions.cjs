const path = require('node:path').posix;

function applySkeletonOptions(entry, options = {}) {
  if (entry.kind !== 'skeletalMesh') return entry;
  const choice = options.skeletonOverrides?.[entry.key] || options.skeletonSelection;
  if (!choice || choice.mode === 'auto') return entry;
  if (!['existing', 'create'].includes(choice.mode)) throw new Error('请选择自动、使用已有骨架或创建新骨架');
  const skeletonPath = choice.mode === 'existing' || choice.path?.trim() ? String(choice.path || '').trim().split('.')[0]
    : `${path.dirname(entry.targetPath)}/SKEL_${entry.name.replace(/^SK_/, '')}_Custom`;
  if (!/^\/Game\/(?:[A-Za-z0-9_]+\/)*[A-Za-z0-9_]+$/.test(skeletonPath)) throw new Error('请选择有效的 UE 骨架路径（/Game/…）');
  return { ...entry, skeletonPath,
    config: { ...entry.config, ownSkeleton: choice.mode === 'create', skeletonOverride: choice.mode,
      skeletonOverridePath: String(choice.path || '').trim() } };
}

module.exports = { applySkeletonOptions };
