import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { PreviewLoader } from "./previewLoader";

// Key this component by sourcePath so an edited/replaced preview starts cleanly.
export function AssetThumbnail({ sourcePath, loader, toUrl, name, cover, fallback }: {
  sourcePath: string;
  loader: PreviewLoader;
  toUrl: (path: string) => string;
  name: string;
  cover: boolean;
  fallback: ReactNode;
}) {
  const subscribe = useCallback((listener: () => void) => loader.subscribe(sourcePath, listener), [loader, sourcePath]);
  const getSnapshot = useCallback(() => loader.get(sourcePath), [loader, sourcePath]);
  const thumbnail = useSyncExternalStore(subscribe, getSnapshot);
  const [failedSource, setFailedSource] = useState("");
  const [loadedSource, setLoadedSource] = useState("");
  const [originalFailed, setOriginalFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const path = thumbnail && thumbnail !== failedSource ? thumbnail : thumbnail ? sourcePath : "";
  const src = path ? toUrl(path) : "";
  const loaded = Boolean(src && loadedSource === src);

  useLayoutEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) setLoadedSource(src);
  }, [src]);

  if (!sourcePath || originalFailed) return <>{fallback}</>;
  const isMotionPreview = /\.(webm|mp4)$/i.test(path || sourcePath);
  return <>
    {!loaded && <div className="card-thumb-shimmer" />}
    {src && isMotionPreview && <video
      key={src}
      className={loaded ? "loaded" : ""}
      src={src}
      autoPlay
      loop
      muted
      playsInline
      disablePictureInPicture
      style={cover ? { objectFit: "cover" } : undefined}
      onLoadedData={() => setLoadedSource(src)}
      onError={() => {
        if (path !== sourcePath) setFailedSource(path);
        else setOriginalFailed(true);
      }}
    />}
    {src && !isMotionPreview && <img
      key={src}
      ref={imageRef}
      className={loaded ? "loaded" : ""}
      src={src}
      alt={name}
      loading="eager"
      decoding="async"
      style={cover ? { objectFit: "cover" } : undefined}
      onLoad={() => setLoadedSource(src)}
      onError={() => {
        // A corrupt/missing cached thumbnail must not hide a valid original.
        if (path !== sourcePath) setFailedSource(path);
        else setOriginalFailed(true);
      }}
    />}
  </>;
}
