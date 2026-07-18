import { type CSSProperties, useEffect, useMemo, useState } from "react";
import {
  buildChangedFileTree,
  changedFilesTotals,
  changedFileTypeLabel,
  fileBasename,
  fileParentDir,
  resolveChangedFileSelection,
  sortChangedFilesForDisplay,
  type ChangedFileTreeNode,
} from "../../shared/changed-files";
import { isUnifiedDiff } from "../../shared/diff-view";
import type { ChangedFile } from "../../shared/reducer";
import { CopyButton } from "../CopyButton";
import {
  IconArrowRight,
  IconChevron,
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconSearch,
} from "../icons";
import { ActivityPanelHeader } from "../layout/ActivityPanelHeader";
import { DiffPreview } from "./DiffPreview";

type ReviewMode = "diff" | "file";

function directoryPaths(nodes: ChangedFileTreeNode<ChangedFile>[]): string[] {
  return nodes.flatMap((node) => node.kind === "directory"
    ? [node.path, ...directoryPaths(node.children)]
    : []);
}

function ChangedFileTree({
  nodes,
  selectedPath,
  expanded,
  forceExpanded,
  depth = 0,
  onToggle,
  onSelect,
}: {
  nodes: ChangedFileTreeNode<ChangedFile>[];
  selectedPath: string | null;
  expanded: ReadonlySet<string>;
  forceExpanded: boolean;
  depth?: number;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  return nodes.map((node) => {
    const style = { "--tree-indent": `${depth * 14}px` } as CSSProperties;
    if (node.kind === "directory") {
      const open = forceExpanded || expanded.has(node.path);
      return (
        <div className="changes-tree-directory" key={`directory:${node.path}`}>
          <button
            type="button"
            role="treeitem"
            aria-expanded={open}
            className="changes-tree-row changes-tree-folder"
            style={style}
            onClick={() => onToggle(node.path)}
            title={node.path}
          >
            <IconChevron className={open ? "is-open" : undefined} size={12} />
            {open ? <IconFolderOpen size={13} /> : <IconFolder size={13} />}
            <span className="changes-tree-name">{node.name}</span>
            <span className="changes-tree-count">{node.files}</span>
          </button>
          {open ? (
            <div role="group">
              <ChangedFileTree
                nodes={node.children}
                selectedPath={selectedPath}
                expanded={expanded}
                forceExpanded={forceExpanded}
                depth={depth + 1}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            </div>
          ) : null}
        </div>
      );
    }

    const selected = node.path === selectedPath;
    return (
      <button
        type="button"
        role="treeitem"
        aria-selected={selected}
        className={`changes-tree-row changes-file-row${selected ? " is-selected" : ""}`}
        style={style}
        key={`file:${node.path}`}
        onClick={() => onSelect(node.path)}
        title={node.path}
      >
        <span className="changes-file-type" aria-hidden>{changedFileTypeLabel(node.path)}</span>
        <span className="changes-tree-name">{node.name}</span>
        <span className="changes-file-row-stats" aria-hidden>
          {node.file.added > 0 ? <span className="diff-add-count">+{node.file.added}</span> : null}
          {node.file.removed > 0 ? <span className="diff-del-count">−{node.file.removed}</span> : null}
        </span>
      </button>
    );
  });
}

function NumberedFilePreview({ path, text }: { path: string; text: string | null }) {
  const lines = useMemo(() => (text ?? "").split("\n"), [text]);
  return (
    <div
      className="changes-file-preview"
      role="region"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-scrollable source review
      tabIndex={0}
      aria-label={`Current contents of ${path}`}
    >
      {lines.map((line, index) => (
        <div className="file-preview-line" key={`${index}:${line.slice(0, 48)}`}>
          <span className="file-preview-line-number" aria-hidden>{index + 1}</span>
          <code>{line || " "}</code>
        </div>
      ))}
    </div>
  );
}

export function ChangesView({
  files,
  cwd,
  cloudOwned,
  focusPath,
  onClose,
  onRevealFile,
}: {
  files: ChangedFile[];
  cwd: string | null;
  cloudOwned: boolean;
  focusPath?: string | null;
  onClose: () => void;
  onRevealFile: (path: string) => void;
}) {
  const orderedFiles = useMemo(() => sortChangedFilesForDisplay(files), [files]);
  const [selectedPath, setSelectedPath] = useState<string | null>(() =>
    resolveChangedFileSelection(files, focusPath),
  );
  const [reviewMode, setReviewMode] = useState<ReviewMode>("diff");
  const [query, setQuery] = useState("");
  const initialTree = useMemo(() => buildChangedFileTree(files), [files]);
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(
    () => new Set(directoryPaths(initialTree)),
  );
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [workingDiff, setWorkingDiff] = useState<{
    diff: string;
    added: number;
    removed: number;
  } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const totals = useMemo(() => changedFilesTotals(files), [files]);
  const tree = useMemo(
    () => buildChangedFileTree(files, query, selectedPath),
    [files, query, selectedPath],
  );
  const selectedFile = selectedPath ? files.find((file) => file.path === selectedPath) : undefined;
  const selectedIndex = selectedPath
    ? orderedFiles.findIndex((file) => file.path === selectedPath)
    : -1;
  const previousFile = selectedIndex > 0 ? orderedFiles[selectedIndex - 1] : null;
  const nextFile = selectedIndex >= 0 && selectedIndex < orderedFiles.length - 1
    ? orderedFiles[selectedIndex + 1]
    : null;
  const selectedDirectory = selectedPath ? fileParentDir(selectedPath) : "";

  useEffect(() => {
    setExpandedDirectories((current) => {
      const next = new Set(current);
      for (const path of directoryPaths(initialTree)) next.add(path);
      return next;
    });
  }, [initialTree]);

  useEffect(() => {
    if (focusPath && files.some((file) => file.path === focusPath)) {
      setSelectedPath(focusPath);
      setReviewMode("diff");
    }
  }, [files, focusPath]);

  useEffect(() => {
    const resolved = resolveChangedFileSelection(files, selectedPath);
    if (resolved !== selectedPath) setSelectedPath(resolved);
  }, [files, selectedPath]);

  useEffect(() => {
    if (!selectedPath || !cwd || reviewMode !== "file") {
      setPreviewText(null);
      setPreviewError(null);
      setPreviewTruncated(false);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    void window.vibe.readTextFile({ cwd, path: selectedPath }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setPreviewText(null);
        setPreviewError(result.error);
        setPreviewTruncated(false);
        return;
      }
      setPreviewText(result.text);
      setPreviewError(null);
      setPreviewTruncated(result.truncated);
    }).catch((error: unknown) => {
      if (!cancelled) setPreviewError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!cancelled) setPreviewLoading(false);
    });
    return () => { cancelled = true; };
  }, [cwd, reviewMode, selectedPath]);

  useEffect(() => {
    if (!selectedPath || !cwd) {
      setWorkingDiff(null);
      setDiffError(null);
      return;
    }
    // The engine-authored changed-file event is authoritative in Cloud. The
    // local checkout may have diverged since handoff and must never overwrite
    // that remote diff with a fresh local Git query.
    if (cloudOwned) {
      setWorkingDiff(null);
      setDiffError(null);
      setDiffLoading(false);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    setWorkingDiff(null);
    void window.vibe.gitFileDiff({ cwd, path: selectedPath }).then((result) => {
      if (cancelled) return;
      if (!result.ok) setDiffError(result.error);
      else if (result.available) setWorkingDiff({ diff: result.diff, added: result.added, removed: result.removed });
    }).catch((error: unknown) => {
      if (!cancelled) setDiffError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!cancelled) setDiffLoading(false);
    });
    return () => { cancelled = true; };
  }, [cloudOwned, cwd, selectedFile?.added, selectedFile?.diff, selectedFile?.removed, selectedPath]);

  const selectedDiff = workingDiff?.diff
    ?? (isUnifiedDiff(selectedFile?.diff) ? selectedFile.diff : undefined);
  const selectedAdded = workingDiff?.added ?? selectedFile?.added ?? 0;
  const selectedRemoved = workingDiff?.removed ?? selectedFile?.removed ?? 0;

  const selectFile = (path: string) => {
    setSelectedPath(path);
    setReviewMode("diff");
  };

  const toggleDirectory = (path: string) => {
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <section
      id="changes-panel"
      className="activity-rail changes-rail"
      aria-label="Changed files review"
      aria-labelledby="changes-title"
    >
      <ActivityPanelHeader
        titleId="changes-title"
        title="Changes"
        subtitle={(
          <span className="changes-summary">
            <span>{totals.count === 1 ? "1 file" : `${totals.count} files`}</span>
            <span className="diff-add-count">+{totals.added}</span>
            <span className="diff-del-count">−{totals.removed}</span>
          </span>
        )}
        onClose={onClose}
        closeLabel="Close changes panel"
      />

      <div className="changes-workspace">
        <div className="changes-review-pane">
          {selectedFile ? (
            <>
              <div className="changes-file-header">
                <div className="changes-file-identity">
                  <span className="changes-file-type" aria-hidden>{changedFileTypeLabel(selectedFile.path)}</span>
                  <span className="changes-file-path" title={selectedFile.path}>
                    {selectedDirectory ? <span>{selectedDirectory}/</span> : null}
                    <strong>{fileBasename(selectedFile.path)}</strong>
                  </span>
                  <span className="file-diff" aria-label={`${selectedAdded} additions, ${selectedRemoved} deletions`}>
                    <span className="diff-add-count">+{selectedAdded}</span>
                    <span className="diff-del-count">−{selectedRemoved}</span>
                  </span>
                </div>
                <div className="changes-file-actions">
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
                  <div className="changes-file-nav" role="group" aria-label="Navigate changed files">
                    <button
                      type="button"
                      className="icon-button changes-nav-previous"
                      disabled={!previousFile}
                      onClick={() => previousFile && selectFile(previousFile.path)}
                      aria-label="Previous changed file"
                      title={previousFile ? `Previous · ${previousFile.path}` : "No previous file"}
                    >
                      <IconArrowRight size={13} />
                    </button>
                    <span>{selectedIndex + 1}/{orderedFiles.length}</span>
                    <button
                      type="button"
                      className="icon-button"
                      disabled={!nextFile}
                      onClick={() => nextFile && selectFile(nextFile.path)}
                      aria-label="Next changed file"
                      title={nextFile ? `Next · ${nextFile.path}` : "No next file"}
                    >
                      <IconArrowRight size={13} />
                    </button>
                  </div>
                  <button
                    type="button"
                    className="icon-button changes-reveal"
                    onClick={() => onRevealFile(selectedFile.path)}
                    aria-label="Reveal in Finder"
                    title="Reveal in Finder"
                  >
                    <IconFolderOpen size={13} />
                  </button>
                  {reviewMode === "diff" && selectedDiff ? <CopyButton text={selectedDiff} label="Copy diff" /> : null}
                </div>
              </div>

              <div className="changes-review-content">
                {reviewMode === "diff" && diffLoading ? (
                  <p className="changes-loading"><span className="spinner" aria-hidden /> Loading current diff…</p>
                ) : reviewMode === "diff" && diffError && !selectedDiff ? (
                  <p className="changes-loading is-error" role="alert">Couldn’t load diff · {diffError}</p>
                ) : reviewMode === "diff" ? (
                  <DiffPreview
                    path={selectedFile.path}
                    diff={selectedDiff}
                    added={selectedAdded}
                    removed={selectedRemoved}
                    hideFileHeaders
                    fill
                  />
                ) : previewLoading ? (
                  <p className="changes-loading"><span className="spinner" aria-hidden /> Loading file…</p>
                ) : previewError ? (
                  <p className="changes-loading is-error" role="alert">Couldn’t load file · {previewError}</p>
                ) : (
                  <NumberedFilePreview path={selectedFile.path} text={previewText} />
                )}
                {reviewMode === "file" && previewTruncated ? (
                  <p className="changes-truncated">Showing the first 64 KB.</p>
                ) : null}
              </div>
            </>
          ) : (
            <div className="changes-empty">
              <IconFile size={20} />
              <strong>No changed files</strong>
              <span>Files edited during this session will appear here.</span>
            </div>
          )}
        </div>

        <aside className="changes-file-browser" aria-label="Changed files">
          <div className="changes-browser-heading">
            <label className="changes-search">
              <IconSearch size={13} />
              <span className="sr-only">Filter changed files</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter files…"
              />
            </label>
            <span className="changes-browser-count">{files.length}</span>
          </div>
          <div className="changes-file-groups" role="tree" aria-label="Changed file tree">
            {tree.length > 0 ? (
              <ChangedFileTree
                nodes={tree}
                selectedPath={selectedPath}
                expanded={expandedDirectories}
                forceExpanded={query.trim().length > 0}
                onToggle={toggleDirectory}
                onSelect={selectFile}
              />
            ) : (
              <p className="changes-filter-empty">No files match “{query}”.</p>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
