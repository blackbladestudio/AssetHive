import { useEffect, useMemo, useState } from 'react';
import type { AssetRecord } from '../types';
import { type AnimationFbxStats } from './animationRules';
import { animationRulesRevision, findMonsterLoop } from './animationMonsterRules';
import { evaluateUnifiedAnimationRules } from './animationRuleEvaluation';
import { animationAffiliation, animationType } from './animationNavigation';

export function AnimationRulesPanel({ asset, assets, filePath, skeletonPath, loadStats, language }: {
  asset: AssetRecord; assets: AssetRecord[]; filePath: string; skeletonPath: string; language: 'zh' | 'en';
  loadStats: (file: string, skeleton: string, revision: string) => Promise<AnimationFbxStats>;
}) {
  const t = (zh: string, en: string) => language === 'en' ? en : zh;
  const [stats, setStats] = useState<AnimationFbxStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loopStats, setLoopStats] = useState<AnimationFbxStats | null>(null);
  const affiliation = animationAffiliation(asset);
  const type = animationType(asset);
  const monster = affiliation === '怪物' && type === '基础移动';
  const pair = useMemo(() => findMonsterLoop(monster ? filePath : '', assets), [monster, filePath, assets]);
  const revision = animationRulesRevision(asset);
  const loopPath = pair.filePath;
  const loopRevision = pair.revision;
  useEffect(() => {
    let active = true;
    setStats(null); setLoopStats(null); setLoading(true);
    void Promise.all([loadStats(filePath, skeletonPath, revision), loopPath ? loadStats(loopPath, '', loopRevision) : Promise.resolve(null)]).then(([value, loop]) => { if (active) { setStats(value); setLoopStats(loop); setLoading(false); } })
      .catch(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [filePath, skeletonPath, revision, loopPath, loopRevision, loadStats]);
  const checks = evaluateUnifiedAnimationRules({ assetName: asset.name, filePath, destinationPath: asset.path, animationType: type, animationAffiliation: affiliation, stats }, { stats: loopStats, name: pair.name, error: pair.error });
  return <section className="animation-detail-section animation-rules-section">
    <h3>{t('动画规范', 'Animation rules')}</h3>
    {monster && <div className="monster-loco-rules">
      <p>{t('项目规范 · 本地 FBX 检查，无需连接 UE。结果不包含 UE 导入后的 Additive、播放倍率与压缩变化。', 'Project rules · local FBX check, no UE connection. UE additive, playback rate and compression changes are not included.')}</p>
    </div>}
    {loading ? <div className="animation-rule-loading" role="status"><span className="save-spinner" />{loopPath ? t('正在读取动画与配对循环…', 'Reading animation and paired loop…') : t('正在读取 FBX 规范信息…', 'Reading FBX rule information…')}</div> :
      <div className="animation-rule-list">{checks.map(check => <div key={check.id} className={`animation-rule-item ${check.status}`} title={t(check.zh, check.en)}>
        <span className="animation-rule-mark">{check.status === 'ok' ? '✓' : check.status === 'fail' ? '✕' : check.status === 'warn' ? '!' : '⊘'}</span><span>{t(check.zh, check.en)}</span>
      </div>)}</div>}
  </section>;
}
