import { useRef, useState } from "react";

interface SizeComparisonProps {
  dimensions?: { x: number; y: number; z: number } | null;
}

export function SizeComparison({ dimensions }: SizeComparisonProps) {
  const [hover, setHover] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLDivElement | null>(null);

  const handleMouseEnter = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setTooltipPosition({
        top: rect.top + 10,
        left: rect.right + 12
      });
    }
    setHover(true);
  };

  const handleMouseLeave = () => {
    setHover(false);
  };

  if (!dimensions) {
      return (
        <div className="icon-action-col">
            <div style={{ width: 48, height: 48, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                    <line x1="12" y1="8" x2="12" y2="16"></line>
                    <line x1="8" y1="12" x2="16" y2="12"></line>
                </svg>
            </div>
            <span className="icon-label" style={{ textTransform: "none" }}>Size</span>
        </div>
      );
  }

  // Dimensions are ALWAYS in Meters now (from assetScanner)
  const lengthM = dimensions.x || 0; // x -> Length
  const heightM = dimensions.y || 0; // y -> Height
  const widthM = dimensions.z || 0;  // z -> Width (or depth)
  
  // Format: "长: 2.18m  宽: 1.02m  高: 0.81m"
  const label = `${lengthM.toFixed(2)}m x ${widthM.toFixed(2)}m x ${heightM.toFixed(2)}m`;
  
  // Calculate scaling for visualization
  // We want to fit the object (length x height) into a box of max 40x40px
  // But we also want to show the human (1.8m) at a reasonable scale if possible.
  
  // Base scale: 1 meter = 10 pixels (previous logic)
  const MAX_VIEW_SIZE = 40;
  const HUMAN_HEIGHT_M = 1.8;
  const maxAssetDim = Math.max(lengthM, widthM, heightM);
  
  // Determine the bounding box of the scene (Object + Human side-by-side)
  // Human is roughly 0.5m wide?
  // We visualize Length (x) as width in 2D icon, and Height (y) as height.
  const sceneWidthM = lengthM + 1.0; // object + gap + human width
  const sceneHeightM = Math.max(heightM, HUMAN_HEIGHT_M);
  
  // Calculate scale to fit MAX_VIEW_SIZE
  let pixelsPerMeter = 10; // Default zoom
  
  // If object is too big, zoom out
  if (sceneWidthM * pixelsPerMeter > MAX_VIEW_SIZE || sceneHeightM * pixelsPerMeter > MAX_VIEW_SIZE) {
      const scaleX = MAX_VIEW_SIZE / sceneWidthM;
      const scaleY = MAX_VIEW_SIZE / sceneHeightM;
      pixelsPerMeter = Math.min(scaleX, scaleY);
  }
  
  // If object is tiny, maybe zoom in? (Optional, but let's stick to max 10px/m to keep human recognizable)
  pixelsPerMeter = Math.min(pixelsPerMeter, 14);

  let humanScaleBoost = 1;
  if (maxAssetDim < 0.2) {
    humanScaleBoost = 2.2;
  } else if (maxAssetDim < 0.5) {
    humanScaleBoost = 1.8;
  } else if (maxAssetDim < 1.0) {
    humanScaleBoost = 1.4;
  }

  return (
    <div 
      className="icon-action-col"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{ position: "relative" }}
      ref={triggerRef}
    >
      <div style={{ width: 48, height: 48, display: "flex", flexDirection: "row", gap: 4, padding: 4, alignItems: "flex-end", justifyContent: "center" }}>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
              <HumanIcon scale={pixelsPerMeter * humanScaleBoost} />
          </div>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
              <AssetBoxIcon width={lengthM} height={heightM} scale={pixelsPerMeter} />
          </div>
      </div>
      <span className="icon-label" style={{ textTransform: "none" }}>Size</span>
      
      {hover && tooltipPosition && (
          <div className="size-tooltip" style={{ position: "fixed", top: tooltipPosition.top, left: tooltipPosition.left, transform: "none", zIndex: 5000, whiteSpace: 'nowrap' }}>
              {label}
          </div>
      )}
    </div>
  );
}

function HumanIcon({ scale }: { scale: number }) {
    // Standard human height ~1.8m
    // Width ~0.5m
    const h = 1.8 * scale;
    const w = 0.5 * scale;
    
    // Minimum visibility size (dot)
    if (h < 2) {
        return <div style={{ width: 2, height: 2, borderRadius: '50%', background: '#888', marginBottom: 0 }} />;
    }

    return (
        <svg width={Math.max(w, 2)} height={h} viewBox="2 0 4 17" fill="#888" style={{ minWidth: Math.max(w, 2) }}>
            <circle cx="4" cy="2.5" r="2" />
            <rect x="2" y="5" width="4" height="6" rx="1" />
            <rect x="2.5" y="11" width="1.2" height="6" />
            <rect x="4.5" y="11" width="1.2" height="6" />
        </svg>
    );
}

function AssetBoxIcon({ width, height, scale }: { width: number, height: number, scale: number }) {
    let pxWidth = width * scale;
    let pxHeight = height * scale;
    
    // Minimum visibility
    if (pxWidth < 1) pxWidth = 1;
    if (pxHeight < 1) pxHeight = 1;
    
    return (
        <div style={{
            width: pxWidth,
            height: pxHeight,
            background: "#aaa",
            borderRadius: 2,
            marginBottom: 0
        }} />
    );
}
