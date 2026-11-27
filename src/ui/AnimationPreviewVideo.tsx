import { useLayoutEffect, useRef, type ComponentPropsWithoutRef } from "react";
import { isAnimationPreviewActive, subscribeToAnimationPreviewActivity } from "./animationPreviewActivity";

export function AnimationPreviewVideo({ src, ...props }: ComponentPropsWithoutRef<"video">) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    const syncPlayback = () => {
      if (isAnimationPreviewActive()) void video.play().catch(() => {});
      else video.pause();
    };
    const unsubscribe = subscribeToAnimationPreviewActivity(syncPlayback);
    syncPlayback();
    return unsubscribe;
  }, [src]);

  return <video ref={videoRef} src={src} preload="metadata" loop muted playsInline {...props} />;
}
