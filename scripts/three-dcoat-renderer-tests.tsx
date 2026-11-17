import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThreeDCoatImportModal } from "../src/ui/ThreeDCoatImportModal";
import "../src/ui/styles.css";

function Harness() {
  const [assetId, setAssetId] = useState<string | null>(null);
  const [language, setLanguage] = useState("zh");
  return <>
    <button id="open-zh" onClick={() => { setLanguage("zh"); setAssetId("mesh"); }}>Open Chinese</button>
    <button id="open-en" onClick={() => { setLanguage("en"); setAssetId("mesh"); }}>Open English</button>
    <button id="open-empty" onClick={() => { setLanguage("zh"); setAssetId("empty"); }}>Open unsupported</button>
    {assetId && <ThreeDCoatImportModal key={assetId} assetId={assetId} language={language} onClose={() => setAssetId(null)} />}
  </>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);

const pause = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
async function waitFor(predicate: () => unknown) {
  for (let count = 0; count < 150; count++) {
    if (predicate()) return;
    await pause(20);
  }
  throw new Error("UI did not reach the expected state");
}
function button(text: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find(item => item.textContent === text);
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}
async function open(id: string, expected: string) {
  document.getElementById(id)!.focus();
  document.getElementById(id)!.click();
  await waitFor(() => document.querySelector("dialog .three-dcoat-status")?.textContent === expected);
  check(document.querySelector<HTMLDialogElement>("dialog")?.open, "Dialog is modal and open");
}
async function close(text: string) {
  button(text).click();
  await waitFor(() => !document.querySelector("dialog"));
}

(window as unknown as { runThreeDCoatTests: () => Promise<unknown> }).runThreeDCoatTests = async () => {
  await waitFor(() => document.getElementById("open-zh"));
  await open("open-zh", "已找到 3DCoat");
  const model = document.querySelector<HTMLSelectElement>('dialog select[aria-label="模型"]')!;
  check(model.options.length === 2, "Both supported models appear");
  const selectedModel = model.options[1].value;
  model.value = selectedModel;
  model.dispatchEvent(new Event("change", { bubbles: true }));
  const mode = document.querySelector<HTMLSelectElement>('dialog select[aria-label="导入用途"]')!;
  mode.value = "vox";
  mode.dispatchEvent(new Event("change", { bubbles: true }));
  await pause(30);
  button("选择程序").click();
  await pause(30);
  await waitFor(() => !button("选择程序").disabled && [...document.querySelectorAll("dialog button")].some(item => item.textContent === "导入 3DCoat"));
  check(model.value === selectedModel && mode.value === "vox", "Canceled configuration preserves model and mode");
  button("导入 3DCoat").click();
  await waitFor(() => document.querySelector("dialog .three-dcoat-status")?.textContent?.includes("模型已发送"));
  check(model.disabled && mode.disabled, "A sent task cannot be sent again from the same dialog");
  await close("完成");
  await open("open-en", "3DCoat detected");
  check(document.querySelector('dialog select[aria-label="Import mode"]')?.textContent?.includes("Retopology"), "English mode labels are available");
  button("Import into 3DCoat").click();
  await waitFor(() => document.querySelector("dialog .three-dcoat-status")?.getAttribute("data-error") === "true");
  check(!button("Import into 3DCoat").disabled, "A pending AppLink task reports an error and permits retry");
  await close("Cancel");
  await open("open-empty", "此资产没有 FBX、OBJ、STL 或 PLY 模型。");
  check(button("导入 3DCoat").disabled, "Unsupported assets cannot be sent");
  await close("取消");
  await open("open-zh", "已找到 3DCoat");
  document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
  await waitFor(() => !document.querySelector("dialog"));
  check(document.activeElement?.id === "open-zh", "Closing the dialog restores keyboard focus");
  await open("open-zh", "已找到 3DCoat");
  return { ok: true, selectedModel, mode: "vox", checks: ["StrictMode dialog", "model and mode selection", "canceled configuration", "real IPC send", "pending task protection", "unsupported model", "English labels", "focus restoration"] };
};
