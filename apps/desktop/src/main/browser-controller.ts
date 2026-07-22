import { session, shell, WebContentsView, type BrowserWindow } from "electron";
import type { BrowserBounds, BrowserCommand, BrowserState } from "../shared/browser";
import { safeExternalUrl } from "../shared/external-url";
import { linkDisposition } from "../shared/link-routing";

export class BrowserController {
  private view: WebContentsView | null = null;
  private browserSession: Electron.Session | null = null;
  private visible = false;
  private readonly cancelDownload = (event: Electron.Event, item: Electron.DownloadItem) => {
    event.preventDefault();
    void this.openExternal(item.getURL());
  };

  constructor(
    private readonly parent: () => BrowserWindow | null,
    private readonly publish: (state: BrowserState) => void,
    private readonly focusAddress: () => void,
  ) {}

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const partition = "persist:vibe-browser";
    const browserSession = session.fromPartition(partition);
    this.browserSession = browserSession;
    browserSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    const view = new WebContentsView({
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    this.view = view;
    this.parent()?.contentView.addChildView(view);
    const update = (error?: string) => this.publishState(error);
    view.webContents.on("did-start-loading", () => update());
    view.webContents.on("did-stop-loading", () => update());
    view.webContents.on("did-navigate", () => update());
    view.webContents.on("did-navigate-in-page", () => update());
    view.webContents.on("page-title-updated", () => update());
    view.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || (!input.meta && !input.control)) return;
      const key = input.key.toLowerCase();
      if (key === "l") {
        event.preventDefault();
        this.focusAddress();
      } else if (key === "r") {
        event.preventDefault();
        this.command("reload");
      } else if (input.key === "[") {
        event.preventDefault();
        this.command("back");
      } else if (input.key === "]") {
        event.preventDefault();
        this.command("forward");
      }
    });
    view.webContents.on("did-fail-load", (_event, code, description) => {
      if (code !== -3) update(description);
    });
    view.webContents.setWindowOpenHandler(({ url }) => {
      // Chromium routes modifier-clicks and middle-clicks through a new-window
      // request. Keep those in the user's default browser; same-frame clicks
      // continue inside this retained view.
      void this.openExternal(url);
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, url) => {
      const disposition = linkDisposition(url);
      if (disposition !== "embedded") {
        event.preventDefault();
        if (disposition === "external") void this.openExternal(url);
      }
    });
    browserSession.on("will-download", this.cancelDownload);
    view.setVisible(this.visible);
    return view;
  }

  async load(rawUrl: string): Promise<void> {
    const url = safeExternalUrl(rawUrl);
    if (!url) throw new Error("Only HTTP and HTTPS URLs without embedded credentials are supported");
    const view = this.ensureView();
    await view.webContents.loadURL(url).catch((error: unknown) => {
      this.publishState(error instanceof Error ? error.message : String(error));
    });
  }

  setBounds(bounds: BrowserBounds): void {
    const view = this.ensureView();
    view.setBounds({
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.setVisible(visible);
      if (visible) this.publishState();
    }
  }

  command(command: BrowserCommand): void {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (command === "back" && wc.canGoBack()) wc.goBack();
    else if (command === "forward" && wc.canGoForward()) wc.goForward();
    else if (command === "reload") wc.reload();
    else if (command === "stop") wc.stop();
  }

  private publishState(error?: string): void {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    const url = wc.getURL();
    this.publish({
      url,
      title: wc.getTitle() || "Browser",
      loading: wc.isLoading(),
      canGoBack: wc.canGoBack(),
      canGoForward: wc.canGoForward(),
      secure: !url || url.startsWith("https://"),
      ...(error ? { error } : {}),
    });
  }

  private async openExternal(url: string): Promise<void> {
    const safe = safeExternalUrl(url);
    if (safe) await shell.openExternal(safe);
  }

  dispose(): void {
    const parent = this.parent();
    if (this.view && parent && !parent.isDestroyed()) parent.contentView.removeChildView(this.view);
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.browserSession?.removeListener("will-download", this.cancelDownload);
    this.browserSession = null;
    this.view = null;
  }
}
