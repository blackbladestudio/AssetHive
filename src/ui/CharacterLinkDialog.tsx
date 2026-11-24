import { useState } from 'react';
import type { AppSettings } from '../types';
import type { SuitExportResult } from './suitExportTypes';
import { DialogCloseButton } from './DialogCloseButton';

export function CharacterLinkDialog({ assetIds, settings, onClose, onApplied, t }: {
  assetIds: string[]; settings: AppSettings; onClose: () => void; onApplied: () => Promise<void>;
  t: (zh: string, en: string) => string;
}) {
  const [result, setResult] = useState<SuitExportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(phase: 'inspect' | 'apply') {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const reply = await window.arkhive.exportToUnreal({ assetIds, options: { ...settings,
        suitOptions: { linkOnly: true, includeStaticMeshes: true }, suitPhase: phase,
        suitInspectToken: result?.inspectToken, suitManifestHash: result?.manifestHash } });
      if (!reply.ok || !reply.suitResult) throw new Error(reply.message || 'No link result');
      setResult(reply.suitResult);
      await onApplied();
    } catch (reason) { setError(String(reason)); if (phase === 'apply') setResult(null); }
    finally { setBusy(false); }
  }
  const ready = result?.entries.filter(row => row.status === 'ready').length || 0;
  const linked = result?.entries.filter(row => ['linked', 'success', 'unchanged'].includes(row.status)).length || 0;
  return <div className="confirm-overlay recycle-overlay" role="dialog" aria-modal="true" aria-label={t('仅关联现有 UE 资源', 'Link existing UE assets only')}>
    <div className="confirm-dialog recycle-dialog suit-export-dialog">
      <header className="dialog-heading"><h3>{t('管理 UE 资源', 'Manage UE assets')}</h3><DialogCloseButton onClick={busy ? () => {} : onClose} label={t('关闭', 'Close')} /></header>
      <div className="suit-export-body">
        <p>{t('以完整资产为单位检索模型、贴图和依赖，核验后建立关联。已有 UE 资源保持原样；缺失或有差异的资源会列出原因。', 'Find and verify the complete asset and its dependencies. Existing UE assets stay unchanged; missing or different resources are reported.')}</p>
        <p>{t('目标工程：', 'Project: ')}<code>{settings.unrealProjectPath || t('当前连接工程', 'Connected project')}</code></p>
        {result && <p>{t(`已关联 ${linked} 项，可关联 ${ready} 项。`, `${linked} linked; ${ready} ready to link.`)}</p>}
        {result?.entries.map(row => <div className={`suit-export-row ${row.status}`} key={row.key}>
          <strong>{row.name}</strong><span>{({ready:t('可关联','Ready'),linked:t('已关联','Linked'),unchanged:t('已关联','Linked'),success:t('已关联','Linked'),missing:t('UE 中缺失','Missing in UE'),blocked:t('待核对','Needs review'),skipped:t('未关联','Not linked'),failed:t('失败','Failed')}[row.status] || row.status)}</span>
          <small>{row.message}</small><code>{row.path || row.targetPath}</code>
        </div>)}
        {error && <p className="suit-export-error" role="alert">{error}</p>}
      </div>
      <footer className="suit-export-footer"><div className="confirm-actions">
        {busy && <span role="status">{t('正在核验内容与依赖…', 'Checking content and dependencies…')}</span>}
        <button className="browse-btn" disabled={busy} onClick={() => void run('inspect')}>{t('检索并核验完整资产', 'Find and verify asset')}</button>
        {ready > 0 && result?.phase !== 'apply' && <button className="browse-btn primary-btn" disabled={busy} onClick={() => void run('apply')}>{t('关联此资产', 'Link this asset')}</button>}
      </div></footer>
    </div>
  </div>;
}
