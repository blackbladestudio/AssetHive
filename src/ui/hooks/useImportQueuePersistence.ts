import { useCallback, useEffect, useRef, useState } from "react";
import type { ImportQueueSnapshot } from "../../types";

export function useImportQueuePersistence(
  libraryPath: string,
  enabled: boolean,
  snapshot: ImportQueueSnapshot,
  restore: (saved: ImportQueueSnapshot) => void,
  onError: (message: string) => void
) {
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const callbacks = useRef({ restore, onError });
  callbacks.current = { restore, onError };
  const [loadedLibrary, setLoadedLibrary] = useState("");
  const loaded = useRef("");
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!enabled || !libraryPath || !window.arkhive.loadImportQueue) return;
    let active = true;
    void window.arkhive.loadImportQueue(libraryPath).then(saved => {
      if (!active) return;
      callbacks.current.restore(saved);
      loaded.current = libraryPath;
      setLoadedLibrary(libraryPath);
    }).catch(error => { if (active) callbacks.current.onError(String(error)); });
    return () => {
      active = false;
      if (loaded.current === libraryPath) {
        void window.arkhive.saveImportQueue?.({ ...latest.current, libraryPath }).catch(error => callbacks.current.onError(String(error)));
      }
    };
  }, [enabled, libraryPath]);
  const flush = useCallback(async (override?: ImportQueueSnapshot) => {
    if (writeTimer.current) clearTimeout(writeTimer.current);
    writeTimer.current = null;
    if (!enabled || loadedLibrary !== libraryPath || !window.arkhive.saveImportQueue) return;
    await window.arkhive.saveImportQueue({ ...(override || latest.current), libraryPath });
  }, [enabled, libraryPath, loadedLibrary]);
  useEffect(() => {
    if (!enabled || loadedLibrary !== libraryPath) return;
    writeTimer.current = setTimeout(() => {
      void flush().catch(error => callbacks.current.onError(String(error)));
    }, 250);
    return () => { if (writeTimer.current) clearTimeout(writeTimer.current); };
  }, [enabled, loadedLibrary, libraryPath, snapshot, flush]);
  return { ready: !enabled || !window.arkhive.loadImportQueue || loadedLibrary === libraryPath, flush };
}
