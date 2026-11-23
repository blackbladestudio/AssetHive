import type { AssetRecord } from '../types';

export function animationHasBeenSent(asset: AssetRecord, projectPath = '') {
  const key = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  const rows = asset.animationSendReceipts || (Array.isArray(asset.meta.animationUEExports) ? asset.meta.animationUEExports : []);
  const receipt = projectPath ? rows.find(row => key(row.projectPath) === key(projectPath)) : rows.at(-1);
  const fingerprint = asset.animationContentFingerprint || (asset.meta.identity as { contentFingerprint?: string } | undefined)?.contentFingerprint;
  return Boolean(receipt && (!receipt.contentFingerprint || !fingerprint || receipt.contentFingerprint === fingerprint));
}


export type AnimationVersionStatus = { state: string; projectPath?: string; message?: string };
export function animationIndicatorState(asset: AssetRecord, projectPath = '', status?: AnimationVersionStatus) {
  const key = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  if (status?.projectPath && projectPath && key(status.projectPath) !== key(projectPath)) return { current: false, zh: '目标工程不同，未核验 UE 版本', en: 'Different target project; UE version not verified' };
  const labels: Record<string, [string, string]> = {
    current: ['已发送，与 UE 版本一致', 'Sent; matches the UE version'],
    neverSent: ['未发送到当前 UE 工程', 'Not sent to the current UE project'],
    libraryUpdated: ['库已更新，与 UE 版本不一致，待发送', 'Library updated; differs from UE, pending send'],
    engineUpdated: ['UE 已修改，与库版本不一致', 'UE modified; differs from the library'],
    bothUpdated: ['库与 UE 都已修改，版本不一致', 'Library and UE both modified; versions differ'],
    missing: ['UE 资产缺失，待发送', 'UE asset missing; pending send'],
    sourceMissing: ['归档文件无法读取，无法核验版本', 'Archive file unreadable; unable to verify'],
    error: ['UE 版本核验失败', 'UE version check failed'],
    unverified: ['UE 版本尚未核验', 'UE version not verified']
  };
  const fallback: [string, string] = animationHasBeenSent(asset, projectPath) ? ['已发送，UE 版本尚未核验', 'Sent; UE version not verified'] : ['未发送或库已更新，待发送', 'Not sent or library updated; pending send'];
  const [zh, en] = status ? labels[status.state] || labels.unverified : fallback;
  return { current: status?.state === 'current', zh: status?.message && status.state !== 'current' ? `${zh}；${status.message}` : zh, en };
}
