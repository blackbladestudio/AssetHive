// A mesh import success alone is not proof that its LODs arrived.
function verifyCharacterLodReceipt(entry, row) {
  if (entry?.config?.lodPolicy !== 'lod1-reduction-v2'
    || !['success', 'unchanged'].includes(row.status) || row.action === 'retained') return row;
  const report = row.lodReport;
  const levels = new Map((report?.levels || []).map(level => [level.index, level]));
  const manual = [0, ...(entry.config.lodSources || []).map(source => source.index)];
  const invalid = report?.policy !== 'lod1-reduction-v2' || report.qualityVersion !== 1 || report.missingManual?.length
    || manual.some(index => !(levels.get(index)?.triangles > 0) || levels.get(index)?.source !== 'imported');
  const lod1 = levels.get(1);
  const incomplete = (entry.config.skinLodSource || lod1 && ['imported', 'existing'].includes(lod1.source))
    && (report?.missing?.length || report?.pending?.length || [2, 3, 4, 5].some(index => {
      const level = levels.get(index);
      return !(level?.triangles > 0) || level.source === 'generated' && level.structureVerified !== true;
    }));
  return invalid || incomplete ? { ...row, status: 'failed', message: 'UE LOD 验证未通过：美术等级缺失、自动减面未完成或插件未返回有效结果，请更新插件后重新检查发送。' } : row;
}
module.exports = { verifyCharacterLodReceipt };
