import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import {
  terminalSessionNeedsReopen,
  type TerminalEvent,
  type TerminalOpenResult,
} from "../../shared/terminal";
import { getTheme } from "../../shared/themes";
import { requestUrlOpen } from "../link-routing";
import { ActivityPanelHeader } from "../layout/ActivityPanelHeader";

function themeFromTokens() {
  const styles = getComputedStyle(document.documentElement);
  const fallback = getTheme("default");
  const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    background: token("--bg", fallback.background),
    foreground: token("--assistant", fallback.assistant),
    cursor: token("--accent", fallback.primary),
    selectionBackground: token("--sel-bg", fallback.selBg),
    black: token("--bg", fallback.background),
    brightBlack: token("--text-subtle", fallback.muted),
    red: token("--del", fallback.del),
    brightRed: token("--del", fallback.del),
    green: token("--add", fallback.add),
    brightGreen: token("--add", fallback.add),
    yellow: token("--notice", fallback.notice),
    brightYellow: token("--notice", fallback.notice),
    blue: token("--user", fallback.user),
    brightBlue: token("--user", fallback.user),
    magenta: token("--plan", fallback.plan),
    brightMagenta: token("--plan", fallback.plan),
    cyan: token("--tool", fallback.tool),
    brightCyan: token("--tool", fallback.tool),
    white: token("--assistant", fallback.assistant),
    brightWhite: token("--assistant", fallback.assistant),
  };
}

function terminalFontFromTokens(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  return value || '"SFMono-Regular", Menlo, Consolas, monospace';
}

