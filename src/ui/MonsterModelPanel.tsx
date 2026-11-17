import { useState, type HTMLAttributes } from 'react';
import type { AssetRecord } from '../types';
import { characterModelPreviewComponents, characterMeshAssetRecord, characterRigProgress } from '../../shared/characterComponents.mjs';

type MeshKind = 'staticMesh' | 'skeletalMesh';
type Props = {
  asset: AssetRecord;
  selected: { ownerId: string; slot: string; kind: MeshKind } | null;
  disabled: boolean;
  t: (zh: string, en: string) => string;
  previewUrl: (path: string) => string;
  onSelect: (slot: string, kind: MeshKind, view: 'front' | 'left' | 'right' | 'back') => void;
  onUpdate: (asset: AssetRecord) => void;
  onPreview: (asset: AssetRecord) => void;
  updateDropProps: (asset: AssetRecord) => HTMLAttributes<HTMLButtonElement>;
  previewDropProps: (asset: AssetRecord) => HTMLAttributes<HTMLButtonElement>;
  onZoom: (src: string, name: string, gallery: string[]) => void;
};

const views = ['front', 'left', 'right', 'back'] as const;

function ModelPreview({ card, kind, active, hasModel, t, previewUrl, onSelect, onZoom }: {
  card: AssetRecord; kind: MeshKind; active: boolean; hasModel: boolean;
  t: Props['t']; previewUrl: Props['previewUrl']; onSelect: (view: typeof views[number]) => void; onZoom: Props['onZoom'];
}) {
  const [view, setView] = useState<typeof views[number]>('front');
  const images = views.map(angle => card.previewImages?.find(image => image.tags.includes(`view:${angle}`))?.path
    || (angle === 'front' ? card.previewImage : '') || '');
  const source = images[views.indexOf(view)];
  const gallery = images.filter(Boolean).map(previewUrl);
  return <div className="monster-model-preview">
    <button type="button" className={`weapon-model-tile${active ? ' is-selected' : ''}`} aria-pressed={active}
      onClick={() => onSelect(view)} title={card.name}>
      <span className="weapon-model-badge">{kind === 'staticMesh' ? 'SM' : 'SK'}</span>
      {kind === 'staticMesh' && characterRigProgress(card).needsAttention && <span className="character-model-rig-dot" title={t('请查看绑定提醒', 'Review rigging')} />}
      {source ? <img src={previewUrl(source)} alt={`${card.name} · ${view}`} /> : <span className="weapon-model-empty">{hasModel
        ? t('预览生成中', 'Preparing preview') : kind === 'skeletalMesh' ? t('等待上传绑定模型', 'Waiting for rigged mesh') : t('尚未上传静态模型', 'No static mesh')}</span>}
      <span className="weapon-model-caption">{kind === 'staticMesh' ? t('静态模型', 'Static mesh') : t('骨骼模型', 'Skeletal mesh')}</span>
    </button>
    <div className="monster-model-angles" role="group" aria-label={`${card.name} ${t('四视图', 'Views')}`}>
      {views.map((angle, index) => <button type="button" key={angle} disabled={!images[index]} aria-pressed={view === angle}
        title={t(['正面', '左面', '右面', '背面'][index], angle)} onClick={() => { setView(angle); onSelect(angle); }}>
        {t(['正', '左', '右', '后'][index], ['F', 'L', 'R', 'B'][index])}</button>)}
      <button type="button" className="monster-model-zoom" disabled={!source} aria-label={t('放大预览', 'Enlarge preview')}
        title={t('放大预览', 'Enlarge preview')} onClick={() => onZoom(previewUrl(source), card.name, gallery)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></svg>
      </button>
    </div>
  </div>;
}

export function MonsterModelPanel({ asset, selected, disabled, t, previewUrl, onSelect, onUpdate, onPreview, updateDropProps, previewDropProps, onZoom }: Props) {
  const models = characterModelPreviewComponents(asset);
  if (!models.length) return null;
  return <section className="monster-model-panel" aria-label={t('本体与配套武器', 'Body and owned weapons')}>
    <div className="monster-model-panel-heading">
      <span>{t('本体与配套武器', 'Body and owned weapons')}</span>
    </div>
    {models.map(part => {
      const chosenKind = selected?.ownerId === asset.id && selected.slot === part.slot ? selected.kind : part.meshKinds.staticMesh ? 'staticMesh' : 'skeletalMesh';
      const current = characterMeshAssetRecord(asset, part, chosenKind);
      return <div key={part.slot} id={`monster-model-${part.id}`} tabIndex={-1} className="monster-model-group">
        <div className="monster-model-group-heading"><strong>{part.role === 'weapon' ? t('配套武器', 'Owned weapon') : t('本体', 'Body')}</strong>
          <span title={part.name}>{part.label}</span>
        </div>
        <div className="weapon-model-pair">{(['staticMesh', 'skeletalMesh'] as const).map(kind => {
          const card = characterMeshAssetRecord(asset, part, kind);
          const active = selected?.ownerId === asset.id && selected.slot === part.slot && selected.kind === kind;
          return <ModelPreview key={`${asset.id}:${part.slot}:${kind}`} card={card} kind={kind} active={active} hasModel={part.meshKinds[kind]}
            t={t} previewUrl={previewUrl} onSelect={view => onSelect(part.slot, kind, view)} onZoom={onZoom} />;
        })}</div>
        <div className="monster-model-actions">
          <button type="button" {...updateDropProps(current)} disabled={disabled} onClick={() => onUpdate(current)}>{chosenKind === 'staticMesh' ? t('更新静态模型', 'Update static mesh') : t('更新骨骼模型', 'Update skeletal mesh')}</button>
          <button type="button" {...previewDropProps(current)} disabled={disabled || !part.meshKinds[chosenKind]} onClick={() => onPreview(current)}>{t('管理预览图', 'Manage previews')}</button>
        </div>
      </div>;
    })}
  </section>;
}
