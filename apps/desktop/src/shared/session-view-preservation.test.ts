import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("session view preservation contract", () => {
  const sessionSrc = readFileSync(
    resolve(import.meta.dirname, "../renderer/hooks/useSession.ts"),
    "utf8",
  );
  const transcriptSrc = readFileSync(
    resolve(import.meta.dirname, "../renderer/transcript/TranscriptView.tsx"),
    "utf8",
  );
  const appSrc = readFileSync(
    resolve(import.meta.dirname, "../renderer/App.tsx"),
    "utf8",
  );

  it("does not close the active workspace tool during session bootstrap", () => {
    const start = sessionSrc.indexOf("const bootstrap = useCallback");
    const end = sessionSrc.indexOf("useEffect(() =>", start);
    const bootstrap = sessionSrc.slice(start, end);
    expect(bootstrap).not.toContain("setInspectorOpen(false)");
    expect(bootstrap).not.toContain("setJobsView(false)");
  });

  it("keys transcript scroll restoration by session", () => {
    expect(transcriptSrc).toContain("sessionScrollPositions");
    expect(transcriptSrc).toContain("sessionScrollPositions.get(sessionId)");
    expect(transcriptSrc).toContain("sessionScrollPositions.set(sessionId, element.scrollTop)");
    // Two transcript branches plus the Cloud handoff sheet receive the stable
    // id; transcript scroll remains keyed by session rather than position.
    expect(appSrc.match(/sessionId=\{chrome\.sessionId\}/g)).toHaveLength(3);
  });
});
