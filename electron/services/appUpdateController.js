// All entry points share downloads and the installation lock.
function createAppUpdateController({ checkRelease, downloadRelease, launch, isBusy, prompt, onState, onError, onInstallError, autoDownload = true }) {
  let state = {};
  let checking = null;
  let downloading = null;
  let installing = false;
  let prompting = false;
  let deferredVersion = "";
  let timer = null;
  let nextCheck = 0;
  let stopped = false;

  function publish(patch) {
    state = { ...state, ...patch };
    onState?.(state);
  }

  function download() {
    if (downloading) return downloading;
    if (installing) return Promise.resolve({ ok: false, message: "正在安装更新" });
    downloading = (async () => {
      publish({ phase: "downloading" });
      try {
        const result = await downloadRelease();
        if (result.ok) publish({
          ...result, phase: "idle", localPackagePath: result.filePath || "",
          updateReady: Boolean(result.updateReady)
        });
        else publish({ phase: "idle", message: result.message });
        return result;
      } catch (error) {
        publish({ phase: "idle", message: String(error.message || error) });
        throw error;
      } finally {
        downloading = null;
      }
    })();
    return downloading;
  }

  function check() {
    if (checking) return checking;
    // A check must not replace a ready package while another release is downloading.
    if (downloading || installing) return Promise.resolve(state);
    checking = (async () => {
      const result = await checkRelease();
      if (result.ok) {
        publish({ ...result, phase: "idle", message: "" });
        if (autoDownload && result.hasUpdate && !result.updateReady) {
          void download().catch(error => onError?.(error));
        }
      }
      return result.ok ? { ...result, phase: state.phase } : result;
    })().finally(() => { checking = null; });
    return checking;
  }

  async function install(filePath) {
    if (installing || downloading || isBusy()) return { ok: false, busy: true, message: "导入、导出或更新任务正在进行，请完成后再安装更新" };
    installing = true; // Synchronous: no import/export can start during verification or extraction.
    try {
      const result = await launch(filePath);
      if (!result.ok) installing = false;
      if (result.invalidPackage) {
        deferredVersion = "";
        publish({ updateReady: false, localPackagePath: "", message: result.message });
      }
      return result;
    } catch (error) {
      installing = false;
      throw error;
    }
  }

  async function promptIfIdle() {
    if (stopped || prompting || installing || downloading || isBusy()
      || !state.updateReady || !state.localPackagePath || !state.latestVersion
      || deferredVersion === state.latestVersion) return;
    prompting = true;
    const version = state.latestVersion;
    const filePath = state.localPackagePath;
    try {
      const accepted = await prompt(state);
      if (stopped || accepted == null) return;
      deferredVersion = version;
      if (accepted) {
        const result = await install(filePath);
        // A task may have started while the dialog was visible. Ask again when it finishes.
        if (result.busy) deferredVersion = "";
        else if (!result.ok) (onInstallError || onError)?.(new Error(result.message));
      }
    } finally {
      prompting = false;
    }
  }

  async function tick(now = Date.now()) {
    if (stopped) return;
    if (now >= nextCheck && !checking && !downloading && !installing && !prompting) {
      nextCheck = now + 30 * 60 * 1000;
      try { await check(); } catch (error) { onError?.(error); }
    }
    await promptIfIdle();
  }

  return {
    check, download, install, tick,
    isInstalling: () => installing,
    start() {
      if (timer) return;
      stopped = false;
      void tick().catch(error => onError?.(error));
      timer = globalThis.setInterval(() => { void tick().catch(error => onError?.(error)); }, 2000);
      timer.unref?.();
    },
    stop() { stopped = true; globalThis.clearInterval(timer); timer = null; }
  };
}

module.exports = { createAppUpdateController };
