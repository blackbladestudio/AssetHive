import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { AssetRecord } from '../types';
import { animationArchiveLocation, animationCharacterKey } from '../../shared/animationUnrealExport.mjs';
import { DialogCloseButton } from './DialogCloseButton';

type Operation = { at?: string; action?: string; status?: string; sourcePath?: string; projectPath?: string; targetPath?: string; message?: string };

export function AnimationAssetActivity({ asset, projectPath, t }: {
  asset: AssetRecord; projectPath: string; t: (zh: string, en: string) => string;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const history = [...(Array.isArray(asset.meta.importHistory) ? asset.meta.importHistory : []),
    ...(Array.isArray(asset.meta.animationOperationHistory) ? asset.meta.animationOperationHistory : [])]
    .filter((entry): entry is Operation => Boolean(entry && typeof entry === 'object'))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const action = (entry: Operation) => entry.action === 'export'
    ? entry.status === 'success' ? t('发送到 UE · 已保存', 'Send to UE · Saved') : entry.status === 'skipped' ? t('发送到 UE · 已跳过', 'Send to UE · Skipped') : t('发送到 UE · 失败', 'Send to UE · Failed')
    : entry.action === 'import' ? t('首次入库', 'Imported') : entry.action === 'update' ? t('更新动画文件', 'Animation file updated') : t('编辑资产信息', 'Asset information edited');
  const time = (at?: string) => at && Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleString() : t('时间未记录', 'Time not recorded');
  const location = animationArchiveLocation(asset.modelFiles.find(file => /\.fbx$/i.test(file)) || asset.metaPath);
  const tag = asset.animationGameTag;
  const characterEn = animationCharacterKey(location).split('/')[1] || (tag?.kind === 'monster' ? tag.id.replace(/^Monster_/i, '') : '');
  const characterZh = tag?.kind === 'monster' ? tag.name : tag?.kind === 'weapon' ? `主角${tag.name}` : asset.animationAffiliation || String(asset.meta.animationAffiliation || '');
  const lastUpdated = String(asset.meta.updatedAt || history.find(entry => entry.action !== 'export')?.at || asset.createdAt || '');
  const receipts = Array.isArray(asset.meta.animationUEExports) ? asset.meta.animationUEExports : [];
  const receipt = projectPath ? receipts.find(entry => String(entry.projectPath).replaceAll('\\', '/').toLowerCase() === projectPath.replaceAll('\\', '/').toLowerCase()) : receipts.at(-1);
  const target = String(receipt?.targetPath || '').replace(/(\/([^/.]+))\.\2$/, '$1');
  return <section className="animation-asset-activity animation-detail-section">
    <div className="character-engine-location"><span className="character-info-label">{t('引擎内路径：', 'Engine path: ')}</span>
      <span className="character-engine-path" title={target}>{target || t('暂无发送记录', 'No send record')}</span>
      <button type="button" className="character-engine-copy" disabled={!target} aria-label={t('复制引擎路径', 'Copy engine path')} onClick={() => { void navigator.clipboard.writeText(target); }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></svg></button>
    </div>
    <div className="character-display-name-row"><span className="character-info-label">{t('角色中文名：', 'Character Chinese name: ')}</span><strong>{characterZh || t('未记录', 'Not recorded')}</strong></div>
    <div className="character-display-name-row"><span className="character-info-label">{t('角色英文名：', 'Character English name: ')}</span><strong>{characterEn || t('未记录', 'Not recorded')}</strong></div>
    <div className="character-display-name-row animation-last-update-row"><span className="character-info-label">{t('最后更新时间：', 'Last updated: ')}</span><strong><time>{time(lastUpdated)}</time></strong>
      <button type="button" className="character-history-open" onClick={() => setHistoryOpen(true)}>{t('更新历史', 'Update history')}</button>
    </div>
    {historyOpen && createPortal(<div className="confirm-overlay recycle-overlay" role="dialog" aria-modal="true" aria-label={t('更新历史', 'Update history')}>
      <div className="confirm-dialog recycle-dialog character-history-dialog">
        <header className="dialog-heading"><h3>{t('更新历史', 'Update history')} · {asset.name}</h3><DialogCloseButton onClick={() => setHistoryOpen(false)} label={t('关闭', 'Close')} /></header>
      <div className="character-history-list">{history.length ? history.map((entry, index) => <details key={`${entry.at}:${index}`} className={`character-history-entry animation-operation-entry${entry.action === 'export' ? ' is-send' : ''}`}>
        <summary><span>{action(entry)}</span><time>{time(entry.at)}</time></summary>
        {entry.sourcePath && <code>{entry.sourcePath}</code>}{entry.projectPath && <code>{entry.projectPath}</code>}{entry.targetPath && <code>{entry.targetPath}</code>}
        {entry.message && <small>{entry.message}</small>}
      </details>) : <small>{t('暂无操作记录', 'No operation records available.')}</small>}</div>
      </div>
    </div>, document.body)}
  </section>;
}
