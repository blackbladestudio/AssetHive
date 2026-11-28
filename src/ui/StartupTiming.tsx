import { useEffect } from "react";

export function StartupTiming() {
  useEffect(() => {
    // The startup view can occlude this renderer. Report the committed UI
    // without waiting for a frame callback that may be suppressed while covered.
    window.arkhive?.reportStartupMilestone?.("ui-mounted");
  }, []);
  return null;
}
