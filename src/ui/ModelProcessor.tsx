import { useEffect } from "react";
export type { ModelBounds, ModelAnalysis } from "./modelAnalysis";

export function ModelProcessor() {
  useEffect(() => {
    if (!window.arkhive?.onCalculateBoundsRequest || !window.arkhive?.respondBounds) return;
    const respondBounds = window.arkhive.respondBounds;

    const cleanup = window.arkhive.onCalculateBoundsRequest(async (payload) => {
      const { requestId, filePath } = payload;
      console.log("[ModelProcessor] Calculating bounds for:", filePath);

      try {
        const { analyzeModel } = await import("./modelAnalysis");
        const analysis = await analyzeModel(filePath);
        console.log("[ModelProcessor] Analysis:", analysis);
        await respondBounds({ requestId, ...analysis });
      } catch (error) {
        console.error("[ModelProcessor] Failed:", error);
        await respondBounds({ requestId, bounds: null, collision: null, triangleCount: null });
      }
    });

    return cleanup;
  }, []);

  return null;
}
