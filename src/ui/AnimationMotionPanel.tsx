import { useMemo, useState } from "react";
import type { RootMotionAnalysis } from "./animationRootMotion";

type Props = {
  analysis: RootMotionAnalysis | null;
  duration: number;
  time: number;
  enabled: boolean;
  language: "zh" | "en";
  onToggle: () => void;
  onSeek: (time: number) => void;
};

function Eye({ visible }: { visible: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />{!visible && <path d="m3 3 18 18" />}</svg>;
}

export function AnimationMotionPanel({ analysis, duration, time, enabled, language, onToggle, onSeek }: Props) {
  const t = (zh: string, en: string) => language === "en" ? en : zh;
  const [showDisplacement, setShowDisplacement] = useState(true);
  const [showSpeed, setShowSpeed] = useState(true);
  const paths = useMemo(() => {
    if (!analysis) return null;
    // Separate labelled axes preserve physical units instead of normalizing
    // velocity and displacement to one misleading scale.
    const path = (field: "displacement" | "speed", maximum: number) => analysis.samples.filter((_, i) => i % Math.max(1, Math.ceil(analysis.samples.length / 300)) === 0 || i === analysis.samples.length - 1)
      .map(sample => `${36 + sample.time / (duration || 1) * 228},${108 - sample[field] / (maximum || 1) * 82}`).join(" ");
    return { displacement: path("displacement", analysis.maxDisplacement), speed: path("speed", analysis.maxSpeed) };
  }, [analysis, duration]);
  return <section className="animation-motion-panel" aria-label={t("动画信息与 root 曲线", "Animation information and root curves")}>
    <div className="animation-motion-heading"><label className="animation-root-toggle"><input type="checkbox" role="switch" checked={enabled} disabled={!analysis} onChange={onToggle} />{t("Root 位移", "Root motion")}</label></div>
    <div className="animation-motion-summary"><span>{t("时长", "Duration")} {duration.toFixed(2)} s</span>{analysis && <><span>Root: {analysis.boneName}</span><span>{t("累计路程", "Travel")} {analysis.distance.toFixed(2)} m</span></>}</div>
    {analysis && paths ? <>
      <div className="animation-root-chart"><svg viewBox="0 0 300 134" role="img" aria-label={t("Root 位移与速度随时间变化；左轴米，右轴米每秒", "Root displacement and speed over time; left axis metres, right axis metres per second")}>
        {[26, 67, 108].map(y => <line key={y} x1="36" x2="264" y1={y} y2={y} className="animation-chart-grid" />)}
        <text x="3" y="13" className="root-displacement-color">m</text><text x="272" y="13" className="root-speed-color">m/s</text>
        <text x="3" y="30" className="root-displacement-color">{analysis.maxDisplacement.toFixed(1)}</text><text x="270" y="30" className="root-speed-color">{analysis.maxSpeed.toFixed(1)}</text>
        <text x="16" y="111">0</text><text x="276" y="111">0</text>
        {showDisplacement && <polyline points={paths.displacement} className="root-displacement-curve" />}
        {showSpeed && <polyline points={paths.speed} className="root-speed-curve" />}
        <line x1={36 + time / (duration || 1) * 228} x2={36 + time / (duration || 1) * 228} y1="24" y2="108" className="animation-chart-playhead" />
        <text x="36" y="127">0 s</text><text x="264" y="127" textAnchor="end">{duration.toFixed(2)} s</text>
      </svg></div>
      <div className="animation-curve-visibility">
        <button type="button" className="root-displacement-color" aria-pressed={showDisplacement} title={showDisplacement ? t("隐藏位移曲线", "Hide displacement curve") : t("显示位移曲线", "Show displacement curve")} onClick={() => setShowDisplacement(value => !value)}><Eye visible={showDisplacement} />{t("位移", "Displacement")}</button>
        <button type="button" className="root-speed-color" aria-pressed={showSpeed} title={showSpeed ? t("隐藏速度曲线", "Hide speed curve") : t("显示速度曲线", "Show speed curve")} onClick={() => setShowSpeed(value => !value)}><Eye visible={showSpeed} />{t("速度", "Speed")}</button>
      </div>
    </> : <p className="animation-motion-unavailable">{t("未找到可绑定的 root 平移轨道", "No bindable root translation track found")}</p>}
    <input className="animation-motion-seek" type="range" min="0" max={duration || 0} step="0.001" value={Math.min(time, duration)} disabled={!duration} aria-label={t("动画时间", "Animation time")} onChange={event => onSeek(Number(event.target.value))} />
    <div className="animation-motion-time">{time.toFixed(2)} / {duration.toFixed(2)} s</div>
  </section>;
}
