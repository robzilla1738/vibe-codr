import { linkDisposition } from "../shared/link-routing";

export function requestUrlOpen(
  rawUrl: string,
  modifiers: { metaKey?: boolean; ctrlKey?: boolean; button?: number } = {},
): void {
  const disposition = linkDisposition(rawUrl, modifiers);
  if (disposition === "reject") return;
  if (disposition === "external") {
    void window.vibe.openExternal(rawUrl);
    return;
  }
  window.dispatchEvent(new CustomEvent("vibe:open-browser", { detail: { url: rawUrl } }));
}
