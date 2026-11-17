const path = require("node:path");

function createStartupWindow({ BrowserWindow, ipcMain, mainWindow, language, icon, onCancel, onError }) {
  const splash = new BrowserWindow({
    width: 440,
    height: 200,
    title: "AssetHive",
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: "#181818",
    show: false,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, "../startupPreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  let finished = false;
  let painted = false;
  const cancel = event => {
    if (!finished && event.sender === splash.webContents) onCancel();
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    ipcMain.removeListener("startup:cancel", cancel);
    mainWindow.removeListener("closed", finish);
    mainWindow.webContents.removeListener("render-process-gone", finish);
    if (!splash.isDestroyed()) splash.destroy();
  };
  ipcMain.on("startup:cancel", cancel);
  mainWindow.once("closed", finish);
  mainWindow.webContents.once("render-process-gone", finish);
  splash.on("close", event => {
    if (finished) return;
    event.preventDefault();
    onCancel();
  });
  splash.once("closed", finish);
  splash.once("ready-to-show", () => {
    painted = true;
    if (!finished && !mainWindow.isDestroyed()) splash.show();
  });
  splash.webContents.on("will-navigate", event => event.preventDefault());
  splash.loadFile(path.join(__dirname, "../startup.html"), { query: { lang: language === "en" ? "en" : "zh" } }).catch(error => {
    onError?.(error);
    finish();
  });
  return {
    finish,
    focus: () => {
      if (finished || !painted || splash.isDestroyed()) return;
      splash.show();
      splash.focus();
    }
  };
}

module.exports = { createStartupWindow };
