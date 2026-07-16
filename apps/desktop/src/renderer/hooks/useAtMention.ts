import { useEffect, useMemo, useState } from "react";
import { atMentionState, formatAtPath } from "../../shared/file-fuzzy";

/** Fuzzy @path file attach while typing in the composer. */
export function useAtMention(draft: string, cwd: string | null) {
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mention = useMemo(() => atMentionState(draft), [draft]);

  useEffect(() => {
    if (!mention || !cwd) {
      setFiles([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const t = window.setTimeout(() => {
      void window.vibe.listFiles({ cwd, query: mention.query, limit: 30 })
        .then((list) => {
          if (!cancelled) setFiles(list);
        })
        .catch((reason: unknown) => {
          if (!cancelled) {
            setFiles([]);
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [mention, cwd]);

  return {
    mention: mention?.query ?? null,
    files,
    loading,
    error,
    atIndex: mention?.atIndex ?? -1,
  };
}

/** Replace the trailing @query with @path (keep a trailing space). */
export function applyAtMention(draft: string, path: string): string {
  // Replacer function — a string replacement would reinterpret `$` in paths
  // (`price$100.md`, `foo$&bar`) as replacement patterns.
  return draft.replace(/(^|\s)@[^\s]*$/, (_m, lead: string) => `${lead}${formatAtPath(path)} `);
}
