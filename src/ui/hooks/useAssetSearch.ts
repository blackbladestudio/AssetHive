import { useEffect, useRef, useState } from "react";
import type { AssetRecord } from "../../types";
import { createSearchDocument, sameSearchFields } from "../assetSearchDocument";

export function useAssetSearch(assets: AssetRecord[], text: string, tags: string[]) {
  const worker = useRef<Worker | null>(null);
  // Reuse the card objects already owned by assets. A serialized signature for
  // every card duplicated all names/tags for as long as search stayed open.
  const documents = useRef(new Map<string, AssetRecord>());
  const sequence = useRef(0);
  const queryKey = useRef("");
  const minimumRequest = useRef(0);
  const lastAppliedRequest = useRef(0);
  const pendingQuery = useRef<{ requestId: number; text: string; tags: string[] } | null>(null);
  const queryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [result, setResult] = useState<{ ids: Set<string> | null; busy: boolean; error: string }>({ ids: null, busy: false, error: "" });
  const hasQuery = Boolean(text.trim() || tags.length);
  useEffect(() => {
    if (!hasQuery) return;
    let instance: Worker;
    try {
      instance = new Worker(new URL("../assetSearchWorker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      setResult(previous => ({ ...previous, busy: false, error: String(error) }));
      return;
    }
    worker.current = instance;
    instance.onmessage = event => {
      const requestId = event.data.requestId;
      if (requestId !== undefined && (requestId < minimumRequest.current || requestId < lastAppliedRequest.current)) return;
      if (event.data.error) { setResult(previous => ({ ...previous, busy: false, error: event.data.error })); return; }
      if (requestId === undefined) return;
      lastAppliedRequest.current = requestId;
      setResult({ ids: new Set(event.data.ids || []), busy: requestId < sequence.current, error: "" });
    };
    instance.onerror = event => {
      instance.terminate();
      worker.current = null;
      documents.current.clear();
      setResult(previous => ({ ...previous, busy: false, error: event.message || "Search worker failed" }));
    };
    return () => {
      instance.terminate(); worker.current = null; documents.current.clear();
      if (queryTimer.current) clearTimeout(queryTimer.current);
      queryTimer.current = null;
    };
  }, [hasQuery]);
  useEffect(() => {
    if (!worker.current) return;
    const next = new Map<string, AssetRecord>();
    const upserts = [];
    for (const asset of assets) {
      const previous = documents.current.get(asset.id);
      next.set(asset.id, asset);
      if (previous === asset) continue;
      const document = createSearchDocument(asset);
      const prior = previous && createSearchDocument(previous);
      if (!prior || !sameSearchFields(prior.fields, document.fields)
        || !sameSearchFields(prior.identifiers || [], document.identifiers || [])) upserts.push(document);
    }
    const removed = [...documents.current.keys()].filter(id => !next.has(id));
    if (upserts.length || removed.length) worker.current?.postMessage({ upserts, removed });
    documents.current = next;
  }, [assets, hasQuery]);
  useEffect(() => {
    const requestId = ++sequence.current;
    const key = JSON.stringify([text, tags]);
    // Index updates may continue for minutes. They must not invalidate every
    // response for the same query; only a changed query makes results obsolete.
    if (queryKey.current !== key) { queryKey.current = key; minimumRequest.current = requestId; }
    if (!hasQuery) {
      if (queryTimer.current) clearTimeout(queryTimer.current);
      queryTimer.current = null; pendingQuery.current = null;
      setResult({ ids: null, busy: false, error: "" }); return;
    }
    if (!worker.current) {
      setResult(previous => ({ ...previous, busy: false, error: previous.error || "搜索线程未就绪，请重新加载应用 / Search worker unavailable; reload the app" }));
      return;
    }
    setResult(previous => ({ ...previous, busy: true, error: "" }));
    pendingQuery.current = { requestId, text, tags };
    // Throttle the latest request instead of postponing it on every scan batch.
    if (!queryTimer.current) queryTimer.current = setTimeout(() => {
      queryTimer.current = null;
      if (pendingQuery.current) worker.current?.postMessage(pendingQuery.current);
    }, 100);
  }, [assets, text, tags, hasQuery]);
  return { ...result, ids: hasQuery ? result.ids : null };
}
