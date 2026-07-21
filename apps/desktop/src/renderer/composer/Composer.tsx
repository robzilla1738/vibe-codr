import { type CSSProperties, type Dispatch, type DragEvent, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  agentsPickerQuery,
  mcpPickerQuery,
  modelPicker,
  providersPickerQuery,
  skillsPickerFilter,
} from "../../shared/catalog-draft";
import {
  applyPalette,
  isExactCommand,
  PALETTE_GROUP_META,
  PALETTE_GROUPS,
  type PaletteGroup,
  type PaletteState,
  paletteState,
} from "../../shared/commands-catalog";
import { applyComposerPaste } from "../../shared/composer-edit";
import { densityLabel, isTranscriptDensity } from "../../shared/density";
import { modeWord, type PendingModeTransition, type UiMode } from "../../shared/modes";
import { accentNameOf } from "../../shared/themes";
import { applyAtMention, useAtMention } from "../hooks/useAtMention";
import { useFloatingAnchor } from "../hooks/useFloatingAnchor";
import { usePresence, useRetainedValue } from "../hooks/usePresence";
import {
  IconCheck,
  IconChevron,
  IconFile,
  IconPaperclip,
  IconRemove,
  IconSend,
  IconSettings,
  IconStop,
  IconTerminal,
} from "../icons";

const MODE_OPTIONS: UiMode[] = ["plan", "execute", "yolo"];

const MODE_HINT: Record<UiMode, string> = {
  plan: "Plan before editing",
  execute: "Edit with approvals",
  yolo: "Run without asking",
};

function ModeIcon({ mode, size = 15 }: { mode: UiMode; size?: number }) {
  if (mode === "plan") return <IconCheck size={size} />;
  if (mode === "yolo") return <IconTerminal size={size} />;
  return <IconSettings size={size} />;
}

/** Matches `--composer-input-max` — keep JS clamp and CSS in sync. */
const COMPOSER_INPUT_MAX_PX = 320;
const COMPOSER_POPOVER_MAX_PX = 360;
/** Fast UI ceiling; App performs the authoritative encoded-command byte check. */
const COMPOSER_DRAFT_MAX_CHARS = 800_000;
const COMPOSER_MAX_ATTACHMENTS = 32;
const IMAGE_PREVIEW_MAX_BYTES = 12 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tif", "tiff"]);

type DroppedFile = File & { path?: string };

type ComposerAttachment = {
  id: string;
  name: string;
  path: string;
  token: string;
  isImage: boolean;
  size: number;
  previewUrl: string | null;
};

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function comparablePath(path: string): string {
  const normalized = normalizedPath(path);
  return /^[A-Z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function hasFilePayload(transfer: DataTransfer): boolean {
  return ["Files", "text/uri-list", "public.file-url"].some((type) => transfer.types.includes(type));
}

function pathFromTransferValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#")) return "";
  if (/^file:/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "file:") return "";
      let path = decodeURIComponent(url.pathname);
      if (url.hostname && url.hostname !== "localhost") path = `//${url.hostname}${path}`;
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
      return path;
    } catch {
      return "";
    }
  }
  return /^\/?(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(trimmed) ? trimmed : "";
}

function transferPaths(transfer: DataTransfer): string[] {
  const uriPaths = transfer
    .getData("text/uri-list")
    .split(/\r?\n/)
    .map(pathFromTransferValue)
    .filter(Boolean);
  if (uriPaths.length > 0) return uriPaths;
  return transfer
    .getData("text/plain")
    .split(/\r?\n/)
    .map(pathFromTransferValue)
    .filter(Boolean);
}

function fileName(path: string): string {
  const normalized = normalizedPath(path).replace(/\/$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

function relativePath(path: string, cwd: string | null): string {
  if (!cwd) return normalizedPath(path);
  const normalized = normalizedPath(path);
  const root = normalizedPath(cwd).replace(/\/$/, "");
  const comparablePath = /^[A-Z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
  const comparableRoot = /^[A-Z]:\//i.test(root) ? root.toLowerCase() : root;
  if (comparablePath === comparableRoot) return ".";
  if (comparablePath.startsWith(`${comparableRoot}/`)) return normalized.slice(root.length + 1);
  return normalized;
}

/** Project-relative @ mention for dropped files (quotes paths with spaces). */
function attachmentToken(path: string, cwd: string | null): string {
  const displayPath = relativePath(path, cwd);
  // Lazy import avoided — formatAtPath lives in shared/file-fuzzy.
  const p = displayPath.replace(/\\/g, "/");
  const escaped = p.replace(/"/g, '\\"');
  return /\s/.test(p) ? `@"${escaped}"` : `@${escaped}`;
}

function pathExtension(path: string): string {
  return path.split(".").at(-1)?.toLowerCase() ?? "";
}

export type ComposerMetric = {
  key: string;
  label: string;
  title?: string;
};

function useBusyElapsed(busy: boolean): string | null {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Date.now() - start), 200);
    return () => window.clearInterval(timer);
  }, [busy]);
  if (!busy) return null;
  // Always show a tabular elapsed once busy so the Stop control width stays stable.
  return `${(elapsed / 1000).toFixed(elapsed >= 10_000 ? 0 : 1)}s`;
}

function isCatalogDraft(draft: string): boolean {
  return (
    modelPicker(draft) != null ||
    providersPickerQuery(draft) != null ||
    agentsPickerQuery(draft) != null ||
    skillsPickerFilter(draft) != null ||
    mcpPickerQuery(draft) != null
  );
}

function navigateCatalog(direction: 1 | -1): void {
  window.dispatchEvent(new CustomEvent("vibe-catalog-nav", { detail: direction }));
}

function confirmCatalog(): boolean {
  window.dispatchEvent(new CustomEvent("vibe-catalog-confirm"));
  return true;
}

