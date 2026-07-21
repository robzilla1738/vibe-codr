// Mobile session hook — a faithful port of the Electron `useSession` event loop
// that drives the desktop renderer. It reuses the EXACT same pure state machines
// (chrome reducer, transcript reducer, trail, history hydration, stream caps,
// busy-on-send-failure policy) so behavior is 1:1 by construction. The only
// differences are the transport (RemoteEngineClient over WebSocket instead of
// window.vibe IPC) and persistence (in-memory; the engine is authoritative).
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { shouldClearBusyOnSendFailure } from "@shared/busy-on-send-failure";
import type { EngineCommand } from "@shared/commands";
import type { AssistantOutputPhase, UIEvent } from "@shared/events";
import { GLYPH } from "@shared/glyphs";
import { hydrateFromHistory } from "@shared/history-hydrate";
import { estimateJsonUtf8Bytes } from "@shared/json-size";
import { cycleModeAction, deriveUiMode, modeColor, selectModeAction, type PendingModeTransition, type UiMode } from "@shared/modes";
import { isUIEvent } from "@shared/protocol";
import {
  ASSISTANT_OUTPUT_MAX_CHARS,
  capTranscriptState,
  firstLine,
  groupIntoTurns,
  initialTranscript,
  MAX_RETAINED_TRANSCRIPT_BLOCKS,
  reduceTranscript,
  REASONING_OUTPUT_MAX_CHARS,
  type TranscriptAction,
  type TranscriptState,
  truncate,
} from "@shared/reducer";
import { isEngineSnapshot, isRenderableUIEvent } from "@shared/runtime-guards";
import { appendRollingText } from "@shared/stream-cap";
import { bufferToolProgress } from "@shared/tool-progress-buffer";
import { Trail, windowStartIndex, turnWindowStart } from "@shared/trail";
import type { EngineSnapshot } from "@shared/types";
import type { PendingCapabilityRequest } from "@shared/cloud";
import { stripVisionRelayContext } from "@shared/vision-display";
import { initialChrome, reduceChrome, type SessionChrome } from "@hooks/session-state";
import { RequestGate } from "@hooks/request-gate";
import { RemoteEngineClient, type RemoteConnectionState } from "../remote/RemoteEngineClient";

export type { SessionChrome, OrchestrationRow } from "@hooks/session-state";

export type ToastSeverity = "info" | "warn" | "error";
export interface ToastState { message: string; severity: ToastSeverity; closing?: boolean }

const TOAST_TTL: Record<ToastSeverity, number> = { info: 3000, warn: 4500, error: 6000 };
const WINDOW_TURNS = 40;
const REVEAL_PAGE = 20;
const TURN_ITEMS_MAX = 120;
const TURN_ITEMS_STEP = 24;
const TURN_ITEM_REVEAL_PAGE = TURN_ITEMS_STEP;
const TOAST_EXIT_MS = 140;
const BOOTSTRAP_EVENT_LIMIT = 2_048;
const BOOTSTRAP_EVENT_BYTES_LIMIT = 8 * 1024 * 1024;

const CLEAR_SCOPED_TYPES = new Set<string>([
  "assistant-text-delta", "reasoning-delta", "tool-call-started", "tool-call-progress",
  "tool-call-finished", "file-changed", "permission-request", "plan-presented",
  "plan-state-changed", "question-request", "question-settled", "activities-changed",
  "subagent-started", "subagent-activity", "subagent-finished", "notice", "compacted",
  "loop-stopped", "loop-tick", "checkpoint-created", "checkpoint-restored",
  "verify-started", "verify-finished",
]);

type TxAction = TranscriptAction | { type: "reset" } | { type: "replace"; state: TranscriptState };

function reduceTx(s: TranscriptState, a: TxAction): TranscriptState {
  if (a.type === "reset") return initialTranscript();
  if (a.type === "replace") return a.state;
  return reduceTranscript(s, a);
}
function reduceTxCapped(s: TranscriptState, a: TxAction): TranscriptState {
  return capTranscriptState(reduceTx(s, a), MAX_RETAINED_TRANSCRIPT_BLOCKS);
}

export interface UseRemoteSessionArgs {
  client: RemoteEngineClient | null;
  cwd: string | null;
}

