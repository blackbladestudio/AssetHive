type ReceiptEntry = { kind?: string; partSlot?: string; status?: string; action?: string; path?: string; lastSuccessPath?: string; missingInUE?: boolean; livePath?: string; associationPending?: boolean };
type Receipt = { projectPath?: string; projectId?: string; targetRoot?: string; checkedAt?: string; entries?: Record<string, ReceiptEntry> };
const isPending = (row: ReceiptEntry) => row.associationPending || ['failed', 'blocked', 'skipped', 'conflict'].includes(row.status || '') || row.status === 'ready' && row.action !== 'unchanged';
const isMissing = (row: ReceiptEntry) => row.missingInUE ?? (row.status === 'missing' || row.action === 'restore' && row.status !== 'success');
export function suitExportLocations(meta: Record<string, unknown>, projectPath: string, projectId = '') {
  if (!projectPath) return [];
  const records = Object.values((meta.characterUnrealExports || {}) as Record<string, Receipt>);
  const normalize = (value: string) => value.replaceAll('\\', '/').toLowerCase();
  const receipt = (projectPath ? records.filter(item => projectId && item.projectId
    ? item.projectId.toLowerCase() === projectId.toLowerCase()
    : normalize(item.projectPath || '') === normalize(projectPath)) : records)
    .sort((a, b) => String(b.checkedAt).localeCompare(String(a.checkedAt)))[0];
  // A global legacy path is not evidence of presence in the selected project.
  if (!receipt) return [];
  const slot = (meta.componentView as { slot?: string } | undefined)?.slot;
  const entries = Object.values(receipt.entries || {}).filter(row => row.action !== 'retained');
  if (slot) return entries.filter(row => row.partSlot === slot && ['staticMesh', 'skeletalMesh'].includes(row.kind || ''))
    .map(row => ({ label: row.kind === 'skeletalMesh' ? 'SK' : 'SM', path: !isMissing(row) && row.lastSuccessPath ? row.livePath || row.path || row.lastSuccessPath : '',
      missing: isMissing(row), pending: isPending(row) }));
  const models = entries.filter(row => ['staticMesh', 'skeletalMesh', 'groom'].includes(row.kind || ''));
  const relevant = models.length ? models : entries;
  return [{ label: '', path: relevant.length && relevant.every(isMissing) ? '' : String(receipt.targetRoot || ''),
    missing: entries.some(isMissing),
    pending: entries.some(isPending) }];
}
