import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AssetThumbnail } from "./AssetThumbnail";
import { getPreviewUrl } from "./previewUrl";
import type { PreviewLoader } from "./previewLoader";

export function ImportPreviewThumbnail({ sourcePath, loader, fallback }: {
  sourcePath: string;
  loader: PreviewLoader;
  fallback: ReactNode;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: target.closest(".import-asset-list"),
      rootMargin: "72px"
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  // A tiny queue thumbnail must not decode every full-size source or cutout.
  // Leaving the viewport also releases the image/video and its subscription.
  return <span ref={element} className="import-asset-thumb" aria-hidden="true">
    {visible && sourcePath ? <AssetThumbnail key={sourcePath}
      sourcePath={sourcePath} loader={loader} toUrl={getPreviewUrl}
      name="" cover={false} fallback={fallback}
    /> : fallback}
  </span>;
}
