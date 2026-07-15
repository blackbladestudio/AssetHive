import { useState } from "react";
import type { AppSettings } from "../../types";
import {
  defaultSettings,
  defaultImportForm,
  defaultEditForm,
  defaultAppUpdateState,
  type ImportFormState,
  type EditFormState,
  type AppUpdateState,
  type AppUpdateMode
} from "./types";

export function useSettingsState() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState("general");
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [importForm, setImportForm] = useState<ImportFormState>(defaultImportForm);
  const [editForm, setEditForm] = useState<EditFormState>(defaultEditForm);
  const [editBaseline, setEditBaseline] = useState<EditFormState>(defaultEditForm);
  const [importTagInput, setImportTagInput] = useState("");
  const [editTagInput, setEditTagInput] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState>(defaultAppUpdateState);
  const [appUpdateMessage, setAppUpdateMessage] = useState("");
  const [appUpdateDownloadProgress, setAppUpdateDownloadProgress] = useState<number | null>(null);
  const [appUpdateDownloadedBytes, setAppUpdateDownloadedBytes] = useState(0);
  const [appUpdateTotalBytes, setAppUpdateTotalBytes] = useState(0);
  const [appUpdateMode, setAppUpdateMode] = useState<AppUpdateMode>("idle");

  return {
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
  };
}
