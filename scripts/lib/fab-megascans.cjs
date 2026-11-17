const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicJson, exists, assetId, catalogAssetType, downloadFile } = require('./megascans-transfer.cjs');
const { RemoteZip, trustedFabUrl, downloadZipEntry } = require('./fab-zip.cjs');
const { resolveMegascansName } = require('../../electron/services/megascansName');
const { normalizeMegascansTextureType } = require('../../electron/services/megascansTextures');
const { FabSession } = require('./fab-session.cjs');

const SELLER = '45ea3429-f62c-4f17-aa15-5bb9dfcd0079';
const LISTING_TYPES = new Set(['3d-model', 'material', 'decal']);

function sourceIdFromName(name) {
  const match = name.match(/_([A-Za-z0-9]+)_(?:gltf_)?(?:(?:[1248]k)(?:_[a-z0-9]+)*|raw|high|mid|low)\.zip$/i);
  return match ? assetId(match[1]) : null;
}
function applyListingExclusions(listings, exclusions) {
  const sourceType = exclusions?.sourceType || 'bundle';
  if (!['bundle', 'mature'].includes(sourceType) || !Array.isArray(exclusions?.listingIds)
    || exclusions.listingIds.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id))) throw new Error('Fab 排除配置无效');
  const ids = new Set(exclusions.listingIds);
  return listings.map(listing => ids.has(listing.uid) ? { ...listing, excludedSourceType: sourceType, excludedByUser: true } : listing);
}
function existingIds(index) {
  const result = new Map();
  if (!Array.isArray(index.assets)) throw new Error('共享库索引格式无效');
  for (const item of index.assets) {
    const record = item.record, identity = record?.meta?.identity;
    if (identity?.sourceKind === 'megascans' && identity.sourceAssetId && item.metaPath) {
      const id = assetId(identity.sourceAssetId);
      if (!result.has(id)) result.set(id, []);
      result.get(id).push(item.metaPath);
    }
  }
  return result;
}
function freePrice(detail) {
  // During the rollout isFree is stale even when both license tiers cost zero.
  return detail.user?.uid === SELLER && detail.licenses?.some(license => license.slug === 'professional'
    && license.priceTier?.price === 0 && (license.priceTier.discountedPrice == null || license.priceTier.discountedPrice === 0));
}
function transientFabConnection(error) {
  return [429, 500, 502, 503, 504].includes(error?.status)
    || ['AbortError', 'TimeoutError'].includes(error?.name)
    || error?.code === 23 && /timeout/i.test(error?.message || error?.error || '')
    || ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error?.cause?.code || error?.code);
}

function isRawModelFile(name, id) {
  if (!/\.fbx$/i.test(name)) return false;
  const directory = path.posix.dirname(name);
  if (directory.split('/').some(part => /^(?:lod[_-]?\d+|layout)$/i.test(part))) return false;
  const file = path.posix.basename(name);
  // Naming fields and native IDs can themselves contain "lod" or "layout".
  // Inspect export tokens after the verified ID, not arbitrary substrings.
  const suffix = file.match(new RegExp(`(?:^|_)${assetId(id)}_(.*)$`, 'i'))?.[1] || file;
  return !/(?:^|[_-])(?:lod[_-]?\d+|layout)(?:[_\-.]|$)/i.test(suffix);
}

async function readBridgeMetadata(zips, hintedId) {
  for (const zip of zips.filter(Boolean)) {
    const matches = zip.entries.filter(entry => path.posix.basename(entry.name).toLowerCase() === `${hintedId}.json`.toLowerCase());
    const exact = matches.filter(entry => path.posix.basename(entry.name) === `${hintedId}.json`);
    const candidates = exact.length ? exact : matches;
    if (candidates.length > 1) throw new Error('Fab 包内存在多个同名源元数据，无法确定资产身份');
    if (!candidates.length) continue;
    const entry = candidates[0], meta = JSON.parse(await zip.read(entry));
    const nativeId = assetId(meta.id);
    if (path.posix.basename(entry.name).toLowerCase() !== `${nativeId}.json`.toLowerCase() || nativeId.toLowerCase() !== hintedId.toLowerCase()) throw new Error('Fab 文件名与包内 Megascans ID 不匹配');
    // Fab lowercases some package names. Keep the ID inside the verified JSON
    // verbatim; it remains a distinct identity from its case siblings.
    return meta;
  }
  throw Object.assign(new Error('Fab 包没有可验证的 Bridge 源元数据，已保留待重试'), { code: 'FAB_UNSUPPORTED' });
}