export function TerminalPanel({
  cwd,
  scope,
  executionTarget,
  onClose,
}: {
  cwd: string;
  scope: "chat" | "project";
  executionTarget: "local" | "cloud";
  onClose: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const [restartNonce, setRestartNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [exit, setExit] = useState<{ code: number; signal: number } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [scrolledBack, setScrolledBack] = useState(false);
  const [connecting, setConnecting] = useState(true);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    const terminal = new XtermTerminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorInactiveStyle: "bar",
      cursorStyle: "bar",
      cursorWidth: 1,
      fontFamily: terminalFontFromTokens(),
      fontSize: 13,
      lineHeight: 1.3,
      letterSpacing: 0,
      scrollback: 10_000,
      theme: themeFromTokens(),
    });
    const fit = new FitAddon();
    const webLinks = new WebLinksAddon((event, uri) => {
      event.preventDefault();
      requestUrlOpen(uri, event);
    });
    terminal.loadAddon(fit);
    terminal.loadAddon(webLinks);
    terminal.open(surface);
    terminalRef.current = terminal;

    let disposed = false;
    let sessionId: string | null = null;
    let reopening = false;
    const pendingEvents: TerminalEvent[] = [];

    const handleCommandFailure = (message: string) => {
      if (disposed) return;
      if (terminalSessionNeedsReopen(message) && !reopening) {
        reopening = true;
        sessionId = null;
        setError(null);
        setRestartNonce((value) => value + 1);
        return;
      }
      setError(message);
    };

    const applyEvent = (event: TerminalEvent) => {
      if (event.type === "data") {
        terminal.write(event.data);
        return;
      }
      sessionId = null;
      setExit({ code: event.exitCode, signal: event.signal });
      terminal.write(`\r\n\x1b[90m[terminal exited · code ${event.exitCode}]\x1b[0m\r\n`);
    };

    const resize = () => {
      if (disposed) return;
      fit.fit();
      if (sessionId) {
        void window.vibe.terminalResize({
          id: sessionId,
          cols: terminal.cols,
          rows: terminal.rows,
        }).then((result) => {
          if (!result.ok) handleCommandFailure(result.error);
        }).catch((reason: unknown) => {
          if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
        });
      }
    };

    const unsubscribe = window.vibe.onTerminalEvent((event) => {
      if (!sessionId) {
        pendingEvents.push(event);
        return;
      }
      if (event.id === sessionId) applyEvent(event);
    });
    const dataDisposable = terminal.onData((data) => {
      if (!sessionId) return;
      void window.vibe.terminalWrite({ id: sessionId, data }).then((result) => {
        if (!result.ok) handleCommandFailure(result.error);
      }).catch((reason: unknown) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      });
    });
    const selectionDisposable = terminal.onSelectionChange(() => setHasSelection(terminal.hasSelection()));
    const scrollDisposable = terminal.onScroll(() => {
      setScrolledBack(terminal.buffer.active.viewportY < terminal.buffer.active.baseY);
    });
    const refreshTheme = () => {
      terminal.options.theme = themeFromTokens();
      terminal.options.fontFamily = terminalFontFromTokens();
    };
    const themeObserver = new MutationObserver(refreshTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-scheme", "data-contrast"] });
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(surface);

    const open = async () => {
      setConnecting(true);
      setError(null);
      setExit(null);
      fit.fit();
      let result: TerminalOpenResult;
      try {
        result = await window.vibe.terminalOpen({
          cwd,
          cols: terminal.cols,
          rows: terminal.rows,
        });
      } catch (reason) {
        if (!disposed) {
          setConnecting(false);
          setError(reason instanceof Error ? reason.message : String(reason));
        }
        return;
      }
      // Closing/switching panels detaches only; the main-owned PTY remains for
      // replay until app shutdown, even if this renderer closed mid-handshake.
      if (disposed) return;
      if (!result.ok) {
        setConnecting(false);
        setError(result.error);
        return;
      }
      sessionId = result.id;
      setConnecting(false);
      if (result.replay) terminal.write(result.replay);
      for (const event of pendingEvents) {
        if (event.id !== result.id) continue;
        if (event.type === "data" && event.sequence <= result.sequence) continue;
        applyEvent(event);
      }
      pendingEvents.length = 0;
      resize();
      terminal.focus();
    };
    void open();

    return () => {
      disposed = true;
      unsubscribe();
      dataDisposable.dispose();
      selectionDisposable.dispose();
      scrollDisposable.dispose();
      themeObserver.disconnect();
      resizeObserver.disconnect();
      terminalRef.current = null;
      terminal.dispose();
    };
  }, [cwd, restartNonce]);

  return (
    <section className="activity-rail terminal-activity-rail" aria-labelledby="terminal-panel-title">
      <ActivityPanelHeader
        titleId="terminal-panel-title"
        title="Terminal"
        subtitle={(
          <span className="terminal-panel-subtitle" title={cwd}>
            {executionTarget === "cloud" ? "Cloud" : scope === "chat" ? "Home" : "Project"} · {cwd}
          </span>
        )}
        onClose={onClose}
        closeLabel="Close terminal"
        actions={exit || error ? (
          <button type="button" className="button terminal-restart" onClick={() => setRestartNonce((value) => value + 1)}>
            Restart
          </button>
        ) : null}
      />
      <div className="terminal-toolbar" aria-label="Terminal controls">
        <span className="terminal-status-dot" data-state={error ? "error" : exit ? "exited" : connecting ? "connecting" : "running"} />
        <span className="terminal-toolbar-label">{error ? "Error" : exit ? "Exited" : connecting ? "Connecting…" : executionTarget === "cloud" ? "Cloud shell" : "Local shell"}</span>
        <span className="terminal-toolbar-spacer" />
        {scrolledBack ? <button type="button" className="button terminal-tool-button" onClick={() => terminalRef.current?.scrollToBottom()}>Jump to Latest</button> : null}
        <button type="button" className="button terminal-tool-button" disabled={!hasSelection} onClick={() => {
          const selection = terminalRef.current?.getSelection();
          if (selection) void window.vibe.writeClipboardText(selection);
        }}>Copy Selection</button>
        <button type="button" className="button terminal-tool-button" onClick={() => terminalRef.current?.clear()}>Clear Display</button>
      </div>
      <div
        ref={surfaceRef}
        className="terminal-surface"
        aria-label={scope === "chat" ? "Home terminal" : "Project terminal"}
      />
      {error ? <p className="terminal-panel-error" role="alert">{error}</p> : null}
      {exit ? <p className="terminal-panel-status">Process exited with code {exit.code}. Restart to open a new shell.</p> : null}
    </section>
  );
}
