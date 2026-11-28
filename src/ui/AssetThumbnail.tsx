import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { PreviewLoader } from "./previewLoader";
import { AnimationPreviewVideo } from "./AnimationPreviewVideo";

// Key this component by sourcePath so an edited/replaced preview starts cleanly.
export function AssetThumbnail({ sourcePath, originalPath = sourcePath, loader, toUrl, name, cover, fallback, onOriginalError }: {
  sourcePath: string;
  originalPath?: string;
  loader: PreviewLoader;
  toUrl: (path: string) => string;
  name: string;
  cover: boolean;
  fallback: ReactNode;
  onOriginalError?: () => void;
}) {
  const subscribe = useCallback((listener: () => void) => loader.subscribe(sourcePath, listener), [loader, sourcePath]);
  const getSnapshot = useCallback(() => loader.get(sourcePath), [loader, sourcePath]);
  const thumbnail = useSyncExternalStore(subscribe, getSnapshot);
  const [failedSource, setFailedSource] = useState("");
  const [loadedSource, setLoadedSource] = useState("");
  const [originalFailed, setOriginalFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const path = thumbnail && thumbnail !== failedSource && thumbnail !== sourcePath ? thumbnail : thumbnail ? originalPath : "";
  const src = path ? toUrl(path) : "";
  const loaded = Boolean(src && loadedSource === src);
  const handleError = () => {
    if (path !== originalPath) setFailedSource(path);
    else {
      setOriginalFailed(true);
      onOriginalError?.();
    }
  };

  useLayoutEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) setLoadedSource(src);
  }, [src]);

  if (!sourcePath || (originalFailed && path === originalPath) || (thumbnail && !path)) return <>{fallback}</>;
  const isMotionPreview = /\.(webm|mp4)$/i.test(path);
  return <>
    {!loaded && <span className="card-thumb-shimmer" />}
    {src && isMotionPreview && <AnimationPreviewVideo
      key={src}
      className={loaded ? "loaded" : ""}
      src={src}
      disablePictureInPicture
      style={cover ? { objectFit: "cover" } : undefined}
      onLoadedData={() => setLoadedSource(src)}
      onError={handleError}
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
      onError={handleError}
    />}
  </>;
}
