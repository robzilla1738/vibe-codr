/**
 * Post-turn file review card — lists session changed files with +/− stats
 * and opens the Session panel for full Diff/File review (Cursor-like summary).
 */

import { useMemo, useState } from "react";
import {
  changedFilesTotals,
  changedFilesHeading,
  fileBasename,
  fileParentDir,
  sortChangedFilesForDisplay,
} from "../../shared/changed-files";
import type { ChangedFile } from "../../shared/reducer";
import { IconChevron, IconDiff, IconFile } from "../icons";

const PREVIEW_LIMIT = 6;

/** Small post-turn entry point above the composer. The inspector owns the
 * detailed file list and diff preview; this pill only summarizes the work. */
export function ChangedFilesPill({
  files,
  onReview,
}: {
  files: ChangedFile[];
  onReview: () => void;
}) {
  if (files.length === 0) return null;
  const totals = changedFilesTotals(files);
  const noun = totals.count === 1 ? "file" : "files";
  return (
    <button
      type="button"
      className="changed-files-pill"
      onClick={onReview}
      title="Review changed files and diffs"
      aria-label={`Review ${totals.count} changed ${noun}: plus ${totals.added}, minus ${totals.removed}`}
    >
      <span className="changed-files-pill-icon" aria-hidden>
        <IconDiff size={13} />
      </span>
      <span className="changed-files-pill-label">{totals.count} {noun} changed</span>
      <span className="changed-files-pill-stats" aria-hidden>
        <span className="diff-add-count">+{totals.added}</span>
        <span className="diff-del-count">−{totals.removed}</span>
      </span>
      <IconChevron size={13} />
    </button>
  );
}

export function TurnChangesCard({
  files,
  onReview,
  onOpenFile,
}: {
  files: ChangedFile[];
  /** Open session panel on the changes list (optional path focus). */
  onReview: (path?: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const sorted = useMemo(() => sortChangedFilesForDisplay(files), [files]);
  const visible = expanded ? sorted : sorted.slice(0, PREVIEW_LIMIT);
  const hidden = Math.max(0, sorted.length - PREVIEW_LIMIT);
  const heading = changedFilesHeading(files);

  if (files.length === 0) return null;

  return (
    <section className="turn-changes-card" aria-label={heading}>
      <header className="turn-changes-head">
        <div className="turn-changes-title-block">
          <h3 className="turn-changes-title">{heading}</h3>
          <p className="turn-changes-sub">Click a file to review the diff</p>
        </div>
        <button
          type="button"
          className="button turn-changes-review"
          onClick={() => onReview()}
        >
          Review
        </button>
      </header>

      <ul className="turn-changes-list">
        {visible.map((file) => {
          const parent = fileParentDir(file.path);
          return (
            <li key={file.path}>
              <button
                type="button"
                className="turn-changes-row"
                onClick={() => onOpenFile(file.path)}
                title={file.path}
              >
                <span className="turn-changes-icon" aria-hidden>
                  <IconFile size={14} />
                </span>
                <span className="turn-changes-names">
                  <span className="turn-changes-name">{fileBasename(file.path)}</span>
                  {parent ? (
                    <span className="turn-changes-dir">{parent}</span>
                  ) : null}
                </span>
                <span className="turn-changes-stats" aria-label={`+${file.added} −${file.removed}`}>
                  <span className="diff-add-count">+{file.added}</span>
                  <span className="diff-del-count">−{file.removed}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {hidden > 0 && !expanded ? (
        <button
          type="button"
          className="turn-changes-more"
          onClick={() => setExpanded(true)}
        >
          Show {hidden} more
        </button>
      ) : null}
      {expanded && sorted.length > PREVIEW_LIMIT ? (
        <button
          type="button"
          className="turn-changes-more"
          onClick={() => setExpanded(false)}
        >
          Show less
        </button>
      ) : null}
    </section>
  );
}