export function useRemoteSession({ client, cwd }: UseRemoteSessionArgs) {
  const [chrome, dispatchChrome] = useReducer(reduceChrome, cwd ?? "", (c) => initialChrome(c || ""));
  const [transcript, dispatchTranscript] = useReducer(reduceTxCapped, undefined, initialTranscript);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<RemoteConnectionState>("connecting");
  const [booting, setBooting] = useState(false);
  const [ready, setReady] = useState(false);
  const [pendingCapabilities, setPendingCapabilities] = useState<PendingCapabilityRequest[]>([]);
  const [pendingModeTransition, setPendingModeTransition] = useState<PendingModeTransition | null>(null);

  const deltaBuf = useRef("");
  const deltaPhase = useRef<AssistantOutputPhase | undefined>(undefined);
  const progressBuf = useRef<Map<string, string>>(new Map());
  const reasoningBuf = useRef("");
  const reasoningStarted = useRef<number | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressAfterClear = useRef(false);
  const bootstrapHandoff = useRef(false);
  const bootstrapEvents = useRef<Array<{ event: UIEvent; bytes: number }>>([]);
  const bootstrapEventBytes = useRef(0);
  const bootstrapEventsTruncated = useRef(false);
  const lastSnap = useRef<EngineSnapshot | null>(null);
  const trail = useRef(new Trail());
  const bootstrapGate = useRef(new RequestGate());
  const modeTransitioning = useRef(false);
  const activeSessionId = useRef("");
  const activeCwd = useRef(cwd ?? "");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastExitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didInitialConnect = useRef(false);
  const busyRef = useRef(chrome.busy);
  busyRef.current = chrome.busy;

  const uiMode: UiMode = useMemo(() => deriveUiMode(chrome.mode, chrome.approvals), [chrome.mode, chrome.approvals]);
  const turns = useMemo(() => groupIntoTurns(transcript.blocks), [transcript.blocks]);
  const [revealTurns, setRevealTurns] = useState(0);
  const [foldedTurns, setFoldedTurns] = useState<Set<number>>(new Set());
  const [revealedTurnItems, setRevealedTurnItems] = useState<Map<number, number>>(() => new Map());
  const windowStart = useMemo(() => windowStartIndex(turns.length, WINDOW_TURNS, revealTurns), [turns.length, revealTurns]);
  const visibleTurns = useMemo(() => turns.slice(windowStart), [turns, windowStart]);
  const hiddenCount = windowStart;
  const revealEarlier = useCallback(() => {
    setRevealTurns((cur) => cur + Math.min(REVEAL_PAGE, Math.max(0, turns.length - WINDOW_TURNS - cur)));
  }, [turns.length]);

  const foldAllTurns = useCallback(() => {
    setFoldedTurns((prev) => {
      const foldable = turns.filter((t) => t.user && t.items.length > 0);
      const anyFolded = foldable.some((t) => prev.has(t.key));
      if (anyFolded) return new Set();
      return new Set(foldable.map((t) => t.key));
    });
  }, [turns]);

  const toggleTurnFold = useCallback((key: number) => {
    setFoldedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const revealTurnItems = useCallback((turnKey: number, hidden: number) => {
    if (hidden <= 0) return;
    setRevealedTurnItems((prev) => {
      const next = new Map(prev);
      next.set(turnKey, (next.get(turnKey) ?? 0) + Math.min(TURN_ITEM_REVEAL_PAGE, hidden));
      return next;
    });
  }, []);

  const itemWindowFor = useCallback((turnKey: number, itemCount: number) => {
    const revealed = revealedTurnItems.get(turnKey) ?? 0;
    const start = turnWindowStart(itemCount, TURN_ITEMS_MAX, TURN_ITEMS_STEP, revealed);
    return { start, hidden: start, revealPage: Math.min(TURN_ITEM_REVEAL_PAGE, start) };
  }, [revealedTurnItems]);

  // Prune stale fold keys when turns are windowed out (parity with desktop).
  useEffect(() => {
    const retainedKeys = new Set(turns.map((t) => t.key));
    setFoldedTurns((cur) => {
      if ([...cur].every((k) => retainedKeys.has(k))) return cur;
      return new Set([...cur].filter((k) => retainedKeys.has(k)));
    });
  }, [turns]);

  const showToast = useCallback((message: string, severity: ToastSeverity) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    if (toastExitTimer.current) clearTimeout(toastExitTimer.current);
    setToast({ message, severity });
    toastTimer.current = setTimeout(() => {
      setToast((t) => (t ? { ...t, closing: true } : null));
      toastExitTimer.current = setTimeout(() => setToast(null), TOAST_EXIT_MS);
    }, TOAST_TTL[severity]);
  }, []);

  const flushDeltas = useCallback(() => {
    if (flushTimer.current != null) { clearTimeout(flushTimer.current); flushTimer.current = null; }
    if (progressBuf.current.size) {
      for (const [toolCallId, chunk] of progressBuf.current) {
        dispatchTranscript({ type: "tool-progress", toolCallId, chunk });
      }
      progressBuf.current.clear();
    }
    if (deltaBuf.current) {
      const text = deltaBuf.current;
      deltaBuf.current = "";
      const phase = deltaPhase.current;
      deltaPhase.current = undefined;
      dispatchTranscript({ type: "delta", text, ...(phase ? { phase } : {}) });
    }
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
    const seconds = reasoningStarted.current != null
      ? Math.max(1, Math.round((Date.now() - reasoningStarted.current) / 1000))
      : undefined;
    dispatchTranscript({ type: "thinking", text, seconds });
    reasoningBuf.current = "";
    reasoningStarted.current = null;
    dispatchChrome({ type: "set-thinking", text: "" });
  }, []);

  const endTurn = useCallback((opts: { stopWorking: boolean }) => {
    flushDeltas();
    landReasoning();
    dispatchTranscript({ type: "clear-turn" });
    if (opts.stopWorking) dispatchChrome({ type: "set-busy", busy: false });
  }, [flushDeltas, landReasoning]);

  const handleEvent = useCallback((raw: unknown) => {
    if (!isUIEvent(raw) || !isRenderableUIEvent(raw)) {
      dispatchTranscript({ type: "notice", text: "Engine emitted an invalid UI event", level: "error" });
      return;
    }
    const event = raw as UIEvent;
    if (bootstrapHandoff.current) {
      const bytes = estimateJsonUtf8Bytes(event, BOOTSTRAP_EVENT_BYTES_LIMIT);
      if (bytes > BOOTSTRAP_EVENT_BYTES_LIMIT) { bootstrapEventsTruncated.current = true; return; }
      while (bootstrapEvents.current.length >= BOOTSTRAP_EVENT_LIMIT || bootstrapEventBytes.current + bytes > BOOTSTRAP_EVENT_BYTES_LIMIT) {
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
    try {
      if (suppressAfterClear.current) {
        if (event.type === "user-message") suppressAfterClear.current = false;
        else if (event.type === "engine-error") { /* fall through */ }
        else if (CLEAR_SCOPED_TYPES.has(event.type) || event.type === "turn-finished" || event.type === "session-idle" || event.type === "engine-idle") return;
      }
      if (event.type === "session-start") {
        setPendingModeTransition(null);
        dispatchChrome({ type: "seed-from-session-start", event, snap: lastSnap.current });
      } else {
        dispatchChrome({ type: "event", event });
      }
      if (event.type === "plan-presented") setPendingModeTransition(null);
      if (event.type === "plan-state-changed") {
        setPendingModeTransition((pending) => pending
          && event.state.status === "pending"
          && event.state.plan === pending.planIdentity ? pending : null);
      }
      switch (event.type) {
        case "user-message":
          flushDeltas(); landReasoning(); trail.current.reset();
          dispatchTranscript({ type: "user", text: stripVisionRelayContext(event.text), ...(event.origin ? { origin: event.origin } : {}), ...(event.label ? { label: event.label } : {}) });
          break;
        case "plan-presented":
          flushDeltas(); landReasoning(); dispatchTranscript({ type: "finalize" });
          break;
        case "assistant-text-delta":
          if (event.subagentId || !event.delta) break;
          landReasoning();
          if (deltaBuf.current && event.phase && deltaPhase.current && event.phase !== deltaPhase.current) flushDeltas();
          if (event.phase) deltaPhase.current = event.phase;
          deltaBuf.current = appendRollingText(deltaBuf.current, event.delta, ASSISTANT_OUTPUT_MAX_CHARS);
          if (flushTimer.current == null) flushTimer.current = setTimeout(flushDeltas, 24);
          break;
        case "reasoning-delta":
          if (event.subagentId || !event.delta) break;
          if (reasoningStarted.current == null) reasoningStarted.current = Date.now();
          reasoningBuf.current = appendRollingText(reasoningBuf.current, event.delta, REASONING_OUTPUT_MAX_CHARS);
          trail.current.append(event.delta);
          if (flushTimer.current == null) flushTimer.current = setTimeout(flushDeltas, 24);
          break;
        case "tool-call-started":
          if (event.subagentId) break;
          flushDeltas(); landReasoning();
          dispatchTranscript({ type: "tool-start", toolCallId: event.toolCallId, toolName: event.toolName, input: event.input, at: Date.now() });
          break;
        case "tool-call-progress":
          if (event.subagentId || !event.chunk) break;
          bufferToolProgress(progressBuf.current, event.toolCallId, event.chunk);
          if (flushTimer.current == null) flushTimer.current = setTimeout(flushDeltas, 24);
          break;
        case "tool-call-finished":
          if (event.subagentId) break;
          flushDeltas();
          dispatchTranscript({ type: "tool-finish", toolCallId: event.toolCallId, output: event.output, isError: event.isError, at: Date.now() });
          break;
        case "file-changed":
          flushDeltas();
          dispatchTranscript({ type: "file-changed", toolCallId: event.toolCallId, path: event.path, action: event.action, added: event.added, removed: event.removed, diff: event.diff, at: Date.now() });
          break;
        case "notice":
          flushDeltas();
          dispatchTranscript({ type: "notice", text: event.message, level: event.level });
          break;
        case "engine-error":
          endTurn({ stopWorking: true });
          dispatchTranscript({ type: "notice", text: `error: ${event.message}`, level: "error" });
          break;
        case "checkpoint-created":
          flushDeltas();
          dispatchTranscript({ type: "notice", text: `checkpoint ${event.label}`, level: "info" });
          break;
        case "checkpoint-restored":
          flushDeltas();
          dispatchTranscript({ type: "notice", text: `${GLYPH.revert} reverted: ${event.label}`, level: "info" });
          break;
        case "verify-started":
          flushDeltas();
          dispatchTranscript({ type: "notice", text: `verifying: ${event.command}`, level: "info" });
          break;
        case "verify-finished": {
          flushDeltas();
          const detail = !event.ok && event.output ? ` — ${truncate(firstLine(event.output) ?? "", 120)}` : "";
          dispatchTranscript({ type: "notice", text: event.ok ? "verification passed" : `verification failed${detail}`, level: event.ok ? "info" : "error" });
          break;
        }
        case "compacted":
          flushDeltas();
          dispatchTranscript({ type: "notice", text: `Compacted history · freed ~${event.freedTokens} tokens`, level: "info" });
          break;
        case "loop-tick":
          flushDeltas();
          dispatchTranscript({ type: "notice", text: `${GLYPH.loopTick} loop iteration ${event.iteration}`, level: "info" });
          break;
        case "loop-stopped":
          flushDeltas();
          dispatchTranscript({ type: "notice", text: `Loop stopped — ${event.reason}`, level: "info" });
          break;
        case "turn-finished":
        case "session-idle":
          endTurn({ stopWorking: false });
          break;
        case "engine-idle":
          endTurn({ stopWorking: true });
          if (event.gate === "red") dispatchTranscript({ type: "notice", text: "STILL RED — green-gate did not pass", level: "warn" });
          break;
        case "external-capability-pending":
          setPendingCapabilities((c) => [...c.filter((r) => r.id !== event.request.id), event.request]);
          break;
        case "external-capability-resolved":
          setPendingCapabilities((c) => c.filter((r) => r.id !== event.id));
          break;
        default: break;
      }
    } catch (err) {
      dispatchTranscript({ type: "notice", text: `ui error handling "${event.type}": ${err instanceof Error ? err.message : String(err)}`, level: "error" });
    }
  }, [endTurn, flushDeltas, landReasoning]);

  const clearSessionLocal = useCallback(() => {
    setPendingModeTransition(null);
    suppressAfterClear.current = true;
    deltaBuf.current = "";
    deltaPhase.current = undefined;
    progressBuf.current.clear();
    reasoningBuf.current = "";
    reasoningStarted.current = null;
    trail.current.reset();
    if (flushTimer.current != null) { clearTimeout(flushTimer.current); flushTimer.current = null; }
    dispatchTranscript({ type: "reset" });
    setPendingCapabilities([]);
    dispatchChrome({ type: "clear-session-overlays" });
  }, []);

  const bootstrap = useCallback(async (opts: { cwd: string; resume?: string; continueLatest?: boolean }) => {
    setPendingModeTransition(null);
    if (!client) return false;
    const request = bootstrapGate.current.begin();
    bootstrapHandoff.current = true;
    bootstrapEvents.current = [];
    bootstrapEventBytes.current = 0;
    bootstrapEventsTruncated.current = false;
    setBooting(true);
    setBootError(null);
    setReady(false);
    suppressAfterClear.current = false;
    lastSnap.current = null;
    deltaBuf.current = "";
    deltaPhase.current = undefined;
    progressBuf.current.clear();
    reasoningBuf.current = "";
    reasoningStarted.current = null;
    trail.current.reset();
    if (flushTimer.current != null) { clearTimeout(flushTimer.current); flushTimer.current = null; }
    try {
      await client.connect();
    } catch (error) {
      if (!bootstrapGate.current.isCurrent(request)) return false;
      bootstrapHandoff.current = false;
      bootstrapEvents.current = [];
      setBootError(error instanceof Error ? error.message : "Engine connection failed");
      setBooting(false);
      return false;
    }
    if (!bootstrapGate.current.isCurrent(request)) return false;
    let snap: EngineSnapshot;
    try {
      snap = await client.snapshot();
    } catch (error) {
      if (!bootstrapGate.current.isCurrent(request)) return false;
      bootstrapHandoff.current = false;
      bootstrapEvents.current = [];
      await client.shutdown().catch(() => undefined);
      setBootError(`Engine snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      setBooting(false);
      return false;
    }
    if (!bootstrapGate.current.isCurrent(request)) return false;
    activeSessionId.current = snap.sessionId;
    activeCwd.current = opts.cwd;
    lastSnap.current = snap;
    setPendingCapabilities(snap.pendingCapabilities ?? []);
    dispatchChrome({ type: "reset", cwd: opts.cwd });
    dispatchTranscript({ type: "reset" });
    dispatchChrome({ type: "seed", snap, cwd: opts.cwd });
    if (snap.history?.length) {
      const hydrated = hydrateFromHistory(snap.history);
      dispatchTranscript({ type: "replace", state: hydrated });
    }
    const queuedEvents = bootstrapEvents.current
      .filter(({ event }) => "sessionId" in event && event.sessionId === snap.sessionId)
      .map(({ event }) => event);
    const eventsTruncated = bootstrapEventsTruncated.current;
    bootstrapEvents.current = [];
    bootstrapEventBytes.current = 0;
    bootstrapEventsTruncated.current = false;
    bootstrapHandoff.current = false;
    for (const event of queuedEvents) handleEvent(event);
    if (eventsTruncated) {
      dispatchTranscript({ type: "notice", text: "Some live output during session startup was omitted to keep memory bounded.", level: "warn" });
    }
    setReady(true);
    setBooting(false);
    didInitialConnect.current = true;
    return true;
  }, [client, handleEvent]);

  const switchSession = useCallback(async (opts: { cwd: string; resume?: string; continueLatest?: boolean }) => {
    setPendingModeTransition(null);
    if (!client) return false;
    const request = bootstrapGate.current.begin();
    bootstrapHandoff.current = true;
    bootstrapEvents.current = [];
    bootstrapEventBytes.current = 0;
    bootstrapEventsTruncated.current = false;
    setBooting(true);
    setBootError(null);
    setReady(false);
    suppressAfterClear.current = false;
    lastSnap.current = null;
    deltaBuf.current = "";
    deltaPhase.current = undefined;
    progressBuf.current.clear();
    reasoningBuf.current = "";
    reasoningStarted.current = null;
    trail.current.reset();
    if (flushTimer.current != null) { clearTimeout(flushTimer.current); flushTimer.current = null; }
    let snap: EngineSnapshot;
    try {
      await client.rebootstrap(opts);
    } catch (error) {
      if (!bootstrapGate.current.isCurrent(request)) return false;
      bootstrapHandoff.current = false;
      setBootError(error instanceof Error ? error.message : "Session switch failed");
      setBooting(false);
      return false;
    }
    if (!bootstrapGate.current.isCurrent(request)) return false;
    try {
      snap = await client.snapshot();
    } catch (error) {
      if (!bootstrapGate.current.isCurrent(request)) return false;
      bootstrapHandoff.current = false;
      setBootError(`Engine snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      setBooting(false);
      return false;
    }
    if (!bootstrapGate.current.isCurrent(request)) return false;
    activeSessionId.current = snap.sessionId;
    activeCwd.current = opts.cwd;
    lastSnap.current = snap;
    setPendingCapabilities(snap.pendingCapabilities ?? []);
    dispatchChrome({ type: "reset", cwd: opts.cwd });
    dispatchTranscript({ type: "reset" });
    dispatchChrome({ type: "seed", snap, cwd: opts.cwd });
    if (snap.history?.length) {
      dispatchTranscript({ type: "replace", state: hydrateFromHistory(snap.history) });
    }
    const queuedEvents = bootstrapEvents.current
      .filter(({ event }) => "sessionId" in event && event.sessionId === snap.sessionId)
      .map(({ event }) => event);
    bootstrapEvents.current = [];
    bootstrapEventBytes.current = 0;
    bootstrapEventsTruncated.current = false;
    bootstrapHandoff.current = false;
    for (const event of queuedEvents) handleEvent(event);
    setReady(true);
    setBooting(false);
    didInitialConnect.current = true;
    return true;
  }, [client, handleEvent]);

  const send = useCallback(async (command: EngineCommand): Promise<boolean> => {
    if (!client) return false;
    try {
      const ok = client.send(command);
      if (!ok) {
        dispatchTranscript({ type: "notice", text: "Engine connection lost — reconnecting…", level: "warn" });
        if (shouldClearBusyOnSendFailure([command], busyRef.current)) dispatchChrome({ type: "set-busy", busy: false });
        return false;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Engine command failed";
      dispatchTranscript({ type: "notice", text: msg, level: "error" });
      if (shouldClearBusyOnSendFailure([command], busyRef.current)) dispatchChrome({ type: "set-busy", busy: false });
      return false;
    }
    return true;
  }, [client]);

  const sendMany = useCallback(async (commands: EngineCommand[]): Promise<boolean> => {
    if (!client) return false;
    const alreadyBusy = busyRef.current;
    for (const c of commands) {
      try {
        const ok = client.send(c);
        if (!ok) {
          dispatchTranscript({ type: "notice", text: "Engine connection lost — reconnecting…", level: "warn" });
          if (shouldClearBusyOnSendFailure(commands, alreadyBusy)) dispatchChrome({ type: "set-busy", busy: false });
          return false;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Engine command failed";
        dispatchTranscript({ type: "notice", text: msg, level: "error" });
        if (shouldClearBusyOnSendFailure(commands, alreadyBusy)) dispatchChrome({ type: "set-busy", busy: false });
        return false;
      }
    }
    return true;
  }, [client]);

  const cycleMode = useCallback(() => {
    if (modeTransitioning.current) return;
    const action = cycleModeAction(uiMode, { planPending: !!chrome.plan });
    if (action.requiresPlanDecision && chrome.plan && chrome.sessionId) {
      setPendingModeTransition({ sessionId: chrome.sessionId, source: "plan", target: action.target as Exclude<UiMode, "plan">, planIdentity: chrome.plan.text });
      return;
    }
    if (action.commands.length === 0 && !action.optimistic) return;
    modeTransitioning.current = true;
    void (async () => {
      try {
        const sent = await sendMany(action.commands);
        if (!sent) return;
        if (action.optimistic) {
          dispatchChrome({ type: "optimistic-mode", mode: action.optimistic.mode, approvals: action.optimistic.approvals });
        }
      } finally { modeTransitioning.current = false; }
    })();
  }, [uiMode, chrome.plan, chrome.sessionId, sendMany]);

  const selectMode = useCallback((target: UiMode) => {
    if (modeTransitioning.current) return;
    const action = selectModeAction(uiMode, target, { planPending: !!chrome.plan });
    if (action.requiresPlanDecision && chrome.plan && chrome.sessionId) {
      setPendingModeTransition({ sessionId: chrome.sessionId, source: "plan", target: action.target as Exclude<UiMode, "plan">, planIdentity: chrome.plan.text });
      return;
    }
    if (action.commands.length === 0 && !action.optimistic) return;
    modeTransitioning.current = true;
    void (async () => {
      try {
        const sent = await sendMany(action.commands);
        if (!sent) return;
        if (action.optimistic) {
          dispatchChrome({ type: "optimistic-mode", mode: action.optimistic.mode, approvals: action.optimistic.approvals });
        }
      } finally { modeTransitioning.current = false; }
    })();
  }, [uiMode, chrome.plan, chrome.sessionId, sendMany]);

  // Wire transport events while a client is present.
  useEffect(() => {
    if (!client) return;
    const offEvent = client.onEvent(handleEvent);
    const prevReady = client.onReady;
    const prevDisconnect = client.onDisconnect;
    const prevConnectionState = client.onConnectionState;
    client.onReady = () => {
      // Reconnect resync: after the initial connect, a new ready means the
      // transport reconnected. Re-fetch the snapshot + re-seed chrome + re-
      // hydrate the transcript so the view matches the engine without a full
      // reset (seamless remote control across drops).
      if (!didInitialConnect.current || bootstrapHandoff.current) return;
      void (async () => {
        const request = bootstrapGate.current.begin();
        bootstrapHandoff.current = true;
        bootstrapEvents.current = [];
        bootstrapEventBytes.current = 0;
        bootstrapEventsTruncated.current = false;
        try {
          const snap = await client.snapshot();
          if (!bootstrapGate.current.isCurrent(request)) return;
          activeSessionId.current = snap.sessionId;
          lastSnap.current = snap;
          setPendingCapabilities(snap.pendingCapabilities ?? []);
          dispatchChrome({ type: "seed", snap, cwd: activeCwd.current });
          dispatchTranscript({ type: "replace", state: hydrateFromHistory(snap.history ?? []) });
          const queuedEvents = bootstrapEvents.current
            .filter(({ event }) => "sessionId" in event && event.sessionId === snap.sessionId)
            .map(({ event }) => event);
          const eventsTruncated = bootstrapEventsTruncated.current;
          bootstrapEvents.current = [];
          bootstrapEventBytes.current = 0;
          bootstrapEventsTruncated.current = false;
          bootstrapHandoff.current = false;
          for (const event of queuedEvents) handleEvent(event);
          if (eventsTruncated) {
            dispatchTranscript({ type: "notice", text: "Some live output during reconnection was omitted to keep memory bounded.", level: "warn" });
          }
          setBootError(null);
          setReady(true);
        } catch (error) {
          if (!bootstrapGate.current.isCurrent(request)) return;
          bootstrapHandoff.current = false;
          bootstrapEvents.current = [];
          bootstrapEventBytes.current = 0;
          bootstrapEventsTruncated.current = false;
          const message = `Engine resync failed: ${error instanceof Error ? error.message : String(error)}`;
          setBootError(message);
          dispatchTranscript({ type: "notice", text: message, level: "error" });
        }
      })();
    };
    client.onDisconnect = () => undefined;
    client.onConnectionState = setConnectionState;
    const prevFatal = client.onFatal;
    client.onFatal = (message: string) => {
      bootstrapHandoff.current = false;
      bootstrapEvents.current = [];
      setPendingModeTransition(null);
      setBootError(message);
      setReady(false);
      setBooting(false);
      dispatchTranscript({ type: "notice", text: message, level: "error" });
      dispatchChrome({ type: "set-busy", busy: false });
    };
    return () => {
      offEvent();
      client.onReady = prevReady;
      client.onDisconnect = prevDisconnect;
      client.onConnectionState = prevConnectionState;
      client.onFatal = prevFatal;
      if (flushTimer.current != null) clearTimeout(flushTimer.current);
      if (toastTimer.current != null) clearTimeout(toastTimer.current);
      if (toastExitTimer.current != null) clearTimeout(toastExitTimer.current);
    };
  }, [client, handleEvent]);

  return {
    chrome, transcript, turns, uiMode, modeColor: modeColor(uiMode),
    toast, showToast, bootError, booting, ready, connectionState, pendingCapabilities,
    bootstrap, switchSession, send, sendMany, clearSessionLocal, cycleMode, selectMode,
    pendingModeTransition, dismissPendingModeTransition: () => setPendingModeTransition(null),
    visibleTurns, hiddenCount, revealEarlier, foldedTurns, foldAllTurns, toggleTurnFold,
    revealTurnItems, itemWindowFor,
    dispatchChrome, dispatchTranscript,
  };
}
