import { describe, expect, it, vi } from "vitest";
import type { NativeNotificationPayload } from "./local-runtime-notifications";
import { LocalRuntimeNotificationRouter } from "./local-runtime-notifications";

describe("LocalRuntimeNotificationRouter", () => {
  it("routes a content-free payload and activates the exact private target", () => {
    const shown: Array<{ payload: NativeNotificationPayload; click: () => void }> = [];
    const activate = vi.fn();
    const router = new LocalRuntimeNotificationRouter({
      adapter: {
        isSupported: () => true,
        show: (payload, click) => shown.push({ payload, click }),
      },
      labelsFor: () => ({ projectTitle: "Acme", sessionTitle: "Fix checkout" }),
      activate,
    });
    router.observe({
      kind: "permission",
      cwd: "/secret/acme",
      sessionId: "session-private",
      transitionId: "permission-1",
    });

    expect(shown).toHaveLength(1);
    expect(shown[0]!.payload).toEqual({
      title: "Vibe Codr",
      body: "Acme · Fix checkout needs permission",
      silent: false,
    });
    expect(JSON.stringify(shown[0]!.payload)).not.toContain("/secret/acme");
    expect(JSON.stringify(shown[0]!.payload)).not.toContain("session-private");
    shown[0]!.click();
    expect(activate).toHaveBeenCalledWith({ cwd: "/secret/acme", sessionId: "session-private" });
  });

  it("deduplicates transitions and degrades when notifications are unavailable", () => {
    const show = vi.fn();
    const transition = {
      kind: "completed" as const,
      cwd: "/repo",
      sessionId: "s1",
      transitionId: "turn-1",
    };
    const router = new LocalRuntimeNotificationRouter({
      adapter: { isSupported: () => true, show },
      labelsFor: () => ({ projectTitle: "Repo", sessionTitle: "Session" }),
      activate: vi.fn(),
    });
    router.observe(transition);
    router.observe(transition);
    expect(show).toHaveBeenCalledTimes(1);

    const unavailableShow = vi.fn();
    const unavailable = new LocalRuntimeNotificationRouter({
      adapter: { isSupported: () => false, show: unavailableShow },
      labelsFor: () => ({ projectTitle: "Repo", sessionTitle: "Session" }),
      activate: vi.fn(),
    });
    expect(() => unavailable.observe({ ...transition, transitionId: "turn-2" })).not.toThrow();
    expect(unavailableShow).not.toHaveBeenCalled();

    const failing = new LocalRuntimeNotificationRouter({
      adapter: {
        isSupported: () => true,
        show: () => { throw new Error("notification center unavailable"); },
      },
      labelsFor: () => ({ projectTitle: "Repo", sessionTitle: "Session" }),
      activate: vi.fn(),
    });
    expect(() => failing.observe({ ...transition, transitionId: "turn-3" })).not.toThrow();
  });
});
