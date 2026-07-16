import { useEffect, useMemo, useRef, useState } from "react";
import { belowBreakpoint } from "../../shared/breakpoints";
import {
  fileBasename,
  sortChangedFilesForDisplay,
} from "../../shared/changed-files";
import { contextUsagePercent } from "../../shared/context-usage";
import { formatDiffStats } from "../../shared/diff-view";
import type { ChangedFile } from "../../shared/reducer";
import { CopyButton } from "../CopyButton";
import type { SessionChrome } from "../hooks/useSession";
import { IconFolderOpen } from "../icons";
import { ActivityPanelHeader } from "../layout/ActivityPanelHeader";
import {
  formatGitLine,
  formatGoalLine,
  MetaRow,
  OrchestrationSection,
  projectName,
  SubagentsSection,
  TasksSection,
  ThinkingTrail,
} from "./activity-shared";
import { DiffPreview } from "./DiffPreview";

type ReviewMode = "diff" | "file";

export function Inspector({
  chrome,
  changedFiles,
  cwd,
  focusPath = null,
  focusSection = null,
  onClose,
  onUndo,
  onRedo,
  onRevealFile,
}: {
  chrome: SessionChrome;
  changedFiles: ChangedFile[];
  cwd: string | null;
  /** When set (e.g. from turn card / dock), jump straight into file review. */
  focusPath?: string | null;
  /** When set by a live activity pill, reveal that session section immediately. */
  focusSection?: "subagents" | null;
  onClose: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onRevealFile: (path: string) => void;
}) {
  const [previewPath, setPreviewPath] = useState<string | null>(focusPath);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [confirmCp, setConfirmCp] = useState<"undo" | "redo" | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [reviewMode, setReviewMode] = useState<ReviewMode>("diff");

  const ctxPct = contextUsagePercent(chrome.ctxUsed, chrome.ctxWindow);
  const ctxLine =
    chrome.ctxWindow > 0
      ? `${chrome.ctxUsed.toLocaleString()} / ${chrome.ctxWindow.toLocaleString()} · ${ctxPct}%`
      : "No usage yet";
  const gitLine = formatGitLine(chrome.git, { showClean: true });
  const goalLine = formatGoalLine(chrome.goal, chrome.goalRun);
  const latestCpLabel = chrome.checkpoints.length > 0
    ? chrome.checkpoints[chrome.checkpoints.length - 1]!.label
    : null;
  const rootRef = useRef<HTMLElement>(null);
  const focusedSectionRef = useRef<"subagents" | null>(null);

  // Focus trap only when the inspector is a modal drawer (≤ compact) — when
  // docked it behaves as a side panel and should not capture Tab (I49).
  const [isDrawer, setIsDrawer] = useState(() => belowBreakpoint("compact"));
  useEffect(() => {
    const onResize = () => setIsDrawer(belowBreakpoint("compact"));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !isDrawer) return;
    const trigger = document.activeElement as HTMLElement | null;
    const close = root.querySelector<HTMLButtonElement>(".sidebar-close");
    close?.focus();

    const focusable = (): HTMLElement[] =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), summary, [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => {
        const style = window.getComputedStyle(el);
        const closedDetails = el.closest("details:not([open])");
        const visibleClosedSummary = closedDetails?.querySelector(":scope > summary") === el;
        return style.visibility !== "hidden"
          && style.display !== "none"
          && (!closedDetails || visibleClosedSummary)
          && el.getClientRects().length > 0;
      });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const targets = focusable();
      if (targets.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const index = active ? targets.indexOf(active) : -1;
      if (index < 0) return;
      if (event.shiftKey && index === 0) {
        event.preventDefault();
        targets.at(-1)?.focus();
      } else if (!event.shiftKey && index === targets.length - 1) {
        event.preventDefault();
        targets[0]?.focus();
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Node | null;
      if (!target || root.contains(target)) return;
      const targets = focusable();
      (targets[0] ?? root).focus();
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
      trigger?.focus();
    };
  }, [isDrawer]);

  useEffect(() => {
    if (!previewPath || !cwd || reviewMode !== "file") {
      setPreviewText(null);
      setPreviewError(null);
      setPreviewTruncated(false);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    void window.vibe
      .readTextFile({ cwd, path: previewPath })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setPreviewText(null);
          setPreviewError(res.error);
          setPreviewTruncated(false);
          return;
        }
        setPreviewText(res.text);
        setPreviewError(null);
        setPreviewTruncated(res.truncated);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPreviewText(null);
        setPreviewError(error instanceof Error ? error.message : String(error));
        setPreviewTruncated(false);
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [previewPath, cwd, reviewMode]);

  // External focus (turn card / workspace dock) opens that file's review.
  useEffect(() => {
    if (!focusPath) return;
    if (changedFiles.some((f) => f.path === focusPath)) {
      setPreviewPath(focusPath);
      setReviewMode("diff");
    }
  }, [focusPath, changedFiles]);

  useEffect(() => {
    if (focusSection !== "subagents") {
      focusedSectionRef.current = null;
      return;
    }
    if (focusedSectionRef.current === "subagents" || chrome.subagents.length === 0) return;
    focusedSectionRef.current = "subagents";
    const frame = window.requestAnimationFrame(() => {
      const section = rootRef.current?.querySelector<HTMLElement>(
        '[data-inspector-section="subagents"]',
      );
      section?.scrollIntoView({ block: "start" });
      section?.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusSection, chrome.subagents.length]);

  // Clear stale preview when the file leaves the changed set.
  useEffect(() => {
    if (previewPath && !changedFiles.some((f) => f.path === previewPath)) {
      setPreviewPath(null);
    }
  }, [changedFiles, previewPath]);

  const idle =
    changedFiles.length === 0 &&
    chrome.checkpoints.length === 0 &&
    chrome.orchestration.length === 0 &&
    chrome.subagents.length === 0 &&
    chrome.tasksUnfinishedTotal === 0 &&
    chrome.thoughtLog.length === 0;
  const orderedFiles = useMemo(
    () => sortChangedFilesForDisplay(changedFiles),
    [changedFiles],
  );
  const selectedFile = previewPath
    ? changedFiles.find((file) => file.path === previewPath)
    : undefined;
  const selectedIndex = previewPath
    ? orderedFiles.findIndex((f) => f.path === previewPath)
    : -1;
  const prevFile = selectedIndex > 0 ? orderedFiles[selectedIndex - 1] : null;
  const nextFile =
    selectedIndex >= 0 && selectedIndex < orderedFiles.length - 1
      ? orderedFiles[selectedIndex + 1]
      : null;

  let title = "Session";
  let subtitle = "Model, context, and changes";
  if (previewPath) {
    title = fileBasename(previewPath);
    const stats = selectedFile
      ? formatDiffStats(selectedFile.added, selectedFile.removed)
      : "";
    subtitle =
      reviewMode === "diff"
        ? `Diff${stats ? ` · ${stats}` : ""}`
        : `File${stats ? ` · ${stats}` : ""}`;
  }

  return (
    <section
      id="session-panel"
      className="activity-rail inspector-rail"
      aria-label="Session details"
      aria-labelledby="inspector-title"
      ref={rootRef}
    >
      <ActivityPanelHeader
        titleId="inspector-title"
        title={title}
        subtitle={subtitle}
        onClose={onClose}
        closeLabel="Close session panel"
      />

      <div className="inspector-scroll">
        {!previewPath && (
          <div className="sidebar-section">
            <h4>Overview</h4>
            <div className="meta-block">
              <MetaRow label="Project" value={projectName(chrome.cwd)} />
              <MetaRow label="Model" value={chrome.model || "—"} />
              <MetaRow label="Mode" value={chrome.mode} />
              <MetaRow label="Approvals" value={chrome.approvals} />
              <MetaRow label="Context" value={ctxLine} hot={ctxPct != null && ctxPct >= 80} />
              <MetaRow label="Cost" value={`$${chrome.usage.costUSD.toFixed(4)}`} />
              {gitLine && <MetaRow label="Git" value={gitLine} />}
              {chrome.reasoning && <MetaRow label="Reasoning" value={chrome.reasoning} />}
              {chrome.lastGate && <MetaRow label="Gate" value={chrome.lastGate} />}
              {goalLine && <MetaRow label="Goal" value={goalLine} />}
            </div>
            {chrome.cwd ? (
              <p className="inspector-path" title={chrome.cwd}>
                {chrome.cwd}
              </p>
            ) : null}
          </div>
        )}

        {!previewPath && <TasksSection tasks={chrome.tasks} />}

        {previewPath ? (
          <div className="sidebar-section">
            <div className="file-preview-toolbar">
              <div className="file-preview-toolbar-primary">
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    setPreviewPath(null);
                    setReviewMode("diff");
                  }}
                >
                  Back
                </button>
                <div className="review-mode-toggle" role="tablist" aria-label="Review mode">
                  <button
                    type="button"
                    className={`review-mode-button${reviewMode === "diff" ? " is-active" : ""}`}
                    role="tab"
                    aria-selected={reviewMode === "diff"}
                    onClick={() => setReviewMode("diff")}
                  >
                    Diff
                  </button>
                  <button
                    type="button"
                    className={`review-mode-button${reviewMode === "file" ? " is-active" : ""}`}
                    role="tab"
                    aria-selected={reviewMode === "file"}
                    onClick={() => setReviewMode("file")}
                  >
                    File
                  </button>
                </div>
              </div>
              <div className="file-preview-toolbar-actions">
                <div className="file-preview-nav" role="group" aria-label="Files in this turn">
                  <button
                    type="button"
                    className="button"
                    disabled={!prevFile}
                    onClick={() => prevFile && setPreviewPath(prevFile.path)}
                    title={prevFile ? `Previous · ${prevFile.path}` : "No previous file"}
                    aria-label="Previous changed file"
                  >
                    ←
                  </button>
                  <span className="file-preview-index" aria-live="polite">
                    {selectedIndex >= 0
                      ? `${selectedIndex + 1} / ${orderedFiles.length}`
                      : "—"}
                  </span>
                  <button
                    type="button"
                    className="button"
                    disabled={!nextFile}
                    onClick={() => nextFile && setPreviewPath(nextFile.path)}
                    title={nextFile ? `Next · ${nextFile.path}` : "No next file"}
                    aria-label="Next changed file"
                  >
                    →
                  </button>
                </div>
                <button
                  type="button"
                  className="button"
                  onClick={() => onRevealFile(previewPath)}
                  title="Reveal in Finder"
                >
                  <IconFolderOpen size={13} />
                  Reveal
                </button>
                {reviewMode === "diff" && selectedFile?.diff ? (
                  <CopyButton text={selectedFile.diff} label="Copy diff" />
                ) : null}
              </div>
            </div>
            <p className="inspector-path" title={previewPath}>
              {previewPath}
            </p>
            {reviewMode === "diff" ? (
              <DiffPreview
                path={previewPath}
                diff={selectedFile?.diff}
                added={selectedFile?.added ?? 0}
                removed={selectedFile?.removed ?? 0}
              />
            ) : previewLoading ? (
              <p className="inspector-empty">
                <span className="spinner" aria-hidden /> Loading preview…
              </p>
            ) : previewError ? (
              <p className="inspector-empty is-error" role="alert">
                Couldn’t load preview · {previewError}
              </p>
            ) : (
              <pre
                className="activity-stream inspector-stream file-preview"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-scrollable preview
                tabIndex={0}
                aria-label={`Preview of ${previewPath}`}
              >
                {previewText || "This file is empty."}
              </pre>
            )}
            {previewTruncated ? (
              <p className="inspector-hint">Preview truncated to the first 64 KB.</p>
            ) : null}
          </div>
        ) : (
          <div className="sidebar-section">
            <div className="sidebar-section-title-row">
              <h4>Changed files</h4>
              {orderedFiles.length > 0 && (
                <button
                  type="button"
                  className="sidebar-section-action"
                  onClick={() => {
                    setReviewMode("diff");
                    // Highest-churn file first (matches turn card ordering).
                    setPreviewPath(orderedFiles[0]!.path);
                  }}
                >
                  Review
                </button>
              )}
            </div>
            {orderedFiles.length > 0 ? (
              orderedFiles.map((f) => (
                <div key={f.path} className="file-row-actions">
                  <button
                    type="button"
                    className="activity-button file-row"
                    onClick={() => {
                      setReviewMode("diff");
                      setPreviewPath(f.path);
                    }}
                    aria-label={`Review ${f.path}, ${formatDiffStats(f.added, f.removed)}`}
                    title={`Review ${f.path}`}
                  >
                    <span className="file-path" title={f.path}>
                      {f.path}
                    </span>
                    <span className="file-diff" aria-hidden>
                      <span className="diff-add-count">+{f.added}</span>
                      <span className="diff-del-count">−{f.removed}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="file-reveal"
                    onClick={() => onRevealFile(f.path)}
                    aria-label={`Reveal ${f.path} in Finder`}
                    title="Reveal in Finder"
                  >
                    <IconFolderOpen size={13} />
                  </button>
                </div>
              ))
            ) : (
              <p className="inspector-empty">No file edits yet this session.</p>
            )}
          </div>
        )}

        {!previewPath && chrome.checkpoints.length > 0 ? (
          <div className="sidebar-section">
            <h4>Checkpoints</h4>
            {chrome.checkpoints
              .slice()
              .reverse()
              .map((c) => (
                <div key={c.id} className="sidebar-line">
                  {c.label}
                </div>
              ))}
            <div className="card-actions compact">
              {confirmCp ? (
                <span className="cp-confirm" role="status">
                  <span className="cp-confirm-msg">
                    {confirmCp === "undo"
                      ? `Undo to “${latestCpLabel ?? "last checkpoint"}”?`
                      : "Redo the undone checkpoint?"}
                  </span>
                  <button
                    type="button"
                    className="button"
                    // biome-ignore lint/a11y/noAutofocus: focus the safe choice
                    autoFocus
                    onClick={() => setConfirmCp(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      const mode = confirmCp;
                      setConfirmCp(null);
                      if (mode === "undo") onUndo();
                      else onRedo();
                    }}
                  >
                    {confirmCp === "undo" ? "Undo" : "Redo"}
                  </button>
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    className="button"
                    onClick={() => setConfirmCp("undo")}
                    aria-label={`Undo last checkpoint${latestCpLabel ? ` · ${latestCpLabel}` : ""}`}
                    title={`Undo to ${latestCpLabel ?? "last checkpoint"}`}
                  >
                    Undo
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => setConfirmCp("redo")}
                    aria-label="Redo checkpoint"
                  >
                    Redo
                  </button>
                </>
              )}
            </div>
          </div>
        ) : null}

        {!previewPath && <OrchestrationSection orchestration={chrome.orchestration} />}

        {!previewPath && (
          <SubagentsSection
            subagents={chrome.subagents}
          />
        )}

        {!previewPath && (
          <ThinkingTrail lines={chrome.thoughtLog} live={chrome.busy} />
        )}

        {idle && (
          <p className="inspector-hint">
            File diffs, tasks, and checkpoints appear here as the turn progresses.
          </p>
        )}
      </div>
    </section>
  );
}
