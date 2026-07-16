import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { shouldClearBusyOnSendFailure } from "../../shared/busy-on-send-failure";
import type { PendingCapabilityRequest } from "../../shared/cloud";
import type { EngineCommand } from "../../shared/commands";
import type { UIEvent } from "../../shared/events";
import { GLYPH } from "../../shared/glyphs";
import { hydrateFromHistory } from "../../shared/history-hydrate";
import { estimateJsonUtf8Bytes } from "../../shared/json-size";
import {
  cycleModeAction,
  deriveUiMode,
  modeColor,
  modeWord,
  selectModeAction,
  type UiMode,
} from "../../shared/modes";
import { isUIEvent } from "../../shared/protocol";
import {
  ASSISTANT_OUTPUT_MAX_CHARS,
  capTranscriptState,
  firstLine,
  groupIntoTurns,
  initialTranscript,
  MAX_RETAINED_TRANSCRIPT_BLOCKS,
  REASONING_OUTPUT_MAX_CHARS,
  reduceTranscript,
  type TranscriptAction,
  type TranscriptState,
  truncate,
} from "../../shared/reducer";
import { isEngineSnapshot, isRenderableUIEvent } from "../../shared/runtime-guards";
import { appendRollingText } from "../../shared/stream-cap";
import { getTheme } from "../../shared/themes";
import { bufferToolProgress } from "../../shared/tool-progress-buffer";
import { Trail, turnWindowStart, windowStartIndex } from "../../shared/trail";
import type { EngineSnapshot } from "../../shared/types";
import { stripVisionRelayContext } from "../../shared/vision-display";
import { applyPalette } from "../theme/applyPalette";
import {
  loadTranscriptCache,
  saveTranscriptCache,
  transcriptConversationSignature,
} from "../transcript-cache";
import { RequestGate } from "./request-gate";
import { initialChrome, reduceChrome } from "./session-state";

export type { OrchestrationRow, SessionChrome } from "./session-state";

type TxAction =
  | TranscriptAction
  | { type: "reset" }
  | { type: "replace"; state: TranscriptState };

function reduceTx(s: TranscriptState, a: TxAction): TranscriptState {
  if (a.type === "reset") return initialTranscript();
  if (a.type === "replace") return a.state;
  return reduceTranscript(s, a);
}

export type ToastSeverity = "info" | "warn" | "error";

export interface ToastState {
  message: string;
  severity: ToastSeverity;
  closing?: boolean;
}

/** Auto-dismiss delay by severity. Errors stay long enough to read (I55). */
const TOAST_TTL: Record<ToastSeverity, number> = {
  info: 3000,
  warn: 4500,
  error: 6000,
};
const TOAST_EXIT_MS = 140;
const BOOTSTRAP_EVENT_LIMIT = 2_048;
const BOOTSTRAP_EVENT_BYTES_LIMIT = 8 * 1024 * 1024;

/** Events suppressed while the clear-gate is active (TUI parity:
 * clearScopedEventTypes). Stale stream/notice/subagent/checkpoint/verify
 * events from the pre-clear turn must not bleed into the freshly reset view.
 * Module-level so it is not recreated on every render. */
const CLEAR_SCOPED_TYPES = new Set<string>([
  "assistant-text-delta",
  "reasoning-delta",
  "tool-call-started",
  "tool-call-progress",
  "tool-call-finished",
  "file-changed",
  "permission-request",
  "plan-presented",
  "plan-state-changed",
  "question-request",
  "question-settled",
  "activities-changed",
  "subagent-started",
  "subagent-activity",
  "subagent-finished",
  "notice",
  "compacted",
  "loop-stopped",
  "loop-tick",
  "checkpoint-created",
  "checkpoint-restored",
  "verify-started",
  "verify-finished",
  // engine-error is intentionally NOT listed — clear/abort failures must surface.
]);
const WINDOW_TURNS = 40;
const REVEAL_PAGE = 20;
const TURN_ITEMS_MAX = 120;
const TURN_ITEMS_STEP = 24;
const TURN_ITEM_REVEAL_PAGE = TURN_ITEMS_STEP;
function reduceTxCapped(s: TranscriptState, a: TxAction): TranscriptState {
  return capTranscriptState(reduceTx(s, a), MAX_RETAINED_TRANSCRIPT_BLOCKS);
}

