// Derive readable summaries for old records too; never rewrite the original audit data.
export function characterImportSourceFolders(meta = {}) {
  const files = (meta.characterManifest?.files || []).map(file => file.originalPath || file.sourcePath);
  for (const entry of meta.characterUpdateHistory || []) {
    if (/预览|主图|发送.*UE/.test(entry.label || '')) continue;
    files.push(...(entry.sourcePaths || []), ...(entry.files || []).map(file => file.sourcePath));
  }
  const folders = new Map();
  for (const file of files) {
    const normalized = String(file || '').trim().replace(/\\/g, '/');
    if (!/^(?:[A-Za-z]:\/|\/\/)/.test(normalized)) continue;
    const folder = normalized.slice(0, normalized.lastIndexOf('/'));
    if (folder) folders.set(folder.toLowerCase(), folder.replace(/\//g, '\\'));
  }
  return [...folders.values()];
}

export function characterHistorySummary(entry) {
  const label = String(entry.label || '').trim();
  const ue = /发送到 UE/.test(label);
  // Notes are displayed separately. Preview renders must be classified before PNG/JPG textures.
  if (/主图/.test(label)) return '更换主图';
  if (/预览|四视图|正面照/.test(label)) {
    const part = label.match(/^(头部|上装|下装|臂部|头发|脸部)/)?.[1];
    const kind = /\bSK\b/.test(label) ? '骨骼模型' : /\bSM\b/.test(label) ? '静态模型' : '';
    const automatic = /四视图更新|自动/.test(label);
    return `${[part, kind].filter(Boolean).join(' · ')}${part || kind ? ' · ' : ''}${automatic ? '自动' : ''}更新预览图`;
  }
  const changes = entry.changes?.length ? entry.changes : entry.files || [];
  const changed = changes.filter(file => !['unchanged', 'retained', 'skipped'].includes(file.status) && file.action !== 'retained');
  const names = changed.map(file => String(file.name || file.after || file.sourcePath || ''));
  // Presence events store identity changes separately from readable file names.
  if (!changed.some(file => file.name)) names.push(...(entry.files || []).map(file => String(file.name || '')));
  const model = names.some(name => /^(SM|SK)_|\.(fbx|obj|gltf|glb|abc)$/i.test(name));
  const texture = names.some(name => /^T_|\.(png|tga|jpg|jpeg|tif|tiff|exr|dds)$/i.test(name));
  const material = names.some(name => /^MI?_/.test(name));
  const types = [model && '模型', texture && '贴图', material && '材质'].filter(Boolean);
  const resource = types.length > 1 ? `${types.slice(0, -1).join('、')}和${types.at(-1)}` : types[0] || '资源';
  if (/UE 资源删除/.test(label)) return `UE 中的${resource}已删除`;
  if (/UE 资源恢复/.test(label)) return `UE 中的${resource}已恢复`;
  if (ue) {
    const failed = changed.some(file => ['failed', 'error', 'blocked', 'conflict'].includes(file.status));
    const successful = changed.filter(file => file.status === 'success');
    if (failed && !successful.length) return '发送到 UE 未完成';
    const restored = successful.some(file => file.action === 'restore' || /重新导入/.test(file.message || ''));
    return `${restored ? '重新导入' : '发送'}${resource}到 UE${failed ? '（部分未完成）' : ''}`;
  }
  if (/模型类型规范化/.test(label)) return /Static|SM/.test(label) ? '整理静态模型命名（SM）' : '整理骨骼模型命名（SK）';
  if (/中文名更新|名字更新/.test(label)) return label.replace(/中文名更新|名字更新/, '修改名字');
  if (/制作状态/.test(label)) return label.replace(/^制作状态/, '修改制作状态');
  if (/主图|版本|来源|入库/.test(label)) return label;
  if (model || texture || material) {
    const part = label.match(/^(头部|上装|下装|臂部|头发|脸部)/)?.[1];
    return `${part ? `${part} · ` : ''}更新${resource}`;
  }
  return label || '更新资产信息';
}

// Adjacent renders may be nested under their preceding resource update. Manual edits,
// sends and the next update form boundaries; original records and source IDs stay intact.
export function groupCharacterHistoryEntries(entries) {
  const groups = [];
  for (const entry of entries) {
    const previous = groups.at(-1);
    const elapsed = previous ? Date.parse(entry.at) - Date.parse(previous.entries[0].at) : NaN;
    const followsUpdate = previous && /更新(?:模型|贴图|材质|资源)|入库|导入/.test(previous.entries[0].label || '')
      && !/UE/.test(previous.entries[0].label || '') && !previous.entries[0].automaticPreview
      && previous.entries.slice(1).every(item => item.automaticPreview && !item.note);
    const manualImages = item => !item.automaticPreview && !item.note && /预览图|主图/.test(item.label || '');
    if (entry.automaticPreview && !entry.note
      && (followsUpdate || previous?.entries.every(item => item.automaticPreview && !item.note))
      && elapsed >= 0 && elapsed <= 120000) {
      previous.entries.push(entry);
      if (!followsUpdate) previous.at = entry.at;
    } else if (manualImages(entry) && previous?.entries.every(manualImages) && elapsed >= 0 && elapsed <= 120000) {
      previous.entries.push(entry);
      previous.at = entry.at;
    } else {
      groups.push({ id: entry.id, at: entry.at, entries: [entry] });
    }
  }
  return groups.reverse();
}

export function characterHistoryGroupAction(entries, language = 'zh') {
  const first = entries[0];
  const manualImages = entries.length > 1 && !first.automaticPreview && /预览图|主图/.test(first.label);
  return characterHistoryAction(manualImages ? '更新预览图' : first.label, language);
}

function historyAction(label) {
  if (label === '发送到 UE 未完成') return '发送到 UE 未完成';
  if (/到 UE/.test(label)) return /部分未完成/.test(label) ? '发送到 UE（部分未完成）' : '发送到 UE';
  if (/UE 中/.test(label)) return /已删除/.test(label) ? 'UE 资源已删除' : 'UE 资源已恢复';
  if (/主图/.test(label)) return '更换主图';
  if (/预览图/.test(label)) return /自动/.test(label) ? '自动更新预览图' : '更新预览图';
  if (/名字|命名/.test(label)) return '修改名字';
  if (/制作状态/.test(label)) return '修改制作状态';
  if (/入库/.test(label)) return '导入资产';
  if (/来源/.test(label)) return '更新来源位置';
  if (/版本切换/.test(label)) return '切换版本';
  return '更新资产';
}

export function characterHistoryAction(label, language = 'zh') {
  const action = historyAction(label);
  return language === 'en' ? ({
    '发送到 UE 未完成': 'UE transfer incomplete',
    '发送到 UE（部分未完成）': 'Sent to UE (partly incomplete)',
    '发送到 UE': 'Send to UE',
    'UE 资源已删除': 'Assets deleted in UE',
    'UE 资源已恢复': 'Assets restored in UE',
    '更换主图': 'Change cover',
    '自动更新预览图': 'Automatically update previews',
    '更新预览图': 'Update previews',
    '修改名字': 'Rename asset',
    '修改制作状态': 'Change production status',
    '导入资产': 'Import asset',
    '更新来源位置': 'Relink source',
    '切换版本': 'Switch version',
    '更新资产': 'Update asset'
  }[action] || action) : action;
}
