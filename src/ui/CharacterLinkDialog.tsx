import { useState } from 'react';
import type { AppSettings } from '../types';
import type { SuitExportResult } from './suitExportTypes';
import { DialogCloseButton } from './DialogCloseButton';
import { CharacterSendError } from './CharacterSendError';

export function CharacterLinkDialog({ assetIds, settings, onClose, onApplied, onBusyChange, t }: {
  assetIds: string[]; settings: AppSettings; onClose: () => void; onApplied: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  t: (zh: string, en: string) => string;
}) {
  const [result, setResult] = useState<SuitExportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(phase: 'inspect' | 'apply') {
    if (busy) return;
    setBusy(true); setError(''); onBusyChange(true);
    try {
      const decisions = Object.fromEntries((result?.entries || []).filter(row => row.status === 'conflict' || row.status === 'missing')
        .map(row => [row.key, row.status === 'missing' ? 'restore' : row.action === 'adopt' ? 'adopt' : 'applyMapping']));
      const reply = await window.arkhive.exportToUnreal({ assetIds, options: { ...settings,
        suitOptions: { associationSync: true, includeStaticMeshes: true, inspectAllMeshes: true },
        suitPhase: phase, suitDecisions: decisions,
        suitInspectToken: result?.inspectToken, suitManifestHash: result?.manifestHash } });
      if (!reply.ok || !reply.suitResult) throw new Error(reply.message || 'No association result');
      setResult(reply.suitResult);
      await onApplied();
    } catch (reason) { setError(String(reason)); if (phase === 'apply') setResult(null); }
    finally { setBusy(false); onBusyChange(false); }
  }
  const rows = (result?.entries || []).filter(row => row.action !== 'retained');
  const blocked = rows.some(row => ['blocked', 'failed', 'skipped'].includes(row.status));
  const changed = rows.filter(row => row.action !== 'unchanged').length;
  const done = result?.phase === 'apply';
  return <div className="confirm-overlay recycle-overlay" role="dialog" aria-modal="true" aria-label={t('管理 UE 资源', 'Manage UE assets')}>
    <div className="confirm-dialog recycle-dialog suit-export-dialog">
      <header className="dialog-heading"><h3>{t('管理 UE 资源', 'Manage UE assets')}</h3><DialogCloseButton onClick={busy ? () => {} : onClose} label={t('关闭', 'Close')} /></header>
      <div className="suit-export-body">
        <p>{t('让已有 UE 资源与 AssetHive 当前版本保持一致。确认后同步，后续从 AssetHive 正常更新和发送。', 'Sync existing UE assets to the current AssetHive version. After confirming, use normal AssetHive updates and sending.')}</p>
        <p>{t('目标工程：', 'Project: ')}<code>{settings.unrealProjectPath || t('当前连接工程', 'Connected project')}</code></p>
        {result && <p>{blocked ? t('有项目待处理，请查看下方原因。', 'Some items need attention; see the reasons below.')
          : done ? t('关联并同步完成。', 'Association and sync complete.')
            : changed ? t(`本次需同步 ${changed} 项，确认后执行。`, `${changed} items need syncing. Confirm to proceed.`)
              : t('已有资源与 AssetHive 一致，无需更新。', 'Existing assets match AssetHive; no update needed.')}</p>}
        {result?.sharedAffectedAssets?.length ? <p>{t('共享影响：', 'Shared impact: ')}{result.sharedAffectedAssets.map(asset => asset.name).join('、')}</p> : null}
        {rows.filter(row => row.action !== 'unchanged' || ['blocked', 'failed'].includes(row.status)).map(row => <div className={`suit-export-row ${row.status}`} key={row.key}>
          <strong>{row.name}</strong><span>{['success','unchanged'].includes(row.status) ? t('已同步','Synced') : row.status === 'blocked' || row.status === 'failed' ? t('待处理','Needs attention') : row.action === 'unchanged' ? t('无变化','Unchanged') : row.action === 'added' || row.action === 'restore' ? t('将补充到 UE','Add to UE') : t('将按 AssetHive 更新','Update from AssetHive')}</span>
          {row.message && (['blocked','failed'].includes(row.status) ? <CharacterSendError message={row.message} t={t} /> : <small>{row.message}</small>)}
          <details><summary>{t('查看 UE 位置','Show UE location')}</summary><code>{row.path || row.targetPath}</code></details>
        </div>)}
        {error && <CharacterSendError message={error} t={t} />}
      </div>
      <footer className="suit-export-footer"><div className="confirm-actions">
        {busy && <span role="status">{t('正在处理，请稍候…','Working…')}</span>}
        <button className="browse-btn" disabled={busy} onClick={() => void run('inspect')}>{t('检索并核验完整资产','Find and inspect asset')}</button>
        {result && !done && changed > 0 && <button className="browse-btn primary-btn" disabled={busy || blocked || Boolean(error)} onClick={() => void run('apply')}>{t('关联并同步此资产','Associate and sync this asset')}</button>}
      </div></footer>
    </div>
  </div>;
}