export function useSession(cwd: string | null) {
  const [chrome, dispatchChrome] = useReducer(reduceChrome, cwd ?? "", (c) =>
    initialChrome(c || ""),
  );
  const [transcript, dispatchTranscript] = useReducer(reduceTxCapped, undefined, initialTranscript);
  const [foldedTurns, setFoldedTurns] = useState<Set<number>>(new Set());
  const [revealTurns, setRevealTurns] = useState(0);
  const [revealedTurnItems, setRevealedTurnItems] = useState<Map<number, number>>(() => new Map());
  const [jobsView, setJobsView] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [booting, setBooting] = useState(false);
  const [ready, setReady] = useState(false);
  const [pendingCapabilities, setPendingCapabilities] = useState<PendingCapabilityRequest[]>([]);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const deltaBuf = useRef("");
  const progressBuf = useRef<Map<string, string>>(new Map());
  const reasoningBuf = useRef("");
  const reasoningStarted = useRef<number | null>(null);
  const flushTimer = useRef<number | null>(null);
  const suppressAfterClear = useRef(false);
  /** While true, buffer events from the replacement host so a dying old host
   * cannot mutate the visible transcript and live replacement events survive
   * the asynchronous snapshot/cache handoff. */
  const bootstrapHandoff = useRef(false);
  const bootstrapEvents = useRef<Array<{ event: UIEvent; bytes: number }>>([]);
  const bootstrapEventBytes = useRef(0);
  const bootstrapEventsTruncated = useRef(false);
  const lastSnap = useRef<EngineSnapshot | null>(null);
  const trail = useRef(new Trail());
  const bootstrapGate = useRef(new RequestGate());
  const modeTransitioning = useRef(false);
  const activeSessionId = useRef("");
  const toastTimer = useRef<number | null>(null);
  const toastExitTimer = useRef<number | null>(null);
  /** Always-current chrome.busy for send-failure busy policy (avoid stale closures). */
  const busyRef = useRef(chrome.busy);
  busyRef.current = chrome.busy;

  const uiMode: UiMode = deriveUiMode(chrome.mode, chrome.approvals);

  useEffect(() => {
    applyPalette(getTheme(chrome.theme), chrome.accent || undefined, chrome.theme);
    document.documentElement.style.setProperty("--mode", modeColor(uiMode));
  }, [chrome.theme, chrome.accent, uiMode]);

  const flushDeltas = useCallback(() => {
    if (flushTimer.current != null) {
      window.clearTimeout(flushTimer.current);
    }
    flushTimer.current = null;
    // Flush buffered tool progress chunks first (TUI parity: landPending order).
    if (progressBuf.current.size) {
      for (const [toolCallId, chunk] of progressBuf.current) {
        dispatchTranscript({ type: "tool-progress", toolCallId, chunk });
      }
      progressBuf.current.clear();
    }
    if (deltaBuf.current) {
      const text = deltaBuf.current;
      deltaBuf.current = "";
      dispatchTranscript({ type: "delta", text });
    }
    // Coalesce live thinking/trail chrome onto the same 24ms cadence as text
    // so multi-minute reasoning does not re-render the full App tree per token.
    if (reasoningBuf.current) {
      dispatchChrome({ type: "set-thinking", text: reasoningBuf.current });
      dispatchChrome({ type: "set-trail", lines: trail.current.snapshot() });
    }
  }, []);

  const landReasoning = useCallback(() => {
    const text = reasoningBuf.current.trim();
    if (!text) {
      reasoningBuf.current = "";
      reasoningStarted.current = null;
      dispatchChrome({ type: "set-thinking", text: "" });
      return;
    }
    const seconds =
      reasoningStarted.current != null
        ? Math.max(1, Math.round((Date.now() - reasoningStarted.current) / 1000))
        : undefined;
    dispatchTranscript({ type: "thinking", text, seconds });
    reasoningBuf.current = "";
    reasoningStarted.current = null;
    dispatchChrome({ type: "set-thinking", text: "" });
  }, []);

  const endTurn = useCallback(
    (opts: { stopWorking: boolean }) => {
      // Flush buffered deltas BEFORE landing reasoning (TUI parity: landPending
      // runs before commitThinking so the streaming reply is complete before
      // finalizeActive fires inside the thinking action).
      flushDeltas();
      landReasoning();
      dispatchTranscript({ type: "clear-turn" });
      if (opts.stopWorking) dispatchChrome({ type: "set-busy", busy: false });
    },
    [flushDeltas, landReasoning],
  );

  const handleEvent = useCallback(
    (raw: unknown) => {
      if (!isUIEvent(raw) || !isRenderableUIEvent(raw)) {
        dispatchTranscript({ type: "notice", text: "Engine emitted an invalid UI event", level: "error" });
        return;
      }
      const event: UIEvent = raw;
      // Bootstrap handoff: never treat empty activeSessionId as "accept all".
      // Drop foreign/stale host traffic until snapshot commits the new id.
      if (bootstrapHandoff.current) {
        // The host protocol bounds individual events. Bound the short-lived
        // handoff queue as defense in depth while preserving its newest work.
        // Context samples are also replayed: one can arrive while IndexedDB is
        // loading, after the pre-seed snapshot sample has already been applied.
        const bytes = estimateJsonUtf8Bytes(event, BOOTSTRAP_EVENT_BYTES_LIMIT);
        if (bytes > BOOTSTRAP_EVENT_BYTES_LIMIT) {
          bootstrapEventsTruncated.current = true;
          return;
        }
        while (
          bootstrapEvents.current.length >= BOOTSTRAP_EVENT_LIMIT
          || bootstrapEventBytes.current + bytes > BOOTSTRAP_EVENT_BYTES_LIMIT
        ) {
          const removed = bootstrapEvents.current.shift();
          if (!removed) break;
          bootstrapEventBytes.current -= removed.bytes;
          bootstrapEventsTruncated.current = true;
        }
        bootstrapEvents.current.push({ event, bytes });
        bootstrapEventBytes.current += bytes;
        return;
      }
      if ("sessionId" in event && activeSessionId.current && event.sessionId !== activeSessionId.current) return;
      // A throwing handler must not kill the event loop (TUI parity: try/catch
      // around the per-event switch that surfaces errors as transcript notices).
      try {

      // After /clear|/new, drop stale stream until the next user-message.
      // Stale events from the pre-clear turn are suppressed (streaming deltas,
      // tool activity, notices, subagent events, etc.) until the next
      // user-message arrives — mirroring the TUI's clearScopedEventTypes gate.
      // Keep the gate open through turn-finished / session-idle / engine-idle so
      // late deltas from the aborted turn cannot reappear after the idle flush.
      // engine-error always surfaces (abort/clear failures must not be silent).
      if (suppressAfterClear.current) {
        if (event.type === "user-message") {
          suppressAfterClear.current = false;
        } else if (event.type === "engine-error") {
          // fall through — show the error notice
        } else if (
          CLEAR_SCOPED_TYPES.has(event.type) ||
          event.type === "turn-finished" ||
          event.type === "session-idle" ||
          event.type === "engine-idle"
        ) {
          return;
        }
      }

      if (event.type === "session-start") {
        dispatchChrome({
          type: "seed-from-session-start",
          event,
          snap: lastSnap.current,
        });
      } else {
        dispatchChrome({ type: "event", event });
      }

      switch (event.type) {
        case "user-message":
          flushDeltas();
          landReasoning();
          // Per-turn clean slate for the reasoning trail (chrome thoughtLog is
          // also cleared in session-state on user-message). Without this, the
          // next burst appends onto previous-turn lines in the Inspector.
          trail.current.reset();
          // The engine may append vision-relay captions to the downstream
          // prompt for a text-only model. Keep that transport context internal;
          // the user should see the message they wrote, not an implementation
          // detail about the assisting model.
          dispatchTranscript({
            type: "user",
            text: stripVisionRelayContext(event.text),
            ...(event.origin ? { origin: event.origin } : {}),
            ...(event.label ? { label: event.label } : {}),
          });
          break;
        case "plan-presented":
          // Finalize the streaming assistant reply before the plan card appears
          // (TUI parity: finalizeAssistant() in plan-presented handler).
          flushDeltas();
          landReasoning();
          dispatchTranscript({ type: "finalize" });
          break;
        case "assistant-text-delta":
          if (event.subagentId || !event.delta) break;
          // Commit reasoning before the first answer token. Keep prior answer
          // chunks buffered so normal text streaming stays coalesced at 24ms.
          landReasoning();
          deltaBuf.current = appendRollingText(
            deltaBuf.current,
            event.delta,
            ASSISTANT_OUTPUT_MAX_CHARS,
          );
          if (flushTimer.current == null) {
            flushTimer.current = window.setTimeout(flushDeltas, 24);
          }
          break;
        case "reasoning-delta":
          if (event.subagentId || !event.delta) break;
          if (reasoningStarted.current == null) reasoningStarted.current = Date.now();
          reasoningBuf.current = appendRollingText(
            reasoningBuf.current,
            event.delta,
            REASONING_OUTPUT_MAX_CHARS,
          );
          // Append to the persistent trail (TUI parity: accumulates across bursts,
          // survives past turn end — reset only on the next user-message).
          trail.current.append(event.delta);
          // Chrome updates flush on the shared 24ms timer (see flushDeltas).
          if (flushTimer.current == null) {
            flushTimer.current = window.setTimeout(flushDeltas, 24);
          }
          break;
        case "tool-call-started":
          if (event.subagentId) break;
          flushDeltas();
          landReasoning();
          dispatchTranscript({
            type: "tool-start",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
            at: Date.now(),
          });
          break;
        case "tool-call-progress":
          if (event.subagentId || !event.chunk) break;
          // Buffer progress chunks and flush on the same timer as text deltas
          // (TUI parity: coalesce chatty tool output to avoid per-chunk re-renders).
          // Cap before buffering: the protocol permits a large single line and
          // the reducer's tail ceiling would otherwise apply only after 24ms.
          {
            bufferToolProgress(
              progressBuf.current,
              event.toolCallId,
              event.chunk,
            );
            if (flushTimer.current == null) {
              flushTimer.current = window.setTimeout(flushDeltas, 24);
            }
          }
          break;
        case "tool-call-finished":
          if (event.subagentId) break;
          flushDeltas();
          dispatchTranscript({
            type: "tool-finish",
            toolCallId: event.toolCallId,
            output: event.output,
            isError: event.isError,
            at: Date.now(),
          });
          break;
        case "file-changed":
          flushDeltas();
          dispatchTranscript({
            type: "file-changed",
            toolCallId: event.toolCallId,
            path: event.path,
            action: event.action,
            added: event.added,
            removed: event.removed,
            diff: event.diff,
            at: Date.now(),
          });
          break;
        case "notice":
          flushDeltas();
          dispatchTranscript({
            type: "notice",
            text: event.message,
            level: event.level,
          });
          break;
        case "engine-error":
          endTurn({ stopWorking: true });
          dispatchTranscript({
            type: "notice",
            text: `error: ${event.message}`,
            level: "error",
          });
          break;
        case "checkpoint-created":
          flushDeltas();
          dispatchTranscript({
            type: "notice",
            text: `checkpoint ${event.label}`,
            level: "info",
          });
          break;
        case "checkpoint-restored":
          flushDeltas();
          dispatchTranscript({
            type: "notice",
            text: `${GLYPH.revert} reverted: ${event.label}`,
            level: "info",
          });
          break;
        case "verify-started":
          flushDeltas();
          dispatchTranscript({
            type: "notice",
            text: `verifying: ${event.command}`,
            level: "info",
          });
          break;
        case "verify-finished": {
          flushDeltas();
          const detail =
            !event.ok && event.output
              ? ` — ${truncate(firstLine(event.output) ?? "", 120)}`
              : "";
          dispatchTranscript({
            type: "notice",
            text: event.ok ? "verification passed" : `verification failed${detail}`,
            level: event.ok ? "info" : "error",
          });
          break;
        }
        case "compacted":
          flushDeltas();
          dispatchTranscript({
            type: "notice",
            text: `Compacted history · freed ~${event.freedTokens} tokens`,
            level: "info",
          });
          break;
        case "loop-tick":
          flushDeltas();
          dispatchTranscript({
            type: "notice",
            text: `${GLYPH.loopTick} loop iteration ${event.iteration}`,
            level: "info",
          });
          break;
        case "loop-stopped":
          flushDeltas();
          dispatchTranscript({
            type: "notice",
            text: `Loop stopped — ${event.reason}`,
            level: "info",
          });
          break;
        case "turn-finished":
        case "session-idle":
          endTurn({ stopWorking: false });
          break;
        case "engine-idle":
          endTurn({ stopWorking: true });
          if (event.gate === "red") {
            dispatchTranscript({
              type: "notice",
              text: "STILL RED — green-gate did not pass",
              level: "warn",
            });
          }
          break;
        case "external-capability-pending":
          setPendingCapabilities((current) => [
            ...current.filter((request) => request.id !== event.request.id),
            event.request,
          ]);
          break;
        case "external-capability-resolved":
          setPendingCapabilities((current) => current.filter((request) => request.id !== event.id));
          break;
        case "subagent-finished":
          // Retain the bounded stream for Inspector drill-in after completion.
          // It is cleared when the session changes or /clear|/new resets locally.
          break;
        default:
          break;
      }
      } catch (err) {
        dispatchTranscript({
          type: "notice",
          text: `ui error handling "${event.type}": ${err instanceof Error ? err.message : String(err)}`,
          level: "error",
        });
      }
    },
    [endTurn, flushDeltas, landReasoning],
  );

  const send = useCallback(async (command: EngineCommand): Promise<boolean> => {
    let res: Awaited<ReturnType<typeof window.vibe.send>>;
    try {
      res = await window.vibe.send(command);
    } catch (error) {
      res = {
        ok: false,
        error: error instanceof Error ? error.message : "Engine command failed",
      };
    }
    if (!res.ok) {
      dispatchTranscript({ type: "notice", text: res.error, level: "error" });
      if (shouldClearBusyOnSendFailure([command], busyRef.current)) {
        dispatchChrome({ type: "set-busy", busy: false });
      }
      return false;
    }
    return true;
  }, []);

  const sendMany = useCallback(
    async (commands: EngineCommand[]): Promise<boolean> => {
      const alreadyBusy = busyRef.current;
      for (let i = 0; i < commands.length; i++) {
        const c = commands[i]!;
        let res: Awaited<ReturnType<typeof window.vibe.send>>;
        try {
          res = await window.vibe.send(c);
        } catch (error) {
          res = {
            ok: false,
            error: error instanceof Error ? error.message : "Engine command failed",
          };
        }
        if (!res.ok) {
          dispatchTranscript({ type: "notice", text: res.error, level: "error" });
          // Policy uses the full intended batch so a mid-batch failure of a
          // turn-start still clears optimistic busy correctly.
          if (shouldClearBusyOnSendFailure(commands, alreadyBusy)) {
            dispatchChrome({ type: "set-busy", busy: false });
          }
          return false;
        }
      }
      return true;
    },
    [],
  );

  const clearSessionLocal = useCallback(() => {
    suppressAfterClear.current = true;
    deltaBuf.current = "";
    progressBuf.current.clear();
    reasoningBuf.current = "";
    reasoningStarted.current = null;
    trail.current.reset();
    if (flushTimer.current != null) {
      window.clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    dispatchTranscript({ type: "reset" });
    setPendingCapabilities([]);
    dispatchChrome({ type: "clear-session-overlays" });
    setFoldedTurns(new Set());
    setRevealTurns(0);
    setRevealedTurnItems(new Map());
  }, []);

  const bootstrap = useCallback(
    async (opts: {
      cwd: string;
      resume?: string;
      continueLatest?: boolean;
    }) => {
      const request = bootstrapGate.current.begin();
      // Keep the previous activeSessionId for any race that slips past the
      // handoff gate; never open the filter with "" (accept-all) during bootstrap.
      bootstrapHandoff.current = true;
      bootstrapEvents.current = [];
      bootstrapEventBytes.current = 0;
      bootstrapEventsTruncated.current = false;
      setBooting(true);
      setBootError(null);
      setReady(false);
      setFoldedTurns(new Set());
      setRevealTurns(0);
      setRevealedTurnItems(new Map());
      suppressAfterClear.current = false;
      lastSnap.current = null;
      deltaBuf.current = "";
      progressBuf.current.clear();
      reasoningBuf.current = "";
      reasoningStarted.current = null;
      trail.current.reset();
      if (flushTimer.current != null) {
        window.clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
      // Keep the current conversation visible while the replacement host
      // starts. The shell owns the transition surface; clearing here made a
      // sub-second engine handoff look like a blank, blocking screen.
      let res: Awaited<ReturnType<typeof window.vibe.bootstrap>>;
      try {
        res = await window.vibe.bootstrap(opts);
      } catch (error) {
        if (!bootstrapGate.current.isCurrent(request)) return false;
        bootstrapHandoff.current = false;
        bootstrapEvents.current = [];
        setBootError(error instanceof Error ? error.message : "Engine bootstrap failed");
        setBooting(false);
        return false;
      }
      if (!bootstrapGate.current.isCurrent(request)) return false;
      if (!res.ok) {
        bootstrapHandoff.current = false;
        bootstrapEvents.current = [];
        setBootError(res.error + (res.stderr ? `\n${res.stderr}` : ""));
        setBooting(false);
        return false;
      }
      let snapRes: Awaited<ReturnType<typeof window.vibe.rpc>>;
      try {
        snapRes = await window.vibe.rpc("snapshot");
      } catch (error) {
        if (!bootstrapGate.current.isCurrent(request)) return false;
        bootstrapHandoff.current = false;
        bootstrapEvents.current = [];
        await window.vibe.stop().catch(() => undefined);
        setBootError(`Engine snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
        setBooting(false);
        return false;
      }
      if (!bootstrapGate.current.isCurrent(request)) return false;
      if (!snapRes.ok) {
        bootstrapHandoff.current = false;
        bootstrapEvents.current = [];
        await window.vibe.stop().catch(() => undefined);
        setBootError(`Engine snapshot failed: ${snapRes.error}`);
        setBooting(false);
        return false;
      }
      if (!isEngineSnapshot(snapRes.value)) {
        bootstrapHandoff.current = false;
        bootstrapEvents.current = [];
        await window.vibe.stop().catch(() => undefined);
        setBootError("Engine snapshot failed validation");
        setBooting(false);
        return false;
      }
      const snap: EngineSnapshot = snapRes.value;
      activeSessionId.current = snap.sessionId;
      lastSnap.current = snap;
      setPendingCapabilities(snap.pendingCapabilities ?? []);
      // Commit the new session atomically after bootstrap + snapshot succeed.
      // Until this point the previous transcript remains visible behind the
      // compact boot status, so switching chats feels continuous.
      dispatchChrome({ type: "reset", cwd: opts.cwd });
      dispatchTranscript({ type: "reset" });
      dispatchChrome({ type: "seed", snap, cwd: opts.cwd });
      if (snap.history?.length) {
        const hydrated = hydrateFromHistory(snap.history);
        const cached = await loadTranscriptCache(opts.cwd, snap.sessionId);
        if (!bootstrapGate.current.isCurrent(request)) return false;
        dispatchTranscript({
          type: "replace",
          state:
            cached
              && transcriptConversationSignature(cached)
                === transcriptConversationSignature(hydrated)
              ? cached
              : hydrated,
        });
      }
      // Replacement is now authoritative. React reducer dispatches are ordered,
      // so replay lands after reset/cache replacement and cannot be overwritten.
      // UI events emitted by both the retiring and replacement hosts can be in
      // flight during bootstrap. Every session-scoped replacement event carries
      // the snapshot's id; unscoped and foreign-session traffic cannot be proven
      // to belong to this host generation and must be discarded.
      const queuedEvents = bootstrapEvents.current.filter(
        ({ event }) => "sessionId" in event && event.sessionId === snap.sessionId,
      ).map(({ event }) => event);
      const eventsTruncated = bootstrapEventsTruncated.current;
      bootstrapEvents.current = [];
      bootstrapEventBytes.current = 0;
      bootstrapEventsTruncated.current = false;
      bootstrapHandoff.current = false;
      for (const event of queuedEvents) handleEvent(event);
      if (eventsTruncated) {
        dispatchTranscript({
          type: "notice",
          text: "Some live output during session startup was omitted to keep memory bounded.",
          level: "warn",
        });
      }
      // Persist only a fully bootstrapped workspace. Saving before host ready
      // traps the next launch on a deleted/inaccessible path after a failed open.
      try {
        localStorage.setItem("vibe.lastCwd", opts.cwd);
      } catch {
        /* Persistence is optional. */
      }
      setReady(true);
      setBooting(false);
      return true;
    },
    [handleEvent],
  );

  /** Hydrate the renderer from an already-running transport (cloud reconnect).
   * Unlike bootstrap this never starts or replaces the engine owner. */
  const attachCurrent = useCallback(async (attachCwd: string): Promise<boolean> => {
    const request = bootstrapGate.current.begin();
    bootstrapHandoff.current = true;
    bootstrapEvents.current = [];
    bootstrapEventBytes.current = 0;
    bootstrapEventsTruncated.current = false;
    setBooting(true);
    setBootError(null);
    try {
      const response = await window.vibe.rpc("snapshot");
      if (!bootstrapGate.current.isCurrent(request)) return false;
      if (!response.ok) throw new Error(response.error);
      if (!isEngineSnapshot(response.value)) throw new Error("Engine snapshot failed validation");
      const snap = response.value;
      lastSnap.current = snap;
      activeSessionId.current = snap.sessionId;
      setPendingCapabilities(snap.pendingCapabilities ?? []);
      dispatchChrome({ type: "reset", cwd: attachCwd });
      dispatchTranscript({ type: "reset" });
      dispatchChrome({ type: "seed", snap, cwd: attachCwd });
      if (snap.history?.length) {
        const hydrated = hydrateFromHistory(snap.history);
        const cached = await loadTranscriptCache(attachCwd, snap.sessionId);
        if (!bootstrapGate.current.isCurrent(request)) return false;
        dispatchTranscript({
          type: "replace",
          state: cached && transcriptConversationSignature(cached) === transcriptConversationSignature(hydrated) ? cached : hydrated,
        });
      }
      const queuedEvents = bootstrapEvents.current.filter(
        ({ event }) => "sessionId" in event && event.sessionId === snap.sessionId,
      ).map(({ event }) => event);
      const eventsTruncated = bootstrapEventsTruncated.current;
      bootstrapEvents.current = [];
      bootstrapEventBytes.current = 0;
      bootstrapEventsTruncated.current = false;
      bootstrapHandoff.current = false;
      for (const event of queuedEvents) handleEvent(event);
      if (eventsTruncated) {
        dispatchTranscript({
          type: "notice",
          text: "Some live output during cloud reconnection was omitted to keep memory bounded.",
          level: "warn",
        });
      }
      try { localStorage.setItem("vibe.lastCwd", attachCwd); } catch { /* optional */ }
      setReady(true);
      setBooting(false);
      return true;
    } catch (error) {
      if (!bootstrapGate.current.isCurrent(request)) return false;
      bootstrapHandoff.current = false;
      bootstrapEvents.current = [];
      bootstrapEventBytes.current = 0;
      bootstrapEventsTruncated.current = false;
      setBootError(error instanceof Error ? error.message : String(error));
      setReady(false);
      setBooting(false);
      return false;
    }
  }, [handleEvent]);

  useEffect(() => {
    const offEvent = window.vibe.onEvent(handleEvent);
    const offFatal = window.vibe.onFatal((message) => {
      // Host death mid-bootstrap must reopen the event filter so Retry/New work.
      bootstrapHandoff.current = false;
      bootstrapEvents.current = [];
      setBootError(message);
      setReady(false);
      setBooting(false);
      dispatchTranscript({ type: "notice", text: message, level: "error" });
      dispatchChrome({ type: "set-busy", busy: false });
    });
    return () => {
      offEvent();
      offFatal();
      if (flushTimer.current != null) window.clearTimeout(flushTimer.current);
      if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    };
  }, [handleEvent]);

  useEffect(() => {
    const sessionId = activeSessionId.current;
    if (!ready || !cwd || !sessionId || chrome.busy) return;
    const timer = window.setTimeout(() => {
      void saveTranscriptCache(cwd, sessionId, transcript);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [chrome.busy, cwd, ready, transcript]);

  const cycleMode = useCallback(() => {
    if (modeTransitioning.current) return;
    const action = cycleModeAction(uiMode, { planPending: !!chrome.plan });
    modeTransitioning.current = true;
    void (async () => {
      try {
        const sent = await sendMany(action.commands);
        if (!sent) return;
        if (action.optimistic) {
          dispatchChrome({
            type: "optimistic-mode",
            mode: action.optimistic.mode,
            approvals: action.optimistic.approvals,
          });
        } else if (chrome.plan) {
          // Silent no-op felt broken — surface why the chip didn't move (TUI parity).
          dispatchTranscript({
            type: "notice",
            text: "Approve or revise the plan first (Enter / type / Esc) — mode stays PLAN.",
            level: "info",
          });
        }
      } finally {
        modeTransitioning.current = false;
      }
    })();
  }, [uiMode, chrome.plan, sendMany]);

  const selectMode = useCallback(
    (target: UiMode) => {
      if (modeTransitioning.current) return;
      const action = selectModeAction(uiMode, target, { planPending: !!chrome.plan });
      if (action.commands.length === 0 && !action.optimistic) return;
      modeTransitioning.current = true;
      void (async () => {
        try {
          const sent = await sendMany(action.commands);
          if (!sent) return;
          if (action.optimistic) {
            dispatchChrome({
              type: "optimistic-mode",
              mode: action.optimistic.mode,
              approvals: action.optimistic.approvals,
            });
          } else if (chrome.plan && target !== "plan") {
            dispatchTranscript({
              type: "notice",
              text: "Approve or revise the plan first (Enter / type / Esc) — mode stays PLAN.",
              level: "info",
            });
          }
        } finally {
          modeTransitioning.current = false;
        }
      })();
    },
    [uiMode, chrome.plan, sendMany],
  );

  const foldAllTurns = useCallback(() => {
    setFoldedTurns((prev) => {
      const turns = groupIntoTurns(transcript.blocks);
      const foldable = turns.filter((t) => t.user && t.items.length > 0);
      const anyFolded = foldable.some((t) => prev.has(t.key));
      if (anyFolded) return new Set();
      return new Set(foldable.map((t) => t.key));
    });
  }, [transcript.blocks]);

  const turns = useMemo(() => groupIntoTurns(transcript.blocks), [transcript.blocks]);
  useEffect(() => {
    // Transcript retention shifts old blocks out of memory. Prune interaction
    // state for those turns too, otherwise repeatedly folding/revealing old
    // history could leave stale keys alive for the rest of the renderer run.
    const retainedKeys = new Set(turns.map((turn) => turn.key));
    setFoldedTurns((current) => {
      if ([...current].every((key) => retainedKeys.has(key))) return current;
      return new Set([...current].filter((key) => retainedKeys.has(key)));
    });
    setRevealedTurnItems((current) => {
      if ([...current.keys()].every((key) => retainedKeys.has(key))) return current;
      return new Map([...current].filter(([key]) => retainedKeys.has(key)));
    });
  }, [turns]);
  const windowStart = useMemo(
    () => windowStartIndex(turns.length, WINDOW_TURNS, revealTurns),
    [turns.length, revealTurns],
  );
  const visibleTurns = useMemo(() => turns.slice(windowStart), [turns, windowStart]);
  const hiddenCount = windowStart;

  const revealEarlier = useCallback(() => {
    setRevealTurns((current) => current + Math.min(REVEAL_PAGE, Math.max(0, turns.length - WINDOW_TURNS - current)));
  }, [turns.length]);

  const revealTurnItems = useCallback((turnKey: number, hidden: number) => {
    if (hidden <= 0) return;
    setRevealedTurnItems((prev) => {
      const next = new Map(prev);
      next.set(turnKey, (next.get(turnKey) ?? 0) + Math.min(TURN_ITEM_REVEAL_PAGE, hidden));
      return next;
    });
  }, []);

  const itemWindowFor = useCallback(
    (turnKey: number, itemCount: number) => {
      const revealed = revealedTurnItems.get(turnKey) ?? 0;
      const start = turnWindowStart(itemCount, TURN_ITEMS_MAX, TURN_ITEMS_STEP, revealed);
      return {
        start,
        hidden: start,
        revealPage: Math.min(TURN_ITEM_REVEAL_PAGE, start),
      };
    },
    [revealedTurnItems],
  );

  const beginToastExit = useCallback(() => {
    if (toastExitTimer.current != null) window.clearTimeout(toastExitTimer.current);
    setToast((current) => (current ? { ...current, closing: true } : null));
    toastExitTimer.current = window.setTimeout(() => {
      toastExitTimer.current = null;
      setToast(null);
    }, TOAST_EXIT_MS);
  }, []);

  const dismissToast = useCallback(() => {
    if (toastTimer.current != null) {
      window.clearTimeout(toastTimer.current);
      toastTimer.current = null;
    }
    beginToastExit();
  }, [beginToastExit]);

  const showToast = useCallback((msg: string, severity: ToastSeverity = "info") => {
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    if (toastExitTimer.current != null) {
      window.clearTimeout(toastExitTimer.current);
      toastExitTimer.current = null;
    }
    setToast({ message: msg, severity, closing: false });
    toastTimer.current = window.setTimeout(() => {
      toastTimer.current = null;
      beginToastExit();
    }, TOAST_TTL[severity]);
  }, [beginToastExit]);

  // Clear any pending toast on unmount.
  useEffect(() => () => {
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    if (toastExitTimer.current != null) window.clearTimeout(toastExitTimer.current);
  }, []);

  const setBusy = useCallback((busy: boolean) => {
    dispatchChrome({ type: "set-busy", busy });
  }, []);

  const setSubagentModel = useCallback((model: string | undefined) => {
    dispatchChrome({ type: "set-subagent-model", model });
  }, []);

  // Stabilize the public session object so memoized children (BlockView) and
  // App callbacks that only need dispatch helpers do not thrash every chrome tick.
  return useMemo(
    () => ({
      chrome,
      transcript,
      pendingCapabilities,
      dispatchTranscript,
      foldedTurns,
      setFoldedTurns,
      foldAllTurns,
      revealEarlier,
      revealTurnItems,
      itemWindowFor,
      jobsView,
      setJobsView,
      toast,
      showToast,
      dismissToast,
      bootError,
      setBootError,
      booting,
      ready,
      uiMode,
      modeLabel: modeWord(uiMode),
      turns: visibleTurns,
      hiddenCount,
      revealPage: Math.min(REVEAL_PAGE, hiddenCount),
      totalTurns: turns.length,
      send,
      sendMany,
      bootstrap,
      attachCurrent,
      cycleMode,
      selectMode,
      dispatchChrome,
      clearSessionLocal,
      setBusy,
      setSubagentModel,
      inspectorOpen,
      setInspectorOpen,
    }),
    [
      chrome,
      transcript,
      pendingCapabilities,
      foldedTurns,
      foldAllTurns,
      revealEarlier,
      revealTurnItems,
      itemWindowFor,
      jobsView,
      toast,
      showToast,
      dismissToast,
      bootError,
      booting,
      ready,
      uiMode,
      visibleTurns,
      hiddenCount,
      turns.length,
      send,
      sendMany,
      bootstrap,
      attachCurrent,
      cycleMode,
      selectMode,
      clearSessionLocal,
      setBusy,
      setSubagentModel,
      inspectorOpen,
    ],
  );
}

export type SessionApi = ReturnType<typeof useSession>;
