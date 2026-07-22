import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/renderer/layout/ProjectRail.tsx"),
  "utf8",
);
const appSource = readFileSync(join(process.cwd(), "src/renderer/App.tsx"), "utf8");

describe("project rail mutation contract", () => {
  it("offers an icon-only new-chat action beside the hover actions", () => {
    expect(source).toContain("project-row-actions");
    expect(source).toContain("onClick={() => onNewProjectChat(project.cwd)}");
    expect(source).toContain("<IconPlus size={14} />");
    expect(source).not.toContain("<span>New chat</span>");
  });

  it("marks only catalog sessions whose cloud status is running", () => {
    expect(source).toContain('entry.status === "running"');
    expect(source).toContain("runningCloudSessionIds.has(session.id)");
    expect(source).toContain('className="session-cloud-indicator"');
    expect(source).toContain("Running in Cloud.");
    expect(source).toContain("<IconCloud size={12} />");
  });

  it("preserves rename drafts until the backing operation succeeds", () => {
    expect(source).toContain("if (!renaming || renamePendingRef.current || remoteOwnedSessionIds.has(renaming.id)) return");
    expect(source).toContain("ok = await onRenameSession(cwd, id, title)");
    expect(source).toMatch(/if \(ok\) \{\s*setRenaming\(null\);/);
    expect(source).toContain("ok = await onRenameProject(cwd, name)");
    expect(source).toMatch(/if \(ok\) \{\s*setRenamingProject\(null\);/);
    expect(source).toContain("disabled={renamePending}");
  });

  it("keeps destructive confirmations open and prevents duplicate submission", () => {
    expect(source).toContain("if (menuActionPendingRef.current) return");
    expect(source).toContain("disabled={menuActionPending}");
    expect(source).toContain("void runProjectAction(cwd, mode)");
    expect(source).toContain("void runSessionAction(cwd, session.id, mode)");
    expect(source).toMatch(/if \(ok\) \{\s*setMenu\(null\);\s*setConfirmProjectAction\(null\);/);
    expect(source).toMatch(/if \(ok\) \{\s*setMenu\(null\);\s*setConfirmAction\(null\);/);
  });

  it("blocks local recovery mutations while Cloud owns a session or project", () => {
    expect(source).toContain("isCloudSessionMutationLocked(entry.status)");
    expect(source).toContain("remoteOwnedSessionIds.has(session.id)");
    expect(source).toContain("remoteOwnedSessionIds.has(renaming.id)");
    expect(source).toContain("remoteOwnedSessionIds.has(id)");
    expect(source).toContain("remoteOwnedProjectCwds.has(normalizeCwd(cwd))");
    expect(source).toContain("Return this session to Local to manage it");
  });

  it("hands the active final project to Chats before archiving it", () => {
    expect(appSource).toContain("normalizeCwd(projectCwd) === normalizeCwd(cwd)");
    expect(appSource).toContain("const chats = chatsCwd ?? await window.vibe.ensureChatsDir()");
    expect(appSource).toContain("if (!await openProjectAt(chats)) return false");
    expect(appSource.indexOf("if (!await openProjectAt(chats)) return false")).toBeLessThan(
      appSource.indexOf("window.vibe.archiveProject({ cwd: projectCwd })"),
    );
  });
});
