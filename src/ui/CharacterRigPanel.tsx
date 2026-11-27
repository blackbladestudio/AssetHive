import { useEffect, useState, type HTMLAttributes } from 'react';

export function CharacterRigPanel({ assetId, isPart, suitWorkflow = true, total, uploaded, stale, pendingReview = 0, reviewedUnchanged = 0, complete, staticReady, needsAttention, disabled, onUpload, onReview, uploadDropProps, t }: {
  assetId: string; isPart: boolean; suitWorkflow?: boolean; total: number; uploaded: number; stale: number; pendingReview?: number; reviewedUnchanged?: number; complete: boolean; staticReady: boolean; disabled: boolean;
  needsAttention: boolean;
  onReview: (needsRigging: boolean) => Promise<void>;
  onUpload: () => void; t: (zh: string, en: string) => string;
  uploadDropProps: Pick<HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>;
}) {
  const [downloading, setDownloading] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [percent, setPercent] = useState(0);
  useEffect(() => window.arkhive.onRigDownloadProgress?.(event => {
    if (event.assetId === assetId) setPercent(current => Math.max(current, Math.min(100, Math.round(Number(event.percent) || 0))));
  }), [assetId]);
  const needsUpload = uploaded < total || stale > pendingReview;
  async function review(needsRigging: boolean) {
    setReviewing(true); setFailed(false); setMessage('');
    try { await onReview(needsRigging); }
    catch (error) { setFailed(true); setMessage(String(error)); }
    finally { setReviewing(false); }
  }
  async function download() {
    setDownloading(true); setPercent(0); setMessage(''); setFailed(false);
    try {
      const result = await window.arkhive.downloadCharacterRigFiles(assetId);
      if (result.canceled) return;
      if (!result.ok) throw new Error(result.message);
      setMessage(t(`已保存到：${result.path}`, `Saved to: ${result.path}`));
    } catch (error) { setFailed(true); setMessage(String(error)); }
    finally { setDownloading(false); }
  }
  return <section className="character-rig-panel" aria-label={t('绑定制作', 'Rigging')}>
    <header><strong>{t('绑定制作', 'Rigging')} · {isPart ? t('当前部件', 'This part') : suitWorkflow ? t('整套', 'Whole suit') : t('当前资产', 'This asset')}
      {needsAttention && <span className="character-rig-dot" role="img" aria-label={t('请查看绑定提醒', 'Rigging needs attention')} title={t('请查看绑定提醒', 'Rigging needs attention')} />}</strong>
      <span className="character-rig-status">{pendingReview > 0 ? t('模型已更新 · 待确认', 'Models changed · review needed') : stale > 0 ? t('待重新绑定', 'Rigging needed') : complete ? t('绑定已完成', 'Rigging complete') : uploaded > 0 ? t(`骨骼模型 ${uploaded}/${total}`, `Rigged meshes ${uploaded}/${total}`) : staticReady ? t('素材就绪 · 待绑定', 'Ready for rigging') : t('静态模型待补齐', 'Static meshes incomplete')}</span></header>
    {pendingReview > 0 && <div className="character-rig-review" role="status">
      <p>{t('检测到模型更新，请确认是否需要重新绑定。', 'The model changed. Check whether it needs rigging again.')}</p>
      <div><button className="browse-btn" disabled={disabled || reviewing} onClick={() => void review(false)}>{t('不需要重新绑定', 'No rigging needed')}</button>
        <button className="browse-btn" disabled={disabled || reviewing} onClick={() => void review(true)}>{t('需要重新绑定', 'Rig again')}</button></div>
    </div>}
    {complete && reviewedUnchanged > 0 && <p className="settings-field-hint">{t('已确认无需重新绑定，保留现有骨骼模型。', 'No rigging needed; the existing rigged mesh is retained.')}</p>}
    <ol>
      <li><span className="character-rig-step" aria-hidden="true">1</span><div><strong>{t('下载绑定用 LOD0', 'Download LOD0 for rigging')}</strong><small>{isPart ? t('下载此部件当前 SM LOD0，只需绑定这一等级。', 'Download this part’s current SM LOD0. Only this level needs rigging.') : t('下载当前 SM LOD0 整套，只需绑定这一等级。', 'Download the current SM LOD0 set. Only this level needs rigging.')}</small></div><button className="browse-btn" disabled={disabled || downloading} onClick={() => void download()}>{downloading ? t('下载中…', 'Downloading…') : t('下载 LOD0', 'Download LOD0')}</button></li>
      {needsUpload && <li {...uploadDropProps} title={t('点击上传，或拖入绑定文件/文件夹', 'Click to upload, or drop rigged files/folders')}><span className="character-rig-step" aria-hidden="true">2</span><div><strong>{stale > 0 ? t('重新上传绑定文件', 'Upload updated rigging') : t('上传首次绑定文件', 'Upload initial rigging')}</strong><small>{stale > 0 ? t('静态模型已变化，请重新绑定后上传 FBX。', 'Static models changed. Update the rigging and upload the FBX files.') : t('上传绑定好的 FBX，原静态模型会保留。', 'Upload rigged FBX files. Static meshes stay intact.')}</small></div><button className="browse-btn" disabled={disabled} onClick={onUpload}>{t('上传绑定', 'Upload')}</button></li>}
    </ol>
    <p hidden={pendingReview > 0 && !needsUpload} className={complete ? 'settings-field-hint' : 'character-rig-reminder'}>{complete
      ? isPart ? t('后续修改请使用“更新此部件”按钮。', 'For further changes, use “Update This Part”.') : t('后续修改请使用“更新此资产”按钮。', 'For further changes, use “Update This Asset”.')
      : !suitWorkflow ? t('上传后保留静态模型；后续修改使用资产或部件的更新按钮。', 'Static models are retained. Use the asset or part update action for later changes.')
      : stale > 0 ? t('模型已更新，请重新上传绑定文件，再使用底部“发送到 Unreal Engine”同步。', 'Models changed. Upload updated rigging, then use “Send to Unreal Engine” below.')
        : t('上传完成后，请用底部“发送到 Unreal Engine”同步到 UE。', 'After uploading, use “Send to Unreal Engine” at the bottom to sync to UE.')}</p>
    {(downloading || reviewing) && <div className="character-operation-progress" role="status"><div className="character-operation-progress-heading"><span>{reviewing ? t('正在保存绑定选择…', 'Saving rigging decision…') : t('正在准备并下载模型…', 'Preparing and downloading models…')}</span><span>{reviewing ? 0 : percent}%</span></div><progress max={100} value={reviewing ? 0 : percent} /></div>}
    {message && <p className={failed ? 'character-preview-error' : 'settings-field-hint'} role="status">{message}</p>}
  </section>;
}
