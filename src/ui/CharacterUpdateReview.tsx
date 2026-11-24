type Translate = (zh: string, en: string) => string;
type InputRow = { sourcePath: string; storedPath: string; candidates: Array<{ storedPath: string; name: string }> };
const basename = (value: string) => value.split(/[\\/]/).pop() || value;

export function CharacterUpdateAssignments({ rows, disabled, onChange, t }: {
  rows: InputRow[]; disabled: boolean; onChange: (sourcePath: string, target: string) => void; t: Translate;
}) {
  const counts = new Map<string, number>();
  for (const row of rows) if (row.storedPath && row.storedPath !== '__skip__') counts.set(row.storedPath, (counts.get(row.storedPath) || 0) + 1);
  const pending = rows.filter(row => !row.storedPath || (counts.get(row.storedPath) || 0) > 1);
  const resolved = rows.filter(row => !pending.includes(row));
  const renderRow = (row: InputRow) => <label className="character-update-assignment" key={row.sourcePath}>
    <span title={row.sourcePath}>{basename(row.sourcePath)}</span>
    {(counts.get(row.storedPath) || 0) > 1 && <small className="error">{t('多个文件指向同一目标，请调整或跳过', 'Multiple files target this destination. Reassign or skip.')}</small>}
    <select className="settings-input" disabled={disabled} aria-label={t('更新目标', 'Update destination')} value={row.storedPath}
      onChange={event => onChange(row.sourcePath, event.target.value)}>
      <option value="">{t('请选择目标', 'Choose destination')}</option>
      <option value="__skip__">{t('本次不更新', 'Skip this file')}</option>
      {row.candidates.filter(candidate => candidate.storedPath === row.storedPath
        || !rows.some(other => other.sourcePath !== row.sourcePath && other.storedPath === candidate.storedPath))
        .map(candidate => <option key={candidate.storedPath} value={candidate.storedPath}>{candidate.storedPath.startsWith('__new_') ? t('新增 · ', 'Add · ') : ''}{candidate.name}</option>)}
    </select>
  </label>;
  return <section className="character-update-review">
    <div className="character-update-stats"><span>{t(`已匹配 / 跳过 ${resolved.length}`, `Matched / skipped ${resolved.length}`)}</span><span className={pending.length ? 'needs-attention' : ''}>{t(`待确认 ${pending.length}`, `Needs attention ${pending.length}`)}</span></div>
    {!!pending.length && <><strong>{t('只需确认以下文件', 'Only these files need your input')}</strong>
      <small>{t('补齐目标后自动检查；不需要的文件可选择跳过。', 'Checking continues automatically when resolved. You can skip unwanted files.')}</small>
      <div className="character-update-review-list">{pending.map(renderRow)}</div></>}
    {!!resolved.length && <details><summary>{t(`已处理的文件 · ${resolved.length}`, `Resolved files · ${resolved.length}`)}</summary><div className="character-update-review-list">{resolved.map(renderRow)}</div></details>}
  </section>;
}

export function CharacterUpdateChanges({ changes, replacements, excludedFiles, t }: {
  changes: Array<{ name: string; status: string }>;
  replacements?: Array<{ sourcePath: string; storedPath: string }>;
  excludedFiles?: string[]; t: Translate;
}) {
  const changed = changes.filter(change => ['added', 'changed', 'removed'].includes(change.status));
  const kept = changes.filter(change => !['added', 'changed', 'removed'].includes(change.status));
  const label = (status: string) => ({ added: t('新增', 'Add'), changed: t('更新', 'Update'), unchanged: t('无变化', 'Unchanged'), retained: t('未提供 · 保留', 'Not supplied · kept'), removed: t('旧 LOD 已失效 · 移出当前版本', 'Previous LOD invalidated · removed from current version') })[status] || status;
  const renderRows = (items: typeof changes) => <div className="character-update-review-list">{items.map((item, index) => <div className="character-update-review-file" key={`${item.name}:${index}`}><span>{label(item.status)}</span><span title={item.name}>{item.name}</span></div>)}</div>;
  const groups = [
    { label: t('静态模型', 'Static models'), items: changed.filter(item => /^SM_/i.test(item.name)) },
    { label: t('骨骼模型', 'Skeletal models'), items: changed.filter(item => /^SK_/i.test(item.name)) },
    { label: t('贴图', 'Textures'), items: changed.filter(item => /^T_/i.test(item.name)) },
    { label: t('其他文件', 'Other files'), items: changed.filter(item => !/^(?:SM|SK|T)_/i.test(item.name)) }
  ].filter(group => group.items.length);
  return <section className="character-update-review" aria-label={t('检查结果', 'Check results')}>
    <strong>{changed.length ? t('本次更新', 'This update') : t('文件没有变化', 'No file changes')}</strong>
    <div className="character-update-stats">{['changed', 'added', 'removed', 'unchanged', 'retained'].map(status => {
      const count = changes.filter(item => item.status === status).length;
      return count > 0 ? <span key={status}>{label(status)} {count}</span> : null;
    })}</div>
    {groups.map(group => <details key={group.label}><summary>{group.label}<span>{t(`${group.items.length} 个文件`, `${group.items.length} files`)}</span></summary>{renderRows(group.items)}</details>)}
    {!!kept.length && <details><summary>{t('保持原样', 'Kept as is')}<span>{kept.length}</span></summary>{renderRows(kept)}</details>}
    {!!replacements?.length && <details><summary>{t('查看文件对应关系', 'View file mapping')}</summary><div className="character-update-review-list">{replacements.map(item => <div className="character-update-mapping" key={item.sourcePath}>
      <span title={item.sourcePath}>{basename(item.sourcePath)}</span><span title={item.storedPath}>→ {basename(item.storedPath)}</span>
    </div>)}</div></details>}
    {!!excludedFiles?.length && <details><summary>{t('不参与更新', 'Excluded')}<span>{excludedFiles.length}</span></summary><div className="character-update-review-list">{excludedFiles.map(file => <div className="character-update-review-file" key={file} title={file}>{basename(file)}</div>)}</div></details>}
  </section>;
}
