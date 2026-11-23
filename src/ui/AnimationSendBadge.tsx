import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AssetRecord } from '../types';
import { animationHasBeenSent, animationIndicatorState, type AnimationVersionStatus } from './animationSendState';

export function AnimationSendBadge({ asset, language, projectPath = '' }: { asset: AssetRecord; language: 'zh' | 'en'; projectPath?: string }) {
  const host = useRef<HTMLSpanElement>(null);
  const [tooltip, setTooltip] = useState<{ top: number; left: number } | null>(null);
  const [status, setStatus] = useState<AnimationVersionStatus>();
  const [checking, setChecking] = useState(false);
  const request = useRef({ generation: 0, busy: false, checkedAt: 0 });
  const revision = JSON.stringify([asset.animationContentFingerprint || asset.meta.identity, asset.animationSendReceipts || asset.meta.animationUEExports]);
  useEffect(() => {
    request.current = { generation: request.current.generation + 1, busy: false, checkedAt: 0 };
    setStatus(undefined); setChecking(false);
    return () => { request.current.generation++; };
  }, [asset.id, projectPath, revision]);
  const indicator = animationIndicatorState(asset, projectPath, status);
  const label = checking ? language === 'en' ? 'Checking UE version…' : '正在核验 UE 版本…' : indicator[language];
  const check = useCallback(async () => {
    const service = window.arkhive?.getAnimationUnrealStatus;
    const current = request.current;
    if (!service || current.busy || Date.now() - current.checkedAt < 30000) return;
    current.busy = true; setChecking(true);
    const generation = current.generation;
    try {
      const result = await service(asset.id);
      if (request.current.generation === generation) setStatus(result);
    } catch (error) {
      if (request.current.generation === generation) setStatus({ state: 'error', message: String(error) });
    } finally {
      if (request.current.generation === generation) {
        current.busy = false; current.checkedAt = Date.now(); setChecking(false);
      }
    }
  }, [asset.id]);
  const hasReceipt = animationHasBeenSent(asset, projectPath);
  useEffect(() => { if (hasReceipt) void check(); }, [check, hasReceipt, projectPath, revision]);
  const showTooltip = () => {
    const rect = host.current?.getBoundingClientRect();
    if (rect) setTooltip({ top: Math.min(rect.bottom + 4, window.innerHeight - 100), left: Math.max(8, Math.min(rect.right - 240, window.innerWidth - 248)) });
    void check();
  };
  return <>
    <span ref={host} className="animation-send-indicator" tabIndex={0} aria-label={label} onMouseEnter={showTooltip} onFocus={showTooltip} onMouseLeave={() => setTooltip(null)} onBlur={() => setTooltip(null)}>
      <span className={`animation-send-dot ${indicator.current ? 'is-sent' : 'is-pending'}`} />
    </span>
    {tooltip && createPortal(<span className="animation-send-tooltip" role="tooltip" style={tooltip}>{label}</span>, document.body)}
  </>;
}
