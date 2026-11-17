import { useEffect, useRef, useState } from 'react';
import type { AppSettings } from '../types';
import type { SuitExportOptions, SuitExportResult } from './suitExportTypes';
import { DialogCloseButton } from './DialogCloseButton';
import { characterSendSummary } from '../../shared/characterSendSummary.mjs';

export function SuitExportDialog({ assetIds, weapon = false, monster = false, heroPart = '', settings, hidden, onHide, onShow, onClose, onApplied, onProjectSettings, t }: {
  weapon?: boolean;
  monster?: boolean;
  heroPart?: string;
  assetIds: string[]; settings: AppSettings; onClose: () => void; onApplied: () => Promise<void>;
  hidden: boolean; onHide: () => void; onShow: () => void;
  onProjectSettings: () => void;
  t: (zh: string, en: string) => string;
}) {
  const [options, setOptions] = useState<SuitExportOptions>({ includeStaticMeshes: false });
  const subject = monster ? t('怪物', 'Monster') : weapon ? t('武器', 'Weapon') : heroPart === 'Hair' ? t('头发', 'Hair') : heroPart === 'Face' ? t('脸部', 'Face') : t('套装', 'Suit');
  const [result, setResult] = useState<SuitExportResult | null>(null);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'inspect' | 'apply'>('inspect');
  const [progress, setProgress] = useState({ percent: 0, message: '' });
  const [error, setError] = useState('');
  const [mappingChanged, setMappingChanged] = useState(false);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [hasSkeletalMesh, setHasSkeletalMesh] = useState<boolean | null>(null);
  const started = useRef(false);
  function changeOptions(next: SuitExportOptions) { setOptions(next); setResult(null); setDecisions({}); }
  async function send(phase: 'inspect' | 'apply', exportOptions = options) {
    if (busy || (phase === 'apply' && !result)) return;
    setBusy(true); setPhase(phase); setError(''); setProgress({ percent: 0, message: '' });
    try {
      const reply = await window.arkhive.exportToUnreal({ assetIds, options: { ...settings, suitPhase: phase,
        suitOptions: exportOptions, suitManifestHash: result?.manifestHash, suitInspectToken: result?.inspectToken,
        suitDecisions: { ...decisions, ...Object.fromEntries((result?.entries || []).filter(row => row.status === 'missing').map(row => [row.key, 'restore'])) } } });
      if (!reply.ok || !reply.suitResult) throw new Error(reply.message);
      setResult(reply.suitResult);
      setHasSkeletalMesh(reply.suitResult.entries.some(row => row.kind === 'skeletalMesh' && row.action !== 'retained'));
      setMappingChanged(false);
      // The checklist is already current. Refresh the information card without
      // keeping the inspection spinner blocked on another library round-trip.
      void onApplied().catch(reason => console.warn('Character card refresh failed', reason));
    } catch (reason) { setError(String(reason)); if (phase === 'apply') setResult(null); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!started.current) { started.current = true; void send('inspect'); }
    // Each dialog instance owns one fixed selection; later inspections are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => window.arkhive.onExportProgress(setProgress), []);
  const actionLabel: Record<string, string> = {
    added: t('新增', 'Add'), updated: t('更新', 'Update'), renamed: t('改名', 'Rename'),
    updatedRenamed: t('更新并改名', 'Update & rename'), unchanged: t('无变化', 'Unchanged'),
    restore: t('新增', 'Add'), adopt: t('同名待确认', 'Confirm existing asset'), retained: t('保持不变', 'Keep existing'),
    repair: t('更新材质关联', 'Update material references'), relinked: t('自动重新关联', 'Reassociate automatically')
  };
  const done = result?.phase === 'apply';
  const needsAttention = Boolean(error || result?.entries.some(row => ['failed', 'blocked', 'conflict', 'skipped'].includes(row.status)));
  const rows = result?.entries.filter(row => row.action !== 'retained') || [];
  const sendBlocked = Boolean(error || rows.some(row => ['failed', 'blocked'].includes(row.status) || row.status === 'conflict' && !decisions[row.key]));
  const unchanged = rows.filter(row => row.action === 'unchanged').length;
  const added = rows.filter(row => ['added', 'restore'].includes(row.action)).length;
  const updated = rows.filter(row => ['updated', 'updatedRenamed', 'renamed', 'repair', 'relinked'].includes(row.action)).length;
  const content = characterSendSummary(rows, decisions, done);
  const materialGroups = result?.monsterMaterialGroups || [];
  const uncertainMaterials = materialGroups.filter(group => !group.type);
  const knownMaterials = materialGroups.filter(group => group.type);
  const renderMaterialType = (group: typeof materialGroups[number]) => <label key={group.key}>
    {assetIds.length > 1 ? `${group.assetName} · ${group.name}` : group.name}
    <select disabled={busy || done} aria-label={`${group.name} ${t('材质类型', 'Material type')}`}
      value={options.monsterMaterialTypes?.[group.key] || group.type}
      onChange={event => {
        const value = event.target.value as 'cloth' | 'skin';
        if (!value) return;
        setMappingChanged(true);
        setOptions(current => ({ ...current, monsterMaterialTypes: { ...current.monsterMaterialTypes, [group.key]: value } }));
      }}>
      {!group.type && <option value="" disabled>{t('请选择类型', 'Choose type')}</option>}
      <option value="cloth">{t('衣服', 'Clothing')}</option>
      <option value="skin">{t('皮肤', 'Skin')}</option>
    </select>
  </label>;
  const partNames: Record<string, string> = { head: t('头部', 'Head'), upbody: t('上装', 'Upbody'), downbody: t('下装', 'Downbody'), arm: t('臂部', 'Arm') };
  const modelParts = (parts: string[]) => parts.map(part => partNames[part.toLowerCase().replace(/^.*_/, '')] || part).join(' · ');
  const taskStatus = busy
    ? phase === 'apply' ? t('正在发送到 UE', 'Sending to UE') : t('正在检查变化', 'Inspecting changes')
    : needsAttention ? t('有项目待处理', 'Items need attention')
      : done ? t('发送完成', 'Send complete') : t('检查完成，等待确认', 'Inspection ready');
  if (hidden) return <aside className="suit-export-background" aria-label={t(`${subject} UE 后台任务`, `${subject} UE background task`)}>
    <div role="status"><strong>{taskStatus}</strong>
      <span className="suit-export-background-message">{error || (busy ? progress.message : t('点击查看清单及结果', 'View the checklist and results'))}</span>
      {busy && <div className="suit-export-background-progress"><progress max={100} value={progress.percent || undefined} /><span>{progress.percent > 0 ? `${progress.percent}%` : '…'}</span></div>}
    </div>
    <button className="browse-btn" onClick={onShow}>{t('查看任务', 'View task')}</button>
  </aside>;
  return <div className="confirm-overlay recycle-overlay" role="dialog" aria-modal="true" aria-label={t(`发送${subject}到 UE`, `Send ${subject} to UE`)}>
    <div className="confirm-dialog recycle-dialog suit-export-dialog">
      <header className="dialog-heading"><h3>{t(`发送${subject}到 Unreal Engine`, `Send ${subject} to Unreal Engine`)}</h3>
        <DialogCloseButton onClick={busy ? onHide : onClose} label={busy ? t('收起并继续后台运行', 'Hide and continue in background') : t('关闭', 'Close')} />
      </header>
      <div className="suit-export-body">
      <p>{t('只发送新增或有变化的资源，其他资源保持不变。', 'Send new or changed resources only. Everything else stays unchanged.')}</p>
      <div className="suit-export-project">
        <span>{t('目标工程', 'Project')}</span>
        <code>{result?.projectPath || settings.unrealProjectPath || t('自动识别当前连接的 UE 工程', 'Use the currently connected UE project')}</code>
        <button type="button" className="character-name-edit" disabled={busy} onClick={onProjectSettings}>{t('设置目标工程', 'Set project')}</button>
      </div>
      <label className="suit-export-static-option"><input type="checkbox" disabled={busy} checked={Boolean(options.includeStaticMeshes)} onChange={event => {
        const next = { ...options, includeStaticMeshes: event.target.checked }; changeOptions(next); void send('inspect', next);
      }} /><span>{t('同时发送静态模型', 'Also send static meshes')}</span></label>
      {hasSkeletalMesh === false && <p className="settings-field-hint">{options.includeStaticMeshes
        ? t('尚未上传骨骼模型。本次包含静态模型，绑定完成后可再次发送。', 'No rigged meshes yet. This send includes static meshes; send again after rigging.')
        : t('尚未上传骨骼模型，本次仅发送贴图和材质。上传绑定文件后可再次发送。', 'No skeletal meshes yet. This send includes textures and materials only. Upload rigged meshes and send again later.')}</p>}
      <details className="suit-export-settings"><summary>{t('导入设置', 'Import settings')}</summary>
      <fieldset disabled={busy} className="suit-export-options">
        <label>{t('法线格式', 'Normal format')}<select value={options.normalFormat || ''} onChange={event => changeOptions({ ...options, normalFormat: event.target.value })}>
          <option value="">{t('使用入库记录；未知时提示', 'Use library record; flag unknown')}</option><option value="dx">DirectX</option><option value="gl">OpenGL</option>
        </select></label>
        {hasSkeletalMesh && !weapon && !monster && <label>{t('关联 UE 已有骨架', 'Use an existing UE Skeleton')}
          <input value={options.skeletonPath || ''} placeholder={t('自动使用工程共享骨架 SKEL_Character', 'Use project Skeleton SKEL_Character automatically')} onChange={event => changeOptions({ ...options, skeletonPath: event.target.value })} />
          <small>{t('默认关联 Common/SKEL_Character，并检查骨骼层级。只有使用其他骨架时才需要填写；不会创建或修改骨架。', 'Uses Common/SKEL_Character and checks the bone hierarchy. Enter a path only for a different Skeleton; no Skeleton is created or modified.')}</small></label>}
      </fieldset>
      </details>
      {uncertainMaterials.length > 0 && <div className="suit-export-mappings">
        <h4>{t('这些材质组需要确认类型', 'Confirm these material types')}</h4>
        <small>{t('其余材质已自动识别。这里只需选择衣服或皮肤，发送后记住选择。', 'Other groups were identified automatically. Choose clothing or skin here; your choice is saved when sent.')}</small>
        {uncertainMaterials.map(renderMaterialType)}
        {mappingChanged && <small>{t('选择后点击“重新检查”。', 'Recheck after choosing.')}</small>}
      </div>}
      {knownMaterials.length > 0 && <details className="suit-export-settings">
        <summary>{t('已识别的材质类型', 'Identified material types')}</summary>
        <div className="suit-export-mappings">{knownMaterials.map(renderMaterialType)}</div>
        {mappingChanged && <small>{t('调整后点击“重新检查”。', 'Recheck after changing a type.')}</small>}
      </details>}
      {!!result?.materialRequests?.length && <div className="suit-export-mappings">
        <h4>{t('请指定未匹配的材质槽', 'Resolve unmatched material slots')}</h4>
        {result.materialRequests.map(request => <label key={request.key}>{request.meshName} · {request.slot}
          <input list={`suit-groups-${request.key}`} placeholder={t('选择材质组或输入已有 UE 材质路径', 'Select group or enter an existing UE material path')}
            disabled={busy}
            value={options.materialMappings?.[request.key] || ''}
            onChange={event => { setMappingChanged(true); setOptions(current => ({ ...current, materialMappings: { ...current.materialMappings, [request.key]: event.target.value } })); }} />
          <datalist id={`suit-groups-${request.key}`}>{request.groups.map(group => <option key={group.key} value={`group:${group.key}`}>{group.name}</option>)}</datalist>
        </label>)}
        <p>{t('修改后点击“重新检查”。', 'Recheck after making changes.')}</p>
      </div>}
      {result && <div className="suit-export-summary"><span>{t('新增', 'New')} {added}</span><span>{t('更新', 'Updated')} {updated}</span><span>{t('无变化', 'Unchanged')} {unchanged}</span>
        {unchanged > 0 && <button type="button" className="suit-export-text-button" onClick={() => setShowUnchanged(value => !value)}>{showUnchanged ? t('收起无变化项', 'Hide unchanged') : t('查看无变化项', 'Show unchanged')}</button>}
      </div>}
      {result && <section className="suit-send-content" aria-label={t('本次发送内容', 'Contents of this send')}>
        <h4>{done ? t('本次已发送', 'Sent this time') : t('本次发送内容', 'Sending this time')}</h4>
        <dl>
          {(options.includeStaticMeshes || content.staticMesh.count > 0) && <div><dt>{t('静态模型', 'Static meshes')}</dt><dd>{content.staticMesh.count} {t('个', '')}</dd><small>{modelParts(content.staticMesh.parts) || t('本次无需发送', 'Nothing to send')}</small></div>}
          <div><dt>{t('骨骼模型', 'Skeletal meshes')}</dt><dd>{content.skeletalMesh.count} {t('个', '')}</dd><small>{modelParts(content.skeletalMesh.parts) || t('本次无需发送', 'Nothing to send')}</small></div>
          {content.groom.count > 0 && <div><dt>Groom ABC</dt><dd>{content.groom.count}</dd><small>{modelParts(content.groom.parts)}</small></div>}
          <div><dt>{t('贴图', 'Textures')}</dt><dd>{content.textures.count} {t('张', '')} · {content.textures.groupCount} {t('组', 'groups')}</dd><small>{content.textures.groups.join(' · ') || t('本次无需发送', 'Nothing to send')}</small></div>
          <div><dt>{t('材质实例', 'Material instances')}</dt><dd>{content.materials.count} {t('个', '')}</dd><small>{content.materials.groups.join(' · ') || t('本次无需发送', 'Nothing to send')}</small></div>
        </dl>
        {content.pending > 0 && <p>{t(`另有 ${content.pending} 项待处理或已跳过，未计入以上内容。`, `${content.pending} items need attention or were skipped; excluded above.`)}</p>}
      </section>}
      {result && <div className="suit-export-rows">{rows.filter(row => showUnchanged || row.action !== 'unchanged').map(row => <div className={`suit-export-row ${row.status}`} key={row.key}>
        <strong>{row.name}</strong><span>{done ? ({ success: t('已完成', 'Done'), unchanged: t('未重导', 'Unchanged'), failed: t('失败', 'Failed'), blocked: t('待处理', 'Blocked'), skipped: t('已跳过', 'Skipped') }[row.status] || row.status) : actionLabel[row.action] || row.action}</span>
        <details className="suit-export-item-path"><summary>{t('查看引擎内位置', 'Show location in Unreal Engine')}</summary><code>{row.path || row.targetPath}</code></details>{row.message && (row.action !== 'restore' || ['failed', 'blocked'].includes(row.status)) && <small>{row.message}</small>}
        {!done && row.status === 'conflict' && <select aria-label={`${row.name} ${t('处理方式', 'Action')}`} value={decisions[row.key] || 'skip'} onChange={event => setDecisions(current => ({ ...current, [row.key]: event.target.value }))} disabled={busy}>
          <option value="skip">{t('跳过本次', 'Skip this time')}</option>
          {row.action === 'adopt' ? <option value="adopt">{t('确认关联并更新此同名资产', 'Associate and update this asset')}</option>
              : <><option value="keepUE">{t('保留 UE 材质设置', 'Keep UE material settings')}</option><option value="applyMapping">{t('采用本次贴图映射', 'Apply new texture mapping')}</option></>}
        </select>}
      </div>)}</div>}
      {result && unchanged === rows.length && rows.length > 0 && <p className="suit-export-empty">{t('资源已是最新，无需再次发送。', 'Everything is up to date. Nothing to send.')}</p>}
      {error && <p className="suit-export-error">{error}</p>}
      </div>
      <footer className="suit-export-footer">
      {busy && <div role="status"><p>{progress.message || (phase === 'apply' ? t('正在发送资源…', 'Sending resources…') : t('正在检查资源…', 'Checking resources…'))}</p>
        <progress max={100} value={progress.percent || undefined} />{progress.percent > 0 && <span> {progress.percent}%</span>}</div>}
      <div className="confirm-actions">
        <button className="browse-btn" onClick={onHide}>{busy ? t('后台运行', 'Run in background') : t('收起窗口', 'Minimize')}</button>
        <button className="browse-btn" disabled={busy} onClick={() => void send('inspect')}>{t('重新检查', 'Recheck')}</button>
        <button className="browse-btn primary-btn" disabled={busy || sendBlocked || mappingChanged || !result || done || !rows.some(row => row.status === 'missing' || row.status === 'ready' && row.action !== 'unchanged' || decisions[row.key] && decisions[row.key] !== 'skip')} onClick={() => void send('apply')}>{t('确认发送', 'Confirm send')}</button>
      </div>
      </footer>
    </div>
  </div>;
}
