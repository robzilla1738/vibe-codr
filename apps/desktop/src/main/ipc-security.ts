/**
 * Shared IPC security helpers extracted from `index.ts` so feature modules
 * (git, config) can assert trusted sender without duplicating the logic.
 */

import type { BrowserWindow } from "electron";

let mainWindow: BrowserWindow | null = null;

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

export type AssertTrustedIpc = (event: Electron.IpcMainInvokeEvent) => void;
export type AssertTrustedSender = (sender: Electron.WebContents) => void;

export const assertTrustedIpc: AssertTrustedIpc = (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("IPC request did not originate from the application renderer");
  }
};

export const assertTrustedSender: AssertTrustedSender = (sender) => {
  if (!mainWindow || sender !== mainWindow.webContents) {
    throw new Error("IPC message did not originate from the application renderer");
  }
};

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
