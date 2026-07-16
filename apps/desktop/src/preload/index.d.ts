import type { VibeApi } from "./index";

declare global {
  interface Window {
    vibe: VibeApi;
  }
}
