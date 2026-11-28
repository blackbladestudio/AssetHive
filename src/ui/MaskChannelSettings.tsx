import { useEffect, useState } from "react";
import { defaultMaskGroup, maskParentSuffix, type MaskChannel, type MaskGroup } from "../../shared/maskMaterials.mjs";

type Props = {
  value?: MaskGroup;
  maskFile: string;
  hasFullAo: boolean;
  onChange: (group: MaskGroup) => void;
  t: (zh: string, en: string) => string;
};

export function MaskChannelSettings({ value, maskFile, hasFullAo, onChange, t }: Props) {
  const group = value || defaultMaskGroup();
  const [detection, setDetection] = useState<{ file: string; channels: MaskChannel[]; error?: string }>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    if (!maskFile) return;
    const analyze = window.arkhive?.detectMaskChannels;
    const request = analyze ? analyze(maskFile) : Promise.reject(new Error("请重启 AssetHive 后检测通道 / Restart AssetHive to detect channels"));
    void request.then(result => {
      if (!cancelled) setDetection({ file: maskFile, channels: result.channels, error: result.message });
    }).catch(error => {
      if (!cancelled) setDetection({ file: maskFile, channels: [], error: String(error) });
    });
    return () => { cancelled = true; };
  }, [maskFile, revision]);
  const current = detection?.file === maskFile ? detection : undefined;
  const channels = current?.channels || [];
  const uvInput = (label: string, value: number, update: (uv: number) => void) => (
    <label className="mask-uv-field">{label}
      <select className="settings-input" value={value} onChange={event => update(Number(event.target.value))}>
        {Array.from({ length: 8 }, (_, index) => <option key={index} value={index}>{index} · UV{index + 1}</option>)}
      </select>
    </label>
  );
  return <div className="mask-channel-settings">
    <div className="mask-channel-header">
      {uvInput("Base UV", group.baseUvSet, baseUvSet => onChange({ ...group, baseUvSet }))}
      {uvInput("Mask UV", group.maskUvSet, maskUvSet => onChange({ ...group, maskUvSet }))}
      <span className="settings-field-hint">{hasFullAo ? "Use Full UV2 AO · UV2" : "Base"}</span>
    </div>
    <div className="mask-channel-header">
      <span>{current?.error || (maskFile && !current ? t("正在检测 Mask 通道…", "Detecting mask channels…") : `MI_Env_Mask_BakedDiffuse_${maskParentSuffix(channels)}`)}</span>
      {maskFile && <button type="button" className="texture-add-btn" onClick={() => setRevision(value => value + 1)}>{t("重新检测", "Detect again")}</button>}
    </div>
    {channels.map(channel => {
      const layer = group.channels[channel];
      const update = (patch: Partial<typeof layer>) => onChange({ ...group, channels: { ...group.channels, [channel]: { ...layer, ...patch } } });
      return <div className="mask-channel" key={channel}>
        <div className="mask-channel-header">
          <strong>{t(`${channel} 通道`, `Channel ${channel}`)}</strong>
          {uvInput("UV", layer.uvSet, uvSet => update({ uvSet }))}
          <span className="settings-field-hint">{t("自动 Tiling · 768 px/m", "Auto tiling · 768 px/m")}</span>
        </div>
        {([['BCR', 'bcr'], ['N', 'normal']] as const).map(([label, key]) => <label className="mask-reference" key={key}>
          <span>{label}</span><input className="settings-input" value={layer[key]} placeholder="/Game/Environment/Asset/TilableTex/T_…"
            aria-label={`${channel} ${label}`} onChange={event => update({ [key]: event.target.value })} />
        </label>)}
        <label className="mask-channel-header"><input type="checkbox" checked={layer.metallicEnabled}
          onChange={event => update({ metallicEnabled: event.target.checked })} />Metallic</label>
        {layer.metallicEnabled && <label className="mask-reference"><span>M</span><input className="settings-input"
          value={layer.metallic} aria-label={`${channel} Metallic`} placeholder="/Game/Environment/Asset/TilableTex/T_…"
          onChange={event => update({ metallic: event.target.value })} /></label>}
      </div>;
    })}
  </div>;
}
