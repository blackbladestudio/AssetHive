import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

// Zoom is bounded: no smaller than "fit to screen" (fitScale) and no larger
// than fitScale * MAX_ZOOM_FACTOR (with an absolute floor for small images).
const MAX_ZOOM_FACTOR = 8;
const MAX_ZOOM_FLOOR = 4;

// Initial "fit" leaves a breathing margin instead of filling the window edge-to-edge.
const FIT_PADDING = 160;

function computeFitScale(stageW: number, stageH: number, imageW: number, imageH: number) {
  const availW = Math.max(1, stageW - FIT_PADDING * 2);
  const availH = Math.max(1, stageH - FIT_PADDING * 2);
  return Math.min(availW / imageW, availH / imageH, 1);
}

type ViewState = {
  scale: number;
  offsetX: number;
  offsetY: number;
  fitScale: number;
};

export function ImagePreviewModal({
  src,
  name,
  lang,
  onClose,
  onPrevious,
  onNext
}: {
  src: string;
  name: string;
  lang?: string;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [status, setStatus] = useState<"loading" | "loaded" | "failed">("loading");

  const viewRef = useRef<ViewState>({ scale: 1, offsetX: 0, offsetY: 0, fitScale: 1 });
  const dragRef = useRef<{ startX: number; startY: number; startOffsetX: number; startOffsetY: number } | null>(null);

  const isEn = lang === "en";

  const applyView = useCallback(() => {
    const image = imageRef.current;
    if (!image) return;
    const view = viewRef.current;
    image.style.transform = `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.scale})`;
  }, []);

  const clampScale = useCallback((value: number) => {
    const view = viewRef.current;
    const maxScale = Math.max(view.fitScale * MAX_ZOOM_FACTOR, MAX_ZOOM_FLOOR);
    return Math.max(view.fitScale, Math.min(maxScale, value));
  }, []);

  // Keep the image filling the viewport: when a dimension is smaller than the
  // stage it is re-centered; when larger it can only be panned up to its edges.
  const clampOffset = useCallback((offsetX: number, offsetY: number, scale: number) => {
    const stage = stageRef.current;
    const image = imageRef.current;
    const stageW = stage?.clientWidth || 1;
    const stageH = stage?.clientHeight || 1;
    const imageW = image?.naturalWidth || 1;
    const imageH = image?.naturalHeight || 1;
    const displayW = imageW * scale;
    const displayH = imageH * scale;

    let nextX = offsetX;
    let nextY = offsetY;

    if (displayW <= stageW) {
      nextX = (stageW - displayW) / 2;
    } else {
      nextX = Math.min(0, Math.max(stageW - displayW, nextX));
    }

    if (displayH <= stageH) {
      nextY = (stageH - displayH) / 2;
    } else {
      nextY = Math.min(0, Math.max(stageH - displayH, nextY));
    }

    return { x: nextX, y: nextY };
  }, []);

  const fit = useCallback(() => {
    const stage = stageRef.current;
    const image = imageRef.current;
    if (!stage || !image) return;
    const stageW = stage.clientWidth;
    const stageH = stage.clientHeight;
    const imageW = image.naturalWidth || 1;
    const imageH = image.naturalHeight || 1;
    const fitScale = computeFitScale(stageW, stageH, imageW, imageH);
    viewRef.current = {
      scale: fitScale,
      offsetX: (stageW - imageW * fitScale) / 2,
      offsetY: (stageH - imageH * fitScale) / 2,
      fitScale
    };
    applyView();
  }, [applyView]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && onPrevious) { event.preventDefault(); onPrevious(); }
      if (event.key === "ArrowRight" && onNext) { event.preventDefault(); onNext(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, onPrevious, onNext]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      const view = viewRef.current;
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      const nextScale = clampScale(view.scale * factor);
      const imageX = (cursorX - view.offsetX) / view.scale;
      const imageY = (cursorY - view.offsetY) / view.scale;
      const clamped = clampOffset(
        cursorX - imageX * nextScale,
        cursorY - imageY * nextScale,
        nextScale
      );
      viewRef.current = { ...view, scale: nextScale, offsetX: clamped.x, offsetY: clamped.y };
      applyView();
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [applyView, clampScale, clampOffset]);

  useEffect(() => {
    const onResize = () => {
      const stage = stageRef.current;
      const image = imageRef.current;
      if (!stage || !image) return;
      const stageW = stage.clientWidth;
      const stageH = stage.clientHeight;
      const imageW = image.naturalWidth || 1;
      const imageH = image.naturalHeight || 1;
      const fitScale = computeFitScale(stageW, stageH, imageW, imageH);
      const view = viewRef.current;
      viewRef.current = { ...view, fitScale };
      const nextScale = clampScale(view.scale);
      const clamped = clampOffset(view.offsetX, view.offsetY, nextScale);
      viewRef.current = { scale: nextScale, offsetX: clamped.x, offsetY: clamped.y, fitScale };
      applyView();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [applyView, clampScale, clampOffset]);

  const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const view = viewRef.current;
    dragRef.current = { startX: event.clientX, startY: event.clientY, startOffsetX: view.offsetX, startOffsetY: view.offsetY };
  };

  const handleMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const view = viewRef.current;
    const clamped = clampOffset(
      drag.startOffsetX + (event.clientX - drag.startX),
      drag.startOffsetY + (event.clientY - drag.startY),
      view.scale
    );
    viewRef.current = { ...view, offsetX: clamped.x, offsetY: clamped.y };
    applyView();
  };

  const handleMouseUp = () => {
    dragRef.current = null;
  };

  return (
    <div className="image-preview-overlay" role="dialog" aria-modal="true">
      <div
        className="image-preview-stage"
        ref={stageRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={fit}
      >
        {status === "loading" && <div className="image-preview-loading" />}
        {status === "failed" ? (
          <div className="image-preview-failed">{isEn ? "Failed to load image" : "图片加载失败"}</div>
        ) : (
          <img
            ref={imageRef}
            className={`image-preview-image ${status === "loaded" ? "loaded" : ""}`}
            src={src}
            alt={name}
            draggable={false}
            onLoad={() => { setStatus("loaded"); fit(); }}
            onError={() => setStatus("failed")}
          />
        )}
      </div>
      <div className="image-preview-topbar">
        <div className="image-preview-title">{name}</div>
        <button type="button" className="image-preview-close" onClick={onClose} title={isEn ? "Close (Esc)" : "关闭 (Esc)"} aria-label={isEn ? "Close (Esc)" : "关闭 (Esc)"}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      {onPrevious && <button type="button" className="character-gallery-nav character-gallery-prev" onClick={onPrevious} aria-label={isEn ? "Previous image" : "上一张"}>‹</button>}
      {onNext && <button type="button" className="character-gallery-nav character-gallery-next" onClick={onNext} aria-label={isEn ? "Next image" : "下一张"}>›</button>}
      <div className="image-preview-hint">
        {isEn ? "Scroll to zoom · Drag to pan · Double-click to reset · Esc to close" : "滚轮缩放 · 拖拽平移 · 双击复位 · Esc 退出"}
      </div>
    </div>
  );
}
