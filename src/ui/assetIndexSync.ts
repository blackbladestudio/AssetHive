import type { AssetRecord } from "../types";

export type AssetIndexChange = {
  incremental?: boolean;
  complete?: boolean;
  reset?: boolean;
  count?: number;
  records?: AssetRecord[];
  ids?: string[];
  favoriteIds?: string[];
};

// Full IPC replies can arrive after newer streamed records. Never let an older
// reply replace those records, and recover a base snapshot if events were missed.
export function createAssetIndexSync({ readIndex, update, schedule, cancel }: {
  readIndex: () => Promise<AssetRecord[]>;
  update: (value: AssetRecord[] | ((previous: AssetRecord[]) => AssetRecord[])) => void;
  schedule: (callback: () => void, delay: number) => number;
  cancel: (timer: number) => void;
}) {
  let revision = 0;
  let request = 0;
  let timer = 0;
  let disposed = false;
  let inFlight: Promise<void> | null = null;
  let refreshPending = false;
  let deferred = false;
  let needsSnapshot = false;
  let deferredReset = false;
  let changesDuringSnapshot: Array<AssetIndexChange | undefined> | null = null;
  let completion: { revision: number; ids: Set<string>; favorites: Set<string> } | null = null;

  function requestRefresh(delay = 0) {
    if (disposed || timer) return;
    if (deferred || inFlight) { refreshPending = true; return; }
    timer = schedule(() => { timer = 0; void refresh().catch(() => {}); }, delay);
  }

  async function refresh() {
    if (deferred) { needsSnapshot = true; return; }
    if (inFlight) return inFlight;
    const changes: Array<AssetIndexChange | undefined> | null = needsSnapshot ? [] : null;
    changesDuringSnapshot = changes;
    needsSnapshot = false;
    const currentRequest = ++request;
    const currentRevision = revision;
    const reading = (async () => {
      const assets = await readIndex();
      if (disposed || currentRequest !== request || !Array.isArray(assets)) return;
      if (changes) {
        // Start with the authoritative snapshot so stale cards from before the
        // window went into the background cannot reappear after a deletion.
        update(assets);
        return;
      }
      if (currentRevision === revision) { update(assets); return; }
      // Seed the missing base immediately, even if a scan keeps streaming.
      // Newer rendered records win; a later completion still confirms removals.
      const confirmed = completion && completion.revision > currentRevision ? completion : null;
      update(previous => {
        const byId = new Map(assets.filter(asset => !confirmed || confirmed.ids.has(asset.id))
          .map(asset => [asset.id, { ...asset, ...(confirmed ? { favorite: confirmed.favorites.has(asset.id) } : {}) }]));
        for (const asset of previous) byId.set(asset.id, { ...byId.get(asset.id), ...asset });
        return [...byId.values()];
      });
    })();
    inFlight = reading;
    let retrySnapshot = false;
    try { await reading; }
    catch (error) {
      if (changes && currentRequest === request) needsSnapshot = retrySnapshot = true;
      throw error;
    }
    finally {
      if (inFlight === reading) {
        if (changes && changesDuringSnapshot === changes) {
          changesDuringSnapshot = null;
          // Replay deltas in order after seeding the base. Keeping the read in
          // flight here also combines any refresh requests raised by replay.
          for (const change of changes) onChange(change);
        }
        inFlight = null;
        if (refreshPending && !deferred) { refreshPending = false; requestRefresh(); }
        else if (retrySnapshot && !deferred) requestRefresh(4000);
      }
    }
  }

  function onChange(payload?: AssetIndexChange) {
    if (disposed) return;
    revision++;
    if (payload?.reset) {
      request++; inFlight = null; refreshPending = false; completion = null;
      changesDuringSnapshot = null;
      if (deferred) deferredReset = true;
      else update([]);
    }
    if (deferred) { needsSnapshot = true; return; }
    if (changesDuringSnapshot) { changesDuringSnapshot.push(payload); return; }
    const records = (payload?.records || []).filter(record => record?.id);
    const complete = payload?.complete && Array.isArray(payload.ids);
    if (complete || (payload?.incremental && records.length > 0)) {
      const ids = complete ? new Set(payload!.ids) : null;
      const favorites = new Set(payload?.favoriteIds || []);
      if (ids) completion = { revision, ids, favorites };
      update(previous => {
        const byId = new Map(previous.filter(asset => !ids || ids.has(asset.id)).map(asset => [asset.id, asset]));
        for (const record of records) {
          if (!ids || ids.has(record.id)) byId.set(record.id, { ...byId.get(record.id), ...record });
        }
        if (complete) {
          for (const [id, asset] of byId) {
            if (Boolean(asset.favorite) !== favorites.has(id)) byId.set(id, { ...asset, favorite: favorites.has(id) });
          }
        }
        // A completion's ID list cannot restore records lost before subscription
        // or during a delayed full read. Fetch the seeded main-process snapshot.
        const expected = ids?.size ?? payload?.count ?? 0;
        if (byId.size < expected) requestRefresh();
        return [...byId.values()];
      });
    } else {
      requestRefresh(payload?.reset ? 0 : payload?.incremental ? 300 : 0);
    }
  }

  return {
    onChange, refresh,
    setDeferred(value: boolean) {
      if (disposed || value === deferred) return;
      deferred = value;
      if (deferred) {
        needsSnapshot ||= Boolean(timer || inFlight || refreshPending);
        if (timer) cancel(timer);
        timer = 0;
        refreshPending = false;
        if (inFlight) request++;
        changesDuringSnapshot = null;
      } else {
        if (deferredReset) { deferredReset = false; update([]); }
        if (needsSnapshot) requestRefresh();
      }
    },
    dispose() { disposed = true; request++; changesDuringSnapshot = null; if (timer) cancel(timer); timer = 0; }
  };
}
