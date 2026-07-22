import { useEffect, useRef, useState } from "react";
import { EMPTY_BROWSER_STATE, type BrowserState } from "../../shared/browser";
import { safeExternalUrl } from "../../shared/external-url";
import { IconChevronLeft, IconCopy, IconExternalLink, IconStop } from "../icons";
import { ActivityPanelHeader } from "../layout/ActivityPanelHeader";

function normalizeAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return safeExternalUrl(trimmed);
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed);
  return safeExternalUrl(`${local ? "http" : "https"}://${trimmed}`);
}

export function BrowserPanel({ initialUrl, onClose }: { initialUrl: string | null; onClose: () => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<BrowserState>(EMPTY_BROWSER_STATE);
  const [address, setAddress] = useState(initialUrl ?? "");

  useEffect(() => window.vibe.onBrowserState((next) => {
    setState(next);
    if (document.activeElement !== addressRef.current) setAddress(next.url);
  }), []);

  useEffect(() => window.vibe.onBrowserFocusAddress(() => {
    addressRef.current?.focus();
    addressRef.current?.select();
  }), []);

  useEffect(() => {
    window.vibe.browserSetVisible(true);
    if (initialUrl) void window.vibe.browserLoad(initialUrl);
    const viewport = viewportRef.current;
    if (!viewport) return () => window.vibe.browserSetVisible(false);
    const update = () => {
      const rect = viewport.getBoundingClientRect();
      window.vibe.browserSetBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    };
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    window.addEventListener("resize", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.vibe.browserSetVisible(false);
    };
  }, [initialUrl]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "l") {
        event.preventDefault();
        addressRef.current?.focus();
        addressRef.current?.select();
      } else if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        window.vibe.browserCommand("reload");
      } else if (event.key === "[") {
        event.preventDefault();
        window.vibe.browserCommand("back");
      } else if (event.key === "]") {
        event.preventDefault();
        window.vibe.browserCommand("forward");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const navigate = () => {
    const url = normalizeAddress(address);
    if (url) void window.vibe.browserLoad(url);
  };

  return (
    <section className="activity-rail browser-activity-rail" aria-labelledby="browser-panel-title">
      <ActivityPanelHeader
        titleId="browser-panel-title"
        title={state.title || "Browser"}
        subtitle={state.loading ? "Loading…" : state.secure ? "Secure page" : "Not secure"}
        onClose={onClose}
        closeLabel="Close browser"
        actions={state.url ? <>
          <button className="icon-button" type="button" title="Copy URL" aria-label="Copy URL" onClick={() => void window.vibe.writeClipboardText(state.url)}><IconCopy /></button>
          <button className="icon-button" type="button" title="Open in default browser" aria-label="Open in default browser" onClick={() => void window.vibe.openExternal(state.url)}><IconExternalLink /></button>
        </> : null}
      />
      <div className="browser-toolbar">
        <button className="icon-button" type="button" disabled={!state.canGoBack} title="Back" onClick={() => window.vibe.browserCommand("back")}><IconChevronLeft /></button>
        <button className="icon-button browser-forward" type="button" disabled={!state.canGoForward} title="Forward" onClick={() => window.vibe.browserCommand("forward")}><IconChevronLeft /></button>
        <form onSubmit={(event) => { event.preventDefault(); navigate(); }}>
          <span className={`browser-security${state.secure ? " is-secure" : " is-insecure"}`} aria-label={state.secure ? "Secure" : "Not secure"} />
          <input ref={addressRef} value={address} onChange={(event) => setAddress(event.target.value)} aria-label="Web address" spellCheck={false} />
        </form>
        <button className="icon-button" type="button" title={state.loading ? "Stop" : "Reload"} onClick={() => window.vibe.browserCommand(state.loading ? "stop" : "reload")}>
          {state.loading ? <IconStop /> : <span className="browser-reload">↻</span>}
        </button>
      </div>
      {state.error ? <div className="browser-error" role="status">{state.error}</div> : null}
      <div ref={viewportRef} className="browser-viewport" aria-label="Web page" />
    </section>
  );
}
