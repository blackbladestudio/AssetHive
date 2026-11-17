const doc = globalThis.document;
const api = globalThis.megascans;
const byId = id => doc.getElementById(id);
const phases = { authenticating: '检查登录', reauthenticating: '正在自动恢复登录', waiting_login: '等待 Quixel 登录，成功后自动继续', retrying: '等待网络恢复，自动重试中', listing: '读取已购清单', checking: '校验完成回执', archive_retention: '整理原始归档容量', ready: '准备处理', planning: '准备下载', downloading: '下载文件', archiving: '归档并校验', importing: 'AssetHive 入库', verifying: '校验结果', cleaning: '清理本地缓存', done: '完成', stopped: '已停止' };
const statuses = { running: '正在运行', failed: '遇到错误，已保留缓存', paused: '已暂停 / 试跑结束', completed: '全部完成', pending_retry: '其余已处理，仍有资产待重试', interrupted: '任务已中断，可续跑' };
const types = { '3d': '3D Assets', '3dplant': '3D Plants', surface: 'Surface', decal: 'Decal', atlas: 'Atlas', hdri: 'HDRI' };
const number = value => value == null ? '—' : Number(value).toLocaleString('zh-CN');
const bytes = value => value == null ? '—' : `${(value / 1024 / 1024).toFixed(1)} MB`;
let offset = 0, total = 0, lastSignature = '', busy = false, queryTimer;
let configurationLoaded = false, modeLocked = false, loginPending = false, fabSource = false;
const selection = () => [...doc.querySelectorAll('input[name="asset-type"]:checked')].map(input => input.value);
function showError(message) { byId('error').hidden = !message; byId('error').textContent = message || ''; }
async function unwrap(promise) { const result = await promise; if (!result.ok) throw new Error(result.error); return result.value; }
function text(parent, tag, content, className) { const node = doc.createElement(tag); node.textContent = content; if (className) node.className = className; parent.append(node); return node; }
async function refreshAssets(force = false) {
  const value = await unwrap(api.assets({ query: byId('search').value, offset, force }));
  total = value.total;
  if (offset >= total && offset) { offset = 0; return refreshAssets(); }
  byId('asset-count').textContent = `已入库 ${number(value.imported)} · 仅归档 ${number(value.archived)}${value.unreadable ? ` · ${value.unreadable} 条记录读取失败` : ''}`;
  const signature = JSON.stringify(value);
  if (force || signature !== lastSignature) {
    lastSignature = signature; byId('assets').replaceChildren();
    if (!value.items.length) text(byId('assets'), 'p', byId('search').value ? '没有匹配的已完成资产' : '还没有完成入库的资产。当前处理内容会在校验成功后出现在这里。', 'empty');
    for (const row of value.items) {
      const card = doc.createElement('article'); card.className = 'asset';
      if (row.preview) { const image = doc.createElement('img'); image.src = row.preview; image.alt = row.name; image.loading = 'lazy'; card.append(image); }
      else text(card, 'div', row.assetType === '3d' ? '◇' : '▦', 'placeholder');
      const body = doc.createElement('div'); body.className = 'asset-body'; card.append(body);
      text(body, 'h3', row.name).title = row.name;
      text(body, 'p', `${types[row.assetType] || row.assetType} · ${row.id}`);
      text(body, 'p', row.status === 'imported' ? '已入库并校验' : '仅原始归档', row.status === 'imported' ? 'done' : 'archived');
      if (row.reason) text(body, 'p', row.reason);
      const open = text(body, 'button', '打开文件夹'); open.onclick = () => unwrap(api.open(row.id)).catch(error => showError(error.message));
      byId('assets').append(card);
    }
  }
  byId('page').textContent = total ? `${offset + 1}–${Math.min(offset + 30, total)} / ${number(total)}` : '0 项';
  byId('previous').disabled = offset === 0; byId('next').disabled = offset + 30 >= total;
}
async function refresh(force = false) {
  if (busy) return;
  busy = true;
  try {
    if (!configurationLoaded) {
      const configuration = await unwrap(api.configuration());
      for (const input of doc.querySelectorAll('input[name="asset-type"]')) input.checked = configuration.assetTypes.includes(input.value);
      byId('mode').value = configuration.mode;
      modeLocked = configuration.modeLocked;
      fabSource = configuration.source === 'fab';
      if (fabSource) byId('selection-info').textContent = 'Fab 当前免费商品 · 按 Megascans 源 ID 与现有资产库去重 · Raw 高模和最高 4K 贴图 · 每项下载前复核 Professional 许可价格为 0。';
      configurationLoaded = true;
    }
    const { progress, library, active, pausePending, loggingIn, loginStatus } = await unwrap(api.progress());
    modeLocked ||= !!progress?.mode;
    const blocked = !!active || loggingIn || loginPending;
    byId('start').disabled = blocked || !selection().length;
    byId('login').disabled = blocked || fabSource;
    byId('login').hidden = fabSource;
    byId('login').textContent = loggingIn || loginPending ? '登录中…' : 'Bridge 登录';
    byId('login-status').textContent = fabSource ? '来源：Fab 免费 Megascans' : loginStatus;
    byId('type-selection').disabled = blocked || fabSource;
    byId('mode').disabled = blocked || modeLocked;
    byId('mode').title = modeLocked ? '当前任务已绑定处理方式；不同模式请使用新的 --cache' : '';
    byId('pause').disabled = loggingIn || loginPending || !active || pausePending;
    byId('pause').textContent = active && pausePending ? '等待当前项完成…' : '暂停';
    byId('library').textContent = library;
    if (progress) {
      byId('status').textContent = statuses[progress.status] || progress.status;
      for (const key of ['completed', 'pending', 'skipped', 'total']) byId(key).textContent = number(progress[key]);
      const percent = progress.total ? progress.completed * 100 / progress.total : 0;
      byId('overall').value = percent;
      byId('overall-text').textContent = `${percent.toFixed(2)}% · 本次处理 ${number(progress.processedThisRun)} 项`;
      const current = progress.current;
      const prefetch = progress.prefetch;
      byId('deferred-info').hidden = !progress.deferred;
      byId('deferred-info').textContent = progress.deferred ? `待重试 ${number(progress.deferred)} 项（未计入完成）：${(progress.deferredIds || []).slice(0, 10).join('、')}${progress.deferred > 10 ? '…' : ''}${progress.lastDeferred ? ` · 最近暂存 ${progress.lastDeferred.id}：${progress.lastDeferred.reason}` : ''}` : '';
      byId('deferred-info').title = (progress.deferredIds || []).join('、');
      byId('prefetch-info').hidden = !prefetch;
      byId('prefetch-info').textContent = prefetch ? `下一项 ${prefetch.id} · ${{ waiting_capacity: '等待缓存空间', prefetched: '下载完成，等待当前项入库' }[prefetch.stage] || phases[prefetch.stage] || prefetch.stage} · ${bytes(prefetch.downloadedBytes)} / ${bytes(prefetch.totalBytes)}` : '';
      byId('current-id').textContent = current?.id || '—'; byId('stage').textContent = phases[progress.stage] || progress.stage;
      if (progress.stage === 'deferred') byId('stage').textContent = '已暂存，继续下一项';
      if (progress.stage === 'awaiting_retry') byId('stage').textContent = '其余队列已处理，等待重试暂存项';
      if (progress.stage === 'ordering') {
        byId('stage').textContent = '按类型整理已购库';
        byId('overall-text').textContent = `分类 ${number(progress.orderingDone)} / ${number(progress.orderingTotal)}，完成后按序下载；分类可续跑。${progress.unavailable ? ` 源站已不可用 ${number(progress.unavailable)} 项（已记录）` : ''}`;
        byId('overall').value = progress.orderingTotal ? progress.orderingDone * 100 / progress.orderingTotal : 0;
      }
      if (fabSource && ['listing', 'identifying'].includes(progress.stage)) {
        byId('stage').textContent = progress.stage === 'listing' ? '读取 Fab 当前免费清单' : '核对 Megascans 源 ID';
        byId('overall-text').textContent = progress.stage === 'listing' ? `已发现 ${number(progress.listed)} 个免费商品` : `ID 映射 ${number(progress.classified)} / ${number(progress.eligible)}`;
      }
      if (progress.stage === 'checking') {
        byId('stage').textContent = progress.checkingMode === 'full' ? '历史文件 SHA-256 校验' : '快速检查完成记录';
        byId('overall-text').textContent = `检查 ${number(progress.checkingDone || 0)} / ${number(progress.checkingTotal)} 项，完成后自动继续下载；可暂停。`;
        byId('overall').value = progress.checkingTotal ? progress.checkingDone * 100 / progress.checkingTotal : 0;
        byId('current-id').textContent = progress.checkingId || '—';
      }
      byId('file-progress').value = current?.totalBytes ? Math.min(100, current.downloadedBytes * 100 / current.totalBytes) : 0;
      byId('file-info').textContent = current ? `${current.file || ''} · 文件 ${current.completedFiles || 0}/${current.totalFiles ?? '—'} · ${bytes(current.downloadedBytes)} / ${bytes(current.totalBytes)}` : '尚无下载数据';
      if (current?.stage === 'downloading') byId('file-info').textContent += progress.downloadAssets === 2
        ? ` · 两资产共享最多 ${progress.downloadConnections || 4} 个下载连接`
        : ` · 并发 ${current.activeFiles?.length || 0}/${current.downloadWorkers || 1}`;
      if (progress.stage === 'checking') byId('file-info').textContent = progress.checkingFile || '正在检查历史记录，尚未开始新下载';
      if (progress.stage === 'archive_retention') byId('file-info').textContent = `原始归档 ${(progress.archiveBytes / 1024 ** 3).toFixed(2)} / ${(progress.maxArchiveBytes / 1024 ** 3).toFixed(0)} GiB · 已回收 ${(progress.reclaimedBytes / 1024 ** 3).toFixed(2)} GiB · 已入库资产保留`;
      else if (current?.omittedPreviews?.length) byId('file-info').textContent += ` · ${current.omittedPreviews.length} 张预览不可用，使用其他源站预览`;
      if (['retrying', 'reauthenticating', 'waiting_login'].includes(progress.stage)) {
        const retry = current?.stage === progress.stage ? current : progress;
        const seconds = retry.retryAt ? Math.max(0, Math.ceil((new Date(retry.retryAt).getTime() - Date.now()) / 1000)) : null;
        byId('file-info').textContent = `${retry.retryReason || phases[progress.stage]}${seconds == null ? '' : ` · 第 ${retry.retryAttempt} 次重试，${seconds} 秒后继续`} · 当前缓存保留`;
      }
      byId('updated').textContent = `更新于 ${new Date(progress.updatedAt).toLocaleString('zh-CN')}`;
      showError(progress.error || '');
    } else byId('status').textContent = '等待下载任务';
    await refreshAssets(force);
  } catch (error) { showError(error.message); }
  finally { busy = false; }
}
byId('refresh').onclick = () => refresh(true);
byId('start').onclick = async () => {
  byId('start').disabled = true;
  try { await unwrap(api.start({ assetTypes: selection(), mode: byId('mode').value })); await refresh(); } catch (error) { showError(error.message); }
};
byId('type-selection').onchange = () => { byId('start').disabled = !selection().length; };
byId('login').onclick = async () => {
  loginPending = true;
  byId('login').disabled = true; byId('start').disabled = true; byId('type-selection').disabled = true; byId('mode').disabled = true;
  byId('login').textContent = '登录中…';
  try { await unwrap(api.login()); showError(''); }
  catch (error) { showError(error.message); }
  finally { loginPending = false; await refresh(); }
};
byId('pause').onclick = async () => {
  byId('pause').disabled = true;
  try { await unwrap(api.pause()); await refresh(); } catch (error) { showError(error.message); }
};
byId('open-library').onclick = () => unwrap(api.open()).catch(error => showError(error.message));
byId('previous').onclick = () => { offset = Math.max(0, offset - 30); refresh(); };
byId('next').onclick = () => { offset += 30; refresh(); };
byId('search').oninput = () => { globalThis.clearTimeout(queryTimer); queryTimer = globalThis.setTimeout(() => { offset = 0; refresh(); }, 250); };
refresh(); globalThis.setInterval(() => refresh(), 2000);
