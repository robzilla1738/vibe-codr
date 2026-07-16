import type { MessageBoxOptions } from "electron";
import { app, type BrowserWindow, dialog } from "electron";
import electronUpdater, { type AppUpdater, type UpdateInfo } from "electron-updater";

export interface AppUpdaterController {
  check(manual?: boolean): Promise<void>;
}

interface AppUpdaterOptions {
  getWindow: () => BrowserWindow | null;
  prepareToInstall: () => Promise<boolean>;
}

function updaterInstance(): AppUpdater {
  // electron-updater is CommonJS; the default import keeps the main bundle
  // compatible with its runtime export shape when this project emits ESM.
  return electronUpdater.autoUpdater;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "The update service could not be reached.";
}

export function createAppUpdater(options: AppUpdaterOptions): AppUpdaterController {
  const updater = updaterInstance();
  let manualCheck = false;
  let checking = false;
  let downloading = false;

  updater.autoDownload = false;
  // Never install as a side effect of an ordinary app quit. The user explicitly
  // chooses Restart and Install after the download completes.
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.logger = {
    info: (message?: unknown) => console.info("[updater]", message),
    warn: (message?: unknown) => console.warn("[updater]", message),
    error: (message?: unknown) => console.error("[updater]", message),
    debug: (message?: unknown) => console.debug("[updater]", message),
  };

  const showMessage = async (message: MessageBoxOptions): Promise<number> => {
    const win = options.getWindow();
    const result = win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, message)
      : await dialog.showMessageBox(message);
    return result.response;
  };

  const clearProgress = (): void => {
    const win = options.getWindow();
    if (win && !win.isDestroyed()) win.setProgressBar(-1);
  };

  updater.on("update-available", (info: UpdateInfo) => {
    checking = false;
    manualCheck = false;
    void (async () => {
      const response = await showMessage({
        type: "info",
        title: "Update Available",
        message: `Vibe Codr ${info.version} is available.`,
        detail: "Download it now? You can keep working while the update downloads.",
        buttons: ["Download Update", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response !== 0 || downloading) return;
      downloading = true;
      try {
        await updater.downloadUpdate();
      } catch (error) {
        // electron-updater also emits `error`; this catch prevents an unhandled
        // rejection without showing a second dialog.
        console.error("[updater] download failed", error);
      }
    })();
  });

  updater.on("update-not-available", () => {
    checking = false;
    const shouldNotify = manualCheck;
    manualCheck = false;
    if (!shouldNotify) return;
    void showMessage({
      type: "info",
      title: "No Updates Available",
      message: "Vibe Codr is up to date.",
      detail: `You are running version ${app.getVersion()}.`,
      buttons: ["OK"],
      defaultId: 0,
      noLink: true,
    });
  });

  updater.on("download-progress", (progress) => {
    const win = options.getWindow();
    if (win && !win.isDestroyed()) {
      win.setProgressBar(Math.max(0, Math.min(1, progress.percent / 100)));
    }
  });

  updater.on("update-downloaded", (info) => {
    checking = false;
    downloading = false;
    clearProgress();
    void (async () => {
      const response = await showMessage({
        type: "info",
        title: "Update Ready",
        message: `Vibe Codr ${info.version} is ready to install.`,
        detail: "Restart now to install it, or choose Later to finish your work first.",
        buttons: ["Restart and Install", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response !== 0) return;
      if (!(await options.prepareToInstall())) return;
      updater.quitAndInstall(false, true);
    })();
  });

  updater.on("error", (error) => {
    const shouldNotify = manualCheck || downloading;
    checking = false;
    downloading = false;
    manualCheck = false;
    clearProgress();
    console.error("[updater]", error);
    if (!shouldNotify) return;
    void showMessage({
      type: "error",
      title: "Update Failed",
      message: "Vibe Codr could not update.",
      detail: `${errorMessage(error)}\n\nYou can still download the latest installer from GitHub Releases.`,
      buttons: ["OK"],
      defaultId: 0,
      noLink: true,
    });
  });

  return {
    async check(manual = false): Promise<void> {
      if (!app.isPackaged || !["darwin", "win32"].includes(process.platform)) {
        if (manual) {
          await showMessage({
            type: "info",
            title: "Updates Unavailable",
            message: "Update checks are available in installed macOS and Windows builds.",
            buttons: ["OK"],
            defaultId: 0,
            noLink: true,
          });
        }
        return;
      }
      if (checking || downloading) return;
      manualCheck = manual;
      checking = true;
      try {
        await updater.checkForUpdates();
      } catch (error) {
        // Most provider errors are also emitted through `error`. Handle a
        // non-emitting failure here so a future API change cannot wedge state.
        if (!checking) return;
        const shouldNotify = manualCheck;
        checking = false;
        manualCheck = false;
        console.error("[updater] check failed", error);
        if (shouldNotify) {
          await showMessage({
            type: "error",
            title: "Update Check Failed",
            message: "Vibe Codr could not check for updates.",
            detail: errorMessage(error),
            buttons: ["OK"],
            defaultId: 0,
            noLink: true,
          });
        }
      }
    },
  };
}
