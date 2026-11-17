const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { writeFileAtomic } = require("./atomicFile");

const token = value => createHash("sha256").update(String(value).replaceAll("\\", "/").toLowerCase()).digest("hex");
const read = async file => {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
};

function createImportQueueStore(directory) {
  const pending = new Map();
  const snapshots = new Map();
  const completedCache = new Map();
  const deletedDrafts = new Set();
  let writes = Promise.resolve();
  const file = library => path.join(directory, `${token(library)}.json`);
  const receipt = (library, id) => path.join(directory, "receipts", token(library), `${token(id)}.json`);
  const write = async (target, value) => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await writeFileAtomic(target, JSON.stringify(value));
  };
  async function completed(library, id) {
    if (!id) return null;
    const cacheKey = `${token(library)}:${id}`;
    if (completedCache.has(cacheKey)) return completedCache.get(cacheKey);
    const record = await read(receipt(library, id));
    if (record?.result?.ok) { completedCache.set(cacheKey, record.result); return record.result; }
    if (record?.proofPath) {
      const proof = await read(record.proofPath);
      if (proof?.importQueueId === id) {
        const result = { ok: true, assetId: record.assetId, assetPath: record.assetPath, metaPath: record.proofPath, recovered: true, message: "已恢复完成的导入记录" };
        await write(receipt(library, id), { ...record, result });
        completedCache.set(cacheKey, result);
        return result;
      }
    }
    completedCache.set(cacheKey, null);
    return null;
  }
  async function trim(library, snapshot) {
    const drafts = [];
    const seen = new Set();
    const selected = new Set((snapshot?.selectedIndexes || []).map(i => snapshot.drafts?.[i]?.form?.queueId));
    const activeId = snapshot?.drafts?.[snapshot.activeIndex || 0]?.form?.queueId;
    for (const draft of snapshot?.drafts || []) {
      const id = draft?.form?.queueId;
      if (!id || typeof id !== "string" || seen.has(id)) continue;
      if (deletedDrafts.has(`${token(library)}:${id}`)) continue;
      seen.add(id);
      if (await completed(library, id)) continue;
      drafts.push(draft);
    }
    return { version: 1, libraryPath: library, savedAt: new Date().toISOString(), drafts,
      activeIndex: Math.max(0, drafts.findIndex(draft => draft.form.queueId === activeId)),
      selectedIndexes: drafts.flatMap((draft, i) => selected.has(draft.form.queueId) ? [i] : []) };
  }
  return {
    discardCharacter(library, scope) {
      const job = writes.catch(() => {}).then(async () => {
        const { matchesCharacterDraft } = require('./characterCacheCleanup');
        const snapshot = await read(file(library));
        const removed = new Set(scope.queueId ? [scope.queueId] : []);
        for (const draft of snapshot?.drafts || []) if (matchesCharacterDraft(draft, scope)) removed.add(draft.form.queueId);
        const receiptDir = path.dirname(receipt(library, ''));
        for (const name of await fs.readdir(receiptDir).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
          if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
          const record = await read(path.join(receiptDir, name));
          if (record?.assetId === scope.assetId || record?.result?.assetId === scope.assetId || [...removed].some(id => token(id) + '.json' === name)) await fs.unlink(path.join(receiptDir, name));
        }
        for (const [id, result] of completedCache) if (id.startsWith(token(library) + ':') && result?.assetId === scope.assetId) {
          removed.add(id.slice(token(library).length + 1)); completedCache.delete(id);
        }
        for (const id of removed) { const cacheKey = `${token(library)}:${id}`; deletedDrafts.add(cacheKey); completedCache.delete(cacheKey); }
        const result = await trim(library, snapshot);
        await write(file(library), result);
        snapshots.set(token(library), result);
        return [...removed];
      });
      writes = job;
      return job;
    },
    async load(library) {
      await writes.catch(() => {});
      const snapshot = await read(file(library));
      if (snapshot && (snapshot.version !== 1 || !Array.isArray(snapshot.drafts))) throw new Error("导入队列格式无效，已保留原文件");
      const result = await trim(library, snapshot);
      snapshots.set(token(library), result);
      return result;
    },
    save(library, snapshot) {
      const job = writes.catch(() => {}).then(async () => {
        if (!Array.isArray(snapshot?.drafts)) throw new Error("导入队列格式无效");
        const result = await trim(library, snapshot);
        await write(file(library), result);
        snapshots.set(token(library), result);
        return result;
      });
      writes = job;
      return job;
    },
    async reserve(library, id, reservation) {
      if (!id) return reservation;
      const previous = await read(receipt(library, id));
      if (previous && (!previous.assetType || previous.assetType === reservation.assetType)
        && (!previous.destinationRoot || previous.destinationRoot === reservation.destinationRoot)) return previous;
      await write(receipt(library, id), reservation);
      return reservation;
    },
    async run(library, id, callback) {
      if (!id) return callback();
      const key = `${token(library)}:${id}`;
      if (deletedDrafts.has(key)) throw new Error('该资产及旧导入草稿已删除，请重新选择文件夹');
      if (pending.has(key)) return pending.get(key);
      const job = (async () => {
        const recovered = await completed(library, id);
        if (recovered) return { ...recovered, recovered: true };
        const result = await callback();
        if (result?.ok) {
          completedCache.set(key, result);
          try { await write(receipt(library, id), { result }); }
          catch (error) {
            return { ...result, warnings: [...(result.warnings || []), `资产已保存，队列完成记录写入失败：${error.message}`] };
          }
        }
        return result;
      })();
      pending.set(key, job);
      try { return await job; }
      finally { pending.delete(key); }
    },
    protects(sourcePath) {
      const target = String(sourcePath).replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "");
      const contains = value => typeof value === "string" ? (() => {
        const candidate = value.replaceAll("\\", "/").toLowerCase();
        return candidate === target || candidate.startsWith(`${target}/`);
      })() : Array.isArray(value) ? value.some(contains) : value && typeof value === "object" ? Object.values(value).some(contains) : false;
      return [...snapshots.values()].some(snapshot => contains(snapshot.drafts.filter(draft => !completedCache.get(`${token(snapshot.libraryPath)}:${draft.form.queueId}`))));
    }
  };
}

module.exports = { createImportQueueStore };
