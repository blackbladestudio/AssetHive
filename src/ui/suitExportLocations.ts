type ReceiptEntry = { kind?: string; partSlot?: string; status?: string; action?: string; path?: string; lastSuccessPath?: string; missingInUE?: boolean; livePath?: string };
type Receipt = { projectPath?: string; targetRoot?: string; checkedAt?: string; entries?: Record<string, ReceiptEntry> };
const isPending = (row: ReceiptEntry) => ['failed', 'blocked', 'skipped', 'conflict'].includes(row.status || '') || row.status === 'ready' && row.action !== 'unchanged';
const isMissing = (row: ReceiptEntry) => row.missingInUE ?? (row.status === 'missing' || row.action === 'restore' && row.status !== 'success');
export function suitExportLocations(meta: Record<string, unknown>, projectPath: string) {
  const records = Object.values((meta.characterUnrealExports || {}) as Record<string, Receipt>);
  const normalize = (value: string) => value.replaceAll('\\', '/').toLowerCase();
  const receipt = (projectPath ? records.filter(item => normalize(item.projectPath || '') === normalize(projectPath)) : records)
    .sort((a, b) => String(b.checkedAt).localeCompare(String(a.checkedAt)))[0];
  if (!receipt) return null;
  const slot = (meta.componentView as { slot?: string } | undefined)?.slot;
  const entries = Object.values(receipt.entries || {}).filter(row => row.action !== 'retained');
  if (slot) return entries.filter(row => row.partSlot === slot && ['staticMesh', 'skeletalMesh'].includes(row.kind || ''))
    .map(row => ({ label: row.kind === 'skeletalMesh' ? 'SK' : 'SM', path: !isMissing(row) && row.lastSuccessPath ? row.livePath || row.path || row.lastSuccessPath : '',
      missing: isMissing(row), pending: isPending(row) }));
  return [{ label: '', path: entries.length && entries.every(isMissing) ? '' : String(receipt.targetRoot || ''),
    missing: entries.some(isMissing),
    pending: entries.some(isPending) }];
}
