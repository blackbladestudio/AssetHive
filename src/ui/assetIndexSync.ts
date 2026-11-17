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
  let completion: { revision: number; ids: Set<string>; favorites: Set<string> } | null = null;

  function requestRefresh(delay = 0) {
    if (disposed || timer) return;
    if (inFlight) { refreshPending = true; return; }
    timer = schedule(() => { timer = 0; void refresh().catch(() => {}); }, delay);
  }

  async function refresh() {
    if (inFlight) return inFlight;
    const currentRequest = ++request;
    const currentRevision = revision;
    const reading = (async () => {
      const assets = await readIndex();
      if (disposed || currentRequest !== request || !Array.isArray(assets)) return;
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
    try { await reading; }
    finally {
      if (inFlight === reading) {
        inFlight = null;
        if (refreshPending) { refreshPending = false; requestRefresh(); }
      }
    }
  }

  function onChange(payload?: AssetIndexChange) {
    if (disposed) return;
    revision++;
    if (payload?.reset) {
      request++; inFlight = null; refreshPending = false; completion = null;
      update([]);
    }
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
    dispose() { disposed = true; request++; if (timer) cancel(timer); timer = 0; }
  };
}
