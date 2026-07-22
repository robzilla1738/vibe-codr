export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  secure: boolean;
  error?: string;
}

export type BrowserCommand = "back" | "forward" | "reload" | "stop";

export const EMPTY_BROWSER_STATE: BrowserState = {
  url: "",
  title: "Browser",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  secure: true,
};
