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
  const workspaceSrc = readFileSync(
    resolve(import.meta.dirname, "../renderer/sessions/SessionsWorkspace.tsx"),
    "utf8",
  );

  it("does not close the active workspace tool during session bootstrap", () => {
    const start = sessionSrc.indexOf("const bootstrap = useCallback");
    const end = sessionSrc.indexOf("useEffect(() =>", start);
    const bootstrap = sessionSrc.slice(start, end);
    expect(bootstrap).not.toContain("setInspectorOpen(false)");
    expect(bootstrap).not.toContain("setJobsView(false)");
  });

  it("does not bind a replacement-host resync to the previously committed cwd", () => {
    expect(sessionSrc).toContain("const restorePreviousAttachment = async");
    expect(sessionSrc).toMatch(/window\.vibe\.onResync\(\(\) => \{\s*if \(bootstrapHandoff\.current\) return;/);
    expect(sessionSrc).toContain("snapshot.sessionId !== previousSnapshot.sessionId");
  });

  it("keys transcript scroll restoration by session", () => {
    expect(transcriptSrc).toContain("sessionScrollPositions");
    expect(transcriptSrc).toContain("sessionScrollPositions.get(sessionId)");
    expect(transcriptSrc).toContain("sessionScrollPositions.set(sessionId, element.scrollTop)");
    // Two transcript branches plus the Cloud handoff sheet receive the stable
    // id; transcript scroll remains keyed by session rather than position.
    expect(appSrc.match(/sessionId=\{chrome\.sessionId\}/g)).toHaveLength(3);
  });

  it("blocks session record navigation while another session is attaching", () => {
    expect(workspaceSrc).toContain("disabled={navigationDisabled}");
    expect(workspaceSrc).toContain('className="session-board-open" disabled={disabled}');
  });

  it("persists and refreshes completed background runtimes", () => {
    expect(appSrc).toContain('!status.foreground');
    expect(appSrc).toContain('status.state === "idle"');
    expect(appSrc).toContain('persistSessionStatus(status.cwd, status.sessionId, "done")');
    expect(appSrc).toContain("void refreshProjects()");
  });
});
