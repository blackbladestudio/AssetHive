const listeners = new Set<() => void>();
let windowForeground: boolean | undefined;
let unsubscribeWindow: (() => void) | undefined;

export function isWindowForeground() {
  return (windowForeground ?? !window.arkhive?.onWindowForegroundChange) && document.visibilityState === "visible";
}

function notify() {
  listeners.forEach(listener => listener());
}

export function subscribeToWindowForeground(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", notify);
    unsubscribeWindow = window.arkhive?.onWindowForegroundChange?.(foreground => {
      if (foreground === windowForeground) return;
      windowForeground = foreground;
      notify();
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    document.removeEventListener("visibilitychange", notify);
    unsubscribeWindow?.();
    unsubscribeWindow = undefined;
    windowForeground = undefined;
  };
}

const BACKGROUND_STATUS_INTERVAL_MS = 30_000;

export function pollWindowStatus(refresh: () => Promise<void>, foregroundInterval: number) {
  let foreground = isWindowForeground();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let lastStartedAt = Date.now();
  let refreshOnFocus = false;
  let disposed = false;

  const schedule = () => {
    clearTimeout(timer);
    if (disposed || running) return;
    const interval = foreground ? foregroundInterval : BACKGROUND_STATUS_INTERVAL_MS;
    const elapsed = Math.max(0, Date.now() - lastStartedAt);
    timer = setTimeout(run, interval - elapsed % interval);
  };
  const run = async () => {
    clearTimeout(timer);
    running = true;
    lastStartedAt = Date.now();
    refreshOnFocus = false;
    try { await refresh(); }
    catch { /* The next status poll retries. */ }
    finally {
      running = false;
      if (!disposed && refreshOnFocus && foreground) void run();
      else schedule();
    }
  };

  const unsubscribe = subscribeToWindowForeground(() => {
    const active = isWindowForeground();
    if (active === foreground) return;
    foreground = active;
    if (foreground && !running) void run();
    else {
      refreshOnFocus = foreground;
      schedule();
    }
  });
  if (!running) {
    if (foreground) void run();
    else schedule();
  }
  return () => {
    disposed = true;
    unsubscribe();
    clearTimeout(timer);
  };
}
