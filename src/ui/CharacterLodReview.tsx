import { characterLodReview, type CharacterLodFile } from '../../shared/characterLodReview.mjs';

export function CharacterLodReview({ files, t, confirmed, onConfirm, onReveal, disabled = false, showEmpty = false, compact = false }: {
  files: CharacterLodFile[]; t: (zh: string, en: string) => string;
  confirmed?: boolean; onConfirm?: (value: boolean) => void; disabled?: boolean; showEmpty?: boolean; compact?: boolean;
  onReveal?: (storedPath: string) => void;
}) {
  const groups = characterLodReview(files);
  const levels = [...new Set(groups.flatMap(group => group.files.map(file => file.index)))].sort((a, b) => a - b);
  const bindingHint = t('绑定只需下载 SM LOD0，上传绑好的 SK LOD0；无需手工制作 SK LOD1。配套 SM LOD1 到位后，发送 UE 时自动生成非布料 LOD。', 'For rigging, download SM LOD0 and upload the rigged SK LOD0; no manual SK LOD1 is required. Once matching SM LOD1 is available, sending to UE generates non-cloth LODs.');
  if (!groups.length && !showEmpty) return null;
  if (compact) return <details className="character-file-section character-lod-files">
    <summary>{t('模型 LOD 文件', 'Model LOD files')}</summary>
    <p>{bindingHint}</p>
    <div className="character-lod-file-groups">{levels.map(level => {
      const entries = groups.flatMap(group => group.files.filter(file => file.index === level).map(file => ({ file, group })));
      return <details className="character-lod-file-group" key={level} open>
      <summary className="character-lod-file-header">{t(`LOD${level} 列表`, `LOD${level} files`)}<span>{t(`${entries.length} 个文件`, `${entries.length} files`)}</span></summary>
      {entries.map(({ file, group }, index) => <button type="button" className="character-lod-locate-row" key={`${group.key}:${index}`}
        disabled={!onReveal || !file.sourcePath} onClick={() => { if (file.sourcePath) onReveal?.(file.sourcePath); }}
        title={`${file.name} · ${t('打开位置', 'Show in Folder')}`} aria-label={`${t('打开位置', 'Show in Folder')} ${file.name}`}>
        <span className="character-lod-level">{group.key.startsWith('skeletalMesh:') ? 'SK' : 'SM'}</span>
        <span className="character-lod-file-name">{file.name}</span>
        <span className="character-lod-locate-action">{t('打开位置', 'Show in Folder')}</span>
      </button>)}
    </details>;
    })}</div>
  </details>;
  const canConfirm = groups.length > 0 && !groups.some(group => group.missingBase || group.duplicate || group.files.some(file => file.inspection === 'pending' || file.inspection === 'failed'));
  return <section className={`character-lod-review${onConfirm && (!confirmed || !canConfirm) ? ' character-identity-unconfirmed' : ''}`} aria-label={t('模型与 LOD 核对', 'Review models and LODs')}>
    <div className="character-lod-heading"><strong>{t('模型与 LOD 核对', 'Review models and LODs')}</strong>
      <span>{groups.length ? t(`${groups.length} 个模型 · ${files.filter(file => /\.fbx$/i.test(file.name)).length} 个文件`, `${groups.length} models · ${files.filter(file => /\.fbx$/i.test(file.name)).length} files`) : t('待选择模型', 'No models selected')}</span></div>
    {!groups.length && <div className="character-lod-empty" role="status">{t('请先选择资产文件夹并完成检查。这里会按部件列出 LOD 等级、来源文件和入库名称，再勾选确认。', 'Select and inspect an asset folder first. Review each component, LOD level, source file and import name here before confirming.')}</div>}
    {groups.length > 0 && <>
    <p>{t('核对每个模型的 LOD 文件，再勾选下方确认。', 'Check each model’s LOD files, then confirm below.')}</p>
    <p>{bindingHint}</p>
    <div className="character-lod-groups">{groups.map(group => <div className="character-lod-group" key={group.key}>
      <div className="character-lod-model-heading"><strong title={group.name}>{group.name}</strong><small>{group.key.startsWith('skeletalMesh:') ? t('骨骼', 'Skeletal') : t('静态', 'Static')}</small></div>
      {group.files.map((file, index) => <div className="character-lod-file-line" key={`${file.index}:${index}`}>
          <span className="model-lod-chip">LOD{file.index}</span>
          <span title={file.sourcePath || file.name}>{file.sourcePath?.split(/[\\/]/).pop() || file.name}</span>
          <small>{file.inspection === 'pending' ? t('检查中', 'Inspecting') : file.inspection === 'failed'
            ? <span className="error" role="alert" title={file.inspectionMessage}>{t('检查失败', 'Inspection failed')}{file.inspectionMessage && <small>{file.inspectionMessage}</small>}</span>
            : ({ added: t('新增', 'Add'), changed: t('更新', 'Update'), retained: t('保留', 'Keep'), unchanged: t('无变化', 'Unchanged') })[file.status || ''] || ''}</small>
        </div>)}
      <details className="character-lod-name-details"><summary>{t('查看入库文件名', 'View import file names')}</summary>
        <table className="character-lod-table"><thead><tr><th scope="col">{t('等级', 'Level')}</th><th scope="col">{t('来源文件', 'Source file')}</th><th scope="col">{t('入库文件名', 'Import file name')}</th></tr></thead>
          <tbody>{group.files.map((file, index) => <tr key={`${file.index}:${index}`}><td>LOD{file.index}</td><td>{file.sourcePath?.split(/[\\/]/).pop() || file.name}</td><td>{file.name}</td></tr>)}</tbody>
        </table>
      </details>
      {!!group.automatic.length && <small>{group.key.startsWith('skeletalMesh:') && !group.files.some(file => file.index === 1)
        ? t('使用同部件 SM LOD1 与 SK LOD0 自动生成：', 'Generated using matching SM LOD1 and SK LOD0: ')
        : group.files.some(file => file.index === 1)
        ? t('LOD1 导入后自动减面：', 'Generated after importing LOD1: ')
        : t('补充 LOD1 后自动生成 LOD2–5；当前缺少：', 'Add LOD1 to generate LOD2–5; currently missing: ')}{group.automatic.map(index => `LOD${index}`).join('、')}</small>}
      {group.missingBase && <small role="alert" className="error">{t('缺少 LOD0 主模型', 'Missing LOD0 base model')}</small>}
      {group.duplicate && <small role="alert" className="error">{t('同一等级有多个文件，请整理后重试', 'Multiple files for the same level. Resolve before continuing.')}</small>}
    </div>)}</div>
    <details className="character-lod-rules"><summary>{t('LOD 规则说明', 'LOD rules')}</summary>
      <p>{t('SM LOD1 与 SK LOD0 可以先后上传，齐全后再次发送 UE 即可生成。替换 LOD0 后会重新核对配套关系：更新 SM LOD0 会清理旧 SM/SK 后续等级；只更新 SK LOD0 会保留有效的 SM LOD1，并重建 SK 后续等级。减面优先保护造型，实际面数可能高于目标比例。布料 LOD 另行确定。', 'SM LOD1 and SK LOD0 can arrive in either order; send to UE again once both are available. Replacing LOD0 rechecks the pairing: updating SM LOD0 clears old later SM/SK levels; updating only SK LOD0 retains valid SM LOD1 and rebuilds later SK levels. Shape preservation takes priority over target triangle ratios. Cloth LOD rules are pending.')}</p>
      <p>{t('不带后缀或 _LOD0 为主模型；各等级共用贴图，无需另建 LOD 文件夹。名称或文件变化后需重新确认。', 'No suffix or _LOD0 is the base. Levels share textures; no extra LOD folder is needed. Review again after names or files change.')}</p>
    </details>
    </>}
    {onConfirm && <label className="character-identity-confirm"><input type="checkbox" checked={canConfirm && confirmed === true} disabled={disabled || !canConfirm} onChange={event => onConfirm(event.target.checked)} />{t('我已核对各部件、LOD 等级及对应模型文件', 'I have checked every component, LOD level and model file')}</label>}
  </section>;
}
