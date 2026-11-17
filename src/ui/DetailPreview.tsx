import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

// Remount by preview path: events from the previous image cannot change the
// replacement's state, and no post-load effect resets a cached image to hidden.
export function DetailPreview({ src, name, fallback }: { src: string; name: string; fallback: ReactNode }) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [status, setStatus] = useState<"loading" | "loaded" | "failed">("loading");
  const [fitScaled, setFitScaled] = useState(false);

  function loaded(image: HTMLImageElement) {
    const ratio = image.naturalWidth / image.naturalHeight;
    setFitScaled(!(ratio > 1.7 && ratio < 1.85));
    setStatus("loaded");
  }

  useLayoutEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) loaded(image);
  }, []);

  if (!src || status === "failed") return <>{fallback}</>;
  return <>
    {status === "loading" && <div className="preview-shimmer" />}
    <img ref={imageRef} src={src} alt={name}
      className={`preview-img ${status === "loaded" ? "loaded" : ""} ${fitScaled ? "fit-scaled" : ""}`}
      onLoad={event => loaded(event.currentTarget)}
      onError={() => setStatus("failed")}
    />
  </>;
}
