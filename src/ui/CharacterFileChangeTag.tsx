type HistoryFile = { storedPath?: string; name?: string; status?: string };
type HistoryEntry = { at?: string; files?: HistoryFile[] };

/** Highlight the latest file upload, independently of UE send history. */
export function CharacterFileChangeTag({ history, storedPath, name, english }: {
  history: unknown; storedPath: string; name: string; english: boolean;
}) {
  if (!Array.isArray(history)) return null;
  const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase();
  const matches = (item: HistoryFile) => item?.storedPath
    ? normalize(item.storedPath) === normalize(storedPath)
    : item?.name === name;
  const entry = [...history].reverse().find((item: HistoryEntry) => Array.isArray(item?.files)
    && item.files.some(file => matches(file) && ['added', 'changed'].includes(file.status || ''))) as HistoryEntry | undefined;
  const file = entry?.files?.find(matches);
  if (!file || !['added', 'changed'].includes(file.status || '')) return null;
  const added = file.status === 'added';
  return <span className={`character-file-change-tag ${added ? 'added' : 'updated'}`}
    title={`${english ? 'Latest upload' : '最近一次上传'}${entry?.at ? ` · ${entry.at}` : ''}`}>
    {added ? (english ? 'New' : '新增') : (english ? 'Updated' : '更新')}
  </span>;
}
