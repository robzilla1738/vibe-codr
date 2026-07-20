import { useState } from "react";
import type { TraceListResultV1, TracePageV1 } from "@vibe/protocol";

export function TraceViewer({ cwd }: { cwd: string | null }) {
  const [page, setPage] = useState<TracePageV1 | null>();
  const load = async (content = false) => {
    if (!cwd) return;
    const list = await window.vibe.rpc("listTraces", { cwd, limit: 1 });
    const runId = list.ok ? (list.value as TraceListResultV1).traces[0]?.runId : null;
    if (!runId) return setPage(null);
    const result = await window.vibe.rpc("readTrace", { cwd, runId, limit: 200, includeRedacted: content });
    if (result.ok) setPage(result.value as TracePageV1);
  };
  return (
    <details className="trace-viewer" onToggle={(event) => {
      if (event.currentTarget.open && page === undefined) void load();
    }}>
      <summary>Latest run evidence</summary>
      {page ? <>
        <button type="button" className="chip" onClick={() => void load(true)}>Show recorded redactions</button>
        {page.corruptions.length ? <p role="alert">Ledger issue detected; source order preserved.</p> : null}
        <pre className="trace-rows">{page.events.map((event) => [
          event.seq, new Date(event.at).toLocaleString(), event.type, event.status,
          event.content ? JSON.stringify(event.content) : "",
        ].filter(Boolean).join(" · ")).join("\n")}</pre>
        {page.nextAfterSeq != null ? <p>Showing the first 200 events.</p> : null}
      </> : <p>{page === null ? "No recorded runs." : "Open to load."}</p>}
    </details>
  );
}
