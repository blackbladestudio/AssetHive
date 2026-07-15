import { useState } from "react";
import type {
  ModalAlertState,
  ContextMenuState,
  TagContextMenuState,
  AssetStageMetrics
} from "./types";

export function useUIState() {
  const [modalAlert, setModalAlert] = useState<ModalAlertState>(null);
  const [status, setStatusText] = useState("");
  const [detailPreviewFitScaled, setDetailPreviewFitScaled] = useState(false);
  const [detailPreviewLoaded, setDetailPreviewLoaded] = useState(false);
  const [showScrollTopButton, setShowScrollTopButton] = useState(false);
  const [assetStageMetrics, setAssetStageMetrics] = useState<AssetStageMetrics>({
    scrollTop: 0,
    viewportHeight: 0,
    viewportWidth: 0
  });
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [tagContextMenu, setTagContextMenu] = useState<TagContextMenuState>(null);

  // Scan
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanHint, setScanHint] = useState("");

  // Plugin
  const [pluginInstalled, setPluginInstalled] = useState(false);
  const [pluginCanInstall, setPluginCanInstall] = useState(false);
  const [pluginInstallBusy, setPluginInstallBusy] = useState(false);
  const [pluginInstallProgress, setPluginInstallProgress] = useState<number | null>(null);
  const [pluginStatusMessage, setPluginStatusMessage] = useState("");
  const [hasImportableProject, setHasImportableProject] = useState(false);

  return {
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
  };
}
