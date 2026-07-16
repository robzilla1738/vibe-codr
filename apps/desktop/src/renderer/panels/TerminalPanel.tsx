import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import {
  terminalSessionNeedsReopen,
  type TerminalEvent,
  type TerminalOpenResult,
} from "../../shared/terminal";
import { getTheme } from "../../shared/themes";
import { ActivityPanelHeader } from "../layout/ActivityPanelHeader";

function themeFromTokens(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const styles = getComputedStyle(document.documentElement);
  const fallback = getTheme("default");
  const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    background: token("--bg", fallback.background),
    foreground: token("--assistant", fallback.assistant),
    cursor: token("--accent", fallback.primary),
    selectionBackground: token("--sel-bg", fallback.selBg),
  };
}

function terminalFontFromTokens(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  return value || 'ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, monospace';
}

export function TerminalPanel({
  cwd,
  scope,
  onClose,
}: {
  cwd: string;
  scope: "chat" | "project";
  onClose: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [restartNonce, setRestartNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [exit, setExit] = useState<{ code: number; signal: number } | null>(null);

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
      fontSize: 12.5,
      lineHeight: 1.35,
      letterSpacing: 0,
      scrollback: 10_000,
      theme: themeFromTokens(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(surface);

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
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(surface);

    const open = async () => {
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
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
        return;
      }
      // Closing/switching panels detaches only; the main-owned PTY remains for
      // replay until app shutdown, even if this renderer closed mid-handshake.
      if (disposed) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      sessionId = result.id;
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
      resizeObserver.disconnect();
      terminal.dispose();
    };
  }, [cwd, restartNonce]);

  return (
    <section className="activity-rail terminal-activity-rail" aria-labelledby="terminal-panel-title">
      <ActivityPanelHeader
        titleId="terminal-panel-title"
        title="Terminal"
        subtitle={<span className="terminal-panel-subtitle" title={cwd}>{scope === "chat" ? "Home" : "Project"} · {cwd}</span>}
        onClose={onClose}
        closeLabel="Close terminal"
        actions={exit || error ? (
          <button type="button" className="button terminal-restart" onClick={() => setRestartNonce((value) => value + 1)}>
            Restart
          </button>
        ) : null}
      />
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
