import { describe, expect, it, beforeEach } from "vitest";
import { assertTrustedIpc, assertTrustedSender, setMainWindow } from "./ipc-security";

describe("ipc-security", () => {
  beforeEach(() => {
    setMainWindow(null);
  });

  it("rejects when no main window is registered", () => {
    const event = { sender: { id: 1 } } as unknown as Electron.IpcMainInvokeEvent;
    expect(() => assertTrustedIpc(event)).toThrow(/did not originate/);
  });

  it("rejects a sender that is not the main webContents", () => {
    const mainWc = { id: 42 };
    setMainWindow({ webContents: mainWc } as unknown as Electron.BrowserWindow);
    const event = { sender: { id: 99 } } as unknown as Electron.IpcMainInvokeEvent;
    expect(() => assertTrustedIpc(event)).toThrow(/did not originate/);
    expect(() => assertTrustedSender({ id: 99 } as unknown as Electron.WebContents)).toThrow(
      /did not originate/,
    );
  });

  it("accepts the registered main webContents", () => {
    const mainWc = { id: 7 };
    setMainWindow({ webContents: mainWc } as unknown as Electron.BrowserWindow);
    const event = { sender: mainWc } as unknown as Electron.IpcMainInvokeEvent;
    expect(() => assertTrustedIpc(event)).not.toThrow();
    expect(() => assertTrustedSender(mainWc as unknown as Electron.WebContents)).not.toThrow();
  });
});
