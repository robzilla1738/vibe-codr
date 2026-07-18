import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, nativeTheme, safeStorage, type MessageBoxOptions } from "electron";
import { privateLanIPv4 } from "../shared/private-network";

type QrTerminal = { generate(input: string, options: { small: boolean }, callback: (value: string) => void): void };
const qrcode = createRequire(import.meta.url)("qrcode-terminal") as QrTerminal;

export class MobileRelayController {
  #child: ChildProcess | null = null;
  #window: BrowserWindow | null = null;
  #desktopOwned = true;
  #closingWindow = false;
  #returnRequested = false;
  #pairing: { cwd: string; url: string; token: string; deepLink: string; sessionId?: string } | null = null;

  constructor(private readonly options: {
    getParent: () => BrowserWindow | null;
    releaseDesktop: () => Promise<void>;
    resumeDesktop: (sessionId?: string, cwd?: string) => void;
  }) {}

  get running(): boolean { return this.#child?.exitCode == null && this.#child != null; }

  async start(cwd: string, sessionId?: string): Promise<void> {
    if (this.running && !this.#desktopOwned) { this.#window?.show(); this.#window?.focus(); return; }
    const parent = this.options.getParent();
    const ip = privateLanIPv4(networkInterfaces());
    if (!ip) throw new Error("Connect this Mac to a private LAN or Tailnet before continuing on your phone. Public-network pairing requires a WSS relay.");
    const prompt: MessageBoxOptions = {
      type: "info",
      title: "Use Vibe Codr on your phone",
      message: "Move this session to mobile?",
      detail: "Vibe will safely release the desktop engine, keep the same project and conversation, and resume it here when your phone returns control.",
      buttons: ["Continue", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const choice = parent ? await dialog.showMessageBox(parent, prompt) : await dialog.showMessageBox(prompt);
    if (choice.response !== 0) return;

    await this.options.releaseDesktop();
    this.#desktopOwned = false;
    this.#returnRequested = false;
    if (this.running && this.#pairing) {
      const deepLink = `vibecodr://connect?url=${encodeURIComponent(this.#pairing.url)}&token=${encodeURIComponent(this.#pairing.token)}&cwd=${encodeURIComponent(cwd)}${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ""}`;
      this.#pairing = { ...this.#pairing, cwd, deepLink, ...(sessionId ? { sessionId } : {}) };
      this.#child?.send?.({ type: "desktop-released", cwd, sessionId });
      clipboard.writeText(deepLink);
      this.#showPairingWindow({ parent, ...this.#pairing });
      return;
    }
    const token = randomUUID();
    const port = 7788;
    const url = `ws://${ip}:${port}`;
    const deepLink = `vibecodr://connect?url=${encodeURIComponent(url)}&token=${encodeURIComponent(token)}&cwd=${encodeURIComponent(cwd)}${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ""}`;
    const entry = join(__dirname, "relay.js");
    const runtimeRoot = app.isPackaged ? process.resourcesPath : app.getAppPath();
    const adjacentEngineRoot = join(dirname(runtimeRoot), "source");
    const child = spawn(process.execPath, [entry, `--host=${ip}`, `--port=${port}`, `--cwd=${cwd}`], {
      cwd: runtimeRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        VIBE_ELECTRON_ROOT: runtimeRoot,
        VIBE_RELAY_TOKEN: token,
        VIBE_RELAY_MANAGED: "1",
        VIBE_RELAY_MOBILE_AUTHORIZED: "1",
        VIBE_RELAY_USER_DATA: app.getPath("userData"),
        VIBE_RELAY_PROTECTED_STORAGE: safeStorage.isEncryptionAvailable() ? "1" : "0",
        ...(sessionId ? { VIBE_RELAY_SESSION_ID: sessionId } : {}),
        ...(process.env.VIBE_CODR_ROOT
          ? { VIBE_CODR_ROOT: process.env.VIBE_CODR_ROOT }
          : !app.isPackaged && existsSync(join(adjacentEngineRoot, "package.json"))
            ? { VIBE_CODR_ROOT: adjacentEngineRoot }
            : {}),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.#child = child;
    this.#pairing = { cwd, url, token, deepLink, ...(sessionId ? { sessionId } : {}) };
    clipboard.writeText(deepLink);
    this.#showPairingWindow({ parent, cwd, url, token, deepLink, sessionId });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_000); });
    child.once("error", (error) => {
      void this.#finish(`Couldn’t start mobile remote control: ${error.message}`);
    });
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const value = message as { type?: string };
      if (value.type === "protected-storage") {
        this.#handleProtectedStorage(child, message);
        return;
      }
      if (value.type !== "mobile-released") return;
      const released = message as { sessionId?: string; cwd?: string };
      this.#desktopOwned = true;
      this.#returnRequested = false;
      this.#closePairingWindow();
      this.options.resumeDesktop(released.sessionId, released.cwd);
    });
    child.once("exit", (code) => {
      const failed = code !== 0;
      void this.#finish(failed ? `Mobile remote control stopped${stderr.trim() ? `:\n${stderr.trim()}` : "."}` : undefined);
    });
  }

  async stopForQuit(): Promise<void> {
    const child = this.#child;
    this.#child = null;
    if (child && child.exitCode == null) child.kill("SIGTERM");
    this.#closePairingWindow();
    this.#pairing = null;
  }

  #handleProtectedStorage(child: ChildProcess, message: unknown): void {
    const request = message as { requestId?: unknown; op?: unknown; value?: unknown };
    if (typeof request.requestId !== "string" || request.requestId.length > 128
      || (request.op !== "encrypt" && request.op !== "decrypt")
      || typeof request.value !== "string" || Buffer.byteLength(request.value) > 4 * 1024 * 1024) {
      return;
    }
    const respond = (response: { ok: true; value: string } | { ok: false; error: string }) => {
      if (child.connected) child.send({ type: "protected-storage-result", requestId: request.requestId, ...response });
    };
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("OS-protected storage is unavailable");
      const value = request.op === "encrypt"
        ? safeStorage.encryptString(request.value).toString("base64")
        : safeStorage.decryptString(Buffer.from(request.value, "base64"));
      respond({ ok: true, value });
    } catch (error) {
      respond({ ok: false, error: error instanceof Error ? error.message : "Protected storage failed" });
    }
  }

  #showPairingWindow(input: { parent: BrowserWindow | null; cwd: string; url: string; token: string; deepLink: string; sessionId?: string }): void {
    this.#closePairingWindow();
    let qr = "";
    qrcode.generate(input.deepLink, { small: true }, (value) => { qr = value; });
    const dark = nativeTheme.shouldUseDarkColors;
    const win = new BrowserWindow({
      width: 460,
      height: 650,
      minWidth: 420,
      minHeight: 600,
      resizable: false,
      minimizable: false,
      maximizable: false,
      modal: !!input.parent,
      parent: input.parent ?? undefined,
      title: "Vibe Codr Mobile",
      backgroundColor: dark ? "#0b0b0b" : "#f6f6f4",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    this.#window = win;
    const fg = dark ? "#f5f5f3" : "#181817";
    const muted = dark ? "#999994" : "#696965";
    const surface = dark ? "#171716" : "#ffffff";
    const border = dark ? "#2b2b29" : "#ddddda";
    const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
      *{box-sizing:border-box}body{margin:0;background:${dark ? "#0b0b0b" : "#f6f6f4"};color:${fg};font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{padding:32px;display:flex;flex-direction:column;align-items:center;text-align:center}h1{font-size:24px;letter-spacing:-.03em;margin:4px 0 8px}p{color:${muted};line-height:1.5;margin:0 0 20px}.qr{font:11px/11px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;background:#000;color:#fff;padding:18px;border-radius:16px;user-select:none}.details{width:100%;text-align:left;background:${surface};border:1px solid ${border};border-radius:12px;padding:12px 14px;margin-top:22px}.label{display:block;color:${muted};font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-top:8px}.label:first-child{margin-top:0}.value{display:block;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;margin-top:3px}.foot{font-size:12px;margin-top:18px;margin-bottom:0}
    </style><main><h1>Continue on your phone</h1><p>Scan with your camera. The pairing link is also copied to your clipboard.</p><div class="qr">${escapeHtml(qr)}</div><div class="details"><span class="label">Relay</span><span class="value">${escapeHtml(input.url)}</span><span class="label">Project</span><span class="value">${escapeHtml(input.cwd)}</span><span class="label">Token</span><span class="value">${escapeHtml(input.token)}</span></div><p class="foot">Keep this window open while using mobile. Close it to return control to desktop.</p></main>`;
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    win.on("close", () => {
      if (this.#closingWindow || this.#returnRequested) return;
      this.#returnRequested = true;
      this.#child?.send?.({ type: "return-to-desktop" });
    });
    win.on("closed", () => { if (this.#window === win) this.#window = null; });
  }

  async #finish(error?: string): Promise<void> {
    if (!this.#child && !this.#window) return;
    this.#child = null;
    this.#pairing = null;
    this.#closePairingWindow();
    if (!this.#desktopOwned) this.options.resumeDesktop();
    this.#desktopOwned = true;
    this.#returnRequested = false;
    if (error) {
      const parent = this.options.getParent();
      const options = { type: "error" as const, title: "Mobile Remote Control", message: error, buttons: ["OK"] };
      if (parent) await dialog.showMessageBox(parent, options); else await dialog.showMessageBox(options);
    }
  }

  #closePairingWindow(): void {
    const win = this.#window;
    this.#window = null;
    if (!win || win.isDestroyed()) return;
    this.#closingWindow = true;
    win.destroy();
    this.#closingWindow = false;
  }
}

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
