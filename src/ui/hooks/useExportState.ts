import { useState } from "react";

export function useExportState() {
  const [busy, setBusy] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [importingAssetIds, setImportingAssetIds] = useState<string[]>([]);
  const [exportStage, setExportStage] = useState("");
  const [exportProgress, setExportProgress] = useState(0);
  const [quickDropActive, setQuickDropActive] = useState(false);
  const [quickDropBusy, setQuickDropBusy] = useState(false);
  const [quickDropProgress, setQuickDropProgress] = useState(0);
  const [importSaving, setImportSaving] = useState(false);
  const [savingProgressMap, setSavingProgressMap] = useState<Record<string, number>>({});
  const [unrealConnected, setUnrealConnected] = useState(false);
  const [unrealConnectedTargetName, setUnrealConnectedTargetName] = useState("");

  return {
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
  };
}
