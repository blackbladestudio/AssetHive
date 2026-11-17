import { useEffect } from "react";

export function StartupTiming() {
  useEffect(() => {
    // Report after a committed UI has had a frame to paint, independently of
    // background indexing, scans and the content of the selected library.
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => window.arkhive?.reportStartupMilestone?.("ui-mounted"));
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return null;
}
