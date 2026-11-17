import { useEffect, useRef, useState } from "react";
import type { ThreeDCoatImportInfo, ThreeDCoatMode } from "../threeDCoat";
import { DialogCloseButton } from './DialogCloseButton';
import "./three-dcoat/import-ui.css";

export function ThreeDCoatImportModal({ assetId, language, onClose }: {
  assetId: string;
  language: string;
  onClose: () => void;
}) {
  const bridge = window.arkhive;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const [info, setInfo] = useState<ThreeDCoatImportInfo | null>(null);
  const [modelFile, setModelFile] = useState("");
  const [mode, setMode] = useState<ThreeDCoatMode>("ppp");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const t = (zh: string, en: string) => language === "en" ? en : zh;
  const canSend = Boolean(info?.ready && modelFile && !busy && !sent);

  useEffect(() => {
    const dialog = dialogRef.current;
    const trigger = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  useEffect(() => {
    let active = true;
    void bridge.getThreeDCoatImportInfo(assetId).then(result => {
      if (!active) return;
      if (!result.ok) throw new Error(result.message);
      setInfo(result);
      setModelFile(result.files[0]?.path || "");
      setMode(result.mode);
      setConnectionOpen(!result.ready);
    }).catch((error: unknown) => {
      if (active) setStatus({ text: String(error instanceof Error ? error.message : error), error: true });
    });
    return () => { active = false; };
  }, [assetId, bridge]);

  async function choose(method: "pickThreeDCoatProgram" | "pickThreeDCoatDataDirectory") {
    if (busyRef.current || sent) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await bridge[method]();
      if (!result.ok) throw new Error(result.message);
      if ("canceled" in result) return;
      setInfo(current => current ? { ...current, ...result } : current);
      setStatus(null);
    } catch (error) {
      setStatus({ text: String(error instanceof Error ? error.message : error), error: true });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function send() {
    if (busyRef.current || !canSend) return;
    busyRef.current = true;
    setBusy(true);
    setStatus(null);
    try {
      const result = await bridge.importToThreeDCoat({ assetId, modelFile, mode });
      if (!result.ok) throw new Error(result.message);
      setSent(true);
    } catch (error) {
      setStatus({ text: String(error instanceof Error ? error.message : error), error: true });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const message = status || (sent
    ? { text: t("模型已发送，请在 3DCoat 中确认导入。", "Model sent. Confirm the import in 3DCoat."), error: false }
    : !info ? { text: t("正在读取模型…", "Loading models…"), error: false }
      : !info.files.length ? { text: t("此资产没有 FBX、OBJ、STL 或 PLY 模型。", "This asset has no FBX, OBJ, STL or PLY model."), error: true }
        : !info.ready ? { text: t("请先选择 3DCoat 程序和数据目录。", "Choose the 3DCoat application and data directory first."), error: true }
          : { text: t("已找到 3DCoat", "3DCoat detected"), error: false });

  return (
    <dialog ref={dialogRef} className="three-dcoat-dialog" aria-labelledby="three-dcoat-title"
      onCancel={event => {
        event.preventDefault();
        if (!busyRef.current) onClose();
      }}
      onClick={event => {
        if (event.target !== event.currentTarget || busyRef.current) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}>
      <header className="three-dcoat-header">
        <h2 id="three-dcoat-title">{t("导入 3DCoat", "Import into 3DCoat")}</h2>
        <span className="three-dcoat-brand">3DCoat</span>
        <DialogCloseButton onClick={onClose} disabled={busy} label={t('关闭', 'Close')} />
      </header>
      <p className="three-dcoat-asset-name">{info?.assetName || assetId}</p>
      <form className="three-dcoat-form" onSubmit={event => { event.preventDefault(); if (sent) onClose(); else void send(); }}>
        <label className="three-dcoat-field">
          <span>{t("模型", "Model")}</span>
          <select aria-label={t("模型", "Model")} value={modelFile} disabled={!info || busy || sent} onChange={event => setModelFile(event.target.value)}>
            {info?.files.map(file => <option key={file.path} value={file.path}>{file.label}</option>)}
          </select>
        </label>
        <label className="three-dcoat-field">
          <span>{t("导入用途", "Import mode")}</span>
          <select aria-label={t("导入用途", "Import mode")} value={mode} disabled={busy || sent} onChange={event => setMode(event.target.value as ThreeDCoatMode)}>
            <option value="ppp">{t("贴图绘制", "Texture painting")}</option>
            <option value="vox">{t("体素雕刻", "Voxel sculpting")}</option>
            <option value="retopo">{t("重拓扑", "Retopology")}</option>
          </select>
        </label>
        <details className="three-dcoat-connection" open={connectionOpen} onToggle={event => setConnectionOpen(event.currentTarget.open)}>
          <summary>{t("连接设置", "Connection settings")}</summary>
          <div className="three-dcoat-path-row">
            <span className="three-dcoat-path" title={info?.executable}>{info?.executable || t("未找到 3DCoat 程序", "3DCoat application not found")}</span>
            <button type="button" className="three-dcoat-secondary" disabled={!info || busy || sent} onClick={() => void choose("pickThreeDCoatProgram")}>{t("选择程序", "Application")}</button>
          </div>
          <div className="three-dcoat-path-row">
            <span className="three-dcoat-path" title={info?.dataDirectory}>{info?.dataDirectory || t("未找到 3DCoat 数据目录", "3DCoat data directory not found")}</span>
            <button type="button" className="three-dcoat-secondary" disabled={!info || busy || sent} onClick={() => void choose("pickThreeDCoatDataDirectory")}>{t("数据目录", "Data directory")}</button>
          </div>
        </details>
        <p className="three-dcoat-hint">{t("发送后，在 3DCoat 中确认导入参数。", "Confirm import options in 3DCoat after sending.")}</p>
        <p className="three-dcoat-status" role="status" aria-live="polite" data-error={message.error}>{message.text}</p>
        <div className="three-dcoat-actions">
          <button type="button" className="three-dcoat-secondary" disabled={busy} onClick={onClose}>{t("取消", "Cancel")}</button>
          <button type="submit" className="three-dcoat-primary" disabled={busy || (!sent && !canSend)}>
            {sent ? t("完成", "Done") : busy ? t("正在处理…", "Working…") : t("导入 3DCoat", "Import into 3DCoat")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