function packageTextureMap(meta, entry, tier, { maxResolution = 4096 } = {}) {
  const name = path.posix.basename(entry.name), resolution = name.match(/_(\d+)K_/i);
  if (!resolution || Number(resolution[1]) * 1024 > maxResolution) return null;
  const suffix = name.match(/_([^_]+)\.(?:png|jpe?g)$/i)?.[1];
  const semantic = value => {
    const normalized = normalizeMegascansTextureType(value).toLowerCase();
    return ['albedo', 'basecolor', 'diffuse'].includes(normalized) ? 'albedo' : normalized;
  };
  const type = semantic(suffix);
  const candidates = (meta.maps || meta.components || []).filter(map => type && semantic(map.type || map.name) === type);
  const pixels = Number(resolution[1]) * 1024;
  const sameTier = candidates.filter(map => map.tier === tier);
  const pool = sameTier.length ? sameTier : candidates;
  const extension = path.posix.extname(name).toLowerCase();
  const matchingFormat = pool.filter(map => path.posix.extname(map.uri || '').toLowerCase() === extension);
  const choices = matchingFormat.length ? matchingFormat : pool;
  const selected = choices.find(map => String(map.resolution) === `${pixels}x${pixels}`) || choices[0];
  if (!selected) throw Object.assign(new Error(`无法对应源贴图类型：${entry.name}`), { code: 'FAB_UNSUPPORTED' });
  // Older Bridge JSON describes 8K maps even inside Fab's resized 4K package.
  // Preserve its semantic/calibration fields, use the selected package's size.
  return { ...selected, uri: name, resolution: `${pixels}x${pixels}`, contentLength: entry.bytes };
}

function rawNormalMap(meta, zip) {
  // A baked High normal belongs to the simplified High mesh. The Raw mesh
  // must use its own normal, even when that requires downloading 8K first.
  const candidates = zip.entries.filter(entry => /_(?:normal|normalbump|normalmap|nrm|nor)\.(?:png|jpe?g)$/i.test(entry.name))
    .map(entry => ({ entry, map: packageTextureMap(meta, entry, 0, { maxResolution: 8192 }) }))
    .filter(item => item.map);
  if (!candidates.length) throw Object.assign(new Error('Fab Raw 包内缺少可用 Normal，禁止搭配 High 法线'), { code: 'FAB_UNSUPPORTED' });
  candidates.sort((left, right) => Number(right.map.resolution.split('x')[0]) - Number(left.map.resolution.split('x')[0])
    || Number(/\.png$/i.test(right.entry.name)) - Number(/\.png$/i.test(left.entry.name)));
  const selected = candidates[0];
  if (candidates.slice(1).some(item => item.map.resolution === selected.map.resolution
    && path.posix.extname(item.entry.name).toLowerCase() === path.posix.extname(selected.entry.name).toLowerCase())) {
    throw Object.assign(new Error('Fab Raw 包内存在多个 Normal，无法确定模型对应关系'), { code: 'FAB_UNSUPPORTED' });
  }
  if (selected.map.tier != null && selected.map.tier !== 0) throw Object.assign(new Error('Fab 源元数据缺少 Raw 档 Normal'), { code: 'FAB_UNSUPPORTED' });
  return selected;
}