function currentValueFor(
  name: string,
  opts: {
    theme: string;
    accent: string;
    approvals: "ask" | "auto";
    density: string;
    reasoning?: string;
    executionTarget?: "local" | "cloud";
  },
): string | undefined {
  if (name === "theme") return opts.theme;
  if (name === "approvals") return opts.approvals;
  if (name === "reasoning") return opts.reasoning ?? "off";
  if (name === "details") return opts.density;
  if (name === "mouse") return undefined; // no-op in Electron
  if (name === "handoff") return opts.executionTarget;
  if (name === "accent") return accentNameOf(opts.accent);
  return undefined;
}

function fileParts(path: string): { base: string; dir: string } {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return { base: normalized, dir: "" };
  return { base: normalized.slice(slash + 1), dir: normalized.slice(0, slash) };
}

function displayModeLabel(mode: UiMode): string {
  const label = modeWord(mode);
  return label.length > 1 ? `${label.slice(0, 1)}${label.slice(1).toLowerCase()}` : label;
}

function highlightMatch(text: string, query: string): { before: string; match: string; after: string } | null {
  if (!query) return null;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return null;
  return {
    before: text.slice(0, idx),
    match: text.slice(idx, idx + q.length),
    after: text.slice(idx + q.length),
  };
}

function HighlightedBase({ base, query }: { base: string; query: string }) {
  const hl = highlightMatch(base, query);
  if (!hl) return <>{base}</>;
  return (
    <>
      {hl.before}
      <span className="hl">{hl.match}</span>
      {hl.after}
    </>
  );
}

function MenuKeyHints({
  action,
  tabAction,
  escapeAction = "close",
}: {
  action: string;
  tabAction?: string;
  escapeAction?: string;
}) {
  return (
    <>
      <kbd className="action-kbd">↑↓</kbd>
      <span>navigate</span>
      {tabAction ? <><kbd className="action-kbd">Tab</kbd><span>{tabAction}</span></> : null}
      <kbd className="action-kbd">Enter</kbd>
      <span>{action}</span>
      <kbd className="action-kbd">Esc</kbd>
      <span>{escapeAction}</span>
    </>
  );
}

