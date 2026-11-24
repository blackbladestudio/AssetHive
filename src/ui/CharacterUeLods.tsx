import type { SuitExportRow } from './suitExportTypes';

export function CharacterUeLods({ receipts, t }: { receipts: unknown; t: (zh: string, en: string) => string }) {
  const projects = Object.values((receipts || {}) as Record<string, {
    projectPath: string; checkedAt?: string; entries?: Record<string, SuitExportRow & { missingInUE?: boolean }>;
  }>).filter(project => Object.values(project.entries || {}).some(row => row.lodReport));
  if (!projects.length) return null;
  return <details className="character-file-section">
    <summary>{t('UE LOD 验证记录', 'UE LOD verification records')}</summary>
    <small>{t('以下为最近检查结果；自动减面保存在 UE 中，不作为库内 FBX 文件。', 'Last checked results. Generated LODs live in UE, not as library FBX files.')}</small>
    {projects.map(project => <div key={project.projectPath}>
      <p>{project.projectPath}</p>
      {Object.values(project.entries || {}).filter(row => row.lodReport).map(row => <div key={row.key}>
        <strong>{row.name}</strong>
        {row.lodCheckedAt && <small> · {new Date(row.lodCheckedAt).toLocaleString()}</small>}
        {(row.missingInUE || row.status === 'failed') && <p className="error">{row.missingInUE ? t('UE 模型已缺失，以下为历史记录', 'UE mesh missing; historical record below') : row.message}</p>}
        {row.lodReport?.levels?.map(level => <div key={level.index}>
          LOD{level.index} · {level.triangles.toLocaleString()} {t('三角面', 'triangles')} · {level.source === 'generated' ? t('自动减面', 'Generated') : level.source === 'imported' ? t('美术文件', 'Artist file') : t('UE 已有', 'Existing in UE')}
        </div>)}
      </div>)}
    </div>)}
  </details>;
}
