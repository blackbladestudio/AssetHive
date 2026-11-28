const path = require("node:path");

function createStartupView({ WebContentsView, mainWindow, language, onLoaded, onError }) {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "../startupPreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  const contents = view.webContents;
  const resize = () => {
    const [width, height] = mainWindow.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  let disposed = false;
  let loaded = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    mainWindow.off("resize", resize);
    mainWindow.off("closed", dispose);
    const windowOpen = !mainWindow.isDestroyed();
    if (windowOpen) mainWindow.contentView.removeChildView(view);
    const close = () => {
      if (!contents.isDestroyed()) contents.close();
    };
    // Let the compositor detach the visible view before releasing its surface.
    if (loaded && windowOpen) globalThis.setTimeout(close, 50).unref();
    else close();
  };
  const fail = error => {
    if (disposed) return;
    dispose();
    onError(error);
  };
  const setLanguage = nextLanguage => {
    language = nextLanguage === "en" ? "en" : "zh";
    if (loaded && !disposed) contents.send("startup:language", language);
  };

  view.setBackgroundColor("#121212");
  mainWindow.contentView.addChildView(view);
  resize();
  mainWindow.on("resize", resize);
  mainWindow.once("closed", dispose);
  contents.ipc.on("startup:minimize", () => mainWindow.minimize());
  contents.ipc.on("startup:cancel", () => mainWindow.close());
  contents.on("will-navigate", event => event.preventDefault());
  contents.once("render-process-gone", (_event, details) => fail(new Error(details.reason)));
  const ready = contents.loadFile(path.join(__dirname, "../startup.html"), { query: { lang: language } }).then(() => {
    if (disposed) return;
    loaded = true;
    setLanguage(language);
    onLoaded();
  }).catch(fail);
  return { dispose, setLanguage, ready };
}

module.exports = { createStartupView };
