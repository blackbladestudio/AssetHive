import type { ExportResultItem } from "../types";

type Translate = (zh: string, en: string) => string;

export type SidebarFeedback = { text: string; detail?: string };
type Progress = { label: string; percent: number; value: number; max: number; count?: string };
type SidebarStatus = SidebarFeedback & { progress?: Progress };

function percentProgress(label: string, value: number): Progress {
  const percent = Math.max(0, Math.min(100, value));
  return { label, percent, value: Math.round(percent), max: 100 };
}

export function getSidebarStatus({ exportFeedback, exporting, exportProgress, importSaving, batchImport,
  characterImport, scanFeedback, scanning, scanProgress, scanHint, status, t }: {
  exportFeedback: SidebarFeedback | null;
  exporting: boolean;
  exportProgress: number;
  importSaving: boolean;
  batchImport: { processed: number; total: number; active: boolean } | null;
  characterImport: { progress: number; message: string };
  scanFeedback: SidebarFeedback | null;
  scanning: boolean;
  scanProgress: number;
  scanHint: string;
  status: string;
  t: Translate;
}): SidebarStatus {
  if (exporting) {
    const feedback = exportFeedback ?? { text: t("导入引擎中", "Importing into engine") };
    return { ...feedback, progress: percentProgress(t("导出进度", "Export progress"), exportProgress) };
  }
  if (exportFeedback && !importSaving && !batchImport?.active) return exportFeedback;
  if (batchImport || importSaving) {
    const active = importSaving || Boolean(batchImport?.active);
    const text = active ? t("导入中", "Importing") : status.split(/\r?\n| · /, 1)[0] || t("导入结束", "Import finished");
    const detail = [...new Set([status, active ? characterImport.message : ""].filter(Boolean))].join("\n");
    if (batchImport) {
      const { processed, total } = batchImport;
      return { text, detail, progress: {
        label: t("批量导入进度", "Batch import progress"), percent: total ? Math.round(processed / total * 100) : 0,
        value: processed, max: total, count: `${processed}/${total}`
      } };
    }
    return characterImport.message
      ? { text, detail, progress: percentProgress(t("导入进度", "Import progress"), characterImport.progress) }
      : { text, detail };
  }
  if (scanFeedback) return scanFeedback;
  if (status) return { text: status };
  if (scanning) {
    return { text: t("扫描中", "Scanning"), detail: scanHint, progress: percentProgress(t("扫描进度", "Scan progress"), scanProgress) };
  }
  return { text: "" };
}

export function getScanFeedback(result: { phase?: string; progress: number; manual?: boolean; total?: number; message?: string },
  elapsedMs: number, t: Translate): (SidebarFeedback & { durationMs: number }) | null {
  const issue = result.phase === "failed" || result.phase === "partial";
  if (!issue && (result.progress < 100 || !result.manual)) return null;
  const durationMs = (issue ? 10000 : 2500) - elapsedMs;
  if (durationMs <= 0) return null;
  const count = result.total ?? 0;
  const text = result.phase === "partial" ? t("扫描未完整 · 查看日志", "Scan incomplete · see logs")
    : result.phase === "failed" ? t("扫描失败", "Scan failed")
    : t(`扫描完成，共 ${count} 个资产`, `Scan complete: ${count} assets`);
  return { text, detail: result.message, durationMs };
}

export function getEngineImportFeedback(result: { ok: boolean; partial?: boolean; message?: string; results?: ExportResultItem[] },
  blender: boolean, t: Translate): SidebarFeedback & { durationMs: number } {
  if (result.partial || !result.ok) {
    const text = result.partial ? t("部分资产未导出", "Some assets were not exported") : result.message || t("导入失败", "Import failed");
    const issues = result.results?.filter(item => item.status !== "success").map(item => `${item.name}：${item.message}`) ?? [];
    const detail = [...new Set([result.message, ...issues].filter(Boolean))].join("\n");
    return { text, detail, durationMs: 10000 };
  }
  const text = blender ? t("Blender 导入完成", "Blender import complete")
    : /已发送到 Unreal|sent to Unreal/i.test(result.message || "")
      ? t("已发送到 Unreal，导入进度请在引擎内查看", "Sent to Unreal. Check import progress in the editor")
      : t("导入完成", "Import complete");
  return { text, durationMs: 4000 };
}
