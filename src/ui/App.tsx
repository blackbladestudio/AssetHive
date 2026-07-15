import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, AssetRecord } from "../types";
import { ModelProcessor } from "./ModelProcessor";
import { SizeComparison } from "./SizeComparison";
import {
  defaultSettings,
  defaultTextureTypes,
  defaultImportForm,
  defaultEditForm,
  type SearchState,
  type TextureEntry,
  type EditFormState
} from "./hooks/types";
import { useAssetState } from "./hooks/useAssetState";
import { useExportState } from "./hooks/useExportState";
import { useSettingsState } from "./hooks/useSettingsState";
import { useCutoutState } from "./hooks/useCutoutState";
import { useUIState } from "./hooks/useUIState";

function Icon({ name }: { name: string }) {
  switch (name) {
    case "import":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="3" width="14" height="18" rx="3"></rect>
          <line x1="20" y1="12" x2="12" y2="12"></line>
          <polyline points="14 8 10 12 14 16"></polyline>
        </svg>
      );
    case "search":
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
      );
    case "settings":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      );
    case "download":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
      );
    case "upload":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="17 8 12 3 7 8"></polyline>
          <line x1="12" y1="3" x2="12" y2="15"></line>
        </svg>
      );
    case "image-preview":
      return (
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2"></rect>
          <circle cx="9" cy="10" r="1.5"></circle>
          <path d="M21 16l-5.5-5.5a1.5 1.5 0 0 0-2.12 0L7 17"></path>
        </svg>
      );
    case "arrow-right":
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <line x1="5" y1="12" x2="19" y2="12"></line>
          <polyline points="12 5 19 12 12 19"></polyline>
        </svg>
      );
    case "arrow-up":
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="19" x2="12" y2="5"></line>
          <polyline points="5 12 12 5 19 12"></polyline>
        </svg>
      );
    case "home":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
          <polyline points="9 22 9 12 15 12 15 22"></polyline>
        </svg>
      );
    case "cube":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
          <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
          <line x1="12" y1="22.08" x2="12" y2="12"></line>
        </svg>
      );
    case "leaf":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"></path>
          <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"></path>
        </svg>
      );
    case "layer":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
          <polyline points="2 17 12 22 22 17"></polyline>
          <polyline points="2 12 12 17 22 12"></polyline>
        </svg>
      );
    case "sticker":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
          <polyline points="10 9 9 9 8 9"></polyline>
        </svg>
      );
    case "brush":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"></path>
        </svg>
      );
    case "folder":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
      );
    case "heart":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
        </svg>
      );
    case "bell":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
        </svg>
      );
    case "user":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
          <circle cx="12" cy="7" r="4"></circle>
        </svg>
      );
    case "trash":
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      );
    case "maximize":
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 3h6v6"></path>
          <path d="M9 21H3v-6"></path>
          <path d="M21 3l-7 7"></path>
          <path d="M3 21l7-7"></path>
        </svg>
      );
    case "minimize":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
      );
    case "close":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      );
    case "file":
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
          <polyline points="13 2 13 9 20 9"></polyline>
        </svg>
      );
    case "link":
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
        </svg>
      );
    case "plus":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
      );
    case "plus-circle":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9"></circle>
          <line x1="12" y1="8" x2="12" y2="16"></line>
          <line x1="8" y1="12" x2="16" y2="12"></line>
        </svg>
      );
    case "pipette":
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 22l6-6"></path>
          <path d="M14.5 3.5a2.1 2.1 0 0 1 3 3L7 17l-4 1 1-4 10.5-10.5z"></path>
        </svg>
      );
    case "heart-filled":
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
        </svg>
      );
    case "stack":
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
          <polyline points="2 17 12 22 22 17"></polyline>
          <polyline points="2 12 12 17 22 12"></polyline>
        </svg>
      );
    default:
      return null;
  }
}

type CategoryNode = {
  id: string;
  label: string;
  children?: Array<CategoryNode | string>;
};

const EXPORT_RESOLUTION_OPTIONS = [
  { value: "2k", label: "2K", pixels: 2048 },
  { value: "4k", label: "4K", pixels: 4096 },
  { value: "8k", label: "8K", pixels: 8192 }
] as const;

function normalizeExportResolutionValue(value: string) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "2k") return "2k";
  if (normalized === "8k") return "8k";
  return "4k";
}

function parseTextureResolutionPixels(filePath: string) {
  const normalizedPath = String(filePath || "").replace(/\\/g, "/");
  const fileName = normalizedPath.split("/").pop() || "";
  const name = fileName.replace(/\.[^.]+$/, "").toLowerCase();
  const match = name.match(/(?:^|[_\-.])(1k|2k|4k|8k|16k)(?:$|[_\-.])/i);
  if (!match) {
    return 0;
  }
  const token = String(match[1] || "").toLowerCase();
  if (token === "1k") return 1024;
  if (token === "2k") return 2048;
  if (token === "4k") return 4096;
  if (token === "8k") return 8192;
  if (token === "16k") return 16384;
  return 0;
}

const categoryTree: CategoryNode[] = [
  {
    id: "home",
    label: "Home",
    children: [
      {
        id: "3d-assets",
        label: "3D Assets",
        children: ["Building", "Food", "Historical", "Industrial", "Interior", "Nature", "Props", "Street"]
      },
      {
        id: "3d-plants",
        label: "3D Plants",
        children: ["Aquatic", "Climber", "Crop", "Fern", "Flowering Plant", "Garden Plant", "Grass", "Ground Cover", "Herb", "Houseplant", "Shrub", "Succulent", "Weed"]
      },
      {
        id: "surfaces",
        label: "Surfaces",
        children: ["Asphalt", "Bark", "Branch", "Brick", "Coal", "Concrete", "Debris", "Fabric", "Grass", "Gravel", "Ground", "Historical", "Marble", "Metal", "Moss", "Plaster", "Rock", "Roofing", "Sand", "Snow", "Soil", "Stone", "Tile", "Wood", "Other"]
      },
      {
        id: "decals",
        label: "Decals",
        children: ["Blood", "Commercial", "Concrete", "Debris", "Door", "Fabric", "Graffiti", "Leakage", "Metal", "Moss", "Mud", "Stone", "Street", "Tree", "Trim", "Vegetation", "Wood", "Other"]
      },
      {
        id: "imperfections",
        label: "Imperfections",
        children: ["Damage", "Dirt", "Fingerprint", "Frost", "Grain", "Grunge", "Leakage", "Metal", "Rubber", "Stain", "Stone", "Wipe Mark", "Other"]
      },
      { id: "displacements", label: "Displacements" },
      {
        id: "hdri",
        label: "HDRI",
        children: ["Outdoor", "Skies", "Indoor", "Studio", "Sunrise/Sunset", "Night", "Nature", "Urban"]
      }
    ]
  }
];

const textureTypeOptions = [
  "Albedo",
  "AO",
  "Brush",
  "Bump",
  "Cavity",
  "Diffuse",
  "Displacement",
  "Fuzz",
  "Gloss",
  "Mask",
  "Metalness",
  "Normal",
  "Opacity",
  "Roughness",
  "Specular",
  "Translucency",
  "HDR"
];

const meshSlotBaseName = "Mesh";
const subCategoryOptionsByAssetType: Record<string, string[]> = {
  "3d": ["Building", "Food", "Historical", "Industrial", "Interior", "Nature", "Props", "Street"],
  "3dplant": ["Aquatic", "Climber", "Crop", "Fern", "Flowering Plant", "Garden Plant", "Grass", "Ground Cover", "Herb", "Houseplant", "Shrub", "Succulent", "Weed"],
  surface: ["Asphalt", "Bark", "Branch", "Brick", "Coal", "Concrete", "Debris", "Fabric", "Grass", "Gravel", "Ground", "Historical", "Marble", "Metal", "Moss", "Plaster", "Rock", "Roofing", "Sand", "Snow", "Soil", "Stone", "Tile", "Wood", "Other"],
  decal: ["Blood", "Commercial", "Concrete", "Debris", "Door", "Fabric", "Graffiti", "Leakage", "Metal", "Moss", "Mud", "Stone", "Street", "Tree", "Trim", "Vegetation", "Wood", "Other"],
  imperfection: ["Damage", "Dirt", "Fingerprint", "Frost", "Grain", "Grunge", "Leakage", "Metal", "Rubber", "Stain", "Stone", "Wipe Mark", "Other"],
  displacement: ["Other"],
  hdri: ["Outdoor", "Skies", "Indoor", "Studio", "Sunrise/Sunset", "Night", "Nature", "Urban"]
};
const appBrandIconPath = new URL("../../LOGO/Icon_V2_256.png", import.meta.url).href;

function getPreviewUrl(previewPath: string | null) {
  if (!previewPath) return "";
  const normalized = previewPath.replace(/\\/g, "/");
  return encodeURI(`file:///${normalized}`);
}

function resolveExportStageLabel(percent: number) {
  if (percent < 20) return "准备导入任务";
  if (percent < 35) return "检查插件与环境";
  if (percent < 55) return "生成导入清单";
  if (percent < 75) return "整理与压缩资产";
  if (percent < 100) return "Unreal 导入中";
  return "导入完成";
}

const TextureEntryRow = memo(({
  entry,
  usedByOthers,
  textureTypeOptions,
  normalMapFormat,
  onToggleNormalMapFormat,
  busy,
  onTextureTypeChange,
  onDrop,
  onPick,
  onRemove,
  isPathMissing,
  disableRemove,
  hideTextureTypeSelect,
  lockTextureTypeSelect
}: {
  entry: TextureEntry;
  usedByOthers: Set<string>;
  textureTypeOptions: string[];
  normalMapFormat?: "dx" | "opengl";
  onToggleNormalMapFormat?: () => void;
  busy: boolean;
  onTextureTypeChange: (nextType: string) => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  onPick: () => void;
  onRemove: () => void;
  isPathMissing: (filePath: string) => boolean;
  disableRemove?: boolean;
  hideTextureTypeSelect?: boolean;
  lockTextureTypeSelect?: boolean;
}) => {
  const normalizedTextureType = String(entry.textureType || "").trim().toLowerCase();
  const isNormalTexture = normalizedTextureType === "normal" || normalizedTextureType === "normalbump";

  // Try to determine the format from the file extension
  const ext = (entry.filePath || "").split('.').pop()?.toUpperCase() || "";
  const showFormatTag = normalizedTextureType === "displacement" && ext;

  return (
    <div className="texture-row texture-slot-row">
      <div style={{ position: "relative" }}>
        {!hideTextureTypeSelect ? (
          <DarkSelect
            value={entry.textureType}
            ariaLabel="Texture Type"
            className="settings-dark-select texture-type-dark-select"
            lockOpen={Boolean(lockTextureTypeSelect)}
            hideChevron={Boolean(lockTextureTypeSelect)}
            options={[
              { value: "", label: "Select Type..." },
              ...textureTypeOptions.map((textureType) => ({
                value: textureType,
                label: textureType,
                disabled: usedByOthers.has(textureType)
              }))
            ]}
            onChange={(nextValue) => onTextureTypeChange(nextValue)}
          />
        ) : (
          <label className="texture-check">
            <span>{entry.textureType || "HDR"}</span>
          </label>
        )}
        {showFormatTag && (
          <div style={{
            position: "absolute",
            right: "34px",
            top: "50%",
            transform: "translateY(-50%)",
            fontSize: "10px",
            fontWeight: 800,
            padding: "2px 4px",
            borderRadius: "4px",
            pointerEvents: "none",
            background: ext === "EXR" ? "rgba(189, 147, 249, 0.15)" : "rgba(130, 130, 130, 0.15)",
            color: ext === "EXR" ? "#bd93f9" : "#a0a0a0",
            border: ext === "EXR" ? "1px solid rgba(189, 147, 249, 0.3)" : "1px solid rgba(130, 130, 130, 0.2)"
          }}>
            {ext}
          </div>
        )}
      </div>
      <div
        className="drop-target texture-drop"
        style={{ flex: 1, width: "100%" }}
        onDragEnter={(event) => event.preventDefault()}
        onDragOverCapture={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
      >
        <div className="path-display-row">
          <div className={`slot-input-wrap${isNormalTexture ? " with-flip" : ""}`}>
            <input
              className={`settings-input${isPathMissing(entry.filePath || "") ? " missing-file-path" : ""}`}
              value={entry.filePath || ""}
              readOnly
              placeholder="选择或拖拽贴图文件"
            />
            {isNormalTexture && normalMapFormat && onToggleNormalMapFormat && (
              <button
                type="button"
                className={`path-icon-btn flip-inline-btn ${normalMapFormat === "opengl" ? "opengl" : "dx"}`}
                title="切换法线格式"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onToggleNormalMapFormat();
                }}
                disabled={busy}
              >
                {normalMapFormat === "opengl" ? "OpenGL" : "DX"}
              </button>
            )}
            <button
              type="button"
              className="path-icon-btn browse-icon-btn"
              title="Browse"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onPick();
              }}
            >
              <Icon name="folder" />
            </button>
          </div>
          {!disableRemove && (
            <button
              type="button"
              className="path-icon-btn remove-icon-btn"
              title="Remove"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRemove();
              }}
            >
              <Icon name="trash" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

const PreviewDropSlot = memo(({
  previewImagePath,
  busy,
  onPick,
  onDrop,
  onRemove,
  onCutout,
  isPathMissing
}: {
  previewImagePath: string;
  busy: boolean;
  onPick: () => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  onRemove: () => void;
  onCutout?: () => void;
  isPathMissing: (filePath: string) => boolean;
}) => {
  const [displayPreviewPath, setDisplayPreviewPath] = useState(previewImagePath);

  useEffect(() => {
    let active = true;
    const nextPath = String(previewImagePath || "").trim();
    if (!nextPath) {
      setDisplayPreviewPath("");
      return () => {
        active = false;
      };
    }
    const bridge = window.arkhive;
    if (!bridge || typeof bridge.getPreviewThumbnail !== "function") {
      setDisplayPreviewPath(nextPath);
      return () => {
        active = false;
      };
    }
    void bridge.getPreviewThumbnail(nextPath).then((resolvedPath: string) => {
      if (!active) {
        return;
      }
      setDisplayPreviewPath(String(resolvedPath || nextPath).trim() || nextPath);
    }).catch(() => {
      if (!active) {
        return;
      }
      setDisplayPreviewPath(nextPath);
    });
    return () => {
      active = false;
    };
  }, [previewImagePath]);

  return (
    <div
      className="drop-target preview-drop-target"
      onClick={onPick}
      onDragEnter={(event) => event.preventDefault()}
      onDragOverCapture={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <div className="preview-slot-actions">
        {previewImagePath && onCutout && (
          <button
            type="button"
            className="path-icon-btn preview-action-btn"
            title="吸管抠像（连续区域）"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onCutout();
            }}
            disabled={busy}
          >
            <Icon name="pipette" />
          </button>
        )}
        {previewImagePath && (
          <button
            type="button"
            className="path-icon-btn preview-action-btn"
            title="Remove"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onRemove();
            }}
            disabled={busy}
          >
            <Icon name="close" />
          </button>
        )}
      </div>
      <div className="preview-drop-content">
        {previewImagePath ? (
          <>
            <img className="preview-slot-image" src={getPreviewUrl(displayPreviewPath || previewImagePath)} alt="preview" />
            <div className={`preview-slot-filename${isPathMissing(previewImagePath) ? " missing-file-path" : ""}`}>
              {String(previewImagePath || "").split(/[\\/]/).pop() || previewImagePath}
            </div>
          </>
        ) : (
          <div className="preview-drop-empty">
            <Icon name="image-preview" />
            <span>预览图</span>
          </div>
        )}
      </div>
    </div>
  );
});

function getCardWidthClass(asset: AssetRecord) {
  const normalizedAssetType = String(asset?.assetType || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (normalizedAssetType === "surface" || normalizedAssetType === "imperfection" || normalizedAssetType === "displacement") {
    return "width-1x";
  }
  const meta = asset?.meta && typeof asset.meta === "object" ? asset.meta as Record<string, unknown> : {};
  const previews = meta.previews && typeof meta.previews === "object" ? meta.previews as Record<string, unknown> : {};
  const relativeSize = String(previews.relativeSize || "").trim().toLowerCase();
  const parsed = relativeSize.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
  if (parsed) {
    const width = Number(parsed[1]);
    const height = Number(parsed[2]);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      const ratio = width / height;
      if (ratio >= 2.4) {
        return "width-3x";
      }
      if (ratio > 1.2) {
        return "width-2x";
      }
      return "width-1x";
    }
  }
  if (normalizedAssetType === "3d" || normalizedAssetType === "3dplant") {
    return "width-2x";
  }
  return "width-1x";
}

