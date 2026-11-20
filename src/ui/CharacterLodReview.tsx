import { characterLodReview, type CharacterLodFile } from '../../shared/characterLodReview.mjs';

export function CharacterLodReview({ files, t, confirmed, onConfirm, onReveal, disabled = false, showEmpty = false, compact = false }: {
  files: CharacterLodFile[]; t: (zh: string, en: string) => string;
  confirmed?: boolean; onConfirm?: (value: boolean) => void; disabled?: boolean; showEmpty?: boolean; compact?: boolean;
  onReveal?: (storedPath: string) => void;
}) {
  const groups = characterLodReview(files);
  const levels = [...new Set(groups.flatMap(group => group.files.map(file => file.index)))].sort((a, b) => a - b);
  if (!groups.length && !showEmpty) return null;
  if (compact) return <details className="character-file-section character-lod-files">
    <summary>{t('模型 LOD 文件', 'Model LOD files')}</summary>
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
      {!!group.automatic.length && <small>{t('UE 自动减面（需设置）：', 'UE reduction (settings required): ')}{group.automatic.map(index => `LOD${index}`).join('、')}</small>}
      {group.missingBase && <small role="alert" className="error">{t('缺少 LOD0 主模型', 'Missing LOD0 base model')}</small>}
      {group.duplicate && <small role="alert" className="error">{t('同一等级有多个文件，请整理后重试', 'Multiple files for the same level. Resolve before continuing.')}</small>}
    </div>)}</div>
    <details className="character-lod-rules"><summary>{t('LOD 规则说明', 'LOD rules')}</summary>
      <p>{t('可以先只提供 LOD0，之后再补充。美术提供的等级使用美术文件；缺少的 LOD1–5 由 UE 按已有减面设置补齐，未配置时会提示。', 'You can start with LOD0 and add source LODs later. Supplied levels use artist files; missing LOD1–5 use existing UE reduction settings. Missing settings are reported.')}</p>
      <p>{t('不带后缀或 _LOD0 为主模型；各等级共用贴图，无需另建 LOD 文件夹。名称或文件变化后需重新确认。', 'No suffix or _LOD0 is the base. Levels share textures; no extra LOD folder is needed. Review again after names or files change.')}</p>
    </details>
    </>}
    {onConfirm && <label className="character-identity-confirm"><input type="checkbox" checked={canConfirm && confirmed === true} disabled={disabled || !canConfirm} onChange={event => onConfirm(event.target.checked)} />{t('我已核对各部件、LOD 等级及对应模型文件', 'I have checked every component, LOD level and model file')}</label>}
  </section>;
}
