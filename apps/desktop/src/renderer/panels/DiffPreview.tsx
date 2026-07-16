import { useMemo } from "react";
import { fileBasename } from "../../shared/changed-files";
import { formatDiffStats, parseUnifiedDiff } from "../../shared/diff-view";

export function DiffPreview({
  path,
  diff,
  added,
  removed,
  hideFileHeaders = false,
  fill = false,
}: {
  path: string;
  diff?: string;
  added: number;
  removed: number;
  hideFileHeaders?: boolean;
  fill?: boolean;
}) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const hunkCount = useMemo(
    () => lines.filter((line) => line.kind === "hunk").length,
    [lines],
  );

  if (!diff || lines.length === 0) {
    return (
      <div className="inspector-empty-block diff-preview-empty" role="status">
        <p className="inspector-empty">No unified diff text for this change.</p>
        <p className="inspector-hint">
          {fileBasename(path)} · {formatDiffStats(added, removed)}
          {added === 0 && removed === 0
            ? " · metadata-only update"
            : " · open File mode to read the current contents"}
        </p>
      </div>
    );
  }

  return (
    <div
      className={`activity-stream inspector-stream diff-preview${fill ? " is-fill" : ""}`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-scrollable preview
      tabIndex={0}
      role="region"
      aria-label={`Diff for ${path}, ${formatDiffStats(added, removed)}`}
    >
      <div className="diff-preview-meta" aria-hidden>
        <span>{fileBasename(path)}</span>
        <span className="diff-preview-meta-detail">
          {hunkCount > 0 ? `${hunkCount} ${hunkCount === 1 ? "hunk" : "hunks"}` : null}
          <span className="file-diff">
            <span className="diff-add-count">+{added}</span>
            <span className="diff-del-count">−{removed}</span>
          </span>
        </span>
      </div>
      {lines.map((line, index) => {
        if (hideFileHeaders && line.kind === "header") return null;
        const isBody = line.kind === "add" || line.kind === "del" || line.kind === "ctx";
        if (!isBody) {
          return (
            <div
              className={`diff-line is-${line.kind}`}
              key={`${index}:${line.kind}:${line.text.slice(0, 48)}`}
            >
              <code>{line.text || " "}</code>
            </div>
          );
        }
        const gutterOld = line.oldNo != null ? String(line.oldNo) : "";
        const gutterNew = line.newNo != null ? String(line.newNo) : "";
        const marker = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
        const body =
          line.text.startsWith("+") || line.text.startsWith("-") || line.text.startsWith(" ")
            ? line.text.slice(1)
            : line.text;
        return (
          <div
            className={`diff-line is-${line.kind}`}
            key={`${index}:${line.kind}:${line.text.slice(0, 48)}`}
          >
            <span className="diff-gutter diff-gutter-old" aria-hidden>{gutterOld}</span>
            <span className="diff-gutter diff-gutter-new" aria-hidden>{gutterNew}</span>
            <span className="diff-marker" aria-hidden>{marker}</span>
            <code>{body.length ? body : " "}</code>
          </div>
        );
      })}
    </div>
  );
}