function mapSubCategoryToOptionLabel(assetType: string, raw: string) {
  const norm = (s: string) => String(s || "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  const options = subCategoryOptionsByAssetType[String(assetType || "").trim().toLowerCase()] || ["Other"];
  const target = norm(raw);
  const found = options.find((opt) => norm(opt) === target);
  return found || raw || "";
}

const AssetCard = memo(({
  asset,
  previewSrc,
  isSelected,
  isFavorite,
  onSelect,
  onToggle,
  onToggleFavorite,
  onContextMenu,
  onQuickExport,
  exportDisabled,
  exportTitle,
  exportDimmed = false,
  exportLoading = false,
  exportProgress = 0,
  savingProgress = -1
}: {
  asset: AssetRecord;
  previewSrc: string;
  isSelected: boolean;
  isFavorite: boolean;
  onSelect: (assetId: string) => void;
  onToggle: (assetId: string) => void;
  onToggleFavorite: (assetId: string) => void;
  onContextMenu: (event: React.MouseEvent, assetId: string) => void;
  onQuickExport: (assetId: string) => void;
  exportDisabled: boolean;
  exportDimmed?: boolean;
  exportLoading?: boolean;
  exportProgress?: number;
  savingProgress?: number;
  exportTitle?: string;
}) => {
  const [displaySrc, setDisplaySrc] = useState(previewSrc);
  const displaySrcRef = useRef(displaySrc);
  const [thumbLoaded, setThumbLoaded] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumbImgRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    displaySrcRef.current = displaySrc;
  }, [displaySrc]);
  useEffect(() => {
    let active = true;
    if (!previewSrc) {
      setDisplaySrc("");
      setThumbLoaded(false);
      setThumbFailed(false);
      return () => {
        active = false;
      };
    }
    if (!displaySrcRef.current) {
      setDisplaySrc(previewSrc);
      setThumbLoaded(false);
      setThumbFailed(false);
      return () => {
        active = false;
      };
    }
    if (previewSrc === displaySrcRef.current) {
      return () => {
        active = false;
      };
    }
    const preload = new Image();
    preload.onload = () => {
      if (!active) {
        return;
      }
      setDisplaySrc(previewSrc);
      setThumbFailed(false);
      setThumbLoaded(true);
    };
    preload.onerror = () => {
      if (!active) {
        return;
      }
      setThumbFailed(true);
    };
    preload.src = previewSrc;
    return () => {
      active = false;
    };
  }, [previewSrc]);
  useEffect(() => {
    const image = thumbImgRef.current;
    if (image && image.complete && image.naturalWidth > 0) {
      setThumbLoaded(true);
    }
  }, [displaySrc]);
  return (
    <article
      id={`asset-card-${asset.id}`}
      className={`card ${isSelected ? "active" : ""} ${getCardWidthClass(asset)} ${savingProgress >= 0 ? "saving" : ""} ${String(asset.assetType || "").trim().toLowerCase() === "hdri" ? "hdri" : ""}`}
      onClick={(e) => {
        if (savingProgress >= 0) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.shiftKey) {
          onToggle(asset.id);
          return;
        }
        onSelect(asset.id);
      }}
      onContextMenu={(event) => {
        if (savingProgress >= 0) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onContextMenu(event, asset.id);
      }}
    >
      <button
        className={`card-fav-btn ${isFavorite ? "active" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite(asset.id);
        }}
      >
        <Icon name={isFavorite ? "heart-filled" : "heart"} />
      </button>
      <button
        className={`card-export-btn ${exportDimmed ? "dimmed" : ""} ${exportLoading ? "loading" : ""}`}
        disabled={exportDisabled || savingProgress >= 0}
        title={exportDisabled ? exportTitle : undefined}
        onClick={(e) => {
          e.stopPropagation();
          onQuickExport(asset.id);
        }}
      >
        {exportLoading ? (
          <span className="card-export-progress" style={{ ["--export-progress" as string]: `${Math.max(0, Math.min(100, exportProgress))}%` }}>
            <Icon name="arrow-right" />
          </span>
        ) : (
          <Icon name="arrow-right" />
        )}
      </button>
      <div
        className={`thumb ${String(asset.assetType || "").trim().toLowerCase() === "hdri" ? "thumb-hdri" : ""}`}
        style={String(asset.assetType || "").trim().toLowerCase() === "hdri" ? { padding: 0 } : undefined}
      >
        {asset.previewImage || asset.preview ? (
          <>
            {!thumbLoaded && !thumbFailed && displaySrc && <div className="card-thumb-shimmer" />}
            {displaySrc && !thumbFailed ? (
              <img
                ref={thumbImgRef}
                className={thumbLoaded ? "loaded" : ""}
                src={displaySrc}
                alt={asset.name}
                loading="lazy"
                decoding="async"
                style={String(asset.assetType || "").trim().toLowerCase() === "hdri" ? { objectFit: "cover" } : undefined}
                onLoad={() => setThumbLoaded(true)}
                onError={() => {
                  setThumbFailed(true);
                  setThumbLoaded(false);
                }}
              />
            ) : (
              <div style={{ opacity: 0.7 }}>
                <Icon name="image-preview" />
              </div>
            )}
          </>
        ) : (
          <div style={{ opacity: 0.7 }}>
            <Icon name="image-preview" />
          </div>
        )}
      </div>
      <div className="name">{asset.name}</div>
      {savingProgress >= 0 && (
        <div className="card-saving-mask">
          <div className="card-saving-ring" style={{ ["--save-progress" as string]: `${Math.max(0, Math.min(100, savingProgress))}%` }}>
            <span>{Math.round(Math.max(0, Math.min(100, savingProgress)))}%</span>
          </div>
        </div>
      )}
    </article>
  );
});

function hashForStagger(input: string, seed: number) {
  let hash = seed ^ 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function resolveAssetGridMetrics(width: number) {
  let minCardWidth = 220;
  let gap = 12;
  let padding = 24;
  let cardHeight = 220;
  if (width <= 900) {
    minCardWidth = 110;
    gap = 6;
    padding = 10;
    cardHeight = 125;
  } else if (width <= 1200) {
    minCardWidth = 130;
    gap = 8;
    padding = 12;
    cardHeight = 145;
  }
  const contentWidth = Math.max(0, width - padding * 2);
  const columns = Math.max(1, Math.floor((contentWidth + gap) / (minCardWidth + gap)));
  return { minCardWidth, gap, padding, cardHeight, columns };
}

function buildStaggeredOrder(list: AssetRecord[], seed: number, gridColumns = 6) {
  if (!Array.isArray(list) || list.length <= 2) {
    return list;
  }
  const withKeys = list.map(item => ({
    item,
    key: hashForStagger(`${item.id}|${item.name}|${item.assetType}|${item.previewImage || item.preview || ""}`, seed)
  }));
  const sorted = withKeys.sort((a, b) => {
    if (a.key !== b.key) {
      return a.key - b.key;
    }
    return String(a.item.id).localeCompare(String(b.item.id));
  }).map(w => w.item);
  const maxColumns = Math.max(1, gridColumns);
  const remaining = [...sorted];
  const packed: AssetRecord[] = [];

  // Use the seed to create a deterministic pseudo-random number generator for this render
  let prngState = seed;
  const random = () => {
    prngState = (prngState * 1664525 + 1013904223) >>> 0;
    return prngState / 4294967296;
  };

  while (remaining.length > 0) {
    let space = maxColumns;
    let picked = false;

    // Sometimes prefer smaller cards even if there's plenty of space, 
    // to mix them into the middle/start of the row instead of just the end
    while (space > 0 && remaining.length > 0) {
      // Find all candidates that fit in the remaining space
      const candidates = remaining.map((asset, originalIndex) => {
        const widthClass = getCardWidthClass(asset);
        const span = widthClass === "width-3x" ? 3 : widthClass === "width-2x" ? 2 : 1;
        return { asset, originalIndex, span };
      }).filter(c => c.span <= space);

      if (candidates.length === 0) {
        break;
      }

      // Group candidates by span size
      const bySpan: Record<number, typeof candidates> = { 1: [], 2: [], 3: [] };
      candidates.forEach(c => bySpan[c.span].push(c));

      let chosenCandidate: typeof candidates[0];

      // Determine what span size to pick based on available candidates and some randomness
      if (space >= 3 && bySpan[3].length > 0 && random() > 0.3) {
        chosenCandidate = bySpan[3][0];
      } else if (space >= 2 && bySpan[2].length > 0 && random() > 0.4) {
        chosenCandidate = bySpan[2][0];
      } else if (bySpan[1].length > 0) {
        chosenCandidate = bySpan[1][0];
      } else {
        // Fallback to the first available candidate
        chosenCandidate = candidates[0];
      }

      packed.push(chosenCandidate.asset);
      remaining.splice(chosenCandidate.originalIndex, 1);
      space -= chosenCandidate.span;
      picked = true;
    }

    if (!picked && remaining.length > 0) {
      // If we couldn't fit anything perfectly, we just take the first one and force it in,
      // it might overflow visually but prevents an infinite loop and leaves gaps to be handled by CSS Grid
      packed.push(remaining.shift()!);
    }
  }
  return packed;
}

type DarkSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

const DarkSelect = memo(({
  value,
  options,
  onChange,
  disabled = false,
  lockOpen = false,
  hideChevron = false,
  className = "",
  menuClassName = "",
  itemClassName = "",
  ariaLabel
}: {
  value: string;
  options: DarkSelectOption[];
  onChange: (nextValue: string) => void;
  disabled?: boolean;
  lockOpen?: boolean;
  hideChevron?: boolean;
  className?: string;
  menuClassName?: string;
  itemClassName?: string;
  ariaLabel: string;
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const activeOption = options.find((option) => option.value === value) || options[0];

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current) {
        return;
      }
      if (!rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <div className={`dark-select ${className}`.trim()} ref={rootRef}>
      <button
        type="button"
        className={`dark-select-trigger${hideChevron ? " no-chevron" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          if (disabled || lockOpen) {
            return;
          }
          setOpen((prev) => !prev);
        }}
      >
        <span>{activeOption?.label || value}</span>
      </button>
      {open && !lockOpen && (
        <div className={`dark-select-menu ${menuClassName}`.trim()} role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              disabled={option.disabled}
              aria-selected={option.value === (activeOption?.value || value)}
              className={`dark-select-item ${itemClassName} ${option.value === (activeOption?.value || value) ? "active" : ""}`.trim()}
              onClick={() => {
                setOpen(false);
                if (option.disabled || option.value === value) {
                  return;
                }
                onChange(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

const RelatedAssetCard = ({ asset, onSelect }: { asset: AssetRecord; onSelect: (assetId: string) => void }) => {
  const [fitScaled, setFitScaled] = useState(false);
  return (
    <button key={asset.id} className="related-card" onClick={() => onSelect(asset.id)}>
      {(asset.previewImage || asset.preview) ? (
        <img
          src={getPreviewUrl(asset.previewImage || asset.preview)}
          alt={asset.name}
          className={fitScaled ? "fit-scaled" : ""}
          onLoad={(event) => {
            const img = event.currentTarget;
            const ratio = img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 1;
            setFitScaled(Math.abs(ratio - 1) > 0.04);
          }}
        />
      ) : (
        <span>{asset.name}</span>
      )}
    </button>
  );
};

export function App() {
  if (import.meta.env.VITE_FORCE_CRASH_UI === "1") {
    throw new Error("Crash UI preview");
  }
  const bridge = window.arkhive;
  const bridgeAvailable = Boolean(bridge);

  const {
    allAssets, setAllAssets,
    assets, setAssets,
    previewThumbByPath, setPreviewThumbByPath,
    search, setSearch,
    selectedAssetId, setSelectedAssetId,
    selectedIds, setSelectedIds,
    activeMenu, setActiveMenu,
    favoriteIds, setFavoriteIds,
    missingFilePathSet, setMissingFilePathSet,
    deleteConfirmAsset, setDeleteConfirmAsset,
    expandedCategories, setExpandedCategories
  } = useAssetState();
  const {
    busy, setBusy,
    isExporting, setIsExporting,
    importingAssetIds, setImportingAssetIds,
    exportStage, setExportStage,
    exportProgress, setExportProgress,
    quickDropActive, setQuickDropActive,
    quickDropBusy, setQuickDropBusy,
    quickDropProgress, setQuickDropProgress,
    importSaving, setImportSaving,
    savingProgressMap, setSavingProgressMap,
    unrealConnected, setUnrealConnected,
    unrealConnectedTargetName, setUnrealConnectedTargetName
  } = useExportState();
  const {
    settings, setSettings,
    settingsOpen, setSettingsOpen,
    settingsTab, setSettingsTab,
    settingsLoaded, setSettingsLoaded,
    importOpen, setImportOpen,
    editOpen, setEditOpen,
    importForm, setImportForm,
    editForm, setEditForm,
    editBaseline, setEditBaseline,
    importTagInput, setImportTagInput,
    editTagInput, setEditTagInput,
    appVersion, setAppVersion,
    appUpdateBusy, setAppUpdateBusy,
    appUpdateState, setAppUpdateState,
    appUpdateMessage, setAppUpdateMessage,
    appUpdateDownloadProgress, setAppUpdateDownloadProgress,
    appUpdateDownloadedBytes, setAppUpdateDownloadedBytes,
    appUpdateTotalBytes, setAppUpdateTotalBytes,
    appUpdateMode, setAppUpdateMode
  } = useSettingsState();
  const {
    cutoutOpen, setCutoutOpen,
    cutoutWorkingPath, setCutoutWorkingPath,
    cutoutBusy, setCutoutBusy,
    cutoutTolerance, setCutoutTolerance,
    cutoutPickPoint, setCutoutPickPoint,
    cutoutPickSourcePath, setCutoutPickSourcePath,
    cutoutTarget, setCutoutTarget
  } = useCutoutState();
  const {
    modalAlert, setModalAlert,
    status, setStatusText,
    detailPreviewFitScaled, setDetailPreviewFitScaled,
    detailPreviewLoaded, setDetailPreviewLoaded,
    showScrollTopButton, setShowScrollTopButton,
    assetStageMetrics, setAssetStageMetrics,
    contextMenu, setContextMenu,
    tagContextMenu, setTagContextMenu,
    scanning, setScanning,
    scanProgress, setScanProgress,
    scanHint, setScanHint,
    pluginInstalled, setPluginInstalled,
    pluginCanInstall, setPluginCanInstall,
    pluginInstallBusy, setPluginInstallBusy,
    pluginInstallProgress, setPluginInstallProgress,
    pluginStatusMessage, setPluginStatusMessage,
    hasImportableProject, setHasImportableProject
  } = useUIState();

  const previewThumbByPathRef = useRef<Record<string, string>>({});
  const statusClearTimerRef = useRef<number | null>(null);

  const showStatus = useCallback((msg: string, durationMs = 10000) => {
    if (statusClearTimerRef.current) {
      window.clearTimeout(statusClearTimerRef.current);
      statusClearTimerRef.current = null;
    }
    const safeMsg = String(msg || "");
    // Truncate long messages
    const truncatedMsg = safeMsg.length > 80 ? safeMsg.substring(0, 77) + "..." : safeMsg;
    setStatusText(truncatedMsg);
    if (truncatedMsg && durationMs && durationMs > 0) {
      statusClearTimerRef.current = window.setTimeout(() => {
        setStatusText((currentMsg) => currentMsg === truncatedMsg ? "" : currentMsg);
        statusClearTimerRef.current = null;
      }, durationMs);
    }
  }, []);

  const setStatus = useCallback((msg: string) => {
    showStatus(msg, 0); // For backwards compatibility, 0 means permanent until next showStatus
  }, [showStatus]);

  useEffect(() => {
    // Only update assets from allAssets when allAssets actually changes significantly
    // or when filters change.
    // BUT we must avoid resetting search state when allAssets updates.
    // The previous implementation was resetting assets blindly on allAssets change.
    // executeSearch(search); // Removing this self-trigger to break potential loops if any
  }, [allAssets]); // Removed search dependency to avoid loops, executeSearch uses current search ref if needed but here we pass it

  const quickDropRequestIdRef = useRef("");
  const cutoutPendingToleranceRef = useRef<number | null>(null);
  const customSaveClearTimerRef = useRef<Record<string, number>>({});
  const exportForceFinishTimerRef = useRef(0);
  const assetStageRef = useRef<HTMLDivElement | null>(null);
  const lastScrollTopRef = useRef(0);
  const lastScrollTickAtRef = useRef(0);
  const scrollVelocityRef = useRef(0);
  const scrollDirectionRef = useRef<"up" | "down">("down");
  const scrollRafRef = useRef(0);
  const pendingScrollTopRef = useRef(0);
  const shouldVirtualizeAssetGridRef = useRef(false);
  const staggerOrderSeedRef = useRef(Math.floor(Date.now() % 2147483647));

  const clearExportForceFinishTimer = useCallback(() => {
    if (exportForceFinishTimerRef.current) {
      window.clearTimeout(exportForceFinishTimerRef.current);
      exportForceFinishTimerRef.current = 0;
    }
  }, []);

  const scheduleExportForceFinish = useCallback(() => {
    clearExportForceFinishTimer();
    exportForceFinishTimerRef.current = window.setTimeout(() => {
      setIsExporting(false);
      setImportingAssetIds([]);
      setExportProgress(0);
      setExportStage("");
      setStatus("导入状态已自动恢复，如已在引擎导入成功可继续操作");
      exportForceFinishTimerRef.current = 0;
    }, 15000);
  }, [clearExportForceFinishTimer, setStatus]);

  const handleAssetStageScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const nextTop = event.currentTarget.scrollTop;
    const now = performance.now();
    const delta = nextTop - lastScrollTopRef.current;
    const deltaTime = now - lastScrollTickAtRef.current;
    if (deltaTime > 0) {
      scrollVelocityRef.current = Math.abs(delta) / deltaTime;
    }
    lastScrollTickAtRef.current = now;
    scrollDirectionRef.current = nextTop >= lastScrollTopRef.current ? "down" : "up";
    lastScrollTopRef.current = nextTop;
    pendingScrollTopRef.current = nextTop;
    setShowScrollTopButton((prev) => {
      const next = nextTop > 240;
      return prev === next ? prev : next;
    });
    if (!shouldVirtualizeAssetGridRef.current) {
      return;
    }
    if (!scrollRafRef.current) {
      scrollRafRef.current = window.requestAnimationFrame(() => {
        scrollRafRef.current = 0;
        const latestTop = pendingScrollTopRef.current;
        setAssetStageMetrics((prev) => (prev.scrollTop === latestTop ? prev : { ...prev, scrollTop: latestTop }));
      });
    }
  }, []);

  const scrollAssetStageToTop = useCallback(() => {
    const node = assetStageRef.current;
    if (!node) return;
    node.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const node = assetStageRef.current;
    if (!node) {
      return;
    }
    const updateMetrics = () => {
      setAssetStageMetrics((prev) => ({
        ...prev,
        viewportHeight: node.clientHeight,
        viewportWidth: node.clientWidth,
        scrollTop: node.scrollTop
      }));
    };
    updateMetrics();
    const observer = new ResizeObserver(() => {
      updateMetrics();
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => () => {
    if (scrollRafRef.current) {
      window.cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = 0;
    }
  }, []);

  const scanCompleteHideTimerRef = useRef<number | null>(null);
  const saveCompleteHideTimerRef = useRef<number | null>(null);
  const statusRef = useRef<string>("");
  const uiLanguage = settings.uiLanguage === "en" ? "en" : "zh";
  const t = (zh: string, en: string) => (uiLanguage === "en" ? en : zh);

  const shouldVirtualizeAssetGrid = false;
  useEffect(() => {
    shouldVirtualizeAssetGridRef.current = shouldVirtualizeAssetGrid;
  }, [shouldVirtualizeAssetGrid]);
  const orderedAssets = useMemo(
    // Use a fixed reference column count so that opening the detail panel,
    // resizing the window, or scrollbar appearance does not reshuffle the
    // packed order (buildStaggeredOrder's greedy packing is column-dependent).
    // CSS grid still reflows freely; only the logical sequence is stable.
    () => buildStaggeredOrder(assets, staggerOrderSeedRef.current, 6),
    [assets]
  );
  const selectedAssetIndex = useMemo(() => {
    if (!selectedAssetId) {
      return -1;
    }
    return orderedAssets.findIndex((asset) => asset.id === selectedAssetId);
  }, [orderedAssets, selectedAssetId]);
  const virtualGridLayout = useMemo(() => {
    const width = assetStageMetrics.viewportWidth;
    if (!shouldVirtualizeAssetGrid || width <= 0) {
      return {
        startIndex: 0,
        endIndexExclusive: orderedAssets.length,
        topSpacerHeight: 0,
        bottomSpacerHeight: 0
      };
    }
    const { gap, cardHeight, columns } = resolveAssetGridMetrics(width);
    const rowHeight = cardHeight + gap;

    const itemRows = new Array<number>(orderedAssets.length);
    let currentRow = 0;
    let currentColumns = 0;
    for (let i = 0; i < orderedAssets.length; i += 1) {
      const widthClass = getCardWidthClass(orderedAssets[i]);
      const span = Math.min(columns, widthClass === "width-3x" ? 3 : widthClass === "width-2x" ? 2 : 1);
      if (currentColumns > 0 && currentColumns + span > columns) {
        currentRow += 1;
        currentColumns = 0;
      }
      itemRows[i] = currentRow;
      currentColumns += span;
    }
    const totalRows = Math.max(1, currentRow + 1);
    const overscanRows = 3;
    let startRow = Math.max(0, Math.floor(assetStageMetrics.scrollTop / rowHeight) - overscanRows);
    let endRow = Math.min(totalRows - 1, Math.ceil((assetStageMetrics.scrollTop + assetStageMetrics.viewportHeight) / rowHeight) + overscanRows);

    if (selectedAssetIndex >= 0) {
      const selectedRow = itemRows[selectedAssetIndex] ?? 0;
      const rowWindow = 12;
      if (selectedRow >= startRow - rowWindow && selectedRow <= endRow + rowWindow) {
        startRow = Math.min(startRow, selectedRow);
        endRow = Math.max(endRow, selectedRow);
      }
    }

    let startIndex = 0;
    while (startIndex < orderedAssets.length && itemRows[startIndex] < startRow) {
      startIndex += 1;
    }
    let endIndexExclusive = startIndex;
    while (endIndexExclusive < orderedAssets.length && itemRows[endIndexExclusive] <= endRow) {
      endIndexExclusive += 1;
    }
    const topSpacerHeight = startRow > 0 ? startRow * rowHeight - gap : 0;
    const bottomSpacerHeight = (totalRows - endRow - 1) > 0 ? (totalRows - endRow - 1) * rowHeight - gap : 0;
    return { startIndex, endIndexExclusive, topSpacerHeight, bottomSpacerHeight };
  }, [assetStageMetrics.scrollTop, assetStageMetrics.viewportHeight, assetStageMetrics.viewportWidth, orderedAssets, selectedAssetIndex, shouldVirtualizeAssetGrid]);
  const visibleAssets = shouldVirtualizeAssetGrid
    ? orderedAssets.slice(virtualGridLayout.startIndex, virtualGridLayout.endIndexExclusive)
    : orderedAssets;
  const getCardPreviewSrc = useCallback((asset: AssetRecord) => {
    const rawPath = String(asset.previewImage || asset.preview || "").trim();
    if (!rawPath) {
      return "";
    }
    const thumbPath = previewThumbByPath[rawPath];
    return getPreviewUrl(thumbPath || rawPath);
  }, [previewThumbByPath]);

  useEffect(() => {
    previewThumbByPathRef.current = previewThumbByPath;
  }, [previewThumbByPath]);

  useEffect(() => {
    if (!bridgeAvailable || typeof bridge.getPreviewThumbnail !== "function") {
      return;
    }
    const velocity = scrollVelocityRef.current;
    const velocityFactor = velocity >= 3 ? 4 : velocity >= 2 ? 3 : velocity >= 1 ? 2 : 1;
    const preloadCount = (shouldVirtualizeAssetGrid ? 180 : 50) * velocityFactor;
    const frontStart = Math.max(0, virtualGridLayout.startIndex - preloadCount);
    const backEnd = Math.min(orderedAssets.length, virtualGridLayout.endIndexExclusive + preloadCount);
    const direction = scrollDirectionRef.current;
    const nearForwardAssets = direction === "down"
      ? orderedAssets.slice(virtualGridLayout.endIndexExclusive, backEnd)
      : orderedAssets.slice(frontStart, virtualGridLayout.startIndex);
    const nearBackwardAssets = direction === "down"
      ? orderedAssets.slice(frontStart, virtualGridLayout.startIndex)
      : orderedAssets.slice(virtualGridLayout.endIndexExclusive, backEnd);
    const prioritizedAssets = [...visibleAssets, ...nearForwardAssets, ...nearBackwardAssets];
    const rawPaths = prioritizedAssets
      .map((asset) => String(asset.previewImage || asset.preview || "").trim())
      .filter(Boolean);
    const pendingPaths = [...new Set(rawPaths)].filter((filePath) => !previewThumbByPathRef.current[filePath]).slice(0, 220 * velocityFactor);
    if (pendingPaths.length === 0) {
      return;
    }
    let active = true;
    const staged = new Map<string, string>();
    let flushTimer = 0;
    const flushStaged = () => {
      if (!active || staged.size === 0) {
        return;
      }
      const entries = [...staged.entries()];
      staged.clear();
      setPreviewThumbByPath((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [rawPath, thumbPath] of entries) {
          if (!next[rawPath]) {
            next[rawPath] = thumbPath;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    const scheduleFlush = () => {
      if (flushTimer) {
        return;
      }
      flushTimer = window.setTimeout(() => {
        flushTimer = 0;
        flushStaged();
      }, 120);
    };
    const load = async () => {
      let cursor = 0;
      const workerCount = Math.min(6, pendingPaths.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (active) {
          const nextIndex = cursor;
          cursor += 1;
          if (nextIndex >= pendingPaths.length) {
            return;
          }
          const filePath = pendingPaths[nextIndex];
          try {
            const thumbPath = await bridge.getPreviewThumbnail?.(filePath);
            if (!active || !thumbPath) {
              continue;
            }
            if (previewThumbByPathRef.current[filePath]) {
              continue;
            }
            staged.set(filePath, String(thumbPath));
            scheduleFlush();
          } catch {
            void 0;
          }
        }
      });
      await Promise.all(workers);
      flushStaged();
    };
    void load();
    return () => {
      active = false;
      if (flushTimer) {
        window.clearTimeout(flushTimer);
      }
    };
  }, [bridge, bridgeAvailable, orderedAssets, shouldVirtualizeAssetGrid, virtualGridLayout.endIndexExclusive, virtualGridLayout.startIndex, visibleAssets]);

  // Initial load
  useEffect(() => {
    let active = true;
    const updateAssets = async () => {
      if (!bridgeAvailable) return;
      try {
        const index = await bridge.searchAssets({
          text: "",
          tags: [],
          assetTypes: [],
          themes: [],
          source: "all"
        });
        if (active) {
          setAllAssets(index);
          // Initial setAssets is handled by the search effect when allAssets updates
        }
      } catch (error) {
        console.error("Failed to load assets", error);
      }
    };
    void updateAssets();
    return () => {
      active = false;
    };
  }, [bridge, bridgeAvailable]);

  // Re-run search when search criteria change
  useEffect(() => {
    // Logic extracted from executeSearch to avoid redundancy:
    let filtered = allAssets;
    if (search.source === "quixel") {
      filtered = filtered.filter((a) => a.source === "quixel");
    } else if (search.source === "custom") {
      filtered = filtered.filter((a) => a.source === "custom");
    }

    if (search.text) {
      const lower = search.text.toLowerCase();
      filtered = filtered.filter((a) => {
        const nameHit = a.name.toLowerCase().includes(lower);
        const tagHit = (a.tags || []).some((t) => t.toLowerCase().includes(lower));
        const idHit = String(a.id || "").toLowerCase().includes(lower) || String(a.assetID || "").toLowerCase().includes(lower);
        const metaObj = a.meta && typeof a.meta === "object" ? (a.meta as { assetID?: string; slug?: string }) : null;
        const metaIdHit = metaObj?.assetID ? String(metaObj.assetID || "").toLowerCase().includes(lower) : false;
        const slugHit = metaObj?.slug ? String(metaObj.slug || "").toLowerCase().includes(lower) : false;
        return nameHit || tagHit || idHit || metaIdHit || slugHit;
      });
    }

    if (search.tags.length > 0) {
      filtered = filtered.filter((a) => {
        const assetTags = (a.tags || []).map((t) => t.toLowerCase());
        return search.tags.every((t) => assetTags.includes(t.toLowerCase()));
      });
    }

    if (search.assetTypes.length > 0) {
      filtered = filtered.filter((a) => search.assetTypes.includes(a.assetType.toLowerCase()));
    }

    if (search.themes.length > 0) {
      filtered = filtered.filter((a) => {
        const assetTags = (a.tags || []).map((t) => normalizeThemeToken(t));
        return search.themes.every((t) => assetTags.includes(normalizeThemeToken(t)));
      });
    }

    if (activeMenu !== "home" && activeMenu !== "favorite") {
      // Filter by active menu category
      if (activeMenu === "3d-assets") filtered = filtered.filter(a => a.assetType === "3d");
      else if (activeMenu === "3d-plants") filtered = filtered.filter(a => a.assetType === "3dplant");
      else if (activeMenu === "surfaces") filtered = filtered.filter(a => a.assetType === "surface");
      else if (activeMenu === "decals") filtered = filtered.filter(a => a.assetType === "decal");
      else if (activeMenu === "imperfections") filtered = filtered.filter(a => a.assetType === "imperfection");
      else if (activeMenu === "displacements") filtered = filtered.filter(a => a.assetType === "displacement");
      else if (activeMenu === "fav-3d") filtered = filtered.filter(a => favoriteIds.has(a.id) && a.assetType === "3d");
      else if (activeMenu === "fav-3dplant") filtered = filtered.filter(a => favoriteIds.has(a.id) && a.assetType === "3dplant");
      else if (activeMenu === "fav-surface") filtered = filtered.filter(a => favoriteIds.has(a.id) && a.assetType === "surface");
      else if (activeMenu === "fav-decal") filtered = filtered.filter(a => favoriteIds.has(a.id) && a.assetType === "decal");
      else if (activeMenu === "fav-imperfection") filtered = filtered.filter(a => favoriteIds.has(a.id) && a.assetType === "imperfection");
      else if (activeMenu === "fav-displacement") filtered = filtered.filter(a => favoriteIds.has(a.id) && a.assetType === "displacement");
    } else if (activeMenu === "favorite") {
      filtered = filtered.filter(a => favoriteIds.has(a.id));
    }

    if (search.size !== "all") {
      const getAssetSizeTier = (asset: AssetRecord) => {
        const dimensions = getAssetDimensions(asset);
        if (!dimensions) {
          const normalizedAssetType = String(asset.assetType || "").trim().toLowerCase();
          if (normalizedAssetType === "surface" || normalizedAssetType === "decal" || normalizedAssetType === "imperfection" || normalizedAssetType === "displacement") {
            return "tiny";
          }
          if (normalizedAssetType === "3d" || normalizedAssetType === "3dplant") {
            return "small";
          }
          return "medium";
        }
        const maxSize = Math.max(
          Number(dimensions.x) || 0,
          Number(dimensions.y) || 0,
          Number(dimensions.z) || 0
        );
        if (maxSize < 1) return "tiny";
        if (maxSize < 2) return "small";
        if (maxSize < 5) return "medium";
        if (maxSize < 10) return "large";
        return "huge";
      };
      filtered = filtered.filter((asset) => getAssetSizeTier(asset) === search.size);
    }
    if (search.color !== "all") {
      const requiredColor = String(search.color || "").trim().toLowerCase();
      filtered = filtered.filter((asset) => getAssetColorTags(asset).includes(requiredColor));
    }

    if (search.environment !== "all") {
      const requiredEnv = normalizeThemeToken(search.environment);
      filtered = filtered.filter((asset) => (asset.tags || []).some((tag) => normalizeThemeToken(tag) === requiredEnv));
    }

    const favoriteState = search.favoriteState || (search.onlyFavorites ? "fav" : "all");
    if (favoriteState === "fav") {
      filtered = filtered.filter((asset) => favoriteIds.has(asset.id));
    } else if (favoriteState === "not") {
      filtered = filtered.filter((asset) => !favoriteIds.has(asset.id));
    }

    setAssets(filtered);

  }, [search, allAssets, activeMenu, favoriteIds]);

  async function executeSearch(nextSearch: SearchState) {
    // Legacy stub - search is now reactive via useEffect
    // This allows existing calls to 'executeSearch' to just update the state
    setSearch(nextSearch);
  }

  const canExportToUnreal = bridgeAvailable && pluginInstalled && unrealConnected && (hasImportableProject || Boolean(String(settings.unrealEditorPath || "").trim()));

  const favoriteDirtyRef = useRef(false);
  const favoriteHydratedRef = useRef(false);
  useEffect(() => {
    // We should not bail out based on favoriteDirtyRef if we actually got new data from the backend
    // Only bail out if we've hydrated once AND we're just getting the same reference or nothing new.
    if (!Array.isArray(allAssets) || allAssets.length === 0) {
      return;
    }
    const favs = new Set<string>();
    allAssets.forEach((asset) => {
      if (asset?.favorite) {
        favs.add(asset.id);
      }
    });
    // Always sync the favoriteIds with the backend truth when allAssets changes
    setFavoriteIds(favs);
    favoriteHydratedRef.current = true;
  }, [allAssets]);

  const toggleFavorite = useCallback((assetId: string) => {
    favoriteDirtyRef.current = true;
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      const isFavorite = !next.has(assetId);
      if (isFavorite) {
        next.add(assetId);
      } else {
        next.delete(assetId);
      }

      // Update the allAssets array locally so it doesn't revert back on the next render before backend syncs
      setAllAssets(currentAll => currentAll.map(a => a.id === assetId ? { ...a, favorite: isFavorite } : a));

      // Sync with backend
      if (bridgeAvailable && bridge.toggleFavorite) {
        bridge.toggleFavorite(assetId, isFavorite).then(success => {
          if (!success) {
            console.error("Failed to persist favorite status for", assetId);
          }
        });
      }

      return next;
    });
  }, [bridge, bridgeAvailable]);

  const expandedCategoryTree = useMemo(() => {
    const favChildren: CategoryNode[] = [];
    const favAssetTypes = new Set<string>();

    // Find all asset types present in favorites
    allAssets.forEach(asset => {
      if (favoriteIds.has(asset.id) && asset.assetType) {
        favAssetTypes.add(asset.assetType.toLowerCase());
      }
    });

    if (favAssetTypes.has("3d")) favChildren.push({ id: "fav-3d", label: "3D Assets", children: [] });
    if (favAssetTypes.has("3dplant")) favChildren.push({ id: "fav-3dplant", label: "3D Plants", children: [] });
    if (favAssetTypes.has("surface")) favChildren.push({ id: "fav-surface", label: "Surfaces", children: [] });
    if (favAssetTypes.has("decal")) favChildren.push({ id: "fav-decal", label: "Decals", children: [] });
    if (favAssetTypes.has("imperfection")) favChildren.push({ id: "fav-imperfection", label: "Imperfections", children: [] });
    if (favAssetTypes.has("displacement")) favChildren.push({ id: "fav-displacement", label: "Displacements", children: [] });

    const favNode: CategoryNode = {
      id: "favorite",
      label: "Favorite",
      children: favChildren
    };

    // Deep clone categoryTree to avoid mutating the original static definition
    const newTree = JSON.parse(JSON.stringify(categoryTree));

    // Inject favorite node as a sibling of Home, appearing after it.
    newTree.push(favNode);

    return newTree;
  }, [allAssets, favoriteIds]);

  function normalizeThemeToken(input: string) {
    return input.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  }

  function getSubCategoryOptions(assetType: string) {
    return subCategoryOptionsByAssetType[String(assetType || "").trim().toLowerCase()] || ["Other"];
  }

  function getAssetTypeLabel(assetType: string) {
    const normalized = String(assetType || "").trim().toLowerCase();
    if (normalized === "3d") return "3D Assets";
    if (normalized === "3dplant") return "3D Plants";
    if (normalized === "surface") return "Surfaces";
    if (normalized === "decal") return "Decals";
    if (normalized === "imperfection") return "Imperfections";
    if (normalized === "displacement") return "Displacements";
    if (normalized === "hdri") return "HDRI";
    return normalized ? normalized.toUpperCase() : "Unknown";
  }

  function getAssetSubCategory(asset: AssetRecord | null) {
    if (!asset || typeof asset !== "object") {
      return "";
    }
    const meta = asset.meta as {
      category?: string;
      semanticTags?: { subject_matter?: string; theme?: string[] };
      themes?: string[];
    };
    const fromCategory = String(meta?.category || "").trim();
    if (fromCategory) {
      return fromCategory.toLowerCase();
    }
    const fromSubject = String(meta?.semanticTags?.subject_matter || "").trim();
    if (fromSubject) {
      return fromSubject.toLowerCase();
    }
    const fromTheme = Array.isArray(meta?.semanticTags?.theme) ? String(meta.semanticTags?.theme?.[0] || "").trim() : "";
    if (fromTheme) {
      return fromTheme.toLowerCase();
    }
    const themeTop = Array.isArray(asset?.themes || null) ? String((asset.themes as string[])[0] || "").trim() : "";
    if (themeTop) {
      return themeTop.toLowerCase();
    }
    const categoryFromAsset = Array.isArray(asset?.categories || null)
      ? String(((asset.categories as string[]).find((v) => v && v.toLowerCase() !== String(asset.assetType || "").toLowerCase()) || (asset.categories as string[])[0] || "")).trim()
      : "";
    return categoryFromAsset.toLowerCase();
  }

  function mapNodeIdToAssetTypes(nodeId: string | null) {
    if (!nodeId) {
      return [];
    }
    if (nodeId.startsWith("fav-")) {
      return [nodeId.replace("fav-", "")];
    }
    const table: Record<string, string[]> = {
      "3d-assets": ["3d"],
      "3d-plants": ["3dplant"],
      surfaces: ["surface"],
      decals: ["decal"],
      imperfections: ["imperfection"],
      displacements: ["displacement"],
      hdri: ["hdri"]
    };
    return table[nodeId] || [];
  }

  const selectedAsset = useMemo(
    () => allAssets.find((asset) => asset.id === selectedAssetId) || null,
    [allAssets, selectedAssetId]
  );
  const selectedAssetMaxTextureResolution = useMemo(() => {
    if (!selectedAsset || !Array.isArray(selectedAsset.textureFiles)) {
      return 0;
    }
    const resolutions = selectedAsset.textureFiles
      .map((filePath) => parseTextureResolutionPixels(filePath))
      .filter((value) => value > 0);
    if (resolutions.length === 0) {
      return 0;
    }
    return Math.max(...resolutions);
  }, [selectedAsset]);
  const currentExportResolution = normalizeExportResolutionValue(String(settings.exportResolution || "4k"));
  const availableExportResolutionOptions = useMemo(
    () => EXPORT_RESOLUTION_OPTIONS.filter((option) => !(selectedAssetMaxTextureResolution > 0 && option.pixels > selectedAssetMaxTextureResolution)),
    [selectedAssetMaxTextureResolution]
  );
  const activeExportResolutionValue = useMemo(
    () => (availableExportResolutionOptions.some((option) => option.value === currentExportResolution)
      ? currentExportResolution
      : (availableExportResolutionOptions[availableExportResolutionOptions.length - 1]?.value || currentExportResolution)),
    [availableExportResolutionOptions, currentExportResolution]
  );
  const selectedAssetExporting = Boolean(selectedAsset && isExporting && importingAssetIds.includes(selectedAsset.id));

  const refreshAssetFromDisk = useCallback(async (assetId: string) => {
    if (!bridgeAvailable || typeof bridge.getAssetById !== "function") {
      return;
    }
    const normalizedId = String(assetId || "").trim();
    if (!normalizedId) {
      return;
    }
    try {
      const result = await bridge.getAssetById(normalizedId);
      const updated = result?.ok ? result.asset : null;
      if (!updated) {
        return;
      }
      setAllAssets((prev) => prev.map((asset) => (asset.id === updated.id ? { ...asset, ...updated } : asset)));
      setAssets((prev) => prev.map((asset) => (asset.id === updated.id ? { ...asset, ...updated } : asset)));
    } catch {
      void 0;
    }
  }, [bridge, bridgeAvailable]);

  const detailPreviewPath = selectedAsset?.detailImage || selectedAsset?.previewImage || selectedAsset?.preview || "";

  useEffect(() => {
    // Reset preview state when preview path changes
    setDetailPreviewFitScaled(false);
    setDetailPreviewLoaded(false);
  }, [detailPreviewPath]);

  useEffect(() => {
    if (!selectedAssetId) {
      return;
    }
    void refreshAssetFromDisk(selectedAssetId);
  }, [refreshAssetFromDisk, selectedAssetId]);

  const relatedAssets = useMemo(() => {
    if (!selectedAsset) {
      return [];
    }
    const selectedType = String(selectedAsset.assetType || "").trim().toLowerCase();
    const selectedSubCategory = getAssetSubCategory(selectedAsset);
    const selectedTagSet = new Set((selectedAsset.tags || []).map((tag) => String(tag || "").trim().toLowerCase()).filter(Boolean));

    return allAssets
      .filter((asset) => {
        if (asset.id === selectedAsset.id) return false;
        const candidateType = String(asset.assetType || "").trim().toLowerCase();
        return candidateType && candidateType === selectedType;
      })
      .map((asset) => {
        const candidateSubCategory = getAssetSubCategory(asset);
        const sameSubCategory = selectedSubCategory && candidateSubCategory === selectedSubCategory;

        let sharedTagCount = 0;
        if (asset.tags && asset.tags.length > 0) {
          for (const tag of asset.tags) {
            const normalized = String(tag || "").trim().toLowerCase();
            if (normalized && selectedTagSet.has(normalized)) {
              sharedTagCount++;
            }
          }
        }
        const hasTagMatch = sharedTagCount > 0;

        let score = 0;
        if (sameSubCategory && hasTagMatch) {
          score = 3000 + sharedTagCount * 10;
        } else if (sameSubCategory) {
          score = 2000;
        } else {
          score = 1000;
        }
        return { asset, score, sharedTagCount };
      })
      .sort((a, b) => b.score - a.score || b.sharedTagCount - a.sharedTagCount || a.asset.name.localeCompare(b.asset.name))
      .slice(0, 8)
      .map((item) => item.asset);
  }, [allAssets, selectedAsset]);

  const rescan = useCallback(async () => {
    if (!bridgeAvailable) {
      showStatus("预览模式不支持扫描，请启动 Electron 桌面端", 10000);
      return;
    }
    setBusy(true);
    showStatus("扫描中...", 0);
    try {
      const index = await bridge.rescanAssets();
      setAllAssets(index);
      setAssets(index);
      // Removed auto-selection
      // if (index.length > 0) {
      //   setSelectedAssetId((prev) => prev ?? index[0].id);
      // }
      showStatus(`扫描完成，共 ${index.length} 个资产`, 2500);
    } catch (error) {
      showStatus(`扫描失败：${String(error)}`, 10000);
    } finally {
      setBusy(false);
    }
  }, [bridge, bridgeAvailable, showStatus]);

  useEffect(() => {
    function closeMenu() {
      setContextMenu(null);
      setTagContextMenu(null);
    }
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, [clearExportForceFinishTimer]);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let rescanTimer = 0;

    async function init() {
      if (!bridgeAvailable) {
        setStatus("当前为浏览器预览模式，请用 npm run dev 启动桌面端");
        setSettingsLoaded(true);
        return;
      }
      try {
        const loadedSettings = await bridge.getSettings();
        setSettings({
          ...defaultSettings,
          ...loadedSettings,
          exportResolution: normalizeExportResolutionValue(String(loadedSettings?.exportResolution || defaultSettings.exportResolution))
        });
        const cachedIndex = await bridge.getAssetIndex();
        if (Array.isArray(cachedIndex) && cachedIndex.length > 0) {
          setAllAssets(cachedIndex);
          setAssets(cachedIndex);
          setStatus("");
        } else {
          setStatus("");
        }
        if (bridge.getAppVersion) {
          const versionResult = await bridge.getAppVersion();
          if (versionResult?.ok && versionResult.version) {
            setAppVersion(String(versionResult.version));
          }
        }
      } finally {
        setSettingsLoaded(true);
      }

      unsubscribe = bridge.onAssetChange((payload?: { incremental?: boolean }) => {
        if (payload?.incremental && rescanTimer) {
          return;
        }
        const delay = payload?.incremental ? 1200 : 700;
        if (rescanTimer) {
          window.clearTimeout(rescanTimer);
        }
        rescanTimer = window.setTimeout(async () => {
          const latestIndex = await bridge.getAssetIndex();
          if (Array.isArray(latestIndex)) {
            setAllAssets(latestIndex);
          }
          rescanTimer = 0;
        }, delay);
      });
    }

    init();

    return () => {
      if (rescanTimer) {
        window.clearTimeout(rescanTimer);
      }
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [bridge, bridgeAvailable, rescan, setStatus]);

  const shouldRequireLibrarySetup = bridgeAvailable
    && settingsLoaded
    && !String(settings.megascanLibraryPath || "").trim()
    && !String(settings.customLibraryPath || "").trim();

  useEffect(() => {
    if (!bridgeAvailable || typeof bridge.onExportProgress !== "function") {
      return;
    }
    const unsubscribe = bridge.onExportProgress((payload) => {
      const nextPercent = Math.max(0, Math.min(100, Number(payload?.percent) || 0));
      if (nextPercent > 0) {
        setIsExporting(true);
      }
      setExportProgress(nextPercent);
      const rawMessage = String(payload?.message || "").trim();
      const compactMessage = rawMessage.replace(/\s+/g, "");
      const unreadableMessage = compactMessage.length > 0 && (/^\?+$/.test(compactMessage) || /�/.test(rawMessage) || /\?{2,}/.test(rawMessage));
      const stageLabel = rawMessage && !unreadableMessage ? rawMessage : resolveExportStageLabel(nextPercent);
      setExportStage(stageLabel);
      if (rawMessage && !unreadableMessage) {
        setStatus(rawMessage);
      } else {
        setStatus(stageLabel);
      }
      if (nextPercent >= 99) {
        scheduleExportForceFinish();
      }
    });
    return () => unsubscribe();
  }, [bridge, bridgeAvailable, scheduleExportForceFinish, setStatus]);

  useEffect(() => {
    if (!bridgeAvailable || typeof bridge.onResolveDroppedItemsProgress !== "function") {
      return;
    }
    const unsubscribe = bridge.onResolveDroppedItemsProgress((payload) => {
      if (!quickDropBusy) {
        return;
      }
      const requestId = String(payload?.requestId || "").trim();
      if (requestId && quickDropRequestIdRef.current && requestId !== quickDropRequestIdRef.current) {
        return;
      }
      const nextPercent = Math.max(0, Math.min(100, Number(payload?.percent) || 0));
      setQuickDropProgress(nextPercent);
    });
    return () => unsubscribe();
  }, [bridge, bridgeAvailable, quickDropBusy]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (!bridgeAvailable || typeof bridge.onScanProgress !== "function") {
      return;
    }
    const unsubscribe = bridge.onScanProgress((payload) => {
      const active = Boolean(payload?.active);
      const progress = Math.max(0, Math.min(100, Number(payload?.progress) || 0));
      setScanning(active);
      setScanProgress(progress);
      if (active) {
        if (scanCompleteHideTimerRef.current) {
          window.clearTimeout(scanCompleteHideTimerRef.current);
          scanCompleteHideTimerRef.current = null;
        }
        const phase = String(payload?.phase || "scan");
        const processed = Math.max(0, Number(payload?.processed) || 0);
        const total = Math.max(0, Number(payload?.total) || 0);
        const detail = total > 0 ? ` ${processed}/${total}` : "";
        const message = String(payload?.message || "").trim();
        setScanHint((message || `${phase}${detail}`).trim());
        setStatus(uiLanguage === "en" ? "Scanning" : "扫描中");
      } else if (String(payload?.phase || "") === "failed") {
        if (scanCompleteHideTimerRef.current) {
          window.clearTimeout(scanCompleteHideTimerRef.current);
          scanCompleteHideTimerRef.current = null;
        }
        setScanHint("");
        setStatus(uiLanguage === "en" ? "Scan failed" : "扫描失败");
      } else if (progress >= 100) {
        setScanHint("");
        const completeLabel = uiLanguage === "en" ? "Scan complete" : "扫描完成";
        setStatus(completeLabel);
        if (scanCompleteHideTimerRef.current) {
          window.clearTimeout(scanCompleteHideTimerRef.current);
        }
        scanCompleteHideTimerRef.current = window.setTimeout(() => {
          if (statusRef.current === completeLabel) {
            setStatus("");
          }
          scanCompleteHideTimerRef.current = null;
        }, 5000);
      }
    });
    return () => {
      if (scanCompleteHideTimerRef.current) {
        window.clearTimeout(scanCompleteHideTimerRef.current);
        scanCompleteHideTimerRef.current = null;
      }
      unsubscribe();
    };
  }, [bridge, bridgeAvailable, uiLanguage, setStatus]);

  useEffect(() => {
    return () => {
      clearExportForceFinishTimer();
    };
  }, [clearExportForceFinishTimer]);

  useEffect(() => {
    if (!bridgeAvailable || typeof bridge.onCustomSaveProgress !== "function") {
      return;
    }
    const unsubscribe = bridge.onCustomSaveProgress((payload) => {
      const assetId = String(payload?.assetId || "").trim();
      if (!assetId) {
        return;
      }
      const progress = Math.max(0, Math.min(100, Number(payload?.progress) || 0));
      setSavingProgressMap((prev) => ({ ...prev, [assetId]: progress }));
      const timerMap = customSaveClearTimerRef.current;
      if (progress >= 100) {
        if (/^正在保存资产/.test(statusRef.current)) {
          const completeLabel = uiLanguage === "en" ? "Save complete" : "保存完成";
          setStatus(completeLabel);
          if (saveCompleteHideTimerRef.current) {
            window.clearTimeout(saveCompleteHideTimerRef.current);
          }
          saveCompleteHideTimerRef.current = window.setTimeout(() => {
            if (statusRef.current === completeLabel) {
              setStatus("");
            }
            saveCompleteHideTimerRef.current = null;
          }, 2500);
        }
        if (timerMap[assetId]) {
          window.clearTimeout(timerMap[assetId]);
        }
        timerMap[assetId] = window.setTimeout(() => {
          setSavingProgressMap((prev) => {
            const next = { ...prev };
            delete next[assetId];
            return next;
          });
          delete timerMap[assetId];
        }, 1600);
      } else if (timerMap[assetId]) {
        window.clearTimeout(timerMap[assetId]);
        delete timerMap[assetId];
      }
    });
    return () => {
      const timerMap = customSaveClearTimerRef.current;
      for (const timerId of Object.values(timerMap)) {
        window.clearTimeout(timerId);
      }
      customSaveClearTimerRef.current = {};
      if (saveCompleteHideTimerRef.current) {
        window.clearTimeout(saveCompleteHideTimerRef.current);
        saveCompleteHideTimerRef.current = null;
      }
      unsubscribe();
    };
  }, [bridge, bridgeAvailable, uiLanguage, setStatus]);

  const savingAssetIdSet = useMemo(
    () => new Set(Object.keys(savingProgressMap)),
    [savingProgressMap]
  );

  async function pickMegascanPath() {
    if (!bridgeAvailable) {
      showStatus("设置路径需要桌面端环境", 10000);
      return;
    }
    try {
      const picked = await bridge.pickLibraryPath();
      if (!picked) return;

      const next = { ...settings, megascanLibraryPath: picked };
      const saved = await bridge.updateSettings(next);
      setSettings(saved);
      showStatus(`已设置 Megascan 库路径：${picked}`, 2500);
    } catch (error) {
      showStatus(`设置失败：${String(error)}`, 10000);
    }
  }

  async function pickCustomPath() {
    if (!bridgeAvailable) {
      showStatus("设置路径需要桌面端环境", 10000);
      return;
    }
    try {
      const picked = await bridge.pickLibraryPath();
      if (!picked) return;

      const next = { ...settings, customLibraryPath: picked };
      const saved = await bridge.updateSettings(next);
      setSettings(saved);
      showStatus(`已设置 Custom 库路径：${picked}`, 2500);
    } catch (error) {
      showStatus(`设置失败：${String(error)}`, 10000);
    }
  }

  async function clearMegascanPath() {
    if (!bridgeAvailable) return;
    const next = { ...settings, megascanLibraryPath: "" };
    const saved = await bridge.updateSettings(next);
    setSettings(saved);
  }

  async function clearCustomPath() {
    if (!bridgeAvailable) return;
    const next = { ...settings, customLibraryPath: "" };
    const saved = await bridge.updateSettings(next);
    setSettings(saved);
  }

  async function clearEnginePath() {
    if (!bridgeAvailable) return;
    const saved = await bridge.updateSettings({ ...settings, unrealEditorPath: "", unrealProjectPath: "" });
    setSettings(saved);
  }

  async function clearProjectPath() {
    if (!bridgeAvailable) return;
    const saved = await bridge.updateSettings({ ...settings, unrealProjectPath: "", unrealEditorPath: "" });
    setSettings(saved);
  }

  async function clearLogPath() {
    if (!bridgeAvailable) return;
    saveSetting("unrealLogPath", "");
  }

  async function switchUiLanguage(nextLanguage: "zh" | "en") {
    if (uiLanguage === nextLanguage) {
      return;
    }
    await saveSetting("uiLanguage", nextLanguage);
    showStatus(nextLanguage === "zh" ? "已切换为中文" : "Switched to English", 2500);
  }

  function handleWindowMinimize() {
    if (!bridgeAvailable || typeof bridge.windowMinimize !== "function") {
      return;
    }
    void bridge.windowMinimize();
  }

  function handleWindowToggleMaximize() {
    if (!bridgeAvailable || typeof bridge.windowToggleMaximize !== "function") {
      return;
    }
    void bridge.windowToggleMaximize();
  }

  function handleWindowClose() {
    if (!bridgeAvailable || typeof bridge.windowClose !== "function") {
      return;
    }
    void bridge.windowClose();
  }

  async function clearCacheFiles() {
    if (!bridgeAvailable || typeof bridge.clearCaches !== "function") {
      showStatus(t("当前版本不支持清理缓存", "This build does not support cache cleanup"), 10000);
      return;
    }
    setBusy(true);
    showStatus(t("正在清理缓存...", "Clearing cache..."), 0);
    try {
      const result = await bridge.clearCaches();
      if (!result?.ok) {
        const detail = Array.isArray(result?.failed) && result.failed.length > 0
          ? `，失败 ${result.failed.length} 个`
          : "";
        showStatus(uiLanguage === "en" ? `Cache cleanup failed${detail}` : `清理缓存失败${detail}`, 10000);
        return;
      }
      setAllAssets([]);
      setAssets([]);
      setSelectedAssetId(null);
      setSelectedIds([]);
      setFavoriteIds(new Set());
      const removedCount = Array.isArray(result?.removed) ? result.removed.length : 0;
      showStatus(uiLanguage === "en" ? `Cache cleared, removed ${removedCount} files. Rescan started.` : `缓存已清理，共 ${removedCount} 个文件，已开始重扫资产库...`, 2500);
    } catch (error) {
      showStatus(uiLanguage === "en" ? `Cache cleanup failed: ${String(error)}` : `清理缓存失败：${String(error)}`, 10000);
    } finally {
      setBusy(false);
    }
  }

  async function saveSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    if (!bridgeAvailable) {
      return;
    }
    const next = { ...settings, [key]: value };
    const saved = await bridge.updateSettings(next);
    setSettings(saved);
  }

  async function changeExportResolution(value: string) {
    const normalized = normalizeExportResolutionValue(value);
    await saveSetting("exportResolution", normalized);
  }

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const toggleSelect = useCallback((assetId: string) => {
    setSelectedIds((prev) => (prev.includes(assetId) ? prev.filter((id) => id !== assetId) : [...prev, assetId]));
  }, []);

  const handleSelectAsset = useCallback((assetId: string) => {
    setSelectedAssetId(assetId);
    void refreshAssetFromDisk(assetId);
  }, [refreshAssetFromDisk]);

  function handleQuickExport(assetId: string) {
    void runImport([assetId]);
  }

  function toggleCategory(id: string) {
    if (id === "home") return;
    setExpandedCategories(prev => {
      // Accordion behavior: if we are expanding a top-level category, collapse others
      // "Top-level" means it's a direct child of Home or Favorite, or simply checking against known IDs
      // But here we can just simplify: if expanding 'id', remove all others that are siblings?
      // Since structure is simple (Home -> Categories -> Subcategories), 
      // let's just collapse everything else if the clicked item is a main category.

      const isExpanding = !prev.includes(id);

      // Known main categories
      const mainCategories = ["3d-assets", "3d-plants", "surfaces", "decals", "imperfections", "displacements",
        "fav-3d", "fav-3dplant", "fav-surface", "fav-decal", "fav-imperfection", "fav-displacement"];

      if (isExpanding && mainCategories.includes(id)) {
        // Collapse other main categories, keep 'home' and the new one
        return ["home", id];
      }

      return isExpanding ? [...prev, id] : prev.filter(c => c !== id);
    });
  }

  async function runImport(assetIds: string[]) {
    if (!bridgeAvailable) {
      showStatus("导入 Unreal 需要桌面端环境，请运行 npm run dev", 10000);
      return;
    }
    if (assetIds.length === 0) {
      showStatus("请先勾选资产", 2500);
      return;
    }
    if (!canExportToUnreal) {
      showStatus("未检测到可导出工程，请先配置目标并安装启用 AssetHive 插件", 10000);
      return;
    }
    setImportingAssetIds(assetIds);
    setIsExporting(true);
    clearExportForceFinishTimer();
    setExportProgress(0);
    setExportStage("准备导入任务");
    showStatus("正在导入 Unreal...", 0);
    try {
      const result = await bridge.exportToUnreal({
        assetIds,
        options: {
          ...settings,
          exportResolution: activeExportResolutionValue
        }
      });
      if (result.ok) {
        const pluginHint = result.pluginState?.copied ? "AssetHive plugin was auto-installed to project" : result.pluginState?.reason || "Using existing plugin";
        const logHint = result.logFile ? `，日志：${result.logFile}` : "";
        const sentHint = /已发送到 Unreal/i.test(String(result.message || "")) ? "已发送到 Unreal，导入进度请在引擎内查看" : "导入完成";
        showStatus(`${sentHint}：${result.jobFile || ""}，${pluginHint}${logHint}`, 4000);
      } else {
        showStatus(result.message, 10000);
      }
    } catch (error) {
      showStatus(`导入失败：${String(error)}`, 10000);
    } finally {
      clearExportForceFinishTimer();
      setIsExporting(false);
      setImportingAssetIds([]);
      setExportProgress(0);
      setExportStage("");
    }
  }

  async function pickTargetPath() {
    if (bridgeAvailable && bridge.pickTargetPath) {
      const pickTargetPath = (bridge as typeof bridge & {
        pickTargetPath?: () => Promise<{ type?: string; path?: string } | null>;
      }).pickTargetPath;
      const result = pickTargetPath ? await pickTargetPath() : null;
      if (result) {
        if (result.type === "engine") {
          const saved = await bridge.updateSettings({ ...settings, unrealEditorPath: result.path, unrealProjectPath: "" });
          setSettings(saved);
        } else if (result.type === "project") {
          const saved = await bridge.updateSettings({ ...settings, unrealProjectPath: result.path, unrealEditorPath: "" });
          setSettings(saved);
        }
      }
    }
  }

  const refreshPluginStatus = useCallback(async (nextSettings?: AppSettings) => {
    const targetSettings = nextSettings || settings;
    const editorPath = String(targetSettings.unrealEditorPath || "").trim();
    const projectPath = String(targetSettings.unrealProjectPath || "").trim();
    if (!bridgeAvailable || typeof bridge.getPluginStatus !== "function") {
      setPluginInstalled(false);
      setPluginCanInstall(false);
      setPluginStatusMessage("");
      setHasImportableProject(false);
      return;
    }
    if (!editorPath && !projectPath) {
      setPluginInstalled(false);
      setPluginCanInstall(false);
      setPluginStatusMessage("");
      setHasImportableProject(false);
      return;
    }
    try {
      const result = await bridge.getPluginStatus({ editorPath, projectPath });
      const resolvedProjectPath = String((result as { resolvedProjectPath?: string } | null)?.resolvedProjectPath || "").trim();
      if (!projectPath && resolvedProjectPath) {
        const saved = await bridge.updateSettings({ ...targetSettings, unrealProjectPath: resolvedProjectPath });
        setSettings(saved);
      }
      setPluginInstalled(Boolean(result?.installed && (result?.enabled ?? true)));
      setPluginCanInstall(Boolean(result?.canInstall ?? true));
      setPluginStatusMessage(String(result?.message || ""));
      setHasImportableProject(Boolean(resolvedProjectPath || projectPath || editorPath));
    } catch (error) {
      setPluginInstalled(false);
      setPluginCanInstall(false);
      setPluginStatusMessage(String(error || ""));
      setHasImportableProject(false);
    }
  }, [bridge, bridgeAvailable, settings]);

  async function installPluginForCurrentTarget() {
    if (!bridgeAvailable) {
      showStatus("请在桌面端运行后再安装插件", 10000);
      return;
    }
    const targetPath = String(settings.unrealEditorPath || settings.unrealProjectPath || "").trim();
    if (!targetPath) {
      showStatus("请先选择引擎目录或 .uproject", 10000);
      return;
    }
    const repo = String((settings as AppSettings & { pluginRepo?: string }).pluginRepo || "blackbladestudio/AssetHive");
    setPluginInstallBusy(true);
    setPluginInstallProgress(0);
    showStatus("正在安装 AssetHive 插件...", 0);
    try {
      if (typeof bridge.installPlugin === "function") {
        const result = await bridge.installPlugin(repo, targetPath);
        if (!result?.ok) {
          showStatus(result?.message || "插件安装失败", 10000);
          return;
        }
        showStatus(`插件安装完成：${result?.path || ""}`, 2500);
      } else if (typeof bridge.installPluginFromGithub === "function") {
        const result = await bridge.installPluginFromGithub();
        if (!result?.ok) {
          showStatus(result?.message || "插件安装失败", 10000);
          return;
        }
        showStatus(`插件安装完成：${result?.path || ""}`, 2500);
      } else {
        showStatus("当前版本不支持插件安装", 10000);
        return;
      }
      await refreshPluginStatus();
    } catch (error) {
      showStatus(`插件安装失败：${String(error)}`, 10000);
    } finally {
      setPluginInstallBusy(false);
    }
  }

  useEffect(() => {
    // 软件启动时静默检查更新
    if (bridgeAvailable && typeof bridge.checkAppUpdate === "function") {
      bridge.checkAppUpdate().then((result) => {
        if (result?.ok && result?.hasUpdate) {
          setAppUpdateState({
            checked: true,
            hasUpdate: true,
            updateReady: Boolean(result.updateReady),
            localPackagePath: String(result.localPackagePath || ""),
            currentVersion: String(result.currentVersion || ""),
            latestVersion: String(result.latestVersion || ""),
            releaseUrl: String(result.releaseUrl || ""),
            releaseName: String(result.name || ""),
            publishedAt: String(result.publishedAt || ""),
            releaseNotes: String(result.releaseNotes || ""),
            repo: String(result.repo || "")
          });
        }
      }).catch(() => {
        // 静默失败，不打扰用户
      });
    }
  }, [bridge, bridgeAvailable]);

  async function checkAppUpdate() {
    if (!bridgeAvailable || typeof bridge.checkAppUpdate !== "function") {
      setAppUpdateMessage("当前环境不支持检查更新");
      return;
    }
    setAppUpdateMode("checking");
    setAppUpdateBusy(true);
    setAppUpdateMessage("正在检查更新...");
    try {
      const result = await bridge.checkAppUpdate();
      if (!result?.ok) {
        setAppUpdateMessage(result?.message || "检查更新失败");
        return;
      }
      const hasUpdate = Boolean(result?.hasUpdate);
      setAppUpdateState({
        checked: true,
        hasUpdate,
        updateReady: Boolean(result?.updateReady),
        localPackagePath: String(result?.localPackagePath || ""),
        currentVersion: String(result?.currentVersion || ""),
        latestVersion: String(result?.latestVersion || ""),
        releaseUrl: String(result?.releaseUrl || ""),
        releaseName: String(result?.name || ""),
        publishedAt: String(result?.publishedAt || ""),
        releaseNotes: String(result?.releaseNotes || ""),
        repo: String(result?.repo || "")
      });
      // Do not set appUpdateMessage here for the "no update" case so it doesn't show at the bottom
      if (hasUpdate) {
        setAppUpdateMessage(result?.updateReady ? "检测到本地已下载更新包，可直接点击安装" : "检测到新版本，可点击更新下载");
      } else {
        setAppUpdateMessage("");
      }
    } catch (error) {
      setAppUpdateMessage(`检查更新失败：${String(error)}`);
    } finally {
      setAppUpdateMode("idle");
      setAppUpdateBusy(false);
    }
  }

  async function downloadAppUpdate() {
    if (!bridgeAvailable || typeof bridge.downloadAppUpdate !== "function") {
      setAppUpdateMessage("当前环境不支持下载更新");
      return;
    }
    setAppUpdateMode("downloading");
    setAppUpdateDownloadProgress(0);
    setAppUpdateDownloadedBytes(0);
    setAppUpdateTotalBytes(0);
    setAppUpdateBusy(true);
    setAppUpdateMessage("正在下载更新...");
    try {
      const result = await bridge.downloadAppUpdate();
      if (!result?.ok) {
        setAppUpdateMessage(result?.message || "下载更新失败");
        return;
      }
      if (!result?.hasUpdate) {
        setAppUpdateMessage(result?.message || "已经是最新版本");
        return;
      }
      setAppUpdateDownloadProgress(100);
      setAppUpdateState((prev) => ({
        ...prev,
        checked: true,
        hasUpdate: true,
        updateReady: Boolean(result?.updateReady),
        localPackagePath: String(result?.filePath || prev.localPackagePath || "")
      }));
      setAppUpdateMessage(result?.filePath ? `更新包已下载：${result.filePath}` : "更新包已下载");
      setStatus("更新包下载完成，请点击安装");
    } catch (error) {
      setAppUpdateMessage(`下载更新失败：${String(error)}`);
    } finally {
      setAppUpdateMode("idle");
      setAppUpdateBusy(false);
    }
  }

  async function installDownloadedUpdatePackage() {
    const packagePath = String(appUpdateState.localPackagePath || "").trim();
    if (!packagePath) {
      setAppUpdateMessage("未找到可安装的本地更新包");
      return;
    }
    if (!bridgeAvailable || typeof bridge.installDownloadedUpdate !== "function") {
      setAppUpdateMessage("当前环境不支持安装更新包");
      return;
    }
    setAppUpdateMode("installing");
    setAppUpdateBusy(true);
    setAppUpdateMessage("正在启动安装程序...");
    try {
      const result = await bridge.installDownloadedUpdate({ filePath: packagePath });
      if (!result?.ok) {
        setAppUpdateMessage(result?.message || "启动安装失败");
        return;
      }
      setAppUpdateMessage(result?.message || "安装程序已启动");
    } catch (error) {
      setAppUpdateMessage(`启动安装失败：${String(error)}`);
    } finally {
      setAppUpdateMode("idle");
      setAppUpdateBusy(false);
    }
  }

  useEffect(() => {
    if (!bridgeAvailable || typeof bridge.onAppUpdateDownloadProgress !== "function") {
      return;
    }
    const unsubscribe = bridge.onAppUpdateDownloadProgress((payload) => {
      const value = payload?.progress;
      if (typeof value === "number" && Number.isFinite(value)) {
        setAppUpdateDownloadProgress(Math.max(0, Math.min(100, value)));
      } else {
        setAppUpdateDownloadProgress(null);
      }
      const loaded = Number(payload?.loaded);
      const total = Number(payload?.total);
      setAppUpdateDownloadedBytes(Number.isFinite(loaded) && loaded > 0 ? loaded : 0);
      setAppUpdateTotalBytes(Number.isFinite(total) && total > 0 ? total : 0);
    });
    return () => unsubscribe();
  }, [bridge, bridgeAvailable]);

  async function pickLogPath() {
    if (bridgeAvailable && typeof bridge.pickLogPath === "function") {
      const picked = await bridge.pickLogPath();
      if (picked) {
        await saveSetting("unrealLogPath", picked);
        showStatus(`已设置 Unreal 导入日志：${picked}`, 2500);
      }
    }
  }

  useEffect(() => {
    if (!bridgeAvailable || typeof bridge.onPluginInstallProgress !== "function") {
      return;
    }
    const unsubscribe = bridge.onPluginInstallProgress((payload) => {
      const progress = Number(payload?.progress);
      const stage = String(payload?.stage || "").trim();
      if (Number.isFinite(progress)) {
        setPluginInstallProgress(Math.max(0, Math.min(100, progress)));
      }
      if (stage) {
        const stageLabel = stage === "fetching_info"
          ? "正在获取发布信息..."
          : stage === "downloading"
            ? "正在下载插件..."
            : stage === "extracting"
              ? "正在解压插件..."
              : stage === "installing"
                ? "正在安装插件..."
                : stage === "completed"
                  ? "插件安装完成"
                  : "";
        if (stageLabel) {
          setPluginStatusMessage(stageLabel);
        }
      }
    });
    return () => {
      unsubscribe();
    };
  }, [bridge, bridgeAvailable]);

  useEffect(() => {
    void refreshPluginStatus();
  }, [refreshPluginStatus, settings.unrealEditorPath, settings.unrealProjectPath]);

  useEffect(() => {
    if (!bridgeAvailable || typeof bridge.getUnrealConnectionStatus !== "function") {
      setUnrealConnected(false);
      setUnrealConnectedTargetName("");
      return;
    }
    let disposed = false;
    const updateConnectionStatus = async () => {
      try {
        const result = await bridge.getUnrealConnectionStatus();
        if (disposed) {
          return;
        }
        setUnrealConnected(Boolean(result?.connected));
        setUnrealConnectedTargetName(String(result?.targetName || "").trim());
      } catch {
        if (!disposed) {
          setUnrealConnected(false);
          setUnrealConnectedTargetName("");
        }
      }
    };
    void updateConnectionStatus();
    const timer = window.setInterval(() => {
      void updateConnectionStatus();
    }, 4000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [bridge, bridgeAvailable, settings.unrealProjectPath, settings.unrealEditorPath]);

  async function pickImportPreview() {
    if (!bridgeAvailable) {
      showStatus("导入资产需要桌面端环境，请运行 npm run dev", 10000);
      return;
    }
    const picked = await bridge.pickAssetImage();
    if (picked) {
      setImportForm((prev) => ({ ...prev, previewImagePath: picked }));
    }
  }

  async function pickEditPreview() {
    if (!bridgeAvailable) {
      showStatus("编辑资产需要桌面端环境，请运行 npm run dev", 10000);
      return;
    }
    const picked = await bridge.pickAssetImage();
    if (picked) {
      setEditForm((prev) => ({ ...prev, previewImagePath: picked }));
    }
  }

  function isMeshSlotKey(slotKey: string) {
    return /^mesh(?:\d+)?$/i.test(String(slotKey || "").trim());
  }

  function getMeshSlotOrder(slotKey: string) {
    const normalized = String(slotKey || "").trim();
    if (!normalized) {
      return Number.MAX_SAFE_INTEGER;
    }
    if (/^mesh$/i.test(normalized)) {
      return 1;
    }
    const matched = normalized.match(/^mesh(\d+)$/i);
    if (!matched) {
      return Number.MAX_SAFE_INTEGER;
    }
    const parsed = Number(matched[1]);
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  }

  function formatMeshSlotKey(order: number) {
    if (order <= 1) {
      return meshSlotBaseName;
    }
    return `${meshSlotBaseName}${String(order).padStart(2, "0")}`;
  }

  function getOrderedMeshSlotKeys(modelSlots: Record<string, string>) {
    const keys = Object.keys(modelSlots).filter((slotKey) => isMeshSlotKey(slotKey));
    keys.sort((a, b) => getMeshSlotOrder(a) - getMeshSlotOrder(b));
    return keys;
  }

  function getDisplayMeshSlotKeys(modelSlots: Record<string, string>) {
    const ordered = getOrderedMeshSlotKeys(modelSlots);
    if (ordered.length > 0) {
      return ordered;
    }
    return [meshSlotBaseName];
  }

  function getNextMeshSlotKey(modelSlots: Record<string, string>) {
    const ordered = getOrderedMeshSlotKeys(modelSlots);
    if (ordered.length === 0) {
      return meshSlotBaseName;
    }
    const maxOrder = Math.max(...ordered.map((slotKey) => getMeshSlotOrder(slotKey)).filter((value) => Number.isFinite(value)));
    return formatMeshSlotKey((Number.isFinite(maxOrder) ? maxOrder : 1) + 1);
  }

  function getMeshSlotLabel(slotKey: string) {
    const order = getMeshSlotOrder(slotKey);
    if (!Number.isFinite(order) || order <= 0) {
      return "Var1";
    }
    return `Var${order}`;
  }

  function formatTextureAreaOrder(order: number) {
    return String(Math.max(1, Number(order) || 1)).padStart(3, "0");
  }

  function getTextureAreaIdList(entries: TextureEntry[]) {
    const ids = [...new Set(entries.map((entry) => Math.max(1, Number(entry.areaId) || 1)))];
    ids.sort((a, b) => a - b);
    return ids.length > 0 ? ids : [1];
  }

  function getTextureSlotToken(textureType: string, areaId: number, areaCount: number, entryId?: string) {
    const normalizedType = String(textureType || "").trim();
    if (!normalizedType) {
      return "";
    }
    const shouldAttachDisplacementEntryId = () => {
      if (normalizedType.toLowerCase() !== "displacement") {
        return false;
      }
      const id = String(entryId || "").trim();
      if (!id) {
        return false;
      }
      return id.startsWith("import-default-") || id.startsWith("edit-default-");
    };
    const suffix = shouldAttachDisplacementEntryId() ? `_${String(entryId || "").trim()}` : "";
    if (areaCount <= 1) {
      return `${normalizedType}${suffix}`;
    }
    return `${formatTextureAreaOrder(areaId)}_${normalizedType}${suffix}`;
  }

  function parseTextureSlotToken(value: string) {
    const raw = String(value || "").trim();
    const prefixed = raw.match(/^(\d{3})[_-](.+)$/);
    if (prefixed) {
      const areaId = Math.max(1, Number(prefixed[1]) || 1);
      const textureType = String(prefixed[2] || "").trim();
      return { areaId, textureType };
    }
    return { areaId: 1, textureType: raw };
  }

  function inferTextureAreaIdFromPath(filePath: string) {
    const baseName = String(filePath || "").split(/[\\/]/).pop() || "";
    const matched = baseName.match(/_(\d{3})_[^_.]+(?:\.[^.]+)?$/i);
    if (!matched) {
      return 1;
    }
    const parsed = Number(matched[1]);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
  }

  async function pickImportModel(modelType: string) {
    if (!bridgeAvailable) {
      showStatus("导入资产需要桌面端环境，请运行 npm run dev", 10000);
      return;
    }
    let picked = "";
    if (typeof bridge.pickAssetFile === "function") {
      picked = (await bridge.pickAssetFile("model")) || "";
      if (!picked) {
        showStatus(`未选择${getMeshSlotLabel(modelType)}模型文件`, 10000);
        return;
      }
    } else {
      picked = await pickFileByInput(".fbx,.obj,.abc,.gltf,.glb");
    }
    if (picked && !isModelFileAcceptedForType(picked, modelType)) {
      showStatus(`${getMeshSlotLabel(modelType)} 不支持该模型格式`, 10000);
      return;
    }
    if (picked) {
      setImportForm((prev) => ({
        ...prev,
        modelSlots: { ...prev.modelSlots, [modelType]: picked },
        enabledModelTypes: [...new Set([...prev.enabledModelTypes, modelType])]
      }));
      return;
    }
    showStatus(`未选择${getMeshSlotLabel(modelType)}模型文件`, 10000);
  }

  async function pickImportTexture(entryId: string) {
    if (!bridgeAvailable) {
      showStatus("导入资产需要桌面端环境，请运行 npm run dev", 10000);
      return;
    }
    let picked = "";
    if (typeof bridge.pickAssetFile === "function") {
      const acceptType = importForm.assetType === "hdri" ? "hdri" : "texture";
      picked = (await bridge.pickAssetFile(acceptType)) || "";
      if (!picked) {
        showStatus("未选择贴图文件", 10000);
        return;
      }
    } else {
      picked = await pickFileByInput(importForm.assetType === "hdri" ? ".hdr,.exr" : ".png,.jpg,.jpeg,.tif,.tiff,.exr,.tga,.webp,.bmp");
    }
    if (picked && !isTextureFileAccepted(picked, importForm.assetType)) {
      const exts = getAcceptedTextureExtsForAssetType(importForm.assetType).join(", ");
      showStatus(`贴图格式无效（允许：${exts}）`, 10000);
      return;
    }
    if (picked) {
      setImportForm((prev) => ({
        ...prev,
        textureEntries: prev.textureEntries.map((entry) => entry.id === entryId ? { ...entry, filePath: picked } : entry)
      }));
      return;
    }
    showStatus("未选择贴图文件", 10000);
  }

  async function pickEditModel(modelType: string) {
    if (!bridgeAvailable) {
      showStatus("编辑资产需要桌面端环境，请运行 npm run dev", 10000);
      return;
    }
    let picked = "";
    if (typeof bridge.pickAssetFile === "function") {
      picked = (await bridge.pickAssetFile("model")) || "";
      if (!picked) {
        showStatus(`未选择${getMeshSlotLabel(modelType)}模型文件`, 10000);
        return;
      }
    } else {
      picked = await pickFileByInput(".fbx,.obj,.abc,.gltf,.glb");
    }
    if (picked && !isModelFileAcceptedForType(picked, modelType)) {
      showStatus(`${getMeshSlotLabel(modelType)} 不支持该模型格式`, 10000);
      return;
    }
    if (!picked) {
      showStatus(`未选择${getMeshSlotLabel(modelType)}模型文件`, 10000);
      return;
    }
    setEditForm((prev) => ({
      ...prev,
      modelSlots: { ...prev.modelSlots, [modelType]: picked },
      enabledModelTypes: [...new Set([...prev.enabledModelTypes, modelType])]
    }));
  }

  async function pickEditTexture(entryId: string) {
    if (!bridgeAvailable) {
      showStatus("编辑资产需要桌面端环境，请运行 npm run dev", 10000);
      return;
    }
    let picked = "";
    if (typeof bridge.pickAssetFile === "function") {
      const acceptType = editForm.assetType === "hdri" ? "hdri" : "texture";
      picked = (await bridge.pickAssetFile(acceptType)) || "";
      if (!picked) {
        showStatus("未选择贴图文件", 10000);
        return;
      }
    } else {
      picked = await pickFileByInput(editForm.assetType === "hdri" ? ".hdr,.exr" : ".png,.jpg,.jpeg,.tif,.tiff,.exr,.tga,.webp,.bmp");
    }
    if (picked && !isTextureFileAccepted(picked, editForm.assetType)) {
      const exts = getAcceptedTextureExtsForAssetType(editForm.assetType).join(", ");
      showStatus(`贴图格式无效（允许：${exts}）`, 10000);
      return;
    }
    if (!picked) {
      showStatus("未选择贴图文件", 10000);
      return;
    }
    setEditForm((prev) => ({
      ...prev,
      textureEntries: prev.textureEntries.map((entry) => entry.id === entryId ? { ...entry, filePath: picked } : entry)
    }));
  }

  async function resolveDroppedFilePath(file: (File & { path?: string }) | null | undefined) {
    if (!file) {
      return "";
    }
    if (file.path) {
      return file.path;
    }
    if (bridgeAvailable && typeof bridge.getDroppedFilePath === "function") {
      try {
        const resolvedPath = String(bridge.getDroppedFilePath(file) || "").trim();
        if (resolvedPath) {
          return resolvedPath;
        }
      } catch {
        void 0;
      }
    }
    if (bridgeAvailable && typeof bridge.materializeDroppedFile === "function") {
      try {
        const bytes = await file.arrayBuffer();
        const materialized = String(await bridge.materializeDroppedFile({
          name: file.name || "dropped-file.bin",
          bytes
        }) || "").trim();
        if (materialized) {
          return materialized;
        }
      } catch {
        void 0;
      }
    }
    return "";
  }

  async function readDroppedPath(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const dataTransfer = event.dataTransfer;
    const transferFiles = Array.from(dataTransfer.files || []) as Array<File & { path?: string }>;
    const itemFiles = Array.from(dataTransfer.items || [])
      .map((item) => item.getAsFile() as File & { path?: string } | null)
      .filter((file): file is File & { path?: string } => Boolean(file));
    const fileCandidates = [...transferFiles, ...itemFiles];
    const dedupedFiles = Array.from(new Map(fileCandidates.map((file) => [
      `${file.name || ""}|${file.size || 0}|${file.type || ""}|${file.lastModified || 0}`,
      file
    ])).values());
    for (const droppedFile of dedupedFiles) {
      const resolvedPath = await resolveDroppedFilePath(droppedFile);
      if (resolvedPath) {
        return resolvedPath;
      }
    }
    const transferTexts = [
      dataTransfer.getData("text/uri-list"),
      dataTransfer.getData("text/plain"),
      dataTransfer.getData("text"),
      dataTransfer.getData("DownloadURL")
    ].filter(Boolean);
    for (const rawText of transferTexts) {
      const normalizedLine = String(rawText)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith("#")) || "";
      if (!normalizedLine) {
        continue;
      }
      const fromDownloadUrl = normalizedLine.includes("file://")
        ? normalizedLine.slice(normalizedLine.indexOf("file://"))
        : normalizedLine;
      const cleaned = fromDownloadUrl.split("\0").join("").replace(/^"|"$/g, "");
      if (!cleaned) {
        continue;
      }
      try {
        return normalizeLocalPath(decodeURIComponent(cleaned));
      } catch {
        return normalizeLocalPath(cleaned);
      }
    }
    return "";
  }

  function normalizeLocalPath(filePath: string) {
    const trimmed = String(filePath || "").trim().replace(/^"|"$/g, "");
    const fromUri = trimmed.replace(/^file:\/+/i, "");
    const withUnc = /^[a-zA-Z]:/.test(fromUri) ? fromUri : (trimmed.toLowerCase().startsWith("file://") ? `\\\\${fromUri}` : fromUri);
    const withoutLeading = withUnc.replace(/^\/([a-zA-Z]:[\\/])/, "$1");
    return withoutLeading.replace(/\//g, "\\");
  }

  function makeTextureEntry(textureType = "", filePath = "", areaId = 1) {
    return {
      id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      textureType,
      filePath,
      areaId: Math.max(1, Number(areaId) || 1)
    };
  }

  function removeImportModelSlot(modelType: string) {
    setImportForm((prev) => {
      const nextSlots = { ...prev.modelSlots };
      delete nextSlots[modelType];
      return {
        ...prev,
        modelSlots: nextSlots,
        enabledModelTypes: prev.enabledModelTypes.filter((item) => item !== modelType)
      };
    });
  }

  function removeEditModelSlot(modelType: string) {
    setEditForm((prev) => {
      const nextSlots = { ...prev.modelSlots };
      delete nextSlots[modelType];
      return {
        ...prev,
        modelSlots: nextSlots,
        enabledModelTypes: prev.enabledModelTypes.filter((item) => item !== modelType)
      };
    });
  }

  function addImportModelSlot() {
    setImportForm((prev) => {
      const nextSlotKey = getNextMeshSlotKey(prev.modelSlots);
      return {
        ...prev,
        modelSlots: { ...prev.modelSlots, [nextSlotKey]: prev.modelSlots[nextSlotKey] || "" },
        enabledModelTypes: [...new Set([...prev.enabledModelTypes, nextSlotKey])]
      };
    });
  }

  function addEditModelSlot() {
    setEditForm((prev) => {
      const nextSlotKey = getNextMeshSlotKey(prev.modelSlots);
      return {
        ...prev,
        modelSlots: { ...prev.modelSlots, [nextSlotKey]: prev.modelSlots[nextSlotKey] || "" },
        enabledModelTypes: [...new Set([...prev.enabledModelTypes, nextSlotKey])]
      };
    });
  }

  function addImportTextureEntry(areaId?: number) {
    setImportForm((prev) => {
      const areaIds = getTextureAreaIdList(prev.textureEntries);
      const targetAreaId = Math.max(1, Number(areaId) || areaIds[areaIds.length - 1] || 1);
      return { ...prev, textureEntries: [...prev.textureEntries, makeTextureEntry("", "", targetAreaId)] };
    });
  }

  function addEditTextureEntry(areaId?: number) {
    setEditForm((prev) => {
      const areaIds = getTextureAreaIdList(prev.textureEntries);
      const targetAreaId = Math.max(1, Number(areaId) || areaIds[areaIds.length - 1] || 1);
      return { ...prev, textureEntries: [...prev.textureEntries, makeTextureEntry("", "", targetAreaId)] };
    });
  }

  function addImportTextureArea() {
    setImportForm((prev) => {
      const areaIds = getTextureAreaIdList(prev.textureEntries);
      const nextAreaId = (areaIds[areaIds.length - 1] || 1) + 1;
      return {
        ...prev,
        normalMapFormats: { ...prev.normalMapFormats, [nextAreaId]: prev.normalMapFormats[1] || prev.normalMapFormat },
        textureEntries: [...prev.textureEntries, ...defaultTextureTypes.map((textureType) => makeTextureEntry(textureType, "", nextAreaId))]
      };
    });
  }

  function addEditTextureArea() {
    setEditForm((prev) => {
      const areaIds = getTextureAreaIdList(prev.textureEntries);
      const nextAreaId = (areaIds[areaIds.length - 1] || 1) + 1;
      return {
        ...prev,
        normalMapFormats: { ...prev.normalMapFormats, [nextAreaId]: prev.normalMapFormats[1] || prev.normalMapFormat },
        textureEntries: [...prev.textureEntries, ...defaultTextureTypes.map((textureType) => makeTextureEntry(textureType, "", nextAreaId))]
      };
    });
  }

  function reindexTextureAreas(entries: TextureEntry[]) {
    const areaIds = getTextureAreaIdList(entries);
    const areaIdMap = new Map(areaIds.map((areaId, index) => [areaId, index + 1]));
    return entries.map((entry) => ({
      ...entry,
      areaId: areaIdMap.get(Math.max(1, Number(entry.areaId) || 1)) || 1
    }));
  }

  function removeImportTextureArea(areaId: number) {
    setImportForm((prev) => {
      const filtered = prev.textureEntries.filter((entry) => Math.max(1, Number(entry.areaId) || 1) !== areaId);
      const reindexedEntries = reindexTextureAreas(filtered);
      const nextNormalMapFormats = normalizeNormalMapFormatsByArea(prev.normalMapFormats, reindexedEntries, prev.normalMapFormat);
      return {
        ...prev,
        textureEntries: reindexedEntries,
        normalMapFormats: nextNormalMapFormats
      };
    });
  }

  function removeEditTextureArea(areaId: number) {
    setEditForm((prev) => {
      const filtered = prev.textureEntries.filter((entry) => Math.max(1, Number(entry.areaId) || 1) !== areaId);
      const reindexedEntries = reindexTextureAreas(filtered);
      const nextNormalMapFormats = normalizeNormalMapFormatsByArea(prev.normalMapFormats, reindexedEntries, prev.normalMapFormat);
      return {
        ...prev,
        textureEntries: reindexedEntries,
        normalMapFormats: nextNormalMapFormats
      };
    });
  }

  function toggleImportNormalMapFormat(areaId: number) {
    setImportForm((prev) => {
      const current = getNormalMapFormatForArea(prev, areaId);
      const next = current === "dx" ? "opengl" : "dx";
      return {
        ...prev,
        normalMapFormat: areaId === 1 ? next : prev.normalMapFormat,
        normalMapFormats: { ...prev.normalMapFormats, [areaId]: next }
      };
    });
  }

  function toggleEditNormalMapFormat(areaId: number) {
    setEditForm((prev) => {
      const current = getNormalMapFormatForArea(prev, areaId);
      const next = current === "dx" ? "opengl" : "dx";
      return {
        ...prev,
        normalMapFormat: areaId === 1 ? next : prev.normalMapFormat,
        normalMapFormats: { ...prev.normalMapFormats, [areaId]: next }
      };
    });
  }

  function removeImportTextureEntry(entryId: string) {
    setImportForm((prev) => ({ ...prev, textureEntries: prev.textureEntries.filter((entry) => entry.id !== entryId) }));
  }

  function removeEditTextureEntry(entryId: string) {
    setEditForm((prev) => ({ ...prev, textureEntries: prev.textureEntries.filter((entry) => entry.id !== entryId) }));
  }

  function updateImportTextureType(entryId: string, nextType: string) {
    setImportForm((prev) => ({ ...prev, textureEntries: prev.textureEntries.map((entry) => entry.id === entryId ? { ...entry, textureType: nextType } : entry) }));
  }

  function updateEditTextureType(entryId: string, nextType: string) {
    setEditForm((prev) => ({ ...prev, textureEntries: prev.textureEntries.map((entry) => entry.id === entryId ? { ...entry, textureType: nextType } : entry) }));
  }

  function parseTagsText(tagsText: string) {
    return [...new Set(String(tagsText || "").split(",").map((tag) => tag.trim()).filter(Boolean))];
  }

  function parseTagsFromClipboard(rawText: string) {
    return [...new Set(String(rawText || "").split(/[\n\r,，、;；\t]+/).map((tag) => tag.trim()).filter(Boolean))];
  }

  function syncImportTags(tags: string[]) {
    setImportForm((prev) => ({ ...prev, tagsText: tags.join(", ") }));
  }

  function syncEditTags(tags: string[]) {
    setEditForm((prev) => ({ ...prev, tagsText: tags.join(", ") }));
  }

  function addImportTag(rawValue: string) {
    const tag = String(rawValue || "").trim();
    if (!tag) {
      return;
    }
    const nextTags = [...new Set([...parseTagsText(importForm.tagsText), tag])];
    syncImportTags(nextTags);
    setImportTagInput("");
  }

  function removeImportTag(tagToRemove: string) {
    const nextTags = parseTagsText(importForm.tagsText).filter((tag) => tag !== tagToRemove);
    syncImportTags(nextTags);
  }

  function addEditTag(rawValue: string) {
    const tag = String(rawValue || "").trim();
    if (!tag) {
      return;
    }
    const nextTags = [...new Set([...parseTagsText(editForm.tagsText), tag])];
    syncEditTags(nextTags);
    setEditTagInput("");
  }

  function removeEditTag(tagToRemove: string) {
    const nextTags = parseTagsText(editForm.tagsText).filter((tag) => tag !== tagToRemove);
    syncEditTags(nextTags);
  }

  async function copyTagsText(tagsText: string) {
    const value = parseTagsText(tagsText).join(", ");
    if (!value) {
      showStatus("标签为空，无法复制", 10000);
      return;
    }
    try {
      if (bridgeAvailable && typeof bridge.copyText === "function") {
        await bridge.copyText(value);
      } else if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        showStatus("当前环境不支持复制功能", 10000);
        return;
      }
      showStatus("标签已复制", 2500);
    } catch (error) {
      showStatus(`复制标签失败：${String(error)}`, 10000);
    }
  }

  async function pasteEditTagsFromClipboard() {
    try {
      const text = typeof navigator !== "undefined" && navigator.clipboard?.readText ? await navigator.clipboard.readText() : "";
      const tags = parseTagsFromClipboard(text);
      if (tags.length === 0) {
        return;
      }
      syncEditTags([...new Set([...parseTagsText(editForm.tagsText), ...tags])]);
    } catch (error) {
      showStatus(`粘贴标签失败：${String(error)}`, 10000);
    }
  }

  async function pasteDetailTagsToSearch() {
    try {
      const text = typeof navigator !== "undefined" && navigator.clipboard?.readText ? await navigator.clipboard.readText() : "";
      const tags = parseTagsFromClipboard(text).map((tag) => tag.toLowerCase());
      if (tags.length === 0) {
        return;
      }
      await executeSearch({
        ...search,
        tags: [...new Set([...search.tags, ...tags])]
      });
    } catch (error) {
      showStatus(`粘贴标签失败：${String(error)}`, 10000);
    }
  }

  function handleTagContextMenu(event: React.MouseEvent, scope: "detail" | "edit", tag = "") {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    setTagContextMenu({ x: event.clientX, y: event.clientY, scope, tag: tag || undefined });
  }

  async function runTagContextAction(action: "copy-all" | "copy-one" | "paste") {
    if (!tagContextMenu) {
      return;
    }
    const { scope, tag } = tagContextMenu;
    setTagContextMenu(null);
    if (action === "copy-one") {
      await copyTagsText(tag || "");
      return;
    }
    if (action === "copy-all") {
      if (scope === "detail") {
        await copyTagsText((selectedAsset?.tags || []).join(", "));
      } else {
        await copyTagsText(editForm.tagsText);
      }
      return;
    }
    if (scope === "detail") {
      await pasteDetailTagsToSearch();
    } else {
      await pasteEditTagsFromClipboard();
    }
  }

  function inferTextureTypeFromPath(filePath: string) {
    const name = filePath.split("\\").pop()?.toLowerCase() || "";
    for (const textureType of textureTypeOptions) {
      if (name.includes(textureType.toLowerCase())) {
        return textureType;
      }
    }
    return "";
  }

  function buildEditSlots(asset: AssetRecord) {
    const modelSlots: Record<string, string> = {};
    const textureEntryMap = new Map<string, TextureEntry>();
    const normalMapFormatsByArea: Record<number, "dx" | "opengl"> = {};
    const enabledModelTypes = new Set<string>();
    const metaObject = asset?.meta && typeof asset.meta === "object" ? (asset.meta as Record<string, unknown>) : null;
    const assetDir = String(asset?.path || "").trim();
    const assetTypeToken = String((metaObject as { assetType?: string; asset_type?: string } | null)?.assetType || (metaObject as { asset_type?: string } | null)?.asset_type || asset.assetType || "").trim().toLowerCase();
    const isHdriAsset = assetTypeToken === "hdri";
    const resolveAssetPath = (rawPath: string) => {
      const normalizedRaw = String(rawPath || "").trim();
      if (!normalizedRaw) {
        return "";
      }
      const localPath = normalizeLocalPath(normalizedRaw);
      if (/^[a-zA-Z]:[\\/]/.test(localPath) || /^\\\\/.test(localPath)) {
        return localPath;
      }
      if (!assetDir) {
        return localPath;
      }
      const base = normalizeLocalPath(assetDir).replace(/[\\/]+$/, "");
      const child = localPath.replace(/^[\\/]+/, "");
      return normalizeLocalPath(`${base}\\${child}`);
    };

    const modelPaths = new Set<string>();
    const metaModelSlots = metaObject ? (metaObject as { modelSlots?: Record<string, string> }).modelSlots : null;
    if (metaModelSlots && typeof metaModelSlots === "object") {
      for (const filePath of Object.values(metaModelSlots)) {
        const normalizedPath = resolveAssetPath(String(filePath || "").trim());
        if (!normalizedPath) {
          continue;
        }
        modelPaths.add(normalizedPath);
      }
    }

    if (Array.isArray(metaObject?.components)) {
      const modelComponents = (metaObject.components as Array<Record<string, unknown>>).filter((item) => String(item?.type || "").toLowerCase() === "model");
      for (const item of modelComponents) {
        const normalizedPath = resolveAssetPath(String(item?.uri || item?.path || "").trim());
        if (!normalizedPath) {
          continue;
        }
        modelPaths.add(normalizedPath);
      }
    }

    for (const filePath of (asset.modelFiles || [])) {
      const normalizedPath = resolveAssetPath(String(filePath || "").trim());
      if (normalizedPath) {
        modelPaths.add(normalizedPath);
      }
    }

    const orderedModelPaths = [...modelPaths];
    if (orderedModelPaths.length > 0) {
      orderedModelPaths.forEach((filePath, index) => {
        const slotKey = formatMeshSlotKey(index + 1);
        modelSlots[slotKey] = filePath;
        enabledModelTypes.add(slotKey);
      });
    } else {
      enabledModelTypes.add(meshSlotBaseName);
    }

    const metaTextureComponents = Array.isArray(metaObject?.components)
      ? (metaObject.components as Array<Record<string, unknown>>).filter((item) => String(item?.type || "").toLowerCase() === "texture")
      : [];
    const metaNormalMapFormats = metaObject && typeof (metaObject as { normalMapFormats?: unknown }).normalMapFormats === "object"
      ? (metaObject as { normalMapFormats?: Record<string, string> }).normalMapFormats || {}
      : {};
    for (const [areaKey, formatRaw] of Object.entries(metaNormalMapFormats)) {
      const areaId = Math.max(1, Number(areaKey) || 1);
      const format = String(formatRaw || "").trim().toLowerCase() === "opengl" ? "opengl" : "dx";
      normalMapFormatsByArea[areaId] = format;
    }
    const fallbackNormalMapFormat = String((metaObject as { normalMapFormat?: string } | null)?.normalMapFormat || "dx").trim().toLowerCase() === "opengl" ? "opengl" : "dx";
    for (const item of metaTextureComponents) {
      const parsedSlot = parseTextureSlotToken(String(item?.slot || item?.textureType || "").trim());
      const normalizedSlot = textureTypeOptions.find((type) => type.toLowerCase() === String(parsedSlot.textureType || "").trim().toLowerCase());
      const areaId = Math.max(1, Number(item?.areaIndex) || parsedSlot.areaId || 1);
      const normalizedPath = resolveAssetPath(String(item?.uri || item?.path || "").trim());
      if (!normalizedSlot || !normalizedPath) {
        continue;
      }
      if (isHdriAsset && normalizedSlot.toLowerCase() !== "hdr") {
        continue;
      }
      const entryKey = `${areaId}:${normalizedSlot.toLowerCase()}`;
      if (!textureEntryMap.has(entryKey)) {
        textureEntryMap.set(entryKey, makeTextureEntry(normalizedSlot, normalizedPath, areaId));
      }
      if (String(normalizedSlot || "").toLowerCase() === "normal") {
        const source = String(item?.normalMapFormat || "").trim().toLowerCase();
        if (!normalMapFormatsByArea[areaId] || source === "opengl") {
          normalMapFormatsByArea[areaId] = source === "opengl" ? "opengl" : normalMapFormatsByArea[areaId] || fallbackNormalMapFormat;
        }
      }
    }

    for (const filePath of (asset.textureFiles || [])) {
      const textureType = inferTextureTypeFromPath(filePath);
      if (!textureType) {
        continue;
      }
      if (isHdriAsset && textureType.toLowerCase() !== "hdr") {
        continue;
      }
      const areaId = inferTextureAreaIdFromPath(filePath);
      const entryKey = `${areaId}:${textureType.toLowerCase()}`;
      if (!textureEntryMap.has(entryKey)) {
        textureEntryMap.set(entryKey, makeTextureEntry(textureType, resolveAssetPath(String(filePath || "").trim()), areaId));
      }
    }

    if (isHdriAsset) {
      const hdrKey = "1:hdr";
      if (!textureEntryMap.has(hdrKey)) {
        textureEntryMap.set(hdrKey, makeTextureEntry("HDR", "", 1));
      }
    } else {
      const areaIds = getTextureAreaIdList([...textureEntryMap.values()]);
      for (const areaId of areaIds) {
        for (const textureType of defaultTextureTypes) {
          const entryKey = `${areaId}:${textureType.toLowerCase()}`;
          if (!textureEntryMap.has(entryKey)) {
            textureEntryMap.set(entryKey, makeTextureEntry(textureType, "", areaId));
          }
        }
      }
    }

    const textureEntries = [...textureEntryMap.values()].sort((a, b) => {
      if (a.areaId !== b.areaId) {
        return a.areaId - b.areaId;
      }
      return String(a.textureType || "").localeCompare(String(b.textureType || ""));
    });
    const areaIdsForFormat = getTextureAreaIdList(textureEntries);
    for (const areaId of areaIdsForFormat) {
      if (!normalMapFormatsByArea[areaId]) {
        normalMapFormatsByArea[areaId] = fallbackNormalMapFormat;
      }
    }

    return {
      modelSlots,
      textureEntries,
      normalMapFormats: normalMapFormatsByArea,
      enabledModelTypes: [...enabledModelTypes],
    };
  }

  function isModelFileAcceptedForType(filePath: string, modelType: string) {
    void modelType;
    const ext = filePath.toLowerCase().split(".").pop() || "";
    return ["fbx", "obj", "abc", "gltf", "glb", "ztl"].includes(ext);
  }

  function getAcceptedTextureExtsForAssetType(assetType: string) {
    const normalized = String(assetType || "").trim().toLowerCase();
    if (normalized === "hdri") {
      return ["hdr", "exr"];
    }
    return ["png", "jpg", "jpeg", "tif", "tiff", "exr", "hdr", "tga", "webp", "bmp"];
  }

  function isTextureFileAccepted(filePath: string, assetType?: string) {
    const ext = filePath.toLowerCase().split(".").pop() || "";
    const allowed = getAcceptedTextureExtsForAssetType(assetType || "");
    return allowed.includes(ext);
  }

  function getFileExt(filePath: string) {
    const match = String(filePath || "").trim().toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? `.${match[1]}` : "";
  }

  function getFileBaseName(filePath: string) {
    const normalized = String(filePath || "").trim().replace(/\\/g, "/");
    const name = normalized.split("/").pop() || "";
    return name;
  }

  function stripExt(fileName: string) {
    const idx = fileName.lastIndexOf(".");
    return idx > 0 ? fileName.slice(0, idx) : fileName;
  }

  function guessAssetNameFromFileName(fileName: string, options?: { preserveHdr?: boolean }) {
    let base = stripExt(String(fileName || "").trim());
    base = base.replace(/[_-]+/g, " ");
    base = base.replace(/\b(1k|2k|4k|8k|16k)\b/gi, "");
    base = base.replace(/\b(\d{3,4}x\d{3,4})\b/gi, "");
    base = base.replace(/\b(100[1-9]|10[1-9]\d)\b/g, "");
    const stripTokens = "albedo|base ?color|diffuse|color|normal|roughness|rough|metalness|metal|ao|ambient ?occlusion|height|displacement|disp|specular|opacity|gloss|cavity|mask" + (options?.preserveHdr ? "" : "|hdr");
    base = base.replace(new RegExp(`\\b(${stripTokens})\\b`, "gi"), "");
    base = base.replace(/\s{2,}/g, " ").trim();
    return base;
  }

  function detectTextureTypeFromFileName(fileName: string) {
    const normalized = stripExt(String(fileName || "").trim()).toLowerCase();
    const tokens = normalized.split(/[^a-z0-9]+/g).filter(Boolean);
    const has = (set: string[]) => set.some((t) => tokens.includes(t));
    if (has(["albedo", "basecolor", "base", "diffuse", "color", "col"])) return "Albedo";
    if (has(["ao", "ambientocclusion", "occlusion"])) return "AO";
    if (has(["normal", "nrm", "nor"])) return "Normal";
    if (has(["roughness", "rough"])) return "Roughness";
    if (has(["metalness", "metal"])) return "Metalness";
    if (has(["height", "displacement", "disp"])) return "Displacement";
    if (has(["specular", "spec"])) return "Specular";
    if (has(["opacity", "alpha", "transparency"])) return "Opacity";
    if (has(["gloss", "glossiness"])) return "Gloss";
    if (has(["cavity"])) return "Cavity";
    if (has(["mask"])) return "Mask";
    if (has(["hdr"])) return "HDR";
    return "";
  }

  function inferAreaIdFromFileName(fileName: string) {
    const udimMatch = String(fileName || "").match(/(?:^|[_.-])(1\d{3})(?=[_.-]|$)/);
    if (udimMatch) {
      const udim = Number(udimMatch[1]) || 0;
      if (udim >= 1001 && udim <= 1999) {
        return Math.max(1, udim - 1000);
      }
    }
    const groupMatch = String(fileName || "").match(/(?:^|[_.-])(\d{3})(?=[_.-]|$)/);
    if (groupMatch) {
      return Math.max(1, Number(groupMatch[1]) || 1);
    }
    return 1;
  }

  async function readDroppedPathsFromEvent(event: React.DragEvent) {
    const paths: string[] = [];
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) return [];
    const fileList = Array.from(dataTransfer.files || []);
    if (bridgeAvailable && typeof bridge.getDroppedFilePath === "function") {
      for (const file of fileList) {
        const fullPath = String(bridge.getDroppedFilePath(file) || "").trim();
        if (fullPath) paths.push(fullPath);
      }
    } else {
      for (const file of fileList) {
        const anyFile = file as File & { path?: string };
        if (anyFile.path) paths.push(anyFile.path);
      }
    }
    const uriList = String(dataTransfer.getData("text/uri-list") || "").trim();
    if (uriList.startsWith("file://")) {
      paths.push(decodeURIComponent(uriList.replace(/^file:\/+/, "")));
    }
    return [...new Set(paths.map((p) => normalizeLocalPath(p)).filter(Boolean))];
  }

  async function applyQuickDropImport(filePaths: string[]) {
    if (!bridgeAvailable || typeof bridge.resolveDroppedItems !== "function") {
      showStatus("拖拽导入需要桌面端环境", 8000);
      return;
    }
    const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    quickDropRequestIdRef.current = requestId;
    setQuickDropBusy(true);
    setQuickDropProgress(0);
    try {
      const resolved = await bridge.resolveDroppedItems({ paths: filePaths, requestId });
      if (quickDropRequestIdRef.current !== requestId) {
        return;
      }
      const files = (resolved?.files || []).map((p) => normalizeLocalPath(p)).filter(Boolean);
      if (files.length === 0) {
        showStatus("未识别到可导入的文件", 8000);
        return;
      }
      const isLodToken = (filePath: string) => {
        const base = String(getFileBaseName(filePath) || "").toLowerCase();
        return /(?:^|[_.-])lod(?:[_-]?\d+)?(?:$|[_.-])/.test(base);
      };
      const hasPreviewToken = (filePath: string) => {
        const base = String(getFileBaseName(filePath) || "").toLowerCase();
        return /(?:^|[_.-])(preview|thumb|thumbnail)(?:$|[_.-])/.test(base) || base.includes("render") || base.includes("beauty");
      };
      const modelExts = new Set([".fbx", ".obj", ".abc", ".gltf", ".glb", ".ztl"]);
      const modelFiles = files.filter((p) => modelExts.has(getFileExt(p)) && !isLodToken(p));
      const hdrFiles = files.filter((p) => getFileExt(p) === ".hdr");
      const textureFiles = files.filter((p) => {
        const ext = getFileExt(p);
        return [".png", ".jpg", ".jpeg", ".tif", ".tiff", ".exr", ".hdr", ".tga", ".webp", ".bmp"].includes(ext) && !isLodToken(p);
      });
      const inferredType = modelFiles.length > 0 ? "3d" : (hdrFiles.length > 0 ? "hdri" : "");
    const preferredName = typeof resolved?.preferredName === "string" ? resolved.preferredName : "";
    const isHdriType = inferredType === "hdri";
    const nameSeed = isHdriType
      ? (hdrFiles[0] || preferredName.trim() || modelFiles[0] || textureFiles[0] || files[0] || "")
      : (preferredName.trim() ? preferredName : (modelFiles[0] || hdrFiles[0] || textureFiles[0] || files[0] || ""));
    const guessedName = guessAssetNameFromFileName(getFileBaseName(nameSeed), { preserveHdr: isHdriType }) || stripExt(getFileBaseName(nameSeed));
      const nextSubCategory = inferredType ? (getSubCategoryOptions(inferredType)[0] || "") : "";
      const nextModelSlots: Record<string, string> = {};
      const nextEnabledModelTypes: string[] = [];
      if (modelFiles.length > 0) {
        const limited = modelFiles.slice(0, 8);
        limited.forEach((filePath) => {
          const slotKey = getNextMeshSlotKey(nextModelSlots);
          nextModelSlots[slotKey] = filePath;
          nextEnabledModelTypes.push(slotKey);
        });
      }
      let nextTextureEntries: TextureEntry[] = [];
      if (inferredType === "hdri") {
        const hdrPath = hdrFiles[0] || "";
        nextTextureEntries = [{ id: "import-hdri-quick-001", textureType: "HDR", filePath: hdrPath, areaId: 1 }];
      } else {
        const entries: TextureEntry[] = [];
        textureFiles.forEach((filePath) => {
          const fileName = getFileBaseName(filePath);
          const detectedType = detectTextureTypeFromFileName(fileName) || inferTextureTypeFromPath(filePath) || "";
          if (!detectedType) {
            return;
          }
          const areaId = inferAreaIdFromFileName(fileName);
          entries.push({
            id: `import-quick-${detectedType.toLowerCase()}-${areaId}-${Math.random().toString(36).slice(2, 8)}`,
            textureType: detectedType,
            filePath,
            areaId
          });
        });
        nextTextureEntries = entries.length > 0 ? entries : defaultImportForm.textureEntries;
      }
      const previewCandidates = textureFiles
        .filter((filePath) => {
          const ext = getFileExt(filePath);
          return [".png", ".jpg", ".jpeg", ".tif", ".tiff", ".tga", ".webp", ".bmp"].includes(ext);
        });
      const explicitPreview = previewCandidates.find((filePath) => hasPreviewToken(filePath)) || "";
      const looksLikeTextureTypeName = (filePath: string) => {
        const base = String(getFileBaseName(filePath) || "").toLowerCase();
        if (!base) {
          return false;
        }
        const tokens = [
          "albedo",
          "basecolor",
          "base_color",
          "diffuse",
          "color",
          "normal",
          "nrm",
          "nor",
          "roughness",
          "rough",
          "rgh",
          "metalness",
          "metallic",
          "metal",
          "ao",
          "ambientocclusion",
          "ambient_occlusion",
          "occlusion",
          "displacement",
          "disp",
          "height",
          "opacity",
          "alpha",
          "mask",
          "specular",
          "spec",
          "gloss",
          "glossiness",
          "cavity"
        ];
        return tokens.some((token) => base.includes(token));
      };
      const nonTypedPreview = explicitPreview
        ? ""
        : (previewCandidates.find((filePath) => !detectTextureTypeFromFileName(getFileBaseName(filePath)) && !looksLikeTextureTypeName(filePath)) || "");
      const hdriPreview = inferredType === "hdri" ? (hdrFiles[0] || textureFiles.find((filePath) => {
        const ext = getFileExt(filePath);
        return ext === ".hdr" || ext === ".exr";
      }) || "") : "";
      const pickedPreview = hdriPreview || explicitPreview || nonTypedPreview || "";
      setImportTagInput("");
      setImportForm((prev) => ({
        ...defaultImportForm,
        assetName: guessedName,
        assetType: inferredType,
        subCategory: nextSubCategory,
        modelSlots: nextModelSlots,
        enabledModelTypes: nextEnabledModelTypes.length > 0 ? nextEnabledModelTypes : defaultImportForm.enabledModelTypes,
        textureEntries: nextTextureEntries,
        previewImagePath: pickedPreview,
        normalMapFormats: inferredType === "hdri" ? { 1: prev.normalMapFormat } : prev.normalMapFormats
      }));
      setImportOpen(true);
    } finally {
      if (quickDropRequestIdRef.current === requestId) {
        setQuickDropBusy(false);
        setQuickDropProgress(0);
        quickDropRequestIdRef.current = "";
      }
    }
  }

  async function pickFileByInput(accept: string) {
    if (typeof document === "undefined") {
      return "";
    }
    return await new Promise<string>((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.onchange = () => {
        const file = input.files?.[0] as (File & { path?: string }) | undefined;
        resolve(file?.path || "");
      };
      input.oncancel = () => resolve("");
      input.click();
    });
  }

  function isModelAssetImportType(assetType: string) {
    return assetType === "3d" || assetType === "3dplant";
  }

  async function handleModelDrop(event: React.DragEvent<HTMLDivElement>, modelType: string) {
    const droppedPath = normalizeLocalPath(await readDroppedPath(event));
    if (!droppedPath) {
      showStatus(`未获取到${getMeshSlotLabel(modelType)}拖拽文件路径`, 10000);
      return;
    }
    if (!isModelFileAcceptedForType(droppedPath, modelType)) {
      showStatus(`${getMeshSlotLabel(modelType)} 不支持该模型格式`, 10000);
      return;
    }
    setImportForm((prev) => ({
      ...prev,
      modelSlots: { ...prev.modelSlots, [modelType]: droppedPath },
      enabledModelTypes: [...new Set([...prev.enabledModelTypes, modelType])]
    }));
  }

  async function handleTextureDrop(event: React.DragEvent<HTMLDivElement>, entryId: string) {
    const droppedPath = normalizeLocalPath(await readDroppedPath(event));
    if (!droppedPath) {
      showStatus("未获取到贴图拖拽文件路径", 10000);
      return;
    }
    if (!isTextureFileAccepted(droppedPath, importForm.assetType)) {
      const exts = getAcceptedTextureExtsForAssetType(importForm.assetType).join(", ");
      showStatus(`贴图格式无效（允许：${exts}）`, 10000);
      return;
    }
    setImportForm((prev) => ({
      ...prev,
      textureEntries: prev.textureEntries.map((entry) => entry.id === entryId ? { ...entry, filePath: droppedPath } : entry)
    }));
  }

  async function handlePreviewDrop(event: React.DragEvent<HTMLDivElement>) {
    const droppedPath = normalizeLocalPath(await readDroppedPath(event));
    if (!droppedPath) {
      return;
    }
    if (!isTextureFileAccepted(droppedPath, importForm.assetType)) {
      showStatus("预览图格式无效", 10000);
      return;
    }
    setImportForm((prev) => ({ ...prev, previewImagePath: droppedPath }));
  }

  function openEditAsset(asset: AssetRecord) {
    const meta = asset.meta as {
      name?: string;
      tags?: string[];
      assetType?: string;
      asset_type?: string;
      category?: string;
      normalMapFormat?: string;
      normalMapFormats?: Record<string, string>;
      semanticTags?: { asset_type?: string; subject_matter?: string; theme?: string[] };
      themes?: string[];
    };
    const name = String(meta?.name || asset.name || "");
    const assetTypeFromMeta = String(meta?.assetType || meta?.asset_type || meta?.semanticTags?.asset_type || asset.assetType || "").trim().toLowerCase();
    const subCategoryRaw = String(
      meta?.category
      || meta?.semanticTags?.subject_matter
      || meta?.semanticTags?.theme?.[0]
      || (Array.isArray(asset?.themes || null) ? (asset.themes as string[])[0] : "")
      || (Array.isArray(asset?.categories || null)
        ? (((asset.categories as string[]).find((v) => v && v.toLowerCase() !== assetTypeFromMeta)) || (asset.categories as string[])[0] || "")
        : "")
    ).trim();
    const subCategoryFromMeta = mapSubCategoryToOptionLabel(assetTypeFromMeta, subCategoryRaw);
    const tags = Array.isArray(meta?.tags) ? meta.tags : asset.tags;
    const slots = buildEditSlots(asset);
    const normalMapFormat: EditFormState["normalMapFormat"] = String(meta?.normalMapFormat || "dx").trim().toLowerCase() === "opengl" ? "opengl" : "dx";
    const normalMapFormats = normalizeNormalMapFormatsByArea(slots.normalMapFormats, slots.textureEntries, normalMapFormat);
    const nextForm = {
      assetId: asset.id,
      assetPath: asset.path,
      assetName: name,
      assetType: assetTypeFromMeta,
      subCategory: subCategoryFromMeta,
      modelSlots: slots.modelSlots,
      enabledModelTypes: slots.enabledModelTypes,
      textureEntries: slots.textureEntries,
      normalMapFormat,
      normalMapFormats,
      previewImagePath: asset.detailImage || asset.previewImage || asset.preview || "",
      tagsText: (tags || []).filter(Boolean).join(", ")
    };
    setEditForm(nextForm);
    setEditBaseline(nextForm);
    setEditTagInput("");
    setEditOpen(true);
  }

  async function handleEditModelDrop(event: React.DragEvent<HTMLDivElement>, modelType: string) {
    const droppedPath = normalizeLocalPath(await readDroppedPath(event));
    if (!droppedPath) {
      showStatus(`未获取到${getMeshSlotLabel(modelType)}拖拽文件路径`, 10000);
      return;
    }
    if (!isModelFileAcceptedForType(droppedPath, modelType)) {
      showStatus(`${getMeshSlotLabel(modelType)} 不支持该模型格式`, 10000);
      return;
    }
    setEditForm((prev) => ({
      ...prev,
      modelSlots: { ...prev.modelSlots, [modelType]: droppedPath },
      enabledModelTypes: [...new Set([...prev.enabledModelTypes, modelType])]
    }));
  }

  async function handleEditTextureDrop(event: React.DragEvent<HTMLDivElement>, entryId: string) {
    const droppedPath = normalizeLocalPath(await readDroppedPath(event));
    if (!droppedPath) {
      showStatus("未获取到贴图拖拽文件路径", 10000);
      return;
    }
    if (!isTextureFileAccepted(droppedPath, editForm.assetType)) {
      const exts = getAcceptedTextureExtsForAssetType(editForm.assetType).join(", ");
      showStatus(`贴图格式无效（允许：${exts}）`, 10000);
      return;
    }
    setEditForm((prev) => ({
      ...prev,
      textureEntries: prev.textureEntries.map((entry) => entry.id === entryId ? { ...entry, filePath: droppedPath } : entry)
    }));
  }

  async function handleEditPreviewDrop(event: React.DragEvent<HTMLDivElement>) {
    const droppedPath = normalizeLocalPath(await readDroppedPath(event));
    if (!droppedPath) {
      return;
    }
    if (!isTextureFileAccepted(droppedPath)) {
      showStatus("预览图格式无效", 10000);
      return;
    }
    setEditForm((prev) => ({ ...prev, previewImagePath: droppedPath }));
  }

  function openPreviewCutout(target: "import" | "edit" = "edit") {
    const sourcePath = String(target === "import" ? importForm.previewImagePath : editForm.previewImagePath || "").trim();
    if (!sourcePath) {
      showStatus("请先选择预览图", 10000);
      return;
    }
    setCutoutTarget(target);
    setCutoutWorkingPath(sourcePath);
    setCutoutPickPoint(null);
    setCutoutPickSourcePath("");
    cutoutPendingToleranceRef.current = null;
    setCutoutOpen(true);
  }

  function closePreviewCutout() {
    if (cutoutBusy) {
      return;
    }
    setCutoutOpen(false);
    setCutoutWorkingPath("");
    setCutoutPickPoint(null);
    setCutoutPickSourcePath("");
    cutoutPendingToleranceRef.current = null;
  }

  function removeEditPreviewImage() {
    setEditForm((prev) => ({ ...prev, previewImagePath: "" }));
    if (cutoutTarget === "edit") {
      closePreviewCutout();
    }
  }

  function removeImportPreviewImage() {
    setImportForm((prev) => ({ ...prev, previewImagePath: "" }));
    if (cutoutTarget === "import") {
      closePreviewCutout();
    }
  }

  const applyCutoutByPick = useCallback(async (sourcePath: string, x: number, y: number, tolerance: number) => {
    if (!bridgeAvailable) {
      return;
    }
    setCutoutBusy(true);
    try {
      const result = await bridge.cutoutPreviewMagic({
        sourcePath,
        x,
        y,
        tolerance
      });
      if (!result.ok || !result.path) {
        showStatus(result.message || "抠像失败", 10000);
        return;
      }
      setCutoutWorkingPath(result.path);
      showStatus("已抠除连续区域，可继续点选或点击确定", 0);
    } catch (error) {
      showStatus(`抠像失败：${String(error)}`, 10000);
    } finally {
      setCutoutBusy(false);
    }
  }, [bridge, bridgeAvailable, showStatus]);

  function handleCutoutToleranceChange(nextTolerance: number) {
    setCutoutTolerance(nextTolerance);
    if (!cutoutPickPoint || !cutoutPickSourcePath) {
      return;
    }
    if (cutoutBusy) {
      cutoutPendingToleranceRef.current = nextTolerance;
      return;
    }
    cutoutPendingToleranceRef.current = null;
    void applyCutoutByPick(cutoutPickSourcePath, cutoutPickPoint.x, cutoutPickPoint.y, nextTolerance);
  }

  async function handleCutoutPick(event: React.MouseEvent<HTMLImageElement>) {
    if (!bridgeAvailable || cutoutBusy) {
      return;
    }
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height || !target.naturalWidth || !target.naturalHeight) {
      return;
    }
    const x = Math.max(0, Math.min(target.naturalWidth - 1, Math.round(((event.clientX - rect.left) / rect.width) * target.naturalWidth)));
    const y = Math.max(0, Math.min(target.naturalHeight - 1, Math.round(((event.clientY - rect.top) / rect.height) * target.naturalHeight)));
    const sourcePath = cutoutWorkingPath;
    setCutoutPickPoint({ x, y });
    setCutoutPickSourcePath(sourcePath);
    await applyCutoutByPick(sourcePath, x, y, cutoutTolerance);
  }

  async function confirmPreviewCutout() {
    if (!bridgeAvailable || cutoutBusy) {
      return;
    }
    const sourcePath = String(cutoutWorkingPath || "").trim();
    if (!sourcePath) {
      return;
    }
    setCutoutBusy(true);
    try {
      const result = await bridge.finalizePreviewCutout({
        sourcePath,
        padding: 10,
        maxSize: 1024
      });
      if (!result.ok || !result.path) {
        showStatus(result.message || "抠像确认失败", 10000);
        return;
      }
      if (cutoutTarget === "import") {
        setImportForm((prev) => ({ ...prev, previewImagePath: result.path || prev.previewImagePath }));
      } else {
        setEditForm((prev) => ({ ...prev, previewImagePath: result.path || prev.previewImagePath }));
      }
      setCutoutOpen(false);
      setCutoutWorkingPath("");
      setCutoutPickPoint(null);
      setCutoutPickSourcePath("");
      cutoutPendingToleranceRef.current = null;
      showStatus("预览图抠像完成，已替换为裁剪压缩后的PNG", 2500);
    } catch (error) {
      showStatus(`抠像确认失败：${String(error)}`, 10000);
    } finally {
      setCutoutBusy(false);
    }
  }

  useEffect(() => {
    if (cutoutBusy || !cutoutPickPoint || !cutoutPickSourcePath) {
      return;
    }
    const pendingTolerance = cutoutPendingToleranceRef.current;
    if (pendingTolerance == null) {
      return;
    }
    cutoutPendingToleranceRef.current = null;
    void applyCutoutByPick(cutoutPickSourcePath, cutoutPickPoint.x, cutoutPickPoint.y, pendingTolerance);
  }, [applyCutoutByPick, cutoutBusy, cutoutPickPoint, cutoutPickSourcePath, cutoutTolerance]);

  function focusSelectedAssetCard() {
    const targetId = selectedAssetId || selectedAsset?.id || "";
    if (!targetId || !selectedAsset) {
      return;
    }

    // Switch category context to match the selected asset
    const assetType = String(selectedAsset.assetType || "").toLowerCase();
    const subCategory = getAssetSubCategory(selectedAsset);

    // Map asset type to category node ID
    let targetNodeId = "";
    if (assetType === "3d") targetNodeId = "3d-assets";
    else if (assetType === "3dplant") targetNodeId = "3d-plants";
    else if (assetType === "surface") targetNodeId = "surfaces";
    else if (assetType === "decal") targetNodeId = "decals";
    else if (assetType === "imperfection") targetNodeId = "imperfections";
    else if (assetType === "displacement") targetNodeId = "displacements";

    // If currently in favorites, check if we should stay in favorite context
    const isCurrentFav = activeMenu === "favorite" || activeMenu.startsWith("fav-");
    const isAssetFav = favoriteIds.has(selectedAsset.id);

    if (isCurrentFav && isAssetFav) {
      // Switch to the specific favorite subcategory
      if (assetType === "3d") targetNodeId = "fav-3d";
      else if (assetType === "3dplant") targetNodeId = "fav-3dplant";
      else if (assetType === "surface") targetNodeId = "fav-surface";
      else if (assetType === "decal") targetNodeId = "fav-decal";
      else if (assetType === "imperfection") targetNodeId = "fav-imperfection";
      else if (assetType === "displacement") targetNodeId = "fav-displacement";
    }

    if (targetNodeId && targetNodeId !== activeMenu) {
      setActiveMenu(targetNodeId);
      setExpandedCategories(() => {
        const isFavTarget = targetNodeId.startsWith("fav-");
        if (isFavTarget) {
          return ["favorite", targetNodeId];
        } else {
          return ["home", targetNodeId];
        }
      });

      const isFavTarget = targetNodeId.startsWith("fav-");
      executeSearch({
        ...search,
        text: "",
        tags: [],
        assetTypes: mapNodeIdToAssetTypes(targetNodeId),
        themes: subCategory ? [subCategory] : [],
        onlyFavorites: isFavTarget
      });
    }

    // Scroll into view
    setTimeout(() => {
      const card = document.getElementById(`asset-card-${targetId}`);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.add("flash-highlight");
        setTimeout(() => card.classList.remove("flash-highlight"), 1000);
      }
    }, 100);
  }

  function formatDetailTag(tag: string) {
    const value = String(tag || "").trim();
    if (!value) {
      return "";
    }
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function getAssetDimensions(asset: AssetRecord | null) {
    if (!asset || typeof asset.meta !== "object" || !asset.meta) {
      return undefined;
    }
    const scanInformation = (asset.meta as { scanInformation?: unknown }).scanInformation;
    if (scanInformation && typeof scanInformation === "object") {
      const dimensions = (scanInformation as { dimensions?: unknown }).dimensions;
      if (dimensions && typeof dimensions === "object") {
        const x = Number((dimensions as { x?: unknown }).x);
        const y = Number((dimensions as { y?: unknown }).y);
        const z = Number((dimensions as { z?: unknown }).z);
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
          return { x, y, z };
        }
      }
    }
    const entries = Array.isArray((asset.meta as { meta?: unknown }).meta)
      ? ((asset.meta as { meta?: unknown }).meta as Array<{ key?: unknown; value?: unknown }>)
      : [];
    let length = Number.NaN;
    let width = Number.NaN;
    let height = Number.NaN;
    const parseDimension = (value: unknown) => {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      const text = String(value || "").trim().toLowerCase();
      const matched = text.match(/-?\d+(\.\d+)?/);
      if (!matched) return Number.NaN;
      const numeric = Number(matched[0]);
      if (!Number.isFinite(numeric)) return Number.NaN;
      if (text.includes("cm")) return numeric / 100;
      if (text.includes("mm")) return numeric / 1000;
      return numeric;
    };
    for (const entry of entries) {
      const key = String(entry?.key || "").trim().toLowerCase();
      if (key === "length") length = parseDimension(entry?.value);
      if (key === "width") width = parseDimension(entry?.value);
      if (key === "height") height = parseDimension(entry?.value);
    }
    if (Number.isFinite(length) && Number.isFinite(width) && Number.isFinite(height)) {
      return { x: length, y: height, z: width };
    }
    return undefined;
  }

  function getAssetColorTags(asset: AssetRecord | null) {
    if (!asset) {
      return [];
    }
    const normalized = new Set<string>();
    const addColor = (value: unknown) => {
      const next = String(value || "").trim().toLowerCase();
      if (next) {
        normalized.add(next);
      }
    };
    const runtimeColors = (asset as unknown as { colorTags?: unknown }).colorTags;
    if (Array.isArray(runtimeColors)) {
      runtimeColors.forEach(addColor);
    }
    if (asset.meta && typeof asset.meta === "object") {
      const meta = asset.meta as Record<string, unknown>;
      if (Array.isArray(meta.colorTags)) {
        meta.colorTags.forEach(addColor);
      }
      if (Array.isArray(meta.colors)) {
        meta.colors.forEach(addColor);
      }
      const semanticTags = meta.semanticTags;
      if (semanticTags && typeof semanticTags === "object") {
        const semantic = semanticTags as Record<string, unknown>;
        if (Array.isArray(semantic.color)) {
          semantic.color.forEach(addColor);
        } else if (typeof semantic.color === "string") {
          addColor(semantic.color);
        }
      }
    }
    return [...normalized];
  }

  function shouldShowSizePreview(asset: AssetRecord | null) {
    if (!asset) {
      return false;
    }
    const normalizedAssetType = String(asset.assetType || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
    const assetType = normalizedAssetType === "3dasset" ? "3d" : normalizedAssetType === "3dplants" ? "3dplant" : normalizedAssetType;
    if (assetType !== "3d" && assetType !== "3dplant") {
      return false;
    }
    return Boolean(getAssetDimensions(asset));
  }

  function normalizeTextureEntries(entries: TextureEntry[]) {
    return entries
      .map((entry) => ({
        textureType: String(entry.textureType || "").trim(),
        filePath: String(entry.filePath || "").trim(),
        areaId: Math.max(1, Number(entry.areaId) || 1)
      }))
      .filter((entry) => entry.textureType && entry.filePath);
  }

  function normalizeNormalMapFormatsByArea(input: Record<number, "dx" | "opengl"> | Record<string, string> | undefined, entries: TextureEntry[], fallback: "dx" | "opengl") {
    const result: Record<number, "dx" | "opengl"> = {};
    const areaIds = getTextureAreaIdList(entries);
    for (const areaId of areaIds) {
      const raw = String((input && (input as Record<string, string>)[String(areaId)]) || fallback || "dx").trim().toLowerCase();
      result[areaId] = raw === "opengl" ? "opengl" : "dx";
    }
    if (!result[1]) {
      result[1] = fallback;
    }
    return result;
  }

  function getNormalMapFormatForArea(form: { normalMapFormat: "dx" | "opengl"; normalMapFormats?: Record<number, "dx" | "opengl"> }, areaId: number) {
    return form.normalMapFormats?.[areaId] || form.normalMapFormat || "dx";
  }

  function textureEntriesToSlots(entries: TextureEntry[]) {
    const next: Record<string, string> = {};
    const areaCount = getTextureAreaIdList(entries).length;
    for (const entry of entries) {
      const slotToken = getTextureSlotToken(entry.textureType, entry.areaId, areaCount, entry.id);
      if (!slotToken || next[slotToken]) {
        continue;
      }
      next[slotToken] = entry.filePath;
    }
    return next;
  }

  async function submitEditAsset() {
    if (!bridgeAvailable) {
      showStatus("编辑资产需要桌面端环境，请运行 npm run dev", 10000);
      return;
    }
    const editingAssetId = String(editForm.assetId || "").trim();
    if (!editForm.assetId || !editForm.assetName.trim()) {
      showStatus("请先填写资产名", 10000);
      return;
    }
    const incompleteTextureEntries = editForm.textureEntries.filter((entry) => String(entry.filePath || "").trim() && !String(entry.textureType || "").trim());
    if (incompleteTextureEntries.length > 0) {
      showStatus("存在未选择贴图类型的贴图，请先选择类型", 10000);
      return;
    }
    const selectedTextureSlots = textureEntriesToSlots(editForm.textureEntries);
    const selectedTextureEntries = normalizeTextureEntries(editForm.textureEntries);
    const selectedNormalMapFormats = normalizeNormalMapFormatsByArea(editForm.normalMapFormats, editForm.textureEntries, editForm.normalMapFormat);
    const selectedModelSlots = Object.fromEntries(
      Object.entries(editForm.modelSlots).filter(([, filePath]) => String(filePath).trim())
    );
    const baselineTextureSlots = textureEntriesToSlots(editBaseline.textureEntries);
    const baselineTextureEntries = normalizeTextureEntries(editBaseline.textureEntries);
    const baselineNormalMapFormats = normalizeNormalMapFormatsByArea(editBaseline.normalMapFormats, editBaseline.textureEntries, editBaseline.normalMapFormat);
    const baselineModelSlots = Object.fromEntries(
      Object.entries(editBaseline.modelSlots).filter(([, filePath]) => String(filePath).trim())
    );
    const changedModelSlots = Object.fromEntries(
      Object.entries(selectedModelSlots).filter(([slot, filePath]) => baselineModelSlots[slot] !== filePath)
    );
    const changedTextureSlots = Object.fromEntries(
      Object.entries(selectedTextureSlots).filter(([slot, filePath]) => baselineTextureSlots[slot] !== filePath)
    );


    const removedModelSlots = Object.keys(baselineModelSlots).filter((slot) => !(slot in selectedModelSlots));
    const removedTextureSlots = Object.keys(baselineTextureSlots).filter((slot) => !(slot in selectedTextureSlots));
    const textureEntriesChanged = JSON.stringify(selectedTextureEntries) !== JSON.stringify(baselineTextureEntries);
    const normalizedTags = parseTagsText(editForm.tagsText);
    const baselineTags = parseTagsText(editBaseline.tagsText);
    const tagsChanged = normalizedTags.join("|") !== baselineTags.join("|");
    const nameChanged = editForm.assetName.trim() !== editBaseline.assetName.trim();
    const typeChanged = editForm.assetType.trim() !== editBaseline.assetType.trim();
    const categoryChanged = editForm.subCategory.trim() !== editBaseline.subCategory.trim();
    const normalMapFormatChanged = editForm.normalMapFormat !== editBaseline.normalMapFormat;
    const normalMapFormatsChanged = JSON.stringify(selectedNormalMapFormats) !== JSON.stringify(baselineNormalMapFormats);
    const previewChanged = editForm.previewImagePath.trim() !== editBaseline.previewImagePath.trim();
    if (!nameChanged && !typeChanged && !categoryChanged && !normalMapFormatChanged && !normalMapFormatsChanged && !previewChanged && !tagsChanged
      && Object.keys(changedModelSlots).length === 0 && Object.keys(changedTextureSlots).length === 0
      && removedModelSlots.length === 0 && removedTextureSlots.length === 0) {
      setEditOpen(false);
      showStatus("没有检测到变更", 2500);
      return;
    }
    setSavingProgressMap((prev) => ({ ...prev, [editingAssetId]: 0 }));
    showStatus("正在保存资产...", 0);
    try {
      const requestPayload = {
        assetId: editingAssetId,
        assetName: nameChanged ? editForm.assetName.trim() : undefined,
        assetType: typeChanged ? editForm.assetType.trim() : undefined,
        category: categoryChanged ? editForm.subCategory.trim() : undefined,
        modelSlots: Object.keys(changedModelSlots).length > 0 ? changedModelSlots : undefined,
        textureSlots: textureEntriesChanged
          ? selectedTextureSlots
          : (Object.keys(changedTextureSlots).length > 0 ? changedTextureSlots : undefined),
        textureEntries: textureEntriesChanged ? selectedTextureEntries : undefined,
        removeModelSlots: removedModelSlots.length > 0 ? removedModelSlots : undefined,
        removeTextureSlots: removedTextureSlots.length > 0 ? removedTextureSlots : undefined,
        normalMapFormat: normalMapFormatChanged ? editForm.normalMapFormat : undefined,
        normalMapFormats: normalMapFormatsChanged ? selectedNormalMapFormats : undefined,
        previewImagePath: previewChanged ? editForm.previewImagePath.trim() || undefined : undefined,
        clearPreview: previewChanged && !editForm.previewImagePath.trim(),
        tags: tagsChanged ? normalizedTags : undefined
      };
      setEditOpen(false);
      console.info("[assets:updateCustom] request", {
        assetId: requestPayload.assetId,
        modelSlots: Object.keys(requestPayload.modelSlots || {}),
        textureSlots: Object.keys(requestPayload.textureSlots || {}),
        removeModelSlots: requestPayload.removeModelSlots || [],
        removeTextureSlots: requestPayload.removeTextureSlots || [],
        clearPreview: requestPayload.clearPreview
      });
      const result = await bridge.updateCustomAsset(requestPayload);
      console.info("[assets:updateCustom] response", {
        assetId: requestPayload.assetId,
        ok: Boolean(result?.ok),
        message: result?.message || ""
      });
      if (result.ok) {
        if (typeof bridge.rewriteCustomJson === "function") {
          void bridge.rewriteCustomJson().catch(() => void 0);
        }
        setEditForm(defaultEditForm);
        setEditBaseline(defaultEditForm);
        setEditTagInput("");
        if (result.asset) {
          const updatedAsset = result.asset;
          setAllAssets((prev) => prev.map((asset) => (asset.id === updatedAsset.id ? updatedAsset : asset)));
          setAssets((prev) => prev.map((asset) => (asset.id === updatedAsset.id ? updatedAsset : asset)));
          setSelectedAssetId((prev) => (prev === updatedAsset.id ? updatedAsset.id : prev));
        }
        showStatus(uiLanguage === "en" ? "Save complete" : "保存完成", 2500);
      } else {
        showStatus(result.message, 10000);
      }
    } catch (error) {
      showStatus(`更新失败：${String(error)}`, 10000);
    } finally {
      setSavingProgressMap((prev) => {
        const next = { ...prev };
        delete next[editingAssetId];
        return next;
      });
    }
  }

  async function submitImportAsset() {
    if (!bridgeAvailable) {
      showStatus("导入资产需要桌面端环境，请运行 npm run dev", 10000);
      return;
    }
    if (!importForm.assetName.trim()) {
      showStatus("请先填写资产名", 10000);
      return;
    }
    if (!importForm.assetType.trim()) {
      showStatus("请选择分类", 10000);
      return;
    }
    if (!importForm.subCategory.trim()) {
      showStatus("请选择子分类", 10000);
      return;
    }
    const incompleteTextureEntries = importForm.textureEntries.filter((entry) => String(entry.filePath || "").trim() && !String(entry.textureType || "").trim());
    if (incompleteTextureEntries.length > 0) {
      showStatus("存在未选择贴图类型的贴图，请先选择类型", 10000);
      return;
    }
    const selectedTextureSlots = textureEntriesToSlots(importForm.textureEntries);
    const selectedTextureEntries = normalizeTextureEntries(importForm.textureEntries);
    const selectedNormalMapFormats = normalizeNormalMapFormatsByArea(importForm.normalMapFormats, importForm.textureEntries, importForm.normalMapFormat);
    const textureAreaCount = getTextureAreaIdList(importForm.textureEntries).length;
    const selectedModelSlots = Object.fromEntries(
      Object.entries(importForm.modelSlots).filter(([, filePath]) => String(filePath).trim())
    );
    if (Object.keys(selectedTextureSlots).length === 0 && Object.keys(selectedModelSlots).length === 0) {
      showStatus("请至少设置一个模型或贴图", 10000);
      return;
    }
    if (isModelAssetImportType(importForm.assetType) && Object.keys(selectedModelSlots).length === 0 && Object.keys(selectedTextureSlots).length === 0) {
      showStatus("3D资产请至少设置模型或贴图", 10000);
      return;
    }
    setImportSaving(true);
    setBusy(true);
    showStatus("正在导入到 Custom 库...", 0);
    try {
      const result = await bridge.importCustomAsset({
        assetName: importForm.assetName.trim(),
        assetType: importForm.assetType,
        category: importForm.subCategory.trim(),
        modelSlots: selectedModelSlots,
        textureSlots: selectedTextureSlots,
        textureEntries: selectedTextureEntries,
        textureAreaCount,
        normalMapFormat: importForm.normalMapFormat,
        normalMapFormats: selectedNormalMapFormats,
        previewImagePath: importForm.previewImagePath.trim() || undefined,
        tags: parseTagsText(importForm.tagsText)
      });
      if (result.ok) {
        setImportOpen(false);
        setImportForm(defaultImportForm);
        setImportTagInput("");
        const refreshedIndex = await bridge.getAssetIndex().catch(() => null);
        if (Array.isArray(refreshedIndex) && refreshedIndex.length >= 0) {
          setAllAssets(refreshedIndex);
          setAssets(refreshedIndex);
          if (result.assetId) {
            setSelectedAssetId(result.assetId);
          }
        } else {
          await rescan();
        }
        showStatus(`导入成功：${result.assetPath || result.assetId || importForm.assetName}`, 2500);
      } else {
        showStatus(result.message, 10000);
      }
    } catch (error) {
      showStatus(`导入失败：${String(error)}`, 10000);
    } finally {
      setImportSaving(false);
      setBusy(false);
    }
  }

  async function deleteCustomAsset(asset: AssetRecord) {
    if (!bridgeAvailable) {
      showStatus("删除资产需要桌面端环境，请运行 npm run dev", 10000);
      return;
    }
    setDeleteConfirmAsset(asset);
  }

  async function confirmDeleteCustomAsset() {
    if (!deleteConfirmAsset) {
      return;
    }
    const asset = deleteConfirmAsset;
    setDeleteConfirmAsset(null);
    setBusy(true);
    showStatus("正在删除资产...", 0);
    try {
      const result = typeof bridge.deleteCustomAsset === "function"
        ? await bridge.deleteCustomAsset({ assetId: asset.id })
        : await bridge.importCustomAsset({
          __action: "deleteCustom",
          assetId: asset.id,
          assetName: "__delete__",
          assetType: "3d",
          tags: []
        });
      if (result.ok) {
        setSelectedIds((prev) => prev.filter((id) => id !== asset.id));
        setSelectedAssetId((prev) => (prev === asset.id ? null : prev));
        showStatus("资产已删除", 2500);
        await rescan();
      } else {
        showStatus(result.message, 10000);
      }
    } catch (error) {
      showStatus(`删除失败：${String(error)}`, 10000);
    } finally {
      setBusy(false);
    }
  }

  async function copyAssetId(assetId: string) {
    const value = String(assetId || "").trim();
    if (!value) {
      showStatus("资产ID为空，无法复制", 10000);
      return;
    }
    try {
      if (bridgeAvailable && typeof bridge.copyText === "function") {
        await bridge.copyText(value);
      } else if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        showStatus("当前环境不支持复制功能", 10000);
        return;
      }
      showStatus(`已复制资产ID：${value}`, 2500);
    } catch (error) {
      showStatus(`复制资产ID失败：${String(error)}`, 10000);
    }
  }

  const handleContextMenu = useCallback((e: React.MouseEvent, assetId: string) => {
    if (savingAssetIdSet.has(assetId)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, assetId });
    void refreshAssetFromDisk(assetId);
  }, [refreshAssetFromDisk, savingAssetIdSet]);

  function renderCategoryTree(nodes: Array<CategoryNode | string>, depth = 0, parentNodeId: string | null = null) {
    return nodes.map((node) => {
      if (typeof node === "string") {
        const normalizedTheme = normalizeThemeToken(node);
        const isSelected = search.themes.includes(normalizedTheme);
        // Inherit favorite status from parent
        const isParentFav = parentNodeId === "favorite" || (parentNodeId?.startsWith("fav-") ?? false);
        const indentPixels = 16 + depth * 24;

        // Active strip should overlay parent's vertical line
        // Parent depth is depth - 1
        // Parent indent: 16 + (depth - 1) * 24
        // Parent line: indent + 9
        const activeStripLeft = 16 + (depth - 1) * 24 + 9;

        return (
          <div
            key={node}
            className={`submenu-item ${isSelected ? "active" : ""}`}
            style={{ paddingLeft: `${indentPixels}px` }}
            onClick={(e) => {
              e.stopPropagation();
              executeSearch({
                ...search,
                text: "",
                tags: [],
                assetTypes: mapNodeIdToAssetTypes(parentNodeId),
                themes: [normalizedTheme],
                favoriteState: isParentFav ? "fav" : "all",
                onlyFavorites: isParentFav
              });
            }}
          >
            {isSelected && depth > 0 && (
              <div className="active-strip" style={{ left: `${activeStripLeft}px` }}></div>
            )}
            {node}
          </div>
        );
      }

      const isExpanded = expandedCategories.includes(node.id) || node.id === "home";
      const hasChildren = node.children && node.children.length > 0;
      const isActive = activeMenu === node.id;
      const isHomeNode = node.id === "home";
      const isFavNode = node.id === "favorite" || node.id.startsWith("fav-");

      // Calculate indentation: Base 16px. Steps of 24px.
      // Special adjustment for Favorite node to align with Home (All)
      // Home node has arrow which takes space. Favorite node is root but currently rendered as having no arrow if no children?
      // Wait, Favorite node DOES have children (favChildren). 
      // But if it has no children, it won't render arrow.
      // Home node always has children.
      // Let's ensure Favorite always has the same padding structure.

      const indentPixels = 16 + depth * 24;
      const activeStripLeft = 16 + (depth - 1) * 24 + 9;

      return (
        <div key={node.id} className="nav-group">
          <div
            className={`left-item ${isActive ? "active" : ""}`}
            style={{ paddingLeft: `${indentPixels}px` }}
            onClick={() => {
              setActiveMenu(node.id);
              if (hasChildren && node.id !== "home") toggleCategory(node.id);

              const searchBase = {
                ...search,
                text: "",
                tags: [],
                themes: [],
                onlyFavorites: isFavNode
              };

              if (node.id === "home") {
                executeSearch({ ...searchBase, assetTypes: [], source: "all" });
              } else {
                executeSearch({ ...searchBase, assetTypes: mapNodeIdToAssetTypes(node.id) });
              }
            }}
          >
            {isActive && depth > 0 && (
              <div className="active-strip" style={{ left: `${activeStripLeft}px` }}></div>
            )}

            {/* Arrow placeholder to ensure alignment if node has no children but is at same level as nodes with children */}
            {hasChildren && node.id !== "home" ? (
              <span className={`arrow ${isExpanded ? "expanded" : ""}`}><Icon name="chevron-right" /></span>
            ) : (
              (node.id === "home" || node.id === "favorite") ? <span className="arrow" style={{ visibility: 'hidden' }}><Icon name="chevron-right" /></span> :
                <span className="arrow" style={{ visibility: 'hidden' }}><Icon name="chevron-right" /></span>
            )}

            {isHomeNode && <span className="icon"><Icon name="stack" /></span>}
            {node.id === "favorite" && <span className="icon"><Icon name="heart" /></span>}
            <span className="label" style={{ fontSize: depth === 0 ? "14px" : undefined, fontWeight: depth === 0 ? "700" : undefined }}>{isHomeNode ? "All" : node.label}</span>
            {isHomeNode && <span className="left-count">{allAssets.length}</span>}
            {node.id === "favorite" && <span className="left-count">{favoriteIds.size}</span>}
          </div>

          <div className={`submenu-container ${isExpanded ? "expanded" : "collapsed"}`}>
            {hasChildren && (
              <div className="submenu-inner" style={{ position: 'relative' }}>
                {depth >= 0 && <div className="tree-vertical-line" style={{ left: `${indentPixels + 9}px` }}></div>}
                {renderCategoryTree(node.children ?? [], depth + 1, node.id)}
              </div>
            )}
          </div>
        </div>
      );
    });
  }

  const assetModalMode: "import" | "edit" | null = importOpen ? "import" : editOpen ? "edit" : null;
  const isCurrentAssetSaving = assetModalMode === "edit" && editForm?.assetId ? savingAssetIdSet.has(editForm.assetId) : false;
  const normalizePathKey = useCallback((filePath: string) => normalizeLocalPath(String(filePath || "").trim()).toLowerCase(), []);
  const isPathMissing = (filePath: string) => {
    const normalizedPath = normalizePathKey(filePath);
    if (!normalizedPath) {
      return false;
    }
    return missingFilePathSet.has(normalizedPath);
  };
  useEffect(() => {
    if (!assetModalMode) {
      setMissingFilePathSet(new Set());
      return;
    }
    const activeForm = assetModalMode === "edit" ? editForm : importForm;
    const allPaths = [
      ...Object.values(activeForm.modelSlots || {}),
      ...(activeForm.textureEntries || []).map((entry) => entry.filePath),
      activeForm.previewImagePath
    ]
      .map((filePath) => String(filePath || "").trim())
      .filter(Boolean);
    if (!bridgeAvailable || typeof bridge.pathExists !== "function" || allPaths.length === 0) {
      setMissingFilePathSet(new Set());
      return;
    }
    const pathExists = bridge.pathExists;
    let active = true;
    const uniquePaths = [...new Set(allPaths.map((filePath) => normalizePathKey(filePath)).filter(Boolean))];
    Promise.all(uniquePaths.map(async (filePath) => {
      const exists = await pathExists(filePath);
      return { filePath, exists: Boolean(exists) };
    }))
      .then((results) => {
        if (!active) {
          return;
        }
        const nextMissingPathSet = new Set(results.filter((result) => !result.exists).map((result) => result.filePath));
        setMissingFilePathSet(nextMissingPathSet);
      })
      .catch(() => {
        if (active) {
          setMissingFilePathSet(new Set());
        }
      });
    return () => {
      active = false;
    };
  }, [
    assetModalMode,
    bridge,
    bridgeAvailable,
    editForm,
    editForm.modelSlots,
    editForm.textureEntries,
    editForm.previewImagePath,
    importForm,
    importForm.modelSlots,
    importForm.textureEntries,
    importForm.previewImagePath,
    normalizePathKey
  ]);
  const closeAssetModal = () => {
    if (assetModalMode === "import") {
      setImportOpen(false);
      setImportForm(defaultImportForm);
      setImportTagInput("");
      return;
    }
    if (assetModalMode === "edit") {
      setEditOpen(false);
      setEditTagInput("");
    }
  };

  if (shouldRequireLibrarySetup) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "#111", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 99999 }}>
        <div style={{ width: "560px", maxWidth: "92vw", padding: "24px", borderRadius: "12px", border: "1px solid #2a2a2a", background: "#171717", color: "#fff" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "24px" }}>
            <div style={{ width: "36px", height: "36px", background: `url(${appBrandIconPath}) center/contain no-repeat` }}></div>
            <div style={{ fontSize: "24px", fontWeight: 800, letterSpacing: "0.5px" }}>AssetHive</div>
          </div>
          <div style={{ fontSize: "22px", fontWeight: 700, marginBottom: "8px" }}>设置资产库路径</div>
          <div style={{ color: "#b9b9b9", marginBottom: "18px", lineHeight: 1.6 }}>
            当前 Megascan 库和 Custom 库都未配置。请先设置至少一个库路径后再进入软件。
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "16px" }}>
            <button style={{ width: "100%", height: "42px", borderRadius: "8px", border: "1px solid #2f2f2f", background: "#232323", color: "#fff", fontSize: "14px", fontWeight: 600, cursor: "pointer" }} onClick={pickMegascanPath}>
              选择 Megascan 库路径
            </button>
            <button style={{ width: "100%", height: "42px", borderRadius: "8px", border: "1px solid #2f2f2f", background: "#232323", color: "#fff", fontSize: "14px", fontWeight: 600, cursor: "pointer" }} onClick={pickCustomPath}>
              选择 Custom 库路径
            </button>
          </div>
          <div style={{ color: "#8d8d8d", fontSize: "12px", lineHeight: 1.5 }}>
            已设置路径后会自动进入主界面
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`app ${selectedAsset ? "has-details" : ""}`}>
      {settingsOpen && (
        <div className="settings-overlay">
          <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="settings-header">
              <span>PREFERENCES</span>
              <button className="settings-close" onClick={() => setSettingsOpen(false)}>
                <Icon name="close" />
              </button>
            </div>

            <div className="settings-tabs">
              <div
                className={`settings-tab ${settingsTab === "general" ? "active" : ""}`}
                onClick={() => setSettingsTab("general")}
              >
                GENERAL
              </div>
              <div
                className={`settings-tab ${settingsTab === "export" ? "active" : ""}`}
                onClick={() => setSettingsTab("export")}
              >
                EXPORT
              </div>
              <div
                className={`settings-tab ${settingsTab === "development" ? "active" : ""}`}
                onClick={() => setSettingsTab("development")}
              >
                DEVELOPMENT
              </div>
              <div
                className={`settings-tab ${settingsTab === "about" ? "active" : ""}`}
                onClick={() => setSettingsTab("about")}
              >
                ABOUT
              </div>
            </div>

            <div className="settings-content">
              {settingsTab === "general" && (
                <div className="settings-group import-group">
                  <div className="settings-row">
                    <div className="settings-label">{t("语言", "Language")}</div>
                    <div className="settings-field-col">
                      <div className="language-toggle-row">
                        <button
                          className={`language-toggle-btn ${uiLanguage === "zh" ? "active" : ""}`}
                          onClick={() => { void switchUiLanguage("zh"); }}
                        >
                          中文
                        </button>
                        <button
                          className={`language-toggle-btn ${uiLanguage === "en" ? "active" : ""}`}
                          onClick={() => { void switchUiLanguage("en"); }}
                        >
                          English
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="settings-row">
                    <div className="settings-label">
                      Megascan Library
                    </div>
                    <div className="settings-field-col">
                      <div className="path-display-row">
                        <div className="slot-input-wrap">
                          <div className={`path-box ${!settings.megascanLibraryPath ? "placeholder" : ""}`} title={settings.megascanLibraryPath || "No Path Set"}>
                            {settings.megascanLibraryPath || "No Path Set"}
                          </div>
                          <button className="path-icon-btn browse-icon-btn" title="Browse" onClick={pickMegascanPath}>
                            <Icon name="folder" />
                          </button>
                        </div>
                        {settings.megascanLibraryPath && (
                          <button className="path-icon-btn" onClick={clearMegascanPath}><Icon name="trash" /></button>
                        )}
                      </div>
                      <div className="field-desc">Location of Quixel Megascan assets.</div>
                    </div>
                  </div>

                  <div className="settings-row">
                    <div className="settings-label">
                      Custom Library
                    </div>
                    <div className="settings-field-col">
                      <div className="path-display-row">
                        <div className="slot-input-wrap">
                          <div className={`path-box ${!settings.customLibraryPath ? "placeholder" : ""}`} title={settings.customLibraryPath || "No Path Set"}>
                            {settings.customLibraryPath || "No Path Set"}
                          </div>
                          <button className="path-icon-btn browse-icon-btn" title="Browse" onClick={pickCustomPath}>
                            <Icon name="folder" />
                          </button>
                        </div>
                        {settings.customLibraryPath && (
                          <button className="path-icon-btn" onClick={clearCustomPath}><Icon name="trash" /></button>
                        )}
                      </div>
                      <div className="field-desc">Location for your custom assets.</div>
                    </div>
                  </div>
                </div>
              )}

              {settingsTab === "export" && (
                <div className="settings-group">
                  <div className="settings-row">
                    <div className="settings-label">Target Path</div>
                    <div className="settings-field-col">
                      <div className="path-display-row">
                        <div className="slot-input-wrap">
                          <input
                            className="settings-input"
                            value={settings.unrealEditorPath || settings.unrealProjectPath}
                            readOnly
                            placeholder="Select Engine Root or Project File (.uproject)"
                          />
                          <button className="path-icon-btn browse-icon-btn" title="Browse" onClick={pickTargetPath}>
                            <Icon name="folder" />
                          </button>
                        </div>
                        {(settings.unrealEditorPath || settings.unrealProjectPath) && (
                          <button className="path-icon-btn" onClick={() => {
                            clearEnginePath();
                            clearProjectPath();
                          }}><Icon name="close" /></button>
                        )}
                      </div>
                      <div className="field-desc">Select Unreal Engine Root Directory OR .uproject file. Plugin installs only when you click the install button.</div>
                      {(settings.unrealEditorPath || settings.unrealProjectPath) && (
                        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                          <button
                            className={`browse-btn ${pluginInstalled ? 'plugin-installed-btn' : ''}`}
                            style={{ marginTop: 0 }}
                            onClick={installPluginForCurrentTarget}
                            disabled={pluginInstallBusy || !pluginCanInstall}
                          >
                            {pluginInstallBusy ? "Installing..." : (pluginInstalled ? <><span className="text-normal">Installed</span><span className="text-hover">Reinstall AssetHive Plugin</span></> : "Install AssetHive Plugin")}
                          </button>
                          {!pluginInstallBusy && (
                            <span className="field-desc" style={{ marginTop: 0 }}>
                              {pluginInstalled ? "AssetHive plugin detected" : "AssetHive plugin not detected"}
                            </span>
                          )}
                        </div>
                      )}
                      {pluginInstallBusy && pluginInstallProgress != null && (
                        <>
                          <div className="status-progress" style={{ width: "100%", marginTop: 8, marginLeft: 0 }}>
                            <span className="status-progress-fill" style={{ width: `${Math.max(0, Math.min(100, pluginInstallProgress))}%` }} />
                          </div>
                          <div className="field-desc" style={{ marginTop: 6 }}>
                            插件安装进度：{Math.round(pluginInstallProgress)}%
                          </div>
                        </>
                      )}
                      {pluginStatusMessage && (
                        <div className="field-desc">{pluginStatusMessage}</div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {settingsTab === "development" && (
                <div className="settings-group">
                  <div className="settings-row">
                    <div className="settings-label">Log Path</div>
                    <div className="settings-field-col">
                      <div className="path-display-row">
                        <div className="slot-input-wrap">
                          <input
                            className="settings-input"
                            value={settings.unrealLogPath}
                            readOnly
                            placeholder="Log File Path"
                          />
                          <button className="path-icon-btn browse-icon-btn" title="Browse" onClick={pickLogPath}>
                            <Icon name="folder" />
                          </button>
                        </div>
                        {settings.unrealLogPath && (
                          <button className="path-icon-btn" onClick={clearLogPath}><Icon name="close" /></button>
                        )}
                      </div>
                      <div className="field-desc">软件运行日志及 Unreal 导入日志的统一输出路径。</div>
                    </div>
                  </div>
                  <div className="settings-row">
                    <div className="settings-label">{t("缓存文件", "Cache Files")}</div>
                    <div className="settings-field-col">
                      <div className="field-desc">{t("清理索引缓存，用于处理卡住或空白加载。", "Clear index cache to recover from freezes or blank loads.")}</div>
                      <button className="browse-btn" onClick={clearCacheFiles} disabled={busy}>
                        {busy ? t("处理中...", "Processing...") : t("清理缓存", "Clear Cache")}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {settingsTab === "about" && (
                <div className="settings-group">
                  <div className="settings-field-col" style={{ alignItems: "center" }}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, marginTop: 12 }}>
                      <img src={appBrandIconPath} alt="AssetHive" style={{ width: 78, height: 78, objectFit: "contain" }} />
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 22, fontWeight: 800, color: "var(--text-0)", letterSpacing: ".05em" }}>Asset Hive</span>
                        <span style={{ fontSize: 13, fontWeight: 700, opacity: 0.85 }}>v{appVersion || "-"}</span>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <button
                          className="browse-btn"
                          onClick={
                            appUpdateState.hasUpdate && appUpdateState.updateReady ? installDownloadedUpdatePackage :
                              appUpdateState.hasUpdate && !appUpdateState.updateReady ? downloadAppUpdate :
                                checkAppUpdate
                          }
                          disabled={appUpdateBusy || (appUpdateState.checked && !appUpdateState.hasUpdate)}
                        >
                          {appUpdateMode === "checking" ? "检查中..." :
                            appUpdateMode === "downloading" ? "下载中..." :
                              appUpdateMode === "installing" ? "启动中..." :
                                appUpdateState.hasUpdate && appUpdateState.updateReady ? "安装更新" :
                                  appUpdateState.hasUpdate && !appUpdateState.updateReady ? "下载更新" :
                                    appUpdateState.checked && !appUpdateState.hasUpdate ? "已经是最新版本" :
                                      "检查更新"}
                        </button>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
                    </div>
                    {appUpdateMode === "downloading" && (
                      <>
                        <div className="status-progress" style={{ width: "100%", marginTop: 8, marginLeft: 0 }}>
                          <span className="status-progress-fill" style={{ width: `${Math.max(0, Math.min(100, appUpdateDownloadProgress ?? 0))}%` }} />
                        </div>
                        <div className="field-desc" style={{ marginTop: 6 }}>
                          下载进度：{appUpdateDownloadProgress != null ? `${Math.round(appUpdateDownloadProgress)}%` : "计算中..."}{appUpdateTotalBytes > 0 ? `（${(appUpdateDownloadedBytes / 1024 / 1024).toFixed(1)}MB / ${(appUpdateTotalBytes / 1024 / 1024).toFixed(1)}MB）` : ""}
                        </div>
                      </>
                    )}
                    {appUpdateState.releaseNotes && (
                      <div className="field-desc">
                        <span style={{ display: "block", marginBottom: 4 }}>更新内容：</span>
                        <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{appUpdateState.releaseNotes}</div>
                      </div>
                    )}
                    {appUpdateMessage && (
                      <div className="field-desc">{appUpdateMessage}</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {assetModalMode && (
        <div className="settings-overlay">
          <div
            className={`settings-modal import-modal compact-modal ${assetModalMode === "edit" ? "edit-wide" : ""}`}
            onClick={(e) => e.stopPropagation()}
            onDragOverCapture={(event) => event.preventDefault()}
            onDropCapture={(event) => {
              event.preventDefault();
            }}
          >
            <div className="settings-header">
              <span>{assetModalMode === "import" ? "IMPORT CUSTOM ASSET" : "EDIT CUSTOM ASSET"}</span>
              <button className="settings-close" onClick={closeAssetModal} style={{ background: 'transparent', border: 'none', color: 'var(--text-2)', cursor: 'pointer' }}>
                <Icon name="close" />
              </button>
            </div>
            <div className="scrollable-content" style={{ opacity: (isCurrentAssetSaving || importSaving) ? 0.5 : 1, pointerEvents: (isCurrentAssetSaving || importSaving) ? "none" : "auto" }}>
              {assetModalMode === "import" ? (
                <div className="settings-group">
                  <div className="settings-row">
                    <div className="settings-label">Asset Name</div>
                    <div className="settings-field-col">
                      <input
                        className="settings-input"
                        value={importForm.assetName}
                        onChange={(event) => setImportForm((prev) => ({ ...prev, assetName: event.target.value }))}
                        placeholder="输入资产名"
                      />
                    </div>
                  </div>
                  <div className="settings-row">
                    <div className="settings-label">Asset Type</div>
                    <div className="settings-field-col import-type-category-row">
                      <DarkSelect
                        value={importForm.assetType}
                        ariaLabel="Import Asset Type"
                        className="settings-dark-select"
                        options={[
                          { value: "", label: "Select Category..." },
                          { value: "3d", label: "3D Assets" },
                          { value: "3dplant", label: "3D Plants" },
                          { value: "surface", label: "Surfaces" },
                          { value: "decal", label: "Decals" },
                          { value: "imperfection", label: "Imperfections" },
                          { value: "displacement", label: "Displacements" },
                          { value: "hdri", label: "HDRI" }
                        ]}
                        onChange={(nextAssetType) => {
                          const nextSubCategory = nextAssetType ? getSubCategoryOptions(nextAssetType)[0] || "" : "";
                          const isHdri = String(nextAssetType || "").toLowerCase() === "hdri";
                          setImportForm((prev) => ({
                            ...prev,
                            assetType: nextAssetType,
                            subCategory: nextSubCategory,
                            textureEntries: isHdri
                              ? [{ id: "import-hdri-001", textureType: "HDR", filePath: "", areaId: 1 }]
                              : prev.textureEntries.length > 0
                                ? prev.textureEntries
                                : defaultTextureTypes.map((textureType) => ({
                                  id: `import-default-${textureType.toLowerCase()}`,
                                  textureType,
                                  filePath: "",
                                  areaId: 1
                                })),
                            normalMapFormats: isHdri ? { 1: prev.normalMapFormat } : prev.normalMapFormats
                          }));
                        }}
                      />
                      <span className="inline-text-label">Category</span>
                      <DarkSelect
                        value={importForm.subCategory}
                        ariaLabel="Import Sub Category"
                        className="settings-dark-select"
                        disabled={!importForm.assetType}
                        options={[
                          { value: "", label: "Select Category..." },
                          ...getSubCategoryOptions(importForm.assetType).map((item) => ({ value: item, label: item }))
                        ]}
                        onChange={(nextValue) => setImportForm((prev) => ({ ...prev, subCategory: nextValue }))}
                      />
                    </div>
                  </div>
                  <div className="settings-row">
                    <div className="settings-label">Tags</div>
                    <div className="settings-field-col">
                      <div className="tag-editor">
                        {parseTagsText(importForm.tagsText).map((tag) => (
                          <button key={tag} type="button" className="tag-chip" onClick={() => removeImportTag(tag)}>
                            <span>{tag}</span>
                            <span>×</span>
                          </button>
                        ))}
                        <input
                          className="settings-input tag-input"
                          value={importTagInput}
                          onChange={(event) => setImportTagInput(event.target.value)}
                          onPaste={(event) => {
                            const clipboardText = event.clipboardData.getData("text");
                            const pastedTags = parseTagsFromClipboard(clipboardText);
                            if (pastedTags.length > 0) {
                              event.preventDefault();
                              syncImportTags([...new Set([...parseTagsText(importForm.tagsText), ...pastedTags])]);
                            }
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              addImportTag(importTagInput);
                            } else if (event.key === "Backspace" && !importTagInput.trim()) {
                              const tags = parseTagsText(importForm.tagsText);
                              if (tags.length > 0) {
                                removeImportTag(tags[tags.length - 1]);
                              }
                            }
                          }}
                          onBlur={() => addImportTag(importTagInput)}
                          placeholder="标签（按回车添加）"
                        />
                      </div>
                    </div>
                  </div>
                  {isModelAssetImportType(importForm.assetType) && (
                    <div className="settings-row section-divider-top" style={{ gridTemplateColumns: "1fr" }}>
                      <div className="settings-field-col" style={{ width: "100%" }}>
                        <div className="texture-section">
                          {getDisplayMeshSlotKeys(importForm.modelSlots).map((modelType) => (
                            <div key={modelType} className="texture-row model-slot-row">
                              <label className="texture-check">
                                <span>{getMeshSlotLabel(modelType)}</span>
                              </label>
                              <div
                                className="drop-target texture-drop"
                                style={{ flex: 1, width: "100%" }}
                                onDragEnter={(event) => event.preventDefault()}
                                onDragOverCapture={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                }}
                                onDragOver={(event) => event.preventDefault()}
                                onDrop={(event) => handleModelDrop(event, modelType)}
                              >
                                <div className="path-display-row">
                                  <div className="slot-input-wrap">
                                    <input
                                      className={`settings-input${isPathMissing(importForm.modelSlots[modelType] || "") ? " missing-file-path" : ""}`}
                                      value={importForm.modelSlots[modelType] || ""}
                                      readOnly
                                      placeholder={`选择或拖拽${getMeshSlotLabel(modelType)}模型`}
                                    />
                                    <button
                                      type="button"
                                      className="path-icon-btn browse-icon-btn"
                                      title="Browse"
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        pickImportModel(modelType);
                                      }}
                                    >
                                      <Icon name="folder" />
                                    </button>
                                  </div>
                                  {getDisplayMeshSlotKeys(importForm.modelSlots).length > 1 && (
                                    <button
                                      type="button"
                                      className="path-icon-btn remove-icon-btn"
                                      title="Remove"
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        removeImportModelSlot(modelType);
                                      }}
                                    >
                                      <Icon name="trash" />
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                          <div className="model-group-actions">
                            <button type="button" className="texture-add-btn" title="Add Model" onClick={addImportModelSlot}>
                              <Icon name="plus-circle" />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="settings-row section-divider-top" style={{ gridTemplateColumns: "1fr" }}>
                    <div className="settings-field-col" style={{ width: "100%" }}>
                      <div className="texture-section">
                        {getTextureAreaIdList(importForm.textureEntries).map((areaId, areaIndex) => {
                          const areaEntries = importForm.textureEntries.filter((entry) => Math.max(1, Number(entry.areaId) || 1) === areaId);
                          return (
                            <div key={`import-area-${areaId}`} className={`texture-area${areaIndex > 0 ? " with-separator" : ""}`}>
                              <div className="texture-area-header">
                                <span>{importForm.assetType === "hdri" ? "HDRI Texture" : `Texture Group ${formatTextureAreaOrder(areaId)}`}</span>
                                {areaId > 1 && importForm.assetType !== "hdri" && (
                                  <button
                                    type="button"
                                    className="path-icon-btn area-remove-btn"
                                    title="Remove Area"
                                    onClick={() => removeImportTextureArea(areaId)}
                                  >
                                    <Icon name="trash" />
                                  </button>
                                )}
                              </div>
                              {areaEntries.map((entry) => {
                                const usedByOthers = new Set(
                                  areaEntries
                                    .filter((item) => item.id !== entry.id)
                                    .map((item) => item.textureType)
                                    .filter((type) => type && type.toLowerCase() !== "displacement") // Allow multiple Displacements
                                );
                                return (
                                  <TextureEntryRow
                                    key={entry.id}
                                    entry={entry}
                                    usedByOthers={usedByOthers}
                                    textureTypeOptions={importForm.assetType === "hdri" ? ["HDR"] : textureTypeOptions}
                                    normalMapFormat={importForm.assetType === "hdri" ? undefined : getNormalMapFormatForArea(importForm, areaId)}
                                    onToggleNormalMapFormat={importForm.assetType === "hdri" ? undefined : (() => toggleImportNormalMapFormat(areaId))}
                                    busy={busy}
                                    onTextureTypeChange={(nextType) => updateImportTextureType(entry.id, nextType)}
                                    onDrop={(event) => handleTextureDrop(event, entry.id)}
                                    onPick={() => {
                                      void pickImportTexture(entry.id);
                                    }}
                                    onRemove={() => removeImportTextureEntry(entry.id)}
                                    isPathMissing={isPathMissing}
                                    disableRemove={importForm.assetType === "hdri"}
                                    lockTextureTypeSelect={importForm.assetType === "hdri"}
                                  />
                                );
                              })}
                              <div className="texture-group-actions">
                                {importForm.assetType !== "hdri" && (
                                  <>
                                    <button type="button" className="texture-add-btn" title="Add Texture" onClick={() => addImportTextureEntry(areaId)}>
                                      <Icon name="plus-circle" />
                                    </button>
                                    {areaIndex === getTextureAreaIdList(importForm.textureEntries).length - 1 && (
                                      <button type="button" className="texture-add-area-btn" title="Add Texture Group" onClick={addImportTextureArea}>
                                        <Icon name="plus" />
                                        <span>Add Texture Group</span>
                                      </button>
                                    )}
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                  {importForm.assetType !== "hdri" && (
                    <div className="settings-row section-divider-top">
                      <div className="settings-label">Preview Image</div>
                      <div className="settings-field-col">
                        <PreviewDropSlot
                          previewImagePath={importForm.previewImagePath}
                          busy={busy}
                          onPick={() => {
                            void pickImportPreview();
                          }}
                          onDrop={handlePreviewDrop}
                          onRemove={removeImportPreviewImage}
                          onCutout={() => openPreviewCutout("import")}
                          isPathMissing={isPathMissing}
                        />
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="settings-group">
                  <div className="settings-row">
                    <div className="settings-label">Asset Name</div>
                    <div className="settings-field-col">
                      <input
                        className="settings-input"
                        value={editForm.assetName}
                        onChange={(event) => setEditForm((prev) => ({ ...prev, assetName: event.target.value }))}
                        placeholder="输入资产名"
                      />
                    </div>
                  </div>
                  <div className="settings-row">
                    <div className="settings-label">Asset Type</div>
                    <div className="settings-field-col import-type-category-row">
                      <DarkSelect
                        value={editForm.assetType}
                        ariaLabel="Edit Asset Type"
                        className="settings-dark-select"
                        options={[
                          { value: "", label: "Select Category..." },
                          { value: "3d", label: "3D Assets" },
                          { value: "3dplant", label: "3D Plants" },
                          { value: "surface", label: "Surfaces" },
                          { value: "decal", label: "Decals" },
                          { value: "imperfection", label: "Imperfections" },
                          { value: "displacement", label: "Displacements" },
                          { value: "hdri", label: "HDRI" }
                        ]}
                        onChange={(nextAssetType) => {
                          const nextSubCategory = nextAssetType ? getSubCategoryOptions(nextAssetType)[0] || "" : "";
                          const isHdri = String(nextAssetType || "").toLowerCase() === "hdri";
                          setEditForm((prev) => ({
                            ...prev,
                            assetType: nextAssetType,
                            subCategory: nextSubCategory,
                            textureEntries: isHdri
                              ? [{ id: "edit-hdri-001", textureType: "HDR", filePath: "", areaId: 1 }]
                              : prev.textureEntries.length > 0
                                ? prev.textureEntries
                                : defaultTextureTypes.map((textureType) => ({
                                  id: `edit-default-${textureType.toLowerCase()}`,
                                  textureType,
                                  filePath: "",
                                  areaId: 1
                                })),
                            normalMapFormats: isHdri ? { 1: prev.normalMapFormat } : prev.normalMapFormats
                          }));
                        }}
                      />
                      <span className="inline-text-label">Category</span>
                      <DarkSelect
                        value={editForm.subCategory}
                        ariaLabel="Edit Sub Category"
                        className="settings-dark-select"
                        disabled={!editForm.assetType}
                        options={[
                          { value: "", label: "Select Category..." },
                          ...getSubCategoryOptions(editForm.assetType).map((item) => ({ value: item, label: item }))
                        ]}
                        onChange={(nextValue) => setEditForm((prev) => ({ ...prev, subCategory: nextValue }))}
                      />
                    </div>
                  </div>
                  <div className="settings-row">
                    <div className="settings-label">Tags</div>
                    <div className="settings-field-col">
                      <div className="tag-editor" onContextMenu={(event) => handleTagContextMenu(event, "edit")}>
                        {parseTagsText(editForm.tagsText).map((tag) => (
                          <button key={tag} type="button" className="tag-chip" onClick={() => removeEditTag(tag)}>
                            <span>{tag}</span>
                            <span>×</span>
                          </button>
                        ))}
                        <input
                          className="settings-input tag-input"
                          value={editTagInput}
                          onChange={(event) => setEditTagInput(event.target.value)}
                          onPaste={(event) => {
                            const clipboardText = event.clipboardData.getData("text");
                            const pastedTags = parseTagsFromClipboard(clipboardText);
                            if (pastedTags.length > 0) {
                              event.preventDefault();
                              syncEditTags([...new Set([...parseTagsText(editForm.tagsText), ...pastedTags])]);
                            }
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              addEditTag(editTagInput);
                            } else if (event.key === "Backspace" && !editTagInput.trim()) {
                              const tags = parseTagsText(editForm.tagsText);
                              if (tags.length > 0) {
                                removeEditTag(tags[tags.length - 1]);
                              }
                            }
                          }}
                          onBlur={() => addEditTag(editTagInput)}
                          placeholder="标签（按回车添加）"
                        />
                      </div>
                    </div>
                  </div>
                  {isModelAssetImportType(editForm.assetType) && (
                    <div className="settings-row section-divider-top" style={{ gridTemplateColumns: "1fr" }}>
                      <div className="settings-field-col" style={{ width: "100%" }}>
                        <div className="texture-section">
                          {getDisplayMeshSlotKeys(editForm.modelSlots).map((modelType) => (
                            <div key={modelType} className="texture-row model-slot-row">
                              <label className="texture-check">
                                <span>{getMeshSlotLabel(modelType)}</span>
                              </label>
                              <div
                                className="drop-target texture-drop"
                                style={{ flex: 1, width: "100%" }}
                                onDragEnter={(event) => event.preventDefault()}
                                onDragOverCapture={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                }}
                                onDragOver={(event) => event.preventDefault()}
                                onDrop={(event) => handleEditModelDrop(event, modelType)}
                              >
                                <div className="path-display-row">
                                  <div className="slot-input-wrap">
                                    <input
                                      className={`settings-input${isPathMissing(editForm.modelSlots[modelType] || "") ? " missing-file-path" : ""}`}
                                      value={editForm.modelSlots[modelType] || ""}
                                      readOnly
                                      placeholder={`选择或拖拽${getMeshSlotLabel(modelType)}模型`}
                                    />
                                    <button
                                      type="button"
                                      className="path-icon-btn browse-icon-btn"
                                      title="Browse"
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        pickEditModel(modelType);
                                      }}
                                    >
                                      <Icon name="folder" />
                                    </button>
                                  </div>
                                  {getDisplayMeshSlotKeys(editForm.modelSlots).length > 1 && (
                                    <button
                                      type="button"
                                      className="path-icon-btn remove-icon-btn"
                                      title="Remove"
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        removeEditModelSlot(modelType);
                                      }}
                                    >
                                      <Icon name="trash" />
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                          <div className="model-group-actions">
                            <button type="button" className="texture-add-btn" title="Add Model" onClick={addEditModelSlot}>
                              <Icon name="plus-circle" />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="settings-row section-divider-top" style={{ gridTemplateColumns: "1fr" }}>
                    <div className="settings-field-col" style={{ width: "100%" }}>
                      <div className="texture-section">
                        {getTextureAreaIdList(editForm.textureEntries).map((areaId, areaIndex) => {
                          const areaEntries = editForm.textureEntries.filter((entry) => Math.max(1, Number(entry.areaId) || 1) === areaId);
                          return (
                            <div key={`edit-area-${areaId}`} className={`texture-area${areaIndex > 0 ? " with-separator" : ""}`}>
                              <div className="texture-area-header">
                                <span>{editForm.assetType === "hdri" ? "HDRI Texture" : `Texture Group ${formatTextureAreaOrder(areaId)}`}</span>
                                {areaId > 1 && editForm.assetType !== "hdri" && (
                                  <button
                                    type="button"
                                    className="path-icon-btn area-remove-btn"
                                    title="Remove Area"
                                    onClick={() => removeEditTextureArea(areaId)}
                                  >
                                    <Icon name="trash" />
                                  </button>
                                )}
                              </div>
                              {areaEntries.map((entry) => {
                                const usedByOthers = new Set(
                                  areaEntries
                                    .filter((item) => item.id !== entry.id)
                                    .map((item) => item.textureType)
                                    .filter((type) => type && type.toLowerCase() !== "displacement") // Allow multiple Displacements
                                );
                                return (
                                  <TextureEntryRow
                                    key={entry.id}
                                    entry={entry}
                                    usedByOthers={usedByOthers}
                                    textureTypeOptions={editForm.assetType === "hdri" ? ["HDR"] : textureTypeOptions}
                                    normalMapFormat={editForm.assetType === "hdri" ? undefined : getNormalMapFormatForArea(editForm, areaId)}
                                    onToggleNormalMapFormat={editForm.assetType === "hdri" ? undefined : (() => toggleEditNormalMapFormat(areaId))}
                                    busy={busy}
                                    onTextureTypeChange={(nextType) => updateEditTextureType(entry.id, nextType)}
                                    onDrop={(event) => handleEditTextureDrop(event, entry.id)}
                                    onPick={() => {
                                      void pickEditTexture(entry.id);
                                    }}
                                    onRemove={() => removeEditTextureEntry(entry.id)}
                                    isPathMissing={isPathMissing}
                                    disableRemove={editForm.assetType === "hdri"}
                                    lockTextureTypeSelect={editForm.assetType === "hdri"}
                                  />
                                );
                              })}
                              <div className="texture-group-actions edit-texture-group-actions">
                                {editForm.assetType !== "hdri" && (
                                  <>
                                    <button type="button" className="texture-add-btn" title="Add Texture" onClick={() => addEditTextureEntry(areaId)}>
                                      <Icon name="plus-circle" />
                                    </button>
                                    {areaIndex === getTextureAreaIdList(editForm.textureEntries).length - 1 && (
                                      <button type="button" className="texture-add-area-btn" title="Add Texture Group" onClick={addEditTextureArea}>
                                        <Icon name="plus" />
                                        <span>Add Texture Group</span>
                                      </button>
                                    )}
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                  {editForm.assetType !== "hdri" && (
                    <div className="settings-row section-divider-top">
                      <div className="settings-label">Preview Image</div>
                      <div className="settings-field-col">
                        <PreviewDropSlot
                          previewImagePath={editForm.previewImagePath}
                          busy={busy}
                          onPick={() => {
                            void pickEditPreview();
                          }}
                          onDrop={handleEditPreviewDrop}
                          onRemove={removeEditPreviewImage}
                          onCutout={() => openPreviewCutout("edit")}
                          isPathMissing={isPathMissing}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="browse-btn" onClick={closeAssetModal}>{t("取消", "Cancel")}</button>
              {assetModalMode === "import" ? (
                <button className="export-btn import-submit" onClick={submitImportAsset} disabled={busy || importSaving}>
                  {importSaving ? (
                    <>
                      <span className="save-spinner" />
                      <span>{t("保存中...", "Saving...")}</span>
                    </>
                  ) : t("导入", "Import")}
                </button>
              ) : (
                <button className="export-btn import-submit" onClick={submitEditAsset} disabled={busy || isCurrentAssetSaving}>
                  {isCurrentAssetSaving ? (
                    <>
                      <span className="save-spinner" />
                      <span>{t("保存中...", "Saving...")}</span>
                    </>
                  ) : t("保存", "Save")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {modalAlert && modalAlert.visible && (
        <div className="cutout-overlay" onClick={() => setModalAlert(null)}>
          <div className="cutout-modal" onClick={(e) => e.stopPropagation()} style={{ width: "400px", minHeight: "auto" }}>
            <div className="cutout-header">
              <span>{modalAlert.title || "Message"}</span>
              <button className="path-icon-btn" onClick={() => setModalAlert(null)}>
                <Icon name="close" />
              </button>
            </div>
            <div className="cutout-body" style={{ padding: "20px" }}>
              <div style={{ color: "var(--text-1)", fontSize: "14px", lineHeight: "1.5", marginBottom: "20px" }}>
                {modalAlert.message}
              </div>
              <div className="cutout-actions" style={{ justifyContent: "flex-end" }}>
                <button className="export-btn import-submit" onClick={() => setModalAlert(null)}>OK</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {tagContextMenu && (
        <div
          className="context-menu"
          style={{ top: tagContextMenu.y, left: tagContextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={() => void runTagContextAction("copy-all")}>Copy Tags</button>
          {tagContextMenu.tag && <button onClick={() => void runTagContextAction("copy-one")}>Copy This Tag</button>}
          <button onClick={() => void runTagContextAction("paste")}>{tagContextMenu.scope === "detail" ? "Paste To Search" : "Paste Tags"}</button>
        </div>
      )}

      {contextMenu && (
        <div
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x, opacity: savingAssetIdSet.has(contextMenu.assetId) ? 0.5 : 1, pointerEvents: savingAssetIdSet.has(contextMenu.assetId) ? "none" : "auto" }}
          onClick={(e) => e.stopPropagation()}
        >
          {(() => {
            const target = assets.find(a => a.id === contextMenu.assetId);
            if (!target || target.source !== "custom") {
              return null;
            }
            return (
              <button onClick={() => {
                openEditAsset(target);
                setContextMenu(null);
              }}>
                Edit Asset
              </button>
            );
          })()}
          <button onClick={async () => {
            const target = assets.find(a => a.id === contextMenu.assetId);
            if (target) {
              await copyAssetId(target.assetID || target.id);
            }
            setContextMenu(null);
          }}>
            Copy Asset ID
          </button>
          <button onClick={() => {
            const target = assets.find(a => a.id === contextMenu.assetId);
            if (target && bridgeAvailable) {
              bridge.openFolder(target.path);
            }
            setContextMenu(null);
          }}>
            Open in Explorer
          </button>
          {(() => {
            const target = assets.find(a => a.id === contextMenu.assetId);
            if (!target || target.source !== "custom") {
              return null;
            }
            return (
              <>
                <div className="context-menu-divider" />
                <button
                  className="delete-btn"
                  onClick={() => {
                    setContextMenu(null);
                    deleteCustomAsset(target);
                  }}
                >
                  Delete Asset
                </button>
              </>
            );
          })()}
        </div>
      )}
      {cutoutOpen && (
        <div className="cutout-overlay" onClick={closePreviewCutout}>
          <div className="cutout-modal" onClick={(event) => event.stopPropagation()}>
            <div className="cutout-header">
              <span>Preview Cutout</span>
              <button className="path-icon-btn" onClick={closePreviewCutout} disabled={cutoutBusy}>
                <Icon name="close" />
              </button>
            </div>
            <div className="cutout-body">
              <div className="cutout-preview">
                {cutoutWorkingPath ? (
                  <img
                    src={getPreviewUrl(cutoutWorkingPath)}
                    alt="cutout-preview"
                    onClick={handleCutoutPick}
                  />
                ) : (
                  <div style={{ opacity: 0.7 }}>
                    <Icon name="image-preview" />
                  </div>
                )}
              </div>
              <div className="cutout-tolerance">
                <span>Tolerance</span>
                <input
                  type="range"
                  min={1}
                  max={64}
                  step={1}
                  value={cutoutTolerance}
                  onChange={(event) => handleCutoutToleranceChange(Number(event.target.value) || 1)}
                />
                <strong>{cutoutTolerance}</strong>
              </div>
              <div className="field-desc">点击图片可连续抠除相近颜色区域。</div>
              <div className="cutout-actions">
                <button className="browse-btn" onClick={closePreviewCutout} disabled={cutoutBusy}>{t("取消", "Cancel")}</button>
                <button className="export-btn import-submit" onClick={confirmPreviewCutout} disabled={cutoutBusy || !cutoutWorkingPath}>
                  {cutoutBusy ? "Processing..." : "Apply"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <ModelProcessor />
      <aside className="left-nav">
        <div className="brand-wrap">
          <img className="brand-icon-img" src={appBrandIconPath} alt="AssetHive" />
          <div className="brand-text">
            <span className="brand-name">Asset Hive</span>
            {appVersion && <span className="brand-version">v{appVersion}</span>}
            {appUpdateState.hasUpdate && (
              <span
                className="brand-update-badge"
                title="New update available"
                onClick={() => {
                  setSettingsOpen(true);
                  setSettingsTab("about");
                }}
              >
                NEW
              </span>
            )}
          </div>
        </div>
        <div className="left-scroll">
          {renderCategoryTree(expandedCategoryTree)}
        </div>
        <div className="left-status">
          <span
            className={`status-conn-dot ${unrealConnected ? "connected" : "disconnected"}`}
            title={unrealConnected ? `${unrealConnectedTargetName || "Unknown"}` : "未连接"}
          />
          <span className="status-text">{status}</span>
          {scanning && (
            <div className="status-right" title={scanHint || undefined}>
              <div className="status-progress">
                <span className="status-progress-fill" style={{ width: `${Math.max(0, Math.min(100, scanProgress))}%` }} />
              </div>
              <span className="status-progress-text">{Math.round(Math.max(0, Math.min(100, scanProgress)))}%</span>
            </div>
          )}
        </div>
      </aside>

      <main className="center">
        <header className="top-strip">
          <div className="search-wrap">
            <Icon name="search" />
            <input
              className="search-input"
              value={search.text}
              onChange={(event) => executeSearch({ ...search, text: event.target.value })}
              placeholder="Search assets..."
            />
            {search.text && (
              <button className="search-clear" onClick={() => executeSearch({ ...search, text: "" })}>×</button>
            )}
          </div>

          <div className="top-right-actions">
            <button
              className={`top-action import-cta${quickDropActive ? " quick-drop-zone active" : ""}${quickDropBusy ? " importing" : ""}`}
              title={quickDropBusy
                ? `${t("取消识别", "Cancel")} (${Math.round(Math.max(0, Math.min(100, quickDropProgress)))}%)`
                : (quickDropActive ? t("松开以识别并打开导入", "Drop to detect and open import") : t("导入资产", "Import Asset"))}
              onDragEnter={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (quickDropBusy) {
                  return;
                }
                setQuickDropActive(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (quickDropBusy) {
                  return;
                }
                setQuickDropActive(true);
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const related = event.relatedTarget as Node | null;
                if (related && event.currentTarget.contains(related)) {
                  return;
                }
                setQuickDropActive(false);
              }}
              onDrop={async (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (quickDropBusy) {
                  return;
                }
                setQuickDropActive(false);
                const paths = await readDroppedPathsFromEvent(event);
                await applyQuickDropImport(paths);
              }}
              onClick={() => {
                if (quickDropBusy) {
                  const requestId = quickDropRequestIdRef.current;
                  quickDropRequestIdRef.current = "";
                  setQuickDropBusy(false);
                  setQuickDropProgress(0);
                  if (bridgeAvailable && typeof bridge.cancelResolveDroppedItems === "function" && requestId) {
                    void bridge.cancelResolveDroppedItems({ requestId });
                  }
                  return;
                }
                setQuickDropActive(false);
                setImportForm(defaultImportForm);
                setImportTagInput("");
                setImportOpen(true);
              }}
            >
              {quickDropBusy && <div className="import-cta-progress" />}
              {quickDropBusy ? <div className="import-spinner" /> : <Icon name="upload" />}
              <span className="import-cta-label">{quickDropActive && !quickDropBusy ? t("拖拽导入", "Drop") : t("导入", "Import")}</span>
              <span className="import-cta-cancel">{t("取消", "Cancel")}</span>
            </button>
            <button className="settings-trigger" onClick={() => setSettingsOpen((prev) => !prev)}>
              <Icon name="settings" />
            </button>
            <div className="window-controls-divider" />
            <div className="window-controls">
              <button className="window-control-btn" title="Minimize" onClick={handleWindowMinimize}>
                <Icon name="minimize" />
              </button>
              <button className="window-control-btn" title="Toggle Window Size" onClick={handleWindowToggleMaximize}>
                <Icon name="maximize" />
              </button>
              <button className="window-control-btn close-btn" title="Close" onClick={handleWindowClose}>
                <Icon name="close" />
              </button>
            </div>
          </div>
        </header>

        <div className="filter-bar">
          <DarkSelect
            value={search.assetTypes[0] || "all"}
            className="filter-select"
            ariaLabel="Asset Type"
            options={[
              { value: "all", label: "All Types" },
              { value: "3d", label: "3D" },
              { value: "3dplant", label: "3D Plant" },
              { value: "surface", label: "Surface" },
              { value: "decal", label: "Decal" },
              { value: "imperfection", label: "Imperfection" },
              { value: "displacement", label: "Displacement" }
            ]}
            onChange={(nextValue) => executeSearch({ ...search, assetTypes: nextValue === "all" ? [] : [nextValue] })}
          />
          <DarkSelect
            value={search.size}
            className="filter-select"
            ariaLabel="Asset Size"
            options={[
              { value: "all", label: "All Sizes" },
              { value: "tiny", label: "Tiny (0-1m)" },
              { value: "small", label: "Small (1-2m)" },
              { value: "medium", label: "Medium (2-5m)" },
              { value: "large", label: "Large (5-10m)" },
              { value: "huge", label: "Huge (10m+)" }
            ]}
            onChange={(nextValue) => executeSearch({ ...search, size: nextValue })}
          />
          <DarkSelect
            value={search.favoriteState || "all"}
            className="filter-select"
            ariaLabel="Asset State"
            options={[
              { value: "all", label: "All States" },
              { value: "fav", label: "Favorites" },
              { value: "not", label: "Not Favorite" }
            ]}
            onChange={(nextValue) => executeSearch({ ...search, favoriteState: nextValue as SearchState["favoriteState"], onlyFavorites: nextValue === "fav" })}
          />
          <DarkSelect
            value={search.environment}
            className="filter-select"
            ariaLabel="Asset Environment"
            options={[
              { value: "all", label: "All Environments" },
              { value: "nature", label: "Nature" },
              { value: "street", label: "Street" },
              { value: "interior", label: "Interior" },
              { value: "props", label: "Props" },
              { value: "rock", label: "Rock" },
              { value: "wood", label: "Wood" },
              { value: "metal", label: "Metal" },
              { value: "concrete", label: "Concrete" }
            ]}
            onChange={(nextValue) => executeSearch({ ...search, environment: nextValue })}
          />
          <DarkSelect
            value={search.color}
            className="filter-select"
            ariaLabel="Asset Color"
            options={[
              { value: "all", label: "All Colors" },
              { value: "black", label: "Black" },
              { value: "brown", label: "Brown" },
              { value: "blue", label: "Blue" },
              { value: "gray", label: "Gray" },
              { value: "green", label: "Green" },
              { value: "orange", label: "Orange" },
              { value: "pink", label: "Pink" },
              { value: "purple", label: "Purple" },
              { value: "red", label: "Red" },
              { value: "white", label: "White" },
              { value: "yellow", label: "Yellow" }
            ]}
            onChange={(nextValue) => executeSearch({ ...search, color: nextValue })}
          />
        </div>

        {!bridgeAvailable && (
          <div className="warn">Preview Mode: Electron features disabled</div>
        )}

        <div className="stage-container">
          <div className="asset-stage" ref={assetStageRef} onScroll={handleAssetStageScroll}>
            <section className={`asset-grid ${shouldVirtualizeAssetGrid ? "asset-grid-virtual" : ""}`}>
              {shouldVirtualizeAssetGrid && virtualGridLayout.topSpacerHeight > 0 && (
                <div className="asset-grid-spacer" style={{ height: `${virtualGridLayout.topSpacerHeight}px` }} />
              )}
              {visibleAssets.map((asset) => (
                <AssetCard
                  key={asset.id}
                  asset={asset}
                  previewSrc={getCardPreviewSrc(asset)}
                  isSelected={selectedAssetId === asset.id || selectedIdSet.has(asset.id)}
                  isFavorite={favoriteIds.has(asset.id)}
                  onSelect={handleSelectAsset}
                  onToggle={toggleSelect}
                  onToggleFavorite={toggleFavorite}
                  onContextMenu={handleContextMenu}
                  onQuickExport={handleQuickExport}
                  exportDisabled={busy || isExporting || !canExportToUnreal}
                  exportDimmed={(isExporting && !importingAssetIds.includes(asset.id)) || !canExportToUnreal}
                  exportLoading={isExporting && importingAssetIds.includes(asset.id)}
                  exportProgress={isExporting && importingAssetIds.includes(asset.id) ? exportProgress : 0}
                  savingProgress={savingProgressMap[asset.id]}
                  exportTitle={!canExportToUnreal ? t("未找到可导入的工程", "No importable project found") : undefined}
                />
              ))}
              {shouldVirtualizeAssetGrid && virtualGridLayout.bottomSpacerHeight > 0 && (
                <div className="asset-grid-spacer" style={{ height: `${virtualGridLayout.bottomSpacerHeight}px` }} />
              )}
            </section>
          </div>

          <aside className={`right-panel ${selectedAsset ? "open" : ""}`}>
            {selectedAsset ? (
              <>
                <div className="right-content">
                  <div className="preview-main">
                    <div className="preview-overlay-actions">
                      <button className="action-btn" onClick={focusSelectedAssetCard}><Icon name="search" /></button>
                      <button className="action-btn" onClick={() => setSelectedAssetId(null)}><Icon name="close" /></button>
                    </div>
                    {!detailPreviewLoaded && (selectedAsset.detailImage || selectedAsset.previewImage || selectedAsset.preview) && (
                      <div className="preview-shimmer"></div>
                    )}
                    {(selectedAsset.detailImage || selectedAsset.previewImage || selectedAsset.preview) ? (
                      <img
                        key={selectedAsset.id}
                        src={getPreviewUrl(selectedAsset.detailImage || selectedAsset.previewImage || selectedAsset.preview)}
                        alt={selectedAsset.name}
                        className={`preview-img ${detailPreviewLoaded ? "loaded" : ""} ${detailPreviewFitScaled ? "fit-scaled" : ""}`}
                        onLoad={(event) => {
                          const img = event.currentTarget;
                          const ratio = img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 1;
                          const isWide = ratio > 1.7 && ratio < 1.85;
                          setDetailPreviewFitScaled(!isWide);
                          setDetailPreviewLoaded(true);
                        }}
                        onError={() => {
                          setDetailPreviewFitScaled(false);
                          setDetailPreviewLoaded(true);
                        }}
                      />
                    ) : (
                      <div style={{ opacity: 0.7 }}>
                        <Icon name="image-preview" />
                      </div>
                    )}
                  </div>

                  <div className="detail-heading-row">
                    <h2>{selectedAsset.name}</h2>
                    <button
                      className="heart-icon-btn detail-heading-heart"
                      style={{ border: "none", background: "transparent", cursor: "pointer", color: favoriteIds.has(selectedAsset.id) ? "#e74c3c" : "var(--text-2)" }}
                      onClick={() => toggleFavorite(selectedAsset.id)}
                    >
                      <Icon name={favoriteIds.has(selectedAsset.id) ? "heart-filled" : "heart"} />
                    </button>
                  </div>
                  <div className="asset-subline" style={{ color: "var(--text-2)", fontWeight: 500, fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    <span style={{ color: "#a0a0a0", fontWeight: 700 }}>{getAssetTypeLabel(selectedAsset.assetType)}</span>
                    <span style={{ margin: "0 8px", color: "var(--line-1)" }}>|</span>
                    <span style={{ userSelect: "text", color: "var(--text-2)", textTransform: "none" }}>{selectedAsset.id}</span>
                  </div>

                  <div className="detail-tags">
                    {[...new Set([...(selectedAsset.tags || []), ...getAssetColorTags(selectedAsset)])]
                      .filter(tag => {
                        if (!tag || !tag.trim()) return false;
                        const normalizedTag = normalizeThemeToken(tag);
                        const assetTypeLabel = normalizeThemeToken(getAssetTypeLabel(selectedAsset.assetType));
                        const rawAssetType = normalizeThemeToken(selectedAsset.assetType);
                        const subCategory = normalizeThemeToken(getAssetSubCategory(selectedAsset));
                        return normalizedTag !== assetTypeLabel && normalizedTag !== rawAssetType && normalizedTag !== subCategory;
                      })
                      .slice(0, 15)
                      .map((tag) => (
                        <button key={tag} className="pill" onContextMenu={(event) => handleTagContextMenu(event, "detail", tag)}>
                          {formatDetailTag(tag)}
                        </button>
                      ))}
                  </div>

                  <div className="detail-divider" style={{
                    height: '1px',
                    background: 'var(--line-0)',
                    margin: '24px 0 16px',
                    width: '100%'
                  }}></div>

                  <div className="detail-actions">
                    {shouldShowSizePreview(selectedAsset) ? (
                      <SizeComparison dimensions={getAssetDimensions(selectedAsset)} />
                    ) : null}
                  </div>

                  <div className="detail-list">
                    <h3>Related Assets</h3>
                    <div className="related-grid">
                      {relatedAssets.map((asset) => (
                        <RelatedAssetCard key={asset.id} asset={asset} onSelect={setSelectedAssetId} />
                      ))}
                      {relatedAssets.length === 0 && <div style={{ color: 'var(--text-2)', fontSize: '11px' }}>No related assets</div>}
                    </div>
                  </div>
                </div>

                <div className="bottom-actions">
                  <button className={`export-btn detail-export-btn ${selectedAssetExporting ? "loading" : ""} ${(isExporting && !selectedAssetExporting) || !canExportToUnreal ? "dimmed" : ""}`} onClick={() => {
                    const hasCurrentInBatch = selectedIds.includes(selectedAsset.id);
                    const assetIds = selectedIds.length > 0 && hasCurrentInBatch ? selectedIds : [selectedAsset.id];
                    void runImport(assetIds);
                  }} disabled={busy || isExporting || !canExportToUnreal} title={!canExportToUnreal ? t("未找到可导入的工程", "No importable project found") : undefined}>
                    {selectedAssetExporting && (
                      <>
                        <span className="detail-export-fill" style={{ width: `${Math.max(0, Math.min(100, exportProgress))}%` }} />
                        <span className="detail-export-stage">{`${exportStage || resolveExportStageLabel(exportProgress)} ${Math.round(Math.max(0, Math.min(100, exportProgress)))}%`}</span>
                      </>
                    )}
                    {!selectedAssetExporting && (
                      <>
                        <Icon name="plus" />
                        <span>Send To Unreal engine</span>
                      </>
                    )}
                  </button>
                  <div className="detail-export-option">
                    <div className="detail-export-select-wrap">
                      <DarkSelect
                        value={activeExportResolutionValue}
                        options={availableExportResolutionOptions}
                        disabled={busy || isExporting}
                        ariaLabel="Export Resolution"
                        className="detail-export-dark-select"
                        menuClassName="detail-export-menu"
                        itemClassName="detail-export-menu-item"
                        onChange={(nextValue) => {
                          void changeExportResolution(nextValue);
                        }}
                      />
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="detail-empty">Select an asset to view details</div>
            )}
          </aside>
          {showScrollTopButton && (
            <button className="asset-scroll-top-btn" type="button" onClick={scrollAssetStageToTop} title="回到顶部">
              <Icon name="arrow-up" />
            </button>
          )}
        </div>
        {deleteConfirmAsset && (
          <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label="确认删除资产">
            <div className="confirm-dialog">
              <h3>确认删除</h3>
              <p>确认删除资产“{deleteConfirmAsset.name}”？该操作不可恢复。</p>
              <div className="confirm-actions">
                <button type="button" className="confirm-btn ghost" onClick={() => setDeleteConfirmAsset(null)}>取消</button>
                <button type="button" className="confirm-btn danger" onClick={() => { void confirmDeleteCustomAsset(); }}>删除</button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
