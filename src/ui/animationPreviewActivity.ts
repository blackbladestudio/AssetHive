const listeners = new Set<() => void>();
let windowForeground: boolean | undefined;
let unsubscribeWindow: (() => void) | undefined;

export function isAnimationPreviewActive() {
  return (windowForeground ?? !window.arkhive?.onWindowForegroundChange) && document.visibilityState === "visible";
}

function notify() {
  listeners.forEach(listener => listener());
}

export function subscribeToAnimationPreviewActivity(listener: () => void) {
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
