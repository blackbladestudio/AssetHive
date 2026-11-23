import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, AssetRecord } from '../types';
import { DialogCloseButton } from './DialogCloseButton';
import {
  animationArchiveLocation, animationCharacterKey, animationDestinationKey, defaultAnimationSkeleton, planAnimationExport, resolveAnimationExportOptions, suggestAnimationFolders
} from '../../shared/animationUnrealExport.mjs';

type ResultRow = { key: string; name: string; status: string; action?: string; path: string; message?: string };

export function AnimationExportDialog({ assets, settings, connected, connectionMessage, onSaveSettings, onClose, onCompleted, t }: {
  assets: AssetRecord[];
  settings: AppSettings;
  connected: boolean;
  connectionMessage: string;
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  onClose: () => void;
  onCompleted?: () => void;
  t: (zh: string, en: string) => string;
}) {
  const saved = resolveAnimationExportOptions(settings.animationUnrealExport);
  const [targetFolders, setTargetFolders] = useState<Record<string, string>>({});
  const [engineFolders, setEngineFolders] = useState<string[]>([]);
  const [engineProject, setEngineProject] = useState('');
  const [folderMessage, setFolderMessage] = useState('');
  const [existingTargets, setExistingTargets] = useState<string[]>([]);
  const projectPreferences = useRef(settings.animationUnrealExport?.projectFolders);
  projectPreferences.current = settings.animationUnrealExport?.projectFolders;
  const [skeletons, setSkeletons] = useState<Record<string, string>>(saved.skeletons);
  const [enableRootMotion, setEnableRootMotion] = useState(saved.enableRootMotion);
  const [forceRootLock, setForceRootLock] = useState(saved.forceRootLock);
  const [showImportDialog, setShowImportDialog] = useState(saved.showImportDialog);
  const [allowEngineCompressionFallback, setAllowEngineCompressionFallback] = useState(saved.allowEngineCompressionFallback);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ percent: 0, message: '' });
  const [error, setError] = useState('');
  const [result, setResult] = useState<ResultRow[] | null>(null);
  useEffect(() => window.arkhive.onExportProgress(setProgress), []);
  useEffect(() => {
    let alive = true;
    setEngineProject(''); setEngineFolders([]); setTargetFolders({});
    const request = window.arkhive.getAnimationUnrealFolders;
    if (!request) { setFolderMessage(t('工程目录选择需要桌面端。', 'Project folder selection requires the desktop app.')); return; }
    setFolderMessage(t('正在读取工程目录…', 'Reading project folders…'));
    void request().then(reply => {
      if (!alive) return;
      setEngineProject(reply.projectPath); setEngineFolders(reply.folders);
      const key = reply.projectPath.replaceAll('\\', '/').toLowerCase();
      setTargetFolders(current => ({ ...projectPreferences.current?.[key], ...current }));
      setFolderMessage('');
    }).catch(reason => { if (alive) setFolderMessage(String(reason instanceof Error ? reason.message : reason)); });
    return () => { alive = false; };
  }, [connected, settings.unrealProjectPath, t]);
  const items = useMemo(() => assets.map(asset => ({
    assetId: asset.id, name: asset.name, affiliation: String(asset.animationAffiliation || ''),
    fbxPath: (asset.modelFiles || []).find(file => /\.fbx$/i.test(String(file || ''))) || ''
  })), [assets]);
  const options = { targetFolders, skeletons, enableRootMotion, forceRootLock, showImportDialog, allowEngineCompressionFallback };
  const plan = planAnimationExport(items, options, settings.customLibraryPath);
  const targetSignature = JSON.stringify(plan.filter(row => !row.error).map(row => ({ key: row.assetId, targetPath: row.targetPath })));
  useEffect(() => {
    let alive = true;
    setExistingTargets([]);
    if (!engineProject || !window.arkhive.getAnimationExportTargets) return;
    const timer = setTimeout(() => {
      void window.arkhive.getAnimationExportTargets!({ projectPath: engineProject, targets: JSON.parse(targetSignature) }).then(rows => {
        if (alive) setExistingTargets(rows.filter(row => row.exists).map(row => row.key));
      }).catch(reason => { if (alive) setError(String(reason instanceof Error ? reason.message : reason)); });
    }, 200);
    return () => { alive = false; clearTimeout(timer); };
  }, [engineProject, targetSignature]);
  const groups = useMemo(() => {
    const byKey = new Map<string, { key: string; fallback: string; count: number }>();
    for (const item of items) {
      const location = animationArchiveLocation(item.fbxPath, settings.customLibraryPath);
      const key = animationCharacterKey(location);
      const group = byKey.get(key) || { key, fallback: defaultAnimationSkeleton(item.affiliation, location), count: 0 };
      group.count += 1;
      byKey.set(key, group);
    }
    return [...byKey.values()];
  }, [items, settings.customLibraryPath]);
  const destinations = useMemo(() => {
    const byKey = new Map<string, ReturnType<typeof animationArchiveLocation>>();
    for (const item of items) {
      const location = animationArchiveLocation(item.fbxPath, settings.customLibraryPath);
      byKey.set(animationDestinationKey(location), location);
    }
    return [...byKey.entries()];
  }, [items, settings.customLibraryPath]);
  const blocked = plan.some(row => row.error);
  const done = Boolean(result);
  const statusLabel: Record<string, string> = { success: t('已完成', 'Done'), failed: t('失败', 'Failed'), skipped: t('已跳过', 'Skipped') };

  function changeFolder(key: string, value: string) { setTargetFolders(current => ({ ...current, [key]: value })); setResult(null); }
  async function pickFolder(key: string, hint: string) {
    setError('');
    try {
      const folder = await window.arkhive.pickAnimationUnrealFolder?.({ projectPath: engineProject, folder: targetFolders[key] || hint });
      if (folder) changeFolder(key, folder);
    } catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)); }
  }
  async function pickProject() {
    setError('');
    try {
      const picked = await window.arkhive.pickProjectPath();
      if (picked) await onSaveSettings({ unrealProjectPath: picked, unrealEditorPath: '' });
    } catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)); }
  }
  function changeSkeleton(key: string, value: string) { setSkeletons(current => ({ ...current, [key]: value })); setResult(null); }

  async function send() {
    if (busy || blocked || !connected) return;
    setBusy(true); setError(''); setResult(null); setProgress({ percent: 0, message: '' });
    const effectiveSkeletons = Object.fromEntries(groups.map(group => [group.key, String(skeletons[group.key] ?? group.fallback).trim()]));
    const animationExport = { targetFolders, skeletons: effectiveSkeletons, enableRootMotion, forceRootLock, showImportDialog, allowEngineCompressionFallback };
    const projectKey = engineProject.replaceAll('\\', '/').toLowerCase();
    const preferences = { skeletons: { ...saved.skeletons, ...effectiveSkeletons }, enableRootMotion, forceRootLock, showImportDialog, allowEngineCompressionFallback,
      projectFolders: { ...settings.animationUnrealExport?.projectFolders, ...(projectKey ? { [projectKey]: targetFolders } : {}) } };
    try {
      await onSaveSettings({ animationUnrealExport: preferences });
      const reply = await window.arkhive.exportToUnreal({ assetIds: assets.map(asset => asset.id), options: { ...settings, unrealProjectPath: engineProject || settings.unrealProjectPath, animationExport } });
      if (!reply.animationResult) throw new Error(reply.message);
      setResult(reply.animationResult.entries);
      onCompleted?.();
      const remembered = { ...saved.skeletons, ...effectiveSkeletons };
      for (const entry of reply.animationResult.entries) {
        const character = plan.find(row => row.assetId === entry.key)?.characterKey;
        if (entry.status === 'success' && character && entry.skeletonPath) remembered[character] = entry.skeletonPath;
      }
      setSkeletons(remembered);
      await onSaveSettings({ animationUnrealExport: { ...preferences, skeletons: remembered } });
      if (!reply.ok) setError(reply.message);
    } catch (reason) { setError(String(reason instanceof Error ? reason.message : reason).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')); }
    finally { setBusy(false); }
  }

  return <div className="confirm-overlay recycle-overlay" role="dialog" aria-modal="true" aria-label={t('发送动画到 UE', 'Send animations to UE')}>
    <div className="confirm-dialog recycle-dialog suit-export-dialog animation-export-dialog">
      <header className="dialog-heading"><h3>{t('发送动画到 Unreal Engine', 'Send Animations to Unreal Engine')}</h3>
        <DialogCloseButton onClick={onClose} disabled={busy} label={t('关闭', 'Close')} />
      </header>
      <div className="suit-export-body">
        <div className="suit-export-project">
          <span>{t('目标工程', 'Project')}</span>
          <code>{engineProject || settings.unrealProjectPath || t('自动识别当前连接的 UE 工程', 'Use the currently connected UE project')}</code>
          <button type="button" className="browse-btn" disabled={busy} onClick={() => void pickProject()}>{t('选择目标工程…', 'Choose target project…')}</button>
        </div>
        <fieldset disabled={busy} className="suit-export-options">
          {destinations.map(([key, location]) => <div className="suit-export-project animation-destination" key={key}>
            <span>{t('目标目录', 'Destination folder')}</span>
            <code>{targetFolders[key] || t('选择工程目录', 'Choose a project folder')}</code>
            <button type="button" className="browse-btn" disabled={!engineProject} onClick={() => void pickFolder(key, suggestAnimationFolders(engineFolders, location)[0] || '/Game/Characters')}>{t('选择工程目录…', 'Choose project folder…')}</button>
            {!targetFolders[key] && suggestAnimationFolders(engineFolders, location)[0] && <small>{t('建议位置：', 'Suggested location: ')}{suggestAnimationFolders(engineFolders, location)[0]}</small>}
          </div>)}
          {!engineProject && folderMessage && <small>{folderMessage}</small>}
          <p className="animation-checkout-hint">{existingTargets.length
            ? t(`有 ${existingTargets.length} 个对应资产已存在，将自动在 P4 中迁出并更新，保留原有引用。`, `${existingTargets.length} existing assets will be checked out in P4 and updated, keeping references.`)
            : t('已有同名资产时自动迁出并更新；P4 迁出失败则停止发送。', 'Existing assets are checked out and updated; failed P4 checkout stops the send.')}</p>
          <details className="suit-export-settings"><summary>{t('高级导入设置', 'Advanced import settings')}</summary>
          {groups.map(group => <label key={group.key || '-'}>
            {t('Skeleton', 'Skeleton')} · {group.key || t('（未识别角色目录）', '(no character folder)')}{group.count > 1 ? ` · ${group.count}` : ''}
            <input value={skeletons[group.key] ?? group.fallback} placeholder={group.fallback || t('UE 中已有的 Skeleton，例如 /Game/.../SKEL_Character', 'Existing UE Skeleton, e.g. /Game/.../SKEL_Character')}
              onChange={event => changeSkeleton(group.key, event.target.value)} />
          </label>)}
          <small>{t('Skeleton 按角色目录记住。显示原生导入窗口时可留空，在 UE 中选择。', 'Skeletons are remembered per character folder. Leave blank to choose in UE when showing the native import window.')}</small>
          <label className="suit-export-static-option"><input type="checkbox" checked={enableRootMotion} onChange={event => { setEnableRootMotion(event.target.checked); setResult(null); }} />
            <span>Enable Root Motion</span></label>
          <label className="suit-export-static-option"><input type="checkbox" checked={forceRootLock} onChange={event => { setForceRootLock(event.target.checked); setResult(null); }} />
            <span>Force Root Lock</span></label>
          <label className="suit-export-static-option"><input type="checkbox" checked={showImportDialog} onChange={event => { setShowImportDialog(event.target.checked); setResult(null); }} />
            <span>{t('在 UE 中显示原生 FBX 动画导入窗口', 'Show the native FBX animation import window in UE')}</span></label>
          <label className="suit-export-static-option"><input type="checkbox" checked={allowEngineCompressionFallback} onChange={event => { setAllowEngineCompressionFallback(event.target.checked); setResult(null); }} />
            <span>{t('项目压缩不可用时，本次动画使用 UE 默认压缩', 'Use UE default compression for these animations if project compression is invalid')}</span></label>
          <small>{t('仅影响本次动画；不修改工程压缩配置。发送前检查路径、Skeleton、目标冲突和只读状态，保存成功后在 UE 内容浏览器选中资产。', 'Only affects these animations; project compression settings stay unchanged. Paths, Skeletons, conflicts and read-only targets are checked before import. Saved assets are selected in the UE Content Browser.')}</small>
          <ul className="settings-field-hint">
            <li>{t('只导入动画，不导入网格、材质和贴图', 'Animation only; no mesh, materials or textures')}</li>
            <li>{t('采样率 60 FPS，时长使用 FBX 导出时间范围', '60 FPS sample rate; length uses the exported time range')}</li>
            <li>{t('导入骨骼轨道与自定义属性，保留全部关键帧', 'Bone tracks and custom attributes imported; all keys kept')}</li>
          </ul>
          </details>
        </fieldset>
        <div className="suit-export-rows">{plan.map(row => {
          const sent = result?.find(item => item.key === row.assetId);
          return <div className={`suit-export-row ${sent ? sent.status : row.error ? 'blocked' : 'ready'}`} key={row.assetId}>
            <strong>{row.name}</strong>
            <span>{sent ? statusLabel[sent.status] || sent.status : row.error ? t('待处理', 'Blocked') : t('待发送', 'Ready')}</span>
            <details className="suit-export-item-path"><summary>{sent?.status === 'success' ? t('已保存的 UE 资产路径', 'Saved UE asset path') : t('计划导入路径（未保存）', 'Planned import path (not saved)')}</summary><code>{sent?.path || row.targetPath || '—'}</code></details>
            {(sent?.message || row.error) && <small>{sent?.message || row.error}</small>}
          </div>;
        })}</div>
        {!connected && <p className="suit-export-error">{connectionMessage || t('Unreal Engine 未连接：请打开目标工程并启用 AssetHive 插件，连接后即可发送。', 'Unreal Engine is not connected. Open the target project with the AssetHive plugin enabled, then send.')}</p>}
        {error && <p className="suit-export-error">{error}</p>}
      </div>
      <footer className="suit-export-footer">
        {busy && <div role="status"><p>{showImportDialog ? t('请在 Unreal Engine 的动画导入窗口中确认；确认后这里显示实际导入结果。', 'Confirm the animation import in Unreal Engine. The import result will appear here.') : progress.message || t('正在发送动画…', 'Sending animations…')}</p>
          <progress max={100} value={progress.percent || undefined} />{progress.percent > 0 && <span> {progress.percent}%</span>}</div>}
        <div className="confirm-actions">
          <button className="browse-btn" disabled={busy} onClick={onClose}>{done ? t('关闭', 'Close') : t('取消', 'Cancel')}</button>
          <button className="browse-btn primary-btn" disabled={busy || blocked || !connected} onClick={() => void send()}>{done ? t('再次发送', 'Send again') : t('确认发送', 'Confirm send')}</button>
        </div>
      </footer>
    </div>
  </div>;
}
