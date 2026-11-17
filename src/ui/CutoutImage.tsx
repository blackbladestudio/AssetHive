import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";

export type CropSelection = { x: number; y: number; width: number; height: number };

export function CutoutImage({ src, alt, cropEnabled, readOnly, selection, onSelection, onPick }: {
  src: string;
  alt: string;
  cropEnabled: boolean;
  readOnly: boolean;
  selection: CropSelection | null;
  onSelection: (selection: CropSelection | null) => void;
  onPick: (event: React.MouseEvent<HTMLImageElement>) => void;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; pointerId: number; image: DOMRect; canvas: DOMRect } | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<CropSelection | null>(null);
  const [draft, setDraft] = useState<{ value: CropSelection | null } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const image = imageRef.current;
    const container = image?.parentElement;
    if (!image || !container) return;
    const observer = new ResizeObserver(() => {
      const rect = image.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
      setCanvasSize({ width: container.clientWidth, height: container.clientHeight });
    });
    observer.observe(image);
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);
  const point = (event: PointerEvent<SVGSVGElement>) => {
    const rect = drag.current?.image || imageRef.current!.getBoundingClientRect();
    const canvas = drag.current?.canvas || event.currentTarget.getBoundingClientRect();
    const x = canvas.left + Math.max(7, Math.min(canvas.width - 7, event.clientX - canvas.left));
    const y = canvas.top + Math.max(7, Math.min(canvas.height - 7, event.clientY - canvas.top));
    return { x: (x - rect.left) / rect.width, y: (y - rect.top) / rect.height };
  };
  const update = (event: PointerEvent<SVGSVGElement>, preview = true) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId || readOnly) return null;
    const end = point(event);
    const next = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
    pending.current = next;
    // Keep pointer traffic local; only commit to the asset screen on pointer-up.
    if (preview && frame.current === null) frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setDraft({ value: pending.current });
    });
    return next;
  };
  const finishDrag = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    pending.current = null;
    drag.current = null;
    setDraft(null);
  };
  const visibleSelection = draft ? draft.value : selection;
  const box = visibleSelection ? { x: (canvasSize.width - size.width) / 2 + visibleSelection.x * size.width,
    y: (canvasSize.height - size.height) / 2 + visibleSelection.y * size.height,
    width: visibleSelection.width * size.width, height: visibleSelection.height * size.height } : null;
  return <>
    <img ref={imageRef} src={src} alt={alt} draggable={false}
      className={readOnly ? "cutout-image-readonly" : ""}
      style={cropEnabled ? { touchAction: "none" } : undefined}
      onClick={readOnly || cropEnabled ? undefined : onPick}
    />
    {cropEnabled && !readOnly && size.width > 0 && <svg className="cutout-crop-overlay" width="100%" height="100%" viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`} preserveAspectRatio="none" aria-label="裁剪选区：拖拽框选或调整四角"
      onPointerDown={event => {
        if (!cropEnabled || readOnly || event.button !== 0 || drag.current) return;
        event.preventDefault();
        const corner = (event.target as Element).getAttribute("data-corner");
        const anchor = corner && selection ? {
          x: selection.x + (corner.includes("w") ? selection.width : 0),
          y: selection.y + (corner.includes("n") ? selection.height : 0)
        } : point(event);
        drag.current = { ...anchor, pointerId: event.pointerId, image: imageRef.current!.getBoundingClientRect(), canvas: event.currentTarget.getBoundingClientRect() };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDraft({ value: corner ? selection : null });
      }}
      onPointerMove={event => { update(event); }}
      onPointerUp={event => {
        if (drag.current?.pointerId !== event.pointerId) return;
        const next = update(event, false);
        finishDrag();
        if (next) onSelection(next);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={finishDrag}
      onLostPointerCapture={() => { if (drag.current) finishDrag(); }}
    >
      {box && <>
        <path fill="#0008" fillRule="evenodd" d={`M0 0H${canvasSize.width}V${canvasSize.height}H0Z M${box.x} ${box.y}h${box.width}v${box.height}h${-box.width}Z`} />
        <rect x={box.x} y={box.y} width={box.width} height={box.height} fill="transparent" stroke="white" strokeWidth="1.5" />
        {(["nw", "ne", "sw", "se"] as const).map(corner => <rect key={corner} data-corner={corner}
          x={box.x + (corner.includes("e") ? box.width : 0) - 6} y={box.y + (corner.includes("s") ? box.height : 0) - 6}
          width="12" height="12" rx="2" fill="white" stroke="#2196f3" strokeWidth="1.5"
          style={{ cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize" }} />)}
      </>}
    </svg>}
  </>;
}