class FabMegascans {
  constructor(cacheRoot, { fetchImpl = fetch, sessionClient } = {}) {
    this.cacheRoot = cacheRoot; this.fetch = fetchImpl;
    this.session = sessionClient || new FabSession(cacheRoot);
    this.unreachableCdns = new Set();
  }
  async close() { await this.session.close(); }
  async request(endpoint) {
    if (!endpoint.startsWith('/i/')) throw new Error('Fab API 路径无效');
    let failure;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const url = `https://www.fab.com${endpoint}`;
        let response = await this.fetch(url, { redirect: 'error', signal: globalThis.AbortSignal.timeout(60000) });
        if (response.status === 403) {
          let detail;
          try { detail = await response.clone().json(); } catch { /* Not a mature-content response. */ }
          if (detail?.detail === 'Mature content hidden for user') {
            const policyFile = path.join(this.cacheRoot, 'mature-exclusions.json');
            if (await exists(policyFile) && JSON.parse(await fs.readFile(policyFile, 'utf8')).action === 'skip') {
              await response.body?.cancel();
              throw Object.assign(new Error('按用户要求暂时跳过成熟内容'), { code: 'FAB_MATURE_SKIPPED', status: 403, source: 'fab', endpoint, assetType: 'mature' });
            }
            if (await this.session.available()) {
              await response.body?.cancel();
              response = await this.session.fetch(url);
            }
          }
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw Object.assign(new Error(`Fab 接口失败：HTTP ${response.status}`), { status: response.status, source: 'fab', endpoint });
        }
        return await response.json();
      } catch (error) {
        failure = error;
        if (error.status && error.status !== 429 && error.status < 500 || attempt === 3) throw error;
        await new Promise(resolve => globalThis.setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
    throw failure;
  }
  async formats(listing, { refresh = false } = {}) {
    const file = path.join(this.cacheRoot, 'formats', `${listing.uid}.json`);
    if (!refresh && await exists(file)) return JSON.parse(await fs.readFile(file, 'utf8'));
    const formats = await this.request(`/i/listings/${listing.uid}/asset-formats`);
    if (!Array.isArray(formats)) throw new Error('Fab 格式清单发生变化');
    await atomicJson(file, formats);
    return formats;
  }
  async listingIdentity(listing) {
    let formats;
    try { formats = await this.formats(listing); }
    catch (error) {
      if (error.code === 'FAB_MATURE_SKIPPED') return { ...listing, excludedSourceType: 'mature', excludedByUser: true };
      throw error;
    }
    const format = formats.find(format => format.assetFormatType.code === (listing.listingType === '3d-model' ? 'fbx' : 'texture-set'))
      || formats.find(format => format.assetFormatType.code === 'image');
    const identityFiles = format?.files?.length ? format.files : formats.filter(format => ['converted-files', 'gltf'].includes(format.assetFormatType.code)).flatMap(format => format.files);
    const ids = new Set(identityFiles.map(file => sourceIdFromName(file.name)).filter(Boolean));
    if (ids.size !== 1) return { ...listing, unsupported: '无法从官方文件名确定唯一源 ID' };
    return { ...listing, sourceId: [...ids][0] };
  }
  async catalog(onProgress = async () => {}) {
    const listings = new Map(), cursors = new Set(); let cursor;
    do {
      const query = new globalThis.URLSearchParams({ seller: 'Quixel Megascans', is_free: '1', sort_by: '-publishedAt', ...(cursor ? { cursor } : {}) });
      const page = await this.request(`/i/listings/search?${query}`);
      if (!Array.isArray(page.results) || !page.cursors) throw new Error('Fab 免费清单发生变化');
      for (const item of page.results) {
        if (item.user?.uid !== SELLER || item.startingPrice?.price !== 0) throw new Error('Fab 免费筛选返回了收费或其他卖家资源，已停止');
        listings.set(item.uid, { uid: item.uid, title: item.title, listingType: item.listingType,
          publishedAt: item.publishedAt, formats: item.assetFormats?.map(format => format.assetFormatType.code) });
      }
      cursor = page.cursors.next;
      if (cursor && cursors.has(cursor)) throw new Error('Fab 分页游标重复，无法确认清单完整');
      cursors.add(cursor);
      await onProgress({ stage: 'listing', listed: listings.size });
    } while (cursor);
    const items = [...listings.values()];
    await atomicJson(path.join(this.cacheRoot, 'free-catalog.json'), { fetchedAt: new Date().toISOString(), items });
    let classified = 0;
    const eligible = items.filter(item => LISTING_TYPES.has(item.listingType));
    for (let offset = 0; offset < eligible.length; offset += 4) {
      const batch = await Promise.allSettled(eligible.slice(offset, offset + 4).map(item => this.listingIdentity(item)));
      for (let index = 0; index < batch.length; index++) {
        const result = batch[index];
        if (result.status === 'rejected') throw result.reason;
        Object.assign(eligible[offset + index], result.value); classified++;
      }
      await onProgress({ stage: 'identifying', listed: items.length, classified, eligible: eligible.length });
    }
    await atomicJson(path.join(this.cacheRoot, 'free-catalog.json'), { fetchedAt: new Date().toISOString(), items });
    return items;
  }
  async zip(listingId, format, file) {
    let lastConnectionError;
    for (let attempt = 0; ; attempt++) {
      try {
        // Fab may allocate the same file to different official CDNs. Request a
        // fresh signed URL after a transient connect failure; never rewrite a
        // signed host or weaken TLS validation to work around a dead route.
        const info = await this.request(`/i/listings/${listingId}/asset-formats/${format}/files/${file.uid}/download-info`);
        const urls = (info.downloadInfo || []).map(item => item.downloadUrl).filter(Boolean);
        if (!urls.length) throw new Error('Fab 未授权下载此资源');
        const url = urls.find(value => !this.unreachableCdns.has(new globalThis.URL(value).hostname)) || (attempt >= 5 ? urls[0] : null);
        if (!url) {
          if (attempt >= 5) throw lastConnectionError || Object.assign(new Error('Fab 当前分配的官方 CDN 暂不可达'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
          continue;
        }
        const zip = new RemoteZip(url, file.fileSize ?? file.size, { fetchImpl: this.fetch });
        try { await zip.directory(); }
        catch (error) {
          if (transientFabConnection(error) && !error.status) {
            this.unreachableCdns.add(new globalThis.URL(url).hostname);
            lastConnectionError = error;
          }
          throw error;
        }
        return zip;
      } catch (error) {
        if (attempt >= 5 || !transientFabConnection(error)) throw error;
        await new Promise(resolve => globalThis.setTimeout(resolve, Math.min(2000, 500 * 2 ** attempt)));
      }
    }
  }
  async plan(listing, options = {}) {
    try { return await this.planCurrent(listing, options); }
    catch (error) {
      // Fab can replace file UUIDs without changing the listing or filenames.
      // Refresh only a missing download-info target, once; never mask a missing
      // listing, authorization denial, or an integrity failure.
      if (![404, 410].includes(error.status) || !error.endpoint?.endsWith('/download-info')) throw error;
      await this.formats(listing, { refresh: true });
      return this.planCurrent(listing, options);
    }
  }
  async planCurrent(listing, { knownIds, normalOnly = false } = {}) {
    const detail = await this.request(`/i/listings/${listing.uid}`);
    if (!freePrice(detail)) throw Object.assign(new Error('该资产当前未免费提供 Professional 许可，保留待处理'), { code: 'FAB_NOT_FREE' });
    const formats = await this.formats(listing);
    const format = formats.find(format => format.assetFormatType.code === (listing.listingType === '3d-model' ? 'fbx' : 'texture-set'))
      || formats.find(format => format.assetFormatType.code === 'image');
    const files = format?.files || [];
    const raw = files.find(file => /_raw\.zip$/i.test(file.name) && !/exr/i.test(file.name));
    const texture = listing.listingType === '3d-model' ? files.find(file => /_high\.zip$/i.test(file.name)) || files.find(file => /_mid\.zip$/i.test(file.name)) || files.find(file => /_low\.zip$/i.test(file.name))
      : files.find(file => /_4k\.zip$/i.test(file.name)) || files.find(file => /_2k\.zip$/i.test(file.name)) || files.find(file => /_1k\.zip$/i.test(file.name));
    if ((!normalOnly && !texture) || listing.listingType === '3d-model' && !raw) throw Object.assign(new Error('Fab 缺少 Raw 高模或不超过 4K 的资源包'), { code: 'FAB_UNSUPPORTED' });
    let textureZip = normalOnly ? null : await this.zip(listing.uid, format.assetFormatType.code, texture);
    const modelZip = raw ? await this.zip(listing.uid, 'fbx', raw) : null;
    let meta;
    try { meta = await readBridgeMetadata([textureZip, modelZip], listing.sourceId); }
    catch (error) {
      if (!normalOnly || error.code !== 'FAB_UNSUPPORTED' || !texture) throw error;
      textureZip = await this.zip(listing.uid, format.assetFormatType.code, texture);
      meta = await readBridgeMetadata([textureZip, modelZip], listing.sourceId);
    }
    const id = meta.id;
    const sourceType = catalogAssetType(meta);
    if (!['3d', 'surface', 'decal'].includes(sourceType)) throw Object.assign(new Error(`源元数据类型 ${sourceType} 不属于本次选择`), { code: 'FAB_EXCLUDED', nativeId: id, assetType: sourceType });
    if (knownIds?.has(id)) return { meta, files: [] };
    const plan = [];
    const add = (zip, entry) => { const file = { file: path.posix.basename(entry.name), bytes: entry.bytes, zip, entry }; plan.push(file); return file.file; };
    const rawNormal = modelZip ? rawNormalMap(meta, modelZip) : null;
    if (normalOnly) {
      if (!rawNormal) throw Object.assign(new Error('仅 3D Raw 资产支持法线补换'), { code: 'FAB_UNSUPPORTED' });
      add(modelZip, rawNormal.entry);
      return { meta, files: plan, normal: rawNormal.map, rawPackage: raw.name };
    }
    const maps = [];
    const tier = /_high\.zip$/i.test(texture.name) ? 1 : /_mid\.zip$/i.test(texture.name) ? 2 : /_low\.zip$/i.test(texture.name) ? 3 : undefined;
    for (const entry of textureZip.entries.filter(entry => /\.(png|jpe?g)$/i.test(entry.name))) {
      if (rawNormal && /_(?:normal|normalbump|normalmap|nrm|nor)\.(?:png|jpe?g)$/i.test(entry.name)) continue;
      const map = packageTextureMap(meta, entry, tier);
      if (map) { add(textureZip, entry); maps.push(map); }
    }
    if (rawNormal) { add(modelZip, rawNormal.entry); maps.push(rawNormal.map); }
    if (!maps.length) throw Object.assign(new Error('Fab 包内没有符合规格的贴图'), { code: 'FAB_UNSUPPORTED' });
    meta.maps = maps;
    if (rawNormal) meta.fabNormalSource = 'raw';
    if (modelZip) {
      const models = modelZip.entries.filter(entry => isRawModelFile(entry.name, id));
      if (!models.length || !/_raw\.zip$/i.test(raw.name)) throw Object.assign(new Error('Fab Raw 包内缺少最高精度 FBX'), { code: 'FAB_UNSUPPORTED' });
      meta.models = models.map(entry => ({ type: 'original', mimeType: 'application/x-fbx', lod: -1, uri: add(modelZip, entry), contentLength: entry.bytes }));
      delete meta.meshes;
    }
    const preview = detail.medias?.find(media => media.type === 'image');
    if (!preview?.mediaUrl) throw new Error('Fab 缺少源站展示预览');
    const uri = `${id}_Grid${path.extname(new globalThis.URL(preview.mediaUrl).pathname) || '.jpg'}`;
    const url = trustedFabUrl(preview.mediaUrl);
    const head = await this.fetch(url, { method: 'HEAD', redirect: 'error', signal: globalThis.AbortSignal.timeout(60000) });
    const bytes = Number(head.headers.get('content-length'));
    if (!head.ok || !Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('Fab 源预览大小无效');
    plan.push({ file: uri, bytes, url });
    meta.previews = { images: [{ uri, contentLength: bytes, tags: ['grid'], resolution: '1920x1080' }], relativeSize: meta.previews?.relativeSize };
    meta.fab = { listingId: listing.uid, url: `https://www.fab.com/listings/${listing.uid}`, license: 'professional', price: 0 };
    if (!resolveMegascansName(meta)) meta.name = detail.title;
    const names = plan.map(file => file.file.toLowerCase());
    if (new Set(names).size !== names.length) throw new Error('Fab 选中文件在 Windows 上重名');
    return { meta, files: plan };
  }
}

async function downloadFabFile(file, root, options) {
  if (file.zip) return downloadZipEntry(file, root, options);
  return downloadFile(file, root, { ...options, validateUrl: trustedFabUrl });
}

module.exports = { FabMegascans, existingIds, sourceIdFromName, freePrice, downloadFabFile, readBridgeMetadata, packageTextureMap, rawNormalMap, transientFabConnection, applyListingExclusions, isRawModelFile };
