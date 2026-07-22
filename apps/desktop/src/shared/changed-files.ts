/**
 * Display helpers for session changed-file review (turn card + inspector).
 */

export interface ChangedFileLike {
  path: string;
  added: number;
  removed: number;
  countsKnown?: boolean;
  diff?: string;
}

export interface ChangedFileTreeDirectory<T extends ChangedFileLike> {
  kind: "directory";
  name: string;
  path: string;
  files: number;
  added: number;
  removed: number;
  unknownCount: number;
  children: ChangedFileTreeNode<T>[];
}

export interface ChangedFileTreeFile<T extends ChangedFileLike> {
  kind: "file";
  name: string;
  path: string;
  file: T;
}

export type ChangedFileTreeNode<T extends ChangedFileLike> =
  | ChangedFileTreeDirectory<T>
  | ChangedFileTreeFile<T>;

interface MutableDirectory<T extends ChangedFileLike> {
  name: string;
  path: string;
  directories: Map<string, MutableDirectory<T>>;
  files: T[];
}

export function normalizeChangedFilePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

export function fileBasename(path: string): string {
  const parts = normalizeChangedFilePath(path).split("/").filter(Boolean);
  return parts.at(-1) || path;
}

/** Parent path for secondary label (empty when path is a bare filename). */
export function fileParentDir(path: string): string {
  const normalized = normalizeChangedFilePath(path);
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "";
  return normalized.slice(0, idx);
}

/** Compact language/file-kind label for the changed-file explorer. */
export function changedFileTypeLabel(path: string): string {
  const name = fileBasename(path);
  if (/^(readme|license|changelog)(\.|$)/i.test(name)) return "MD";
  const extension = name.includes(".") ? name.split(".").at(-1)?.toUpperCase() ?? "" : "";
  const aliases: Record<string, string> = {
    MJS: "JS",
    CJS: "JS",
    MTS: "TS",
    CTS: "TS",
    MARKDOWN: "MD",
    YAML: "YML",
  };
  return ((aliases[extension] ?? extension) || "FILE").slice(0, 4);
}

/**
 * Build a deterministic directory tree from changed paths. Filtering keeps
 * matching ancestors and the selected file so keyboard/review context never
 * disappears while the user searches.
 */
export function buildChangedFileTree<T extends ChangedFileLike>(
  files: readonly T[],
  query = "",
  selectedPath?: string | null,
): ChangedFileTreeNode<T>[] {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedSelected = selectedPath ? normalizeChangedFilePath(selectedPath) : null;
  const visible = files.filter((file) => {
    const path = normalizeChangedFilePath(file.path);
    return !normalizedQuery || path.toLowerCase().includes(normalizedQuery) || path === normalizedSelected;
  });
  const root: MutableDirectory<T> = {
    name: "",
    path: "",
    directories: new Map(),
    files: [],
  };

  for (const file of visible) {
    const parts = normalizeChangedFilePath(file.path).split("/").filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) continue;
    let current = root;
    for (const part of parts) {
      const path = current.path ? `${current.path}/${part}` : part;
      let directory = current.directories.get(part);
      if (!directory) {
        directory = { name: part, path, directories: new Map(), files: [] };
        current.directories.set(part, directory);
      }
      current = directory;
    }
    current.files.push(file);
  }

  const finalize = (directory: MutableDirectory<T>): ChangedFileTreeNode<T>[] => {
    const directories = [...directory.directories.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((child): ChangedFileTreeDirectory<T> => {
        const children = finalize(child);
        const descendants = children.reduce(
          (totals, node) => {
            if (node.kind === "file") {
              totals.files += 1;
              totals.added += node.file.added;
              totals.removed += node.file.removed;
              if (node.file.countsKnown === false) totals.unknownCount += 1;
            } else {
              totals.files += node.files;
              totals.added += node.added;
              totals.removed += node.removed;
              totals.unknownCount += node.unknownCount;
            }
            return totals;
          },
          { files: 0, added: 0, removed: 0, unknownCount: 0 },
        );
        return { kind: "directory", name: child.name, path: child.path, children, ...descendants };
      });
    const fileNodes = [...directory.files]
      .sort((a, b) => fileBasename(a.path).localeCompare(fileBasename(b.path)))
      .map((file): ChangedFileTreeFile<T> => ({
        kind: "file",
        name: fileBasename(file.path),
        path: file.path,
        file,
      }));
    return [...directories, ...fileNodes];
  };

  return finalize(root);
}

export function resolveChangedFileSelection<T extends ChangedFileLike>(
  files: readonly T[],
  selectedPath?: string | null,
): string | null {
  if (selectedPath && files.some((file) => file.path === selectedPath)) return selectedPath;
  return sortChangedFilesForDisplay(files)[0]?.path ?? null;
}

export function changedFilesTotals(files: readonly ChangedFileLike[]): {
  count: number;
  added: number;
  removed: number;
  unknownCount: number;
} {
  let added = 0;
  let removed = 0;
  let unknownCount = 0;
  for (const f of files) {
    added += f.added || 0;
    removed += f.removed || 0;
    if (f.countsKnown === false) unknownCount += 1;
  }
  return { count: files.length, added, removed, unknownCount };
}

/** Stable display order: largest absolute churn first, then path. */
export function sortChangedFilesForDisplay<T extends ChangedFileLike>(
  files: readonly T[],
): T[] {
  return [...files].sort((a, b) => {
    const scoreA = Math.abs(a.added) + Math.abs(a.removed);
    const scoreB = Math.abs(b.added) + Math.abs(b.removed);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.path.localeCompare(b.path);
  });
}

/** Header label: "3 files changed · +40 −19" */
export function changedFilesHeading(files: readonly ChangedFileLike[]): string {
  const { count, added, removed, unknownCount } = changedFilesTotals(files);
  if (count === 0) return "No files changed";
  const noun = count === 1 ? "file" : "files";
  if (unknownCount === count) return `${count} ${noun} changed`;
  if (unknownCount > 0) {
    return `${count} ${noun} changed · +${added} −${removed} known`;
  }
  return `${count} ${noun} changed · +${added} −${removed}`;
}
