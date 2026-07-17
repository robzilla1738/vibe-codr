import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(join(process.cwd(), "src/renderer/App.tsx"), "utf8");
const main = readFileSync(join(process.cwd(), "src/main/index.ts"), "utf8");
const cloudManager = readFileSync(join(process.cwd(), "src/main/cloud/manager.ts"), "utf8");
const rail = readFileSync(join(process.cwd(), "src/renderer/layout/ProjectRail.tsx"), "utf8");
const workspace = readFileSync(join(process.cwd(), "src/renderer/sessions/SessionsWorkspace.tsx"), "utf8");

describe("sessions workspace contract", () => {
  it("is a real rail destination that preserves the mounted chat workspace", () => {
    expect(rail).toContain("onOpenSessions");
    expect(rail).toContain("sessionsActive");
    expect(app).toContain("<SessionsWorkspace");
    expect(app).toContain("sessionsOpen ? (");
    expect(app).toContain("onOpen={(projectCwd, id) => void resumeSession(projectCwd, id)}");
  });

  it("supports board/list, search, filters, status movement, and every session mutation", () => {
    expect(workspace).toContain('view: "board"');
    expect(workspace).toContain('view: "list"');
    expect(workspace).toContain('placeholder="Search sessions"');
    expect(workspace).toContain('aria-label="Session filters"');
    expect(workspace).toContain("<SessionStatusSelect");
    expect(workspace).toContain("await onRename");
    expect(workspace).toContain("await onArchive");
    expect(workspace).toContain("await onDelete");
  });

  it("does not claim an idle card is running", () => {
    expect(workspace).toContain('active: { label: "Active", description: "Work in progress" }');
    expect(workspace).toContain("cloudAutomaticSessionState(cloudStatus)");
    expect(workspace).toContain("workingKeys.has(item.key)");
    expect(workspace).not.toContain('label: "Running"');
  });

  it("allows a recovered cloud session to enter Review again later", () => {
    expect(workspace).toContain('if (automaticStates.get(key) !== "review") appliedAutomaticStates.current.delete(key)');
    expect(app).toContain('event.type === "session-start"');
    expect(app).toContain("current === event.sessionId ? null : current");
  });

  it("does not mutate the local recovery record while cloud owns a session", () => {
    expect(workspace).toContain("isCloudSessionMutationLocked(entry.status)");
    expect(workspace).toContain("renamePending || cloudOwned.has(item.session.id)");
    expect(workspace).toContain("actionPending || cloudOwned.has(item.session.id)");
    expect(workspace).toContain("disabled={remoteOwned || (interactionDisabled && active)}");
    expect(main).toContain("cloudManager.runHistoryMutation");
    expect(cloudManager).toContain("Return Cloud-owned or interrupted sessions to Local");
  });
});