export function Composer({
  uiMode,
  draft,
  setDraft,
  onSubmit,
  catalogOpen,
  onCycleMode,
  onSelectMode,
  pendingModeTransition,
  onResolveModeTransition,
  modeTransitionRunDisabledReason,
  disabled,
  commandNames,
  cwd,
  model,
  theme,
  accent,
  approvals,
  density,
  reasoning,
  metrics = [],
  ctxPct,
  busy,
  onAbort,
  onCycleDensity,
  onPasteError,
  onOpenModel,
  onOpenInspector,
  onEditInEditor,
  emptyHome = false,
  planPending = false,
  executionTarget = "local",
  executionStatus,
  onExecutionTargetChange,
}: {
  uiMode: UiMode;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  onSubmit: (line: string) => Promise<boolean>;
  catalogOpen: boolean;
  onCycleMode: () => void;
  onSelectMode: (mode: UiMode) => void;
  pendingModeTransition?: PendingModeTransition | null;
  onResolveModeTransition?: (choice: "run" | "switch" | "cancel") => void;
  modeTransitionRunDisabledReason?: string | null;
  disabled?: boolean;
  commandNames: string[];
  cwd: string | null;
  model: string;
  theme: string;
  accent: string;
  approvals: "ask" | "auto";
  density: string;
  reasoning?: string;
  /** Usage / changed-file chips (stable slot; gate & queue have their own surfaces). */
  metrics?: ComposerMetric[];
  /** Context-window fill 0–100, or null before the first turn. */
  ctxPct?: number | null;
  busy: boolean;
  onAbort: () => void;
  /** Cycle transcript density (⌘D). */
  onCycleDensity?: () => void;
  onPasteError: (message: string) => void;
  /** Open the model picker from the model chip (real affordance, I26). */
  onOpenModel?: () => void;
  /** Open the session inspector from the context chip (I26). */
  onOpenInspector?: () => void;
  /** Compose in $VISUAL/$EDITOR — surfaced in the insert menu (I27). */
  onEditInEditor?: () => void;
  /** Empty-session home: taller input + /@-hint placeholder. */
  emptyHome?: boolean;
  /** Plan approval pending — composer submits revise the plan. */
  planPending?: boolean;
  /** The runtime currently responsible for this session. */
  executionTarget?: "local" | "cloud";
  /** More specific cloud state for the accessible label and tooltip. */
  executionStatus?: string;
  /** Requests a reviewed ownership transition; selecting the active target is inert. */
  onExecutionTargetChange?: (target: "local" | "cloud") => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const modeTriggerRef = useRef<HTMLButtonElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const modeSelRef = useRef(0);
  const submitPending = useRef(false);
  const dragDepthRef = useRef(0);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const [sel, setSel] = useState(0);
  const [paletteGroup, setPaletteGroup] = useState<PaletteGroup>("commands");
  const [modeOpen, setModeOpen] = useState(false);
  const [modeSel, setModeSel] = useState(0);
  const [insertOpen, setInsertOpen] = useState(false);
  const [insertSel, setInsertSel] = useState(0);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [dropTarget, setDropTarget] = useState(false);
  const insertTriggerRef = useRef<HTMLButtonElement>(null);
  const insertMenuRef = useRef<HTMLDivElement>(null);
  const insertSelRef = useRef(0);
  const insertActionsRef = useRef<{ id: string; label: string; hint?: string; run: () => void; disabled?: boolean }[]>([]);
  const busyElapsed = useBusyElapsed(busy);
  modeSelRef.current = modeSel;
  insertSelRef.current = insertSel;
  const nameSet = useMemo(
    () => new Set(commandNames.map((n) => n.toLowerCase())),
    [commandNames],
  );
  const palette: PaletteState = useMemo(() => {
    if (isCatalogDraft(draft)) return { open: false };
    return paletteState(draft, commandNames, paletteGroup);
  }, [draft, commandNames, paletteGroup]);
  const exact = isExactCommand(draft, nameSet);
  const { mention: mentionQuery, files, loading: filesLoading, error: filesError } = useAtMention(draft, cwd);
  const atOpen = mentionQuery != null && !palette.open;
  const currentValue = palette.open && palette.mode === "value"
    ? currentValueFor(palette.command.name, {
        theme,
        accent,
        approvals,
        density,
        reasoning,
        executionTarget,
      })
    : undefined;

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    return () => {
      for (const attachment of attachmentsRef.current) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
    };
  }, []);

  const submitAndClear = async (line: string, originalDraft = draft) => {
    if (submitPending.current) return;
    submitPending.current = true;
    try {
      // Slash / local UI commands never carry attachment tokens — keep chips so
      // a mistaken `/jobs` does not silently discard Finder drops.
      const includeAttachments = !line.startsWith("/");
      const prompt = includeAttachments
        ? [line, ...attachments.map((attachment) => attachment.token)].filter(Boolean).join(" ")
        : line;
      const accepted = await onSubmit(prompt);
      if (accepted) {
        setDraft((current) => current === originalDraft ? "" : current);
        if (includeAttachments) {
          for (const attachment of attachments) {
            if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
          }
          setAttachments([]);
        }
      }
    } finally {
      submitPending.current = false;
    }
  };

  useEffect(() => {
    setSel(0);
  }, [draft]);

  useEffect(() => {
    if (!draft.startsWith("/")) setPaletteGroup("commands");
  }, [draft]);

  useEffect(() => {
    if (palette.open && palette.mode === "value" && currentValue) {
      const idx = palette.items.indexOf(currentValue);
      if (idx >= 0) setSel(idx);
    }
  }, [palette.open && palette.mode === "value" ? palette.command.name : "", currentValue]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, COMPOSER_INPUT_MAX_PX);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > COMPOSER_INPUT_MAX_PX ? "auto" : "hidden";
  }, [draft]);

  useEffect(() => {
    const selected = menuRef.current?.querySelector<HTMLElement>(".slash-item.selected");
    selected?.scrollIntoView({ block: "nearest" });
  }, [sel, atOpen, palette.open]);

  useEffect(() => {
    if (!modeOpen) return;
    const selected = modeMenuRef.current?.querySelector<HTMLElement>(".mode-option.selected");
    selected?.scrollIntoView({ block: "nearest" });
  }, [modeSel, modeOpen]);

  useEffect(() => {
    if (!modeOpen) return;
    setModeSel(Math.max(0, MODE_OPTIONS.indexOf(uiMode)));
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (modeMenuRef.current?.contains(target)) return;
      if (modeTriggerRef.current?.contains(target)) return;
      setModeOpen(false);
    };
    // The mode menu fully owns keyboard interaction while open. stopPropagation
    // prevents App's window-level Esc stack from also firing (clearing the
    // draft / denying a permission / aborting) when the user just wants to close
    // the menu. document listeners fire before window in the bubble phase, so
    // stopPropagation here reliably shields App's handler (I25/I58).
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setModeOpen(false);
        modeTriggerRef.current?.focus();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setModeSel((i) => (i + 1) % MODE_OPTIONS.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setModeSel((i) => (i - 1 + MODE_OPTIONS.length) % MODE_OPTIONS.length);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        event.stopPropagation();
        setModeSel(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        event.stopPropagation();
        setModeSel(MODE_OPTIONS.length - 1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        onSelectMode(MODE_OPTIONS[modeSelRef.current]!);
        setModeOpen(false);
        modeTriggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [modeOpen, uiMode, onSelectMode]);

  useEffect(() => {
    if (!insertOpen) return;
    setInsertSel(0);
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (insertMenuRef.current?.contains(target)) return;
      if (insertTriggerRef.current?.contains(target)) return;
      setInsertOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      const actions = insertActionsRef.current;
      const count = actions.length;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setInsertOpen(false);
        insertTriggerRef.current?.focus();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setInsertSel((i) => (i + 1) % count);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setInsertSel((i) => (i - 1 + count) % count);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        event.stopPropagation();
        setInsertSel(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        event.stopPropagation();
        setInsertSel(count - 1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        const action = actions[insertSelRef.current];
        setInsertOpen(false);
        insertTriggerRef.current?.focus();
        action?.run();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [insertOpen]);

  useEffect(() => {
    if (!insertOpen) return;
    const selected = insertMenuRef.current?.querySelector<HTMLElement>(".insert-option.selected");
    selected?.scrollIntoView({ block: "nearest" });
  }, [insertSel, insertOpen]);

  const itemCount = atOpen
    ? files.length
    : palette.open && palette.mode === "command"
      ? palette.items.length
      : palette.open && palette.mode === "value"
        ? palette.items.length
        : 0;

  const menuVisible = atOpen || (palette.open && (palette.mode === "command" || itemCount > 0));
  const slashPresence = usePresence(menuVisible);
  const modePresence = usePresence(modeOpen);
  const insertPresence = usePresence(insertOpen);
  const liveSlashPresentation = atOpen
    ? { kind: "mention" as const, files, filesLoading, filesError, mentionQuery }
    : palette.open && (palette.mode === "command" || itemCount > 0)
      ? { kind: "palette" as const, palette, paletteGroup, currentValue }
      : null;
  const slashPresentation = useRetainedValue(liveSlashPresentation);
  const slashBox = useFloatingAnchor(wrapRef, slashPresence.mounted);
  const modeBox = useFloatingAnchor(modeTriggerRef, modePresence.mounted || !!pendingModeTransition);
  const insertBox = useFloatingAnchor(insertTriggerRef, insertPresence.mounted);

  useEffect(() => {
    if (pendingModeTransition) setModeOpen(false);
  }, [pendingModeTransition]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (modeOpen && ["Enter", "ArrowDown", "ArrowUp", "Escape", "Home", "End"].includes(e.key)) {
      // Document listener owns the open mode menu; block composer submit/nav.
      e.preventDefault();
      return;
    }
    if (insertOpen && ["Enter", "ArrowDown", "ArrowUp", "Escape", "Home", "End"].includes(e.key)) {
      // Document listener owns the open insert menu; block composer submit/nav.
      e.preventDefault();
      return;
    }
    if (isCatalogDraft(draft) && catalogOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        navigateCatalog(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        navigateCatalog(-1);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        confirmCatalog();
        return;
      }
      if (e.key === "Escape") {
        // App Esc stack also closes the picker; clear draft here for TUI parity.
        e.preventDefault();
        setDraft("");
        return;
      }
    }
    if (atOpen && e.key === "Escape") {
      e.preventDefault();
      setDraft(draft.replace(/(^|\s)@[^\s]*$/, "$1"));
      return;
    }
    if (atOpen && itemCount > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((i) => (i + 1) % itemCount);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((i) => (i - 1 + itemCount) % itemCount);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const path = files[sel];
        if (path) setDraft(applyAtMention(draft, path));
        return;
      }
    }
    if (palette.open && palette.mode === "command" && e.key === "Tab") {
      e.preventDefault();
      const current = PALETTE_GROUPS.indexOf(paletteGroup);
      const direction = e.shiftKey ? -1 : 1;
      const next = (current + direction + PALETTE_GROUPS.length) % PALETTE_GROUPS.length;
      setPaletteGroup(PALETTE_GROUPS[next]!);
      setSel(0);
      return;
    }
    if (palette.open && itemCount > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((i) => (i + 1) % itemCount);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((i) => (i - 1 + itemCount) % itemCount);
        return;
      }
      if ((palette.mode === "value" && e.key === "Tab") || (e.key === "Enter" && !e.shiftKey)) {
        const applied = applyPalette(palette, sel);
        if (applied) {
          e.preventDefault();
          if (applied.done) {
            void submitAndClear(applied.draft);
          } else {
            setDraft(applied.draft);
          }
          return;
        }
      }
      if (e.key === "Escape" || (palette.mode === "value" && e.key === "ArrowLeft")) {
        e.preventDefault();
        e.stopPropagation();
        setDraft(palette.mode === "value" ? "/" : "");
        setSel(0);
        return;
      }
    }
    if (palette.open && e.key === "Escape") {
      e.preventDefault();
      setDraft("");
      return;
    }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      setModeOpen(false);
      onCycleMode();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const line = draft.trim();
      if (!line && !attachments.length) return;
      void submitAndClear(line);
    }
  };

  const submitDraft = () => {
    const line = draft.trim();
    if (!line && !attachments.length) return;
    void submitAndClear(line);
  };

  /** Ghost `@` affordance — drops an at-mention token at the end of the draft. */
  const insertAtMention = () => {
    const next = draft.length === 0 || /\s$/.test(draft) ? `${draft}@` : `${draft} @`;
    setDraft(next);
    window.requestAnimationFrame(() => {
      const el = ref.current;
      el?.focus();
      el?.setSelectionRange(next.length, next.length);
    });
  };

  /** Shared clipboard-paste flow for both native paste and the insert menu. */
  const runPasteClipboard = (start: number, end: number) => {
    const sourceDraft = draft;
    void window.vibe.pasteClipboard(cwd ?? undefined).then((result) => {
      if (result.kind === "error") {
        onPasteError(`Clipboard paste failed · ${result.error}`);
        return;
      }
      if (result.kind === "none") {
        onPasteError("Clipboard has no image or text to paste.");
        return;
      }
      const input = ref.current;
      const liveStart = input?.selectionStart ?? sourceDraft.length;
      const liveEnd = input?.selectionEnd ?? liveStart;
      let caret = start;
      let warnedTooLarge = false;
      setDraft((current) => {
        // If the user typed while native clipboard IPC was resolving, paste at
        // the live caret instead of applying stale offsets to the newer draft.
        const unchanged = current === sourceDraft;
        const edit = applyComposerPaste(
          current,
          unchanged ? start : liveStart,
          unchanged ? end : liveEnd,
          result,
        );
        if (edit.value.length > COMPOSER_DRAFT_MAX_CHARS) {
          if (!warnedTooLarge) {
            warnedTooLarge = true;
            queueMicrotask(() => {
              onPasteError(
                `Message is too large to paste safely (limit ${COMPOSER_DRAFT_MAX_CHARS.toLocaleString()} characters).`,
              );
            });
          }
          caret = unchanged ? start : liveStart;
          return current;
        }
        caret = edit.caret;
        return edit.value;
      });
      window.requestAnimationFrame(() => {
        ref.current?.focus();
        ref.current?.setSelectionRange(caret, caret);
      });
    }).catch((error: unknown) => {
      onPasteError(
        `Clipboard paste failed · ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Native browser paste and async IPC cannot race: own the transaction
    // synchronously, then reinsert either text or the saved image mention.
    event.preventDefault();
    const textarea = event.currentTarget;
    runPasteClipboard(textarea.selectionStart, textarea.selectionEnd);
  };

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (disabled || !hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    setDropTarget(true);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (disabled || !hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setDropTarget(true);
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (disabled || !hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDropTarget(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setDropTarget(false);

    const dropped = Array.from(event.dataTransfer.files) as DroppedFile[];
    if (!dropped.length) {
      onPasteError("Drop an image or file onto the composer.");
      return;
    }
    const pathsFromTransfer = transferPaths(event.dataTransfer);
    const seen = new Set(attachments.map((attachment) => comparablePath(attachment.path)));
    const next: ComposerAttachment[] = [];
    let inaccessible = 0;
    const availableSlots = Math.max(0, COMPOSER_MAX_ATTACHMENTS - attachments.length);
    if (availableSlots === 0) {
      onPasteError(`You can attach up to ${COMPOSER_MAX_ATTACHMENTS} files at a time.`);
      return;
    }
    for (const [index, file] of dropped.entries()) {
      if (next.length >= availableSlots) break;
      let path = file.path?.trim() ?? "";
      if (!path) {
        try {
          const resolver = window.vibe.getPathForFile;
          if (typeof resolver === "function") path = resolver(file).trim();
        } catch {
          path = "";
        }
      }
      if (!path) {
        path = pathsFromTransfer[index] ?? pathsFromTransfer.find((candidate) => fileName(candidate) === file.name) ?? "";
      }
      if (!path) {
        inaccessible += 1;
        continue;
      }
      path = normalizedPath(path);
      const key = comparablePath(path);
      if (seen.has(key)) continue;
      seen.add(key);
      const token = attachmentToken(path, cwd);
      const isImage = file.type.startsWith("image/") || IMAGE_EXTENSIONS.has(pathExtension(path));
      next.push({
        id: `${path}:${file.lastModified}:${file.size}`,
        name: fileName(path),
        path,
        token,
        isImage,
        size: file.size,
        // Avoid decoding an unbounded image into renderer memory. The file is
        // still attached by path; only the decorative thumbnail is omitted.
        previewUrl: isImage && file.size <= IMAGE_PREVIEW_MAX_BYTES
          ? URL.createObjectURL(file)
          : null,
      });
    }

    if (!next.length) {
      onPasteError(
        inaccessible > 0
          ? "Couldn’t access that file. Try dropping it directly from Finder."
          : "Those files are already attached.",
      );
      return;
    }
    setAttachments((current) => [...current, ...next]);
    if (dropped.length > availableSlots) {
      onPasteError(`Attached the first ${availableSlots} files (limit ${COMPOSER_MAX_ATTACHMENTS}).`);
    }
    window.requestAnimationFrame(() => ref.current?.focus());
  };

  const removeAttachment = (attachment: ComposerAttachment) => {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    window.requestAnimationFrame(() => ref.current?.focus());
  };

  /** Paste from the system clipboard at the caret (insert-menu action, I27). */
  const pasteFromMenu = () => {
    const el = ref.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    runPasteClipboard(start, end);
    el?.focus();
  };
  // Insert-menu actions (I27): surface paste + external editor beyond keyboard.
  // Kept in a ref so the open-menu keydown effect can read the latest actions
  // without re-subscribing (and resetting selection) on every render.
  const insertActions: { id: string; label: string; hint?: string; run: () => void; disabled?: boolean }[] = [
    { id: "mention", label: "Mention a file", hint: "@", run: insertAtMention },
    { id: "paste", label: "Paste from clipboard", hint: "image / text", run: pasteFromMenu },
  ];
  if (onEditInEditor) {
    insertActions.push({ id: "editor", label: "Edit in external editor", hint: "⌘G", run: onEditInEditor });
  }
  insertActionsRef.current = insertActions;


  const menuId = menuVisible
    ? atOpen
      ? "composer-mention-menu"
      : "composer-slash-menu"
    : undefined;
  const activeOptionId =
    itemCount > 0 && menuId ? `${menuId}-option-${sel}` : undefined;

  const renderedMention = slashPresentation?.kind === "mention" ? slashPresentation : null;
  const renderedPaletteView = slashPresentation?.kind === "palette" ? slashPresentation : null;
  const renderedValuePalette = renderedPaletteView?.palette.mode === "value"
    ? renderedPaletteView.palette
    : null;
  const renderedValueDescriptions = renderedValuePalette?.command.valueDescriptions;

  const slashMenu =
    slashPresence.mounted && renderedMention && slashBox
      ? createPortal(
          <div
            id="composer-mention-menu"
            className={`slash-menu slash-menu-portal popover-surface${slashPresence.closing ? " is-closing" : ""}`}
            ref={menuRef}
            role="listbox"
            aria-label="Matching project files"
            aria-hidden={slashPresence.closing || undefined}
            inert={slashPresence.closing}
            style={{
              left: slashBox.left,
              width: slashBox.width,
              bottom: window.innerHeight - slashBox.top + 10,
              maxHeight: Math.min(COMPOSER_POPOVER_MAX_PX, Math.max(160, slashBox.top - 24)),
            }}
          >
            <div className="slash-menu-header popover-header">
              <span>Attach file</span>
              <span className="slash-menu-hint">@</span>
            </div>
            <div className="slash-menu-body popover-body">
              {renderedMention.filesLoading && <div className="slash-state" role="status">Searching project files…</div>}
              {!renderedMention.filesLoading && renderedMention.filesError && (
                <div className="slash-state error" role="status">Couldn’t search files · {renderedMention.filesError}</div>
              )}
              {!renderedMention.filesLoading && !renderedMention.filesError && renderedMention.files.length === 0 && (
                <div className="slash-state" role="status">No matching project files.</div>
              )}
              {renderedMention.files.map((path, i) => {
                const { base, dir } = fileParts(path);
                const q = renderedMention.mentionQuery ?? "";
                return (
                  <button
                    type="button"
                    id={`composer-mention-menu-option-${i}`}
                    key={path}
                    className={`slash-item${i === sel ? " selected" : ""}`}
                    role="option"
                    aria-selected={i === sel}
                    onMouseDown={(ev) => {
                      ev.preventDefault();
                      setDraft(applyAtMention(draft, path));
                    }}
                  >
                    <span className="slash-item-copy">
                      <span className="name">
                        @
                        <HighlightedBase base={base} query={q} />
                      </span>
                      {dir ? <span className="desc">{dir}</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="slash-menu-footer popover-footer">
              <MenuKeyHints action="select" />
            </div>
          </div>,
          document.body,
        )
      : slashPresence.mounted && renderedPaletteView && slashBox
        ? createPortal(
            <div
              id="composer-slash-menu"
              className={`slash-menu slash-menu-portal slash-menu-${renderedPaletteView.palette.mode === "command" ? "command" : "values"} popover-surface${slashPresence.closing ? " is-closing" : ""}`}
              ref={menuRef}
              role="listbox"
              aria-label={renderedPaletteView.palette.mode === "command"
                ? "Slash commands"
                : `Options for /${renderedPaletteView.palette.command.name}`}
              aria-hidden={slashPresence.closing || undefined}
              inert={slashPresence.closing}
              style={{
                left: slashBox.left,
                width: slashBox.width,
                bottom: window.innerHeight - slashBox.top + 10,
                maxHeight: Math.min(COMPOSER_POPOVER_MAX_PX, Math.max(160, slashBox.top - 24)),
              }}
            >
              <div className="slash-menu-header popover-header">
                {renderedPaletteView.palette.mode === "command" ? (
                  <div className="slash-menu-tabs" role="tablist" aria-label="Slash command groups">
                    {PALETTE_GROUPS.map((group) => (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={renderedPaletteView.paletteGroup === group}
                        className={renderedPaletteView.paletteGroup === group ? "active" : ""}
                        key={group}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          setPaletteGroup(group);
                          setSel(0);
                        }}
                      >
                        {PALETTE_GROUP_META[group].label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="slash-submenu-title">
                    <button
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        setDraft("/");
                        setSel(0);
                      }}
                    >
                      {PALETTE_GROUP_META[paletteGroup].label}
                    </button>
                    <span aria-hidden>/</span>
                    <span>{renderedPaletteView.palette.command.name}</span>
                  </div>
                )}
                <span className="slash-menu-hint">{renderedPaletteView.palette.mode === "value" ? "Esc to go back" : "Tab / ⇧Tab"}</span>
              </div>
              <div className="slash-menu-body popover-body">
                {renderedPaletteView.palette.mode === "command" && renderedPaletteView.palette.items.length === 0 ? (
                  <div className="slash-state" role="status">
                    No matches in {PALETTE_GROUP_META[renderedPaletteView.paletteGroup].label}. Try another tab or search.
                  </div>
                ) : null}
                {renderedPaletteView.palette.mode === "command" &&
                  renderedPaletteView.palette.items.map((item, i) => (
                    <button
                      type="button"
                      id={`composer-slash-menu-option-${i}`}
                      key={item.name}
                      className={`slash-item${i === sel ? " selected" : ""}`}
                      role="option"
                      aria-selected={i === sel}
                      onMouseEnter={() => setSel(i)}
                      onMouseDown={(ev) => {
                        ev.preventDefault();
                        const applied = applyPalette(renderedPaletteView.palette, i);
                        if (!applied) return;
                        if (applied.done) {
                          void submitAndClear(applied.draft);
                        } else setDraft(applied.draft);
                      }}
                    >
                      <span className="slash-item-copy">
                        <span className="name">/{item.name}</span>
                        <span className="desc">{item.description}</span>
                      </span>
                    </button>
                  ))}
                {renderedValuePalette?.items.map((value, i) => (
                    <button
                      type="button"
                      id={`composer-slash-menu-option-${i}`}
                      key={value}
                      className={`slash-item${i === sel ? " selected" : ""}${
                        renderedPaletteView.currentValue === value ? " current" : ""
                      }`}
                      role="option"
                      aria-selected={i === sel}
                      aria-current={renderedPaletteView.currentValue === value ? "true" : undefined}
                      onMouseEnter={() => setSel(i)}
                      onMouseDown={(ev) => {
                        ev.preventDefault();
                        const applied = applyPalette(renderedPaletteView.palette, i);
                        if (!applied) return;
                        void submitAndClear(applied.draft);
                      }}
                    >
                      <span className="slash-item-copy">
                        <span className="name">{value}</span>
                        {renderedValueDescriptions?.[value] ? (
                          <span className="desc">{renderedValueDescriptions[value]}</span>
                        ) : null}
                      </span>
                      {renderedPaletteView.currentValue === value ? <span className="slash-badge">Current</span> : null}
                    </button>
                  ))}
              </div>
              <div className="slash-menu-footer popover-footer">
                <MenuKeyHints
                  action={renderedPaletteView.palette.mode === "command" ? "run" : "select"}
                  tabAction={renderedPaletteView.palette.mode === "command" ? "groups" : undefined}
                  escapeAction={renderedPaletteView.palette.mode === "command" ? "close" : "back"}
                />
              </div>
            </div>,
            document.body,
          )
        : null;

  const modeMenu =
    modePresence.mounted && modeBox
      ? (() => {
          const width = Math.min(400, window.innerWidth - 24);
          const left = Math.max(12, Math.min(modeBox.left, window.innerWidth - width - 12));
          return createPortal(
            <div
              className={`mode-menu mode-menu-portal popover-surface${modePresence.closing ? " is-closing" : ""}`}
              ref={modeMenuRef}
              role="listbox"
              aria-label="Mode"
              aria-hidden={modePresence.closing || undefined}
              inert={modePresence.closing}
              id="composer-mode-menu"
              style={{
                left,
                bottom: window.innerHeight - modeBox.top + 8,
                width,
              }}
            >
              <div className="mode-menu-header">
                <span>How should Vibe work?</span>
                <span className="mode-menu-shortcut"><kbd>⇧</kbd><kbd>Tab</kbd> to cycle</span>
              </div>
              {MODE_OPTIONS.map((mode, i) => {
                const active = uiMode === mode;
                const highlighted = i === modeSel;
                const label = displayModeLabel(mode);
                return (
                  <button
                    key={mode}
                    type="button"
                    id={`composer-mode-menu-option-${i}`}
                    role="option"
                    aria-selected={active}
                    className={`mode-option${highlighted ? " selected" : ""}${active ? " is-active" : ""}`}
                    onMouseEnter={() => setModeSel(i)}
                    onClick={() => {
                      onSelectMode(mode);
                      setModeOpen(false);
                    }}
                  >
                    <span className={`mode-option-icon is-${mode}`} aria-hidden="true">
                      <ModeIcon mode={mode} size={16} />
                    </span>
                    <span className="mode-option-copy">
                      <span className="mode-option-label">{label}</span>
                      <span className="mode-option-hint">{MODE_HINT[mode]}</span>
                    </span>
                    {active ? (
                      <span className="mode-option-check" aria-hidden="true">
                        <IconCheck size={15} strokeWidth={2} />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          );
        })()
      : null;

  const modeDecision = pendingModeTransition && modeBox && onResolveModeTransition
    ? createPortal(
        <div
          className="mode-decision-popover popover-surface"
          role="dialog"
          aria-modal="false"
          aria-labelledby="mode-decision-title"
          style={{
            left: Math.max(12, Math.min(modeBox.left, window.innerWidth - 372)),
            bottom: window.innerHeight - modeBox.top + 8,
            width: Math.min(360, window.innerWidth - 24),
          }}
        >
          <div className="mode-decision-copy">
            <strong id="mode-decision-title">Leave Plan mode?</strong>
            <span>A plan is ready. Choose what happens before switching to {displayModeLabel(pendingModeTransition.target)}.</span>
          </div>
          <div className="mode-decision-actions">
            <button type="button" className="button primary" disabled={!!modeTransitionRunDisabledReason} title={modeTransitionRunDisabledReason ?? undefined} onClick={() => onResolveModeTransition("run")}>Run plan</button>
            <button type="button" className="button" onClick={() => onResolveModeTransition("switch")}>Switch without running</button>
            <button type="button" className="button ghost" onClick={() => onResolveModeTransition("cancel")}>Cancel</button>
          </div>
          {modeTransitionRunDisabledReason ? <div className="mode-decision-reason">{modeTransitionRunDisabledReason}</div> : null}
        </div>,
        document.body,
      )
    : null;

  const insertMenu =
    insertPresence.mounted && insertBox
      ? createPortal(
          <div
            className={`insert-menu insert-menu-portal popover-surface${insertPresence.closing ? " is-closing" : ""}`}
            ref={insertMenuRef}
            role="listbox"
            aria-label="Insert"
            aria-hidden={insertPresence.closing || undefined}
            inert={insertPresence.closing}
            id="composer-insert-menu"
            style={{
              left: insertBox.left,
              bottom: window.innerHeight - insertBox.top + 8,
              minWidth: Math.max(220, insertBox.width),
            }}
          >
            {insertActions.map((action, i) => {
              const highlighted = i === insertSel;
              return (
                <button
                  key={action.id}
                  type="button"
                  id={`composer-insert-menu-option-${i}`}
                  role="option"
                  aria-selected={highlighted}
                  className={`insert-option${highlighted ? " selected" : ""}`}
                  disabled={action.disabled}
                  onMouseEnter={() => setInsertSel(i)}
                  onClick={() => {
                    setInsertOpen(false);
                    insertTriggerRef.current?.focus();
                    action.run();
                  }}
                >
                  <span className="insert-option-label">{action.label}</span>
                  {action.hint ? (
                    <kbd className="insert-option-hint">{action.hint}</kbd>
                  ) : null}
                </button>
              );
            })}
          </div>,
          document.body,
        )
      : null;

  const placeholder = emptyHome
    ? "Plan, build, / for commands, @ for files…"
    : planPending
      ? "Describe changes to revise the plan…"
      : busy
        ? "Add a follow-up or steer the current turn…"
        : "Ask to build, fix, explain, or review…";

  return (
    <div
      className={`composer-wrap${busy ? " is-busy" : ""}${planPending ? " is-plan" : ""}${dropTarget ? " is-drop-target" : ""}`}
      ref={wrapRef}
      role="region"
      aria-label="Message composer"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {slashMenu}
      {insertMenu}
      {attachments.length > 0 ? (
        <div className="composer-attachments" aria-label={`${attachments.length} attached file${attachments.length === 1 ? "" : "s"}`}>
          {attachments.map((attachment) => (
            <div className="composer-attachment" key={attachment.id} title={attachment.path}>
              <span className={`composer-attachment-preview${attachment.isImage ? " is-image" : ""}`}>
                {attachment.previewUrl ? (
                  <img src={attachment.previewUrl} alt="" />
                ) : (
                  <IconFile size={16} />
                )}
              </span>
              <span className="composer-attachment-copy">
                <span className="composer-attachment-name">{attachment.name}</span>
                <span className="composer-attachment-kind">{attachment.isImage ? "Image" : "File"}</span>
              </span>
              <button
                type="button"
                className="composer-attachment-remove"
                onClick={() => removeAttachment(attachment)}
                aria-label={`Remove ${attachment.name}`}
                title={`Remove ${attachment.name}`}
              >
                <IconRemove size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {dropTarget ? (
        <div className="composer-drop-overlay" role="status" aria-live="polite">
          <span className="composer-drop-icon"><IconPaperclip size={16} /></span>
          <span><strong>Release to attach</strong><small>Images, code, and documents</small></span>
        </div>
      ) : null}
      <div className="composer-row">
        <textarea
          ref={ref}
          className={`composer-input${exact ? " exact-cmd" : ""}`}
          value={draft}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={planPending ? "Plan revision feedback" : "Task message"}
          aria-autocomplete="list"
          aria-expanded={menuId != null}
          aria-controls={menuId}
          aria-activedescendant={activeOptionId}
          maxLength={COMPOSER_DRAFT_MAX_CHARS}
          rows={1}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
      </div>
      <div className="composer-status">
        <div className="composer-status-actions">
          <button
            type="button"
            ref={insertTriggerRef}
            className={`composer-ghost${insertOpen ? " is-open" : ""}`}
            onClick={() => setInsertOpen((open) => !open)}
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={insertOpen}
            aria-controls={insertOpen ? "composer-insert-menu" : undefined}
            aria-label="Insert: mention a file, paste clipboard, or edit in external editor"
            title="Insert — mention a file, paste clipboard, or edit in external editor"
          >
            <IconPaperclip size={12} />
          </button>
          <div className={`mode-dropdown${modeOpen ? " is-open" : ""}`}>
            <button
              type="button"
              ref={modeTriggerRef}
              className="mode-trigger composer-chip"
              aria-haspopup="listbox"
              aria-expanded={modeOpen}
              aria-controls={modeOpen ? "composer-mode-menu" : undefined}
              aria-activedescendant={
                modeOpen ? `composer-mode-menu-option-${modeSel}` : undefined
              }
              aria-label={`Mode: ${displayModeLabel(uiMode)}. Shift+Tab to cycle.`}
              title={`${displayModeLabel(uiMode)} mode · Shift+Tab to cycle`}
              data-mode={uiMode}
              onClick={() => setModeOpen((open) => !open)}
            >
              <span className="mode-trigger-icon" aria-hidden="true">
                <ModeIcon mode={uiMode} size={13} />
              </span>
              <span>{displayModeLabel(uiMode)}</span>
              <IconChevron open={modeOpen} size={12} />
            </button>
            {modeMenu}
            {modeDecision}
          </div>
          {onExecutionTargetChange ? (
            <div
              className="execution-target-toggle"
              role="radiogroup"
              aria-label={`Execution location${executionStatus ? `: ${executionStatus}` : ""}`}
            >
              {(["local", "cloud"] as const).map((target) => {
                const active = executionTarget === target;
                const label = target === "local" ? "Local" : "Cloud";
                return (
                  <button
                    key={target}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`execution-target-option${active ? " is-active" : ""}`}
                    disabled={disabled}
                    title={active ? `${executionStatus ?? label} is active` : `Move this session to ${label}`}
                    onClick={() => {
                      if (!active) onExecutionTargetChange(target);
                    }}
                  >
                    <span className="execution-target-dot" aria-hidden />
                    {label}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <div className="composer-status-trailing">
          <div
            className={`composer-metrics-slot${metrics.length ? " has-content" : ""}`}
            aria-hidden={metrics.length === 0 ? true : undefined}
          >
            {metrics.map((metric) => (
              <span
                key={metric.key}
                className="composer-chip composer-metric"
                title={metric.title ?? metric.label}
              >
                {metric.label}
              </span>
            ))}
          </div>
          {onCycleDensity ? (
            <button
              type="button"
              className="composer-chip composer-density"
              onClick={onCycleDensity}
              title={`${isTranscriptDensity(density) ? densityLabel(density) : density} · ⌘D`}
              aria-label={`Density ${density}. ${isTranscriptDensity(density) ? densityLabel(density) : ""}. Press to cycle.`}
            >
              {density}
            </button>
          ) : null}
          {typeof ctxPct === "number" && ctxPct > 0 && (
            <button
              type="button"
              className={`composer-chip ctx-ring${ctxPct >= 95 ? " hot" : ctxPct >= 80 ? " warn" : ""}`}
              style={{ "--ctx-fill": ctxPct } as CSSProperties}
              onClick={onOpenInspector}
              disabled={!onOpenInspector}
              aria-label={`Context window ${ctxPct} percent full. Open session panel.`}
              title={`Context window ${ctxPct}% full${onOpenInspector ? " · open session panel" : ""}`}
            >
              <span className="ctx-ring-dial" aria-hidden />
              {ctxPct}%
            </button>
          )}
          <button
            type="button"
            className="composer-chip composer-model"
            onClick={onOpenModel}
            disabled={!onOpenModel}
            title={onOpenModel ? `${model} · change model` : model}
            aria-label={onOpenModel ? `${model}. Change model` : model}
          >
            {model.split("/").at(-1) || model}
          </button>
          <div className="composer-submit-slot">
            {busy ? (
              <button
                type="button"
                className="composer-chip composer-submit stop"
                onClick={onAbort}
                aria-label={
                  busyElapsed ? `Stop current turn · ${busyElapsed}` : "Stop current turn"
                }
                title={
                  busyElapsed
                    ? `Working ${busyElapsed} · Esc to interrupt`
                    : "Esc to interrupt"
                }
              >
                <IconStop />
                <span className="stop-label">Stop</span>
                <span className="stop-elapsed">{busyElapsed ?? "0.0s"}</span>
              </button>
            ) : (
              <button
                type="button"
                className="composer-submit"
                onClick={submitDraft}
                disabled={!draft.trim() && attachments.length === 0}
                aria-label="Send message"
              >
                <IconSend />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
