// Isolated, hidden Electron renderer: no application startup or user-library writes.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

async function runElectron() {
  const { app, BrowserWindow } = require("electron");
  const directory = process.argv[2];
  app.setPath("userData", path.join(directory, "profile"));
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, webSecurity: false }
  });
  try {
    await window.loadFile(path.join(directory, "index.html"));
    const result = await window.webContents.executeJavaScript("window.runPreviewTests()");
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify(result, null, 2));
    // Also exercise Chromium paint and retain a screenshot for visual inspection.
    const screenshot = await window.webContents.capturePage();
    fs.writeFileSync(path.join(directory, "previews.png"), screenshot.toPNG());
    app.exit(result.ok ? 0 : 1);
  } catch (error) {
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ ok: false, error: String(error) }));
    app.exit(1);
  }
}

async function launch() {
  const { spawn } = require("node:child_process");
  const { build } = require("esbuild");
  const sharp = require("sharp");
  const root = path.resolve(__dirname, "..");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-preview-test-"));
  const fixture = path.join(directory, "素材 #1 100%.png");
  const animationFixture = path.join(directory, "animation.fbx");
  const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AnimationClip, VectorKeyframeTrack } = await import("three");
  const { FBXExporter } = await import("@comfyorg/fbx-exporter-three");
  const scene = new Scene();
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  mesh.name = "MovingBox";
  scene.add(mesh);
  const clip = new AnimationClip("Slide", 3, [new VectorKeyframeTrack("MovingBox.position", [0, 3], [0, 0, 0, 1, 0, 0])]);
  fs.writeFileSync(animationFixture, new FBXExporter().parseSync(scene, { animations: [clip] }));
  const importThumbnailsOnly = process.argv.includes("--import-thumbnails-only");
  await sharp({ create: { width: importThumbnailsOnly ? 4096 : 320, height: importThumbnailsOnly ? 2048 : 160, channels: 4, background: "#58ad86" } }).png().toFile(fixture);
  await sharp({ create: { width: 160, height: 80, channels: 3, background: "#387da8" } }).png().toFile(fixture + ".thumb.png");
  const appSource = fs.readFileSync(path.join(root, "src/ui/App.tsx"), "utf8");
  const card = appSource.slice(appSource.indexOf("const AssetCard = memo("), appSource.indexOf("function OverviewAssetGrid"));
  const previewSlot = appSource.slice(appSource.indexOf("const PreviewDropSlot = memo("), appSource.indexOf("function getTextureAnalysis"));
  const textureRow = appSource.slice(appSource.indexOf("const TextureEntryRow = memo("), appSource.indexOf("const PreviewDropSlot = memo("));
  const darkSelect = appSource.slice(appSource.indexOf("const DarkSelect = memo("), appSource.indexOf("\nconst RelatedAssetCard"));
  const motionPath = appSource.slice(appSource.indexOf("function isMotionVideoPreviewPath("), appSource.indexOf("function getFirstFbxPath("));
  const renderer = fs.readFileSync(path.join(__dirname, "preview-renderer-tests.tsx"), "utf8");
  const legacyFile = path.join(root, ".cache/preview-tests/LegacyAssetCard.tsx");
  // Optional diagnostic comparison captured before the fix; not required by CI.
  const legacy = process.argv.includes("--compare-legacy") && fs.existsSync(legacyFile)
    ? fs.readFileSync(legacyFile, "utf8").slice(fs.readFileSync(legacyFile, "utf8").indexOf("export const AssetCard"))
      .replace("export const AssetCard", "const LegacyAssetCard")
    : "const LegacyAssetCard = null;";
  await build({ stdin: {
    contents: `import { memo, useState, useRef, useEffect, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AssetThumbnail } from "./src/ui/AssetThumbnail";
import { AnimationPreview } from "./src/ui/AnimationPreview";
import { AnimationPreviewVideo } from "./src/ui/AnimationPreviewVideo";
import { ImportPreviewThumbnail } from "./src/ui/ImportPreviewThumbnail";
import { DetailPreview } from "./src/ui/DetailPreview";
import { PreviewLoader } from "./src/ui/previewLoader";
import { getPreviewUrl } from "./src/ui/previewUrl";
import { getCardWidthClass } from "./src/ui/assetGridLayout";
import "./src/ui/styles.css";
function Icon() { return <span data-icon="true">◇</span>; }
function getTextureTypeDisplayLabel(value) { return value; }
${darkSelect}
${textureRow}
${card}
${motionPath}
${previewSlot}
${legacy}
const fixture = ${JSON.stringify(fixture)};
const animationFixture = ${JSON.stringify(animationFixture)};
${renderer}`,
    resolveDir: root, loader: "tsx"
  }, bundle: true, outfile: path.join(directory, "renderer.js"), jsx: "automatic", loader: { ".otf": "file" },
  define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
  fs.writeFileSync(path.join(directory, "index.html"), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script>window.previewClipboardOnly = ${process.argv.includes("--clipboard-only")}; window.importThumbnailsOnly = ${importThumbnailsOnly}; window.normalBatchOnly = ${process.argv.includes("--normal-batch-only")}; window.animationBackgroundOnly = ${process.argv.includes("--animation-background-only")};</script><script src="renderer.js"></script>`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [path.join(__dirname, "test-preview-electron.cjs"), directory], { env, windowsHide: true, stdio: "inherit" });
  const { setTimeout, clearTimeout } = require("node:timers");
  const timer = setTimeout(() => child.kill(), 45000);
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  clearTimeout(timer);
  const resultFile = path.join(directory, "result.json");
  console.log(fs.existsSync(resultFile) ? fs.readFileSync(resultFile, "utf8") : "Electron did not produce a result");
  console.log(`Artifacts: ${directory}`);
  process.exitCode = code === 0 ? 0 : 1;
}

if (process.versions.electron) void runElectron();
else void launch().catch(error => { console.error(error); process.exitCode = 1; });
