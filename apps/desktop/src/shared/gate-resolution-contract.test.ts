import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("pending gate resolution contract", () => {
  const app = readFileSync(join(process.cwd(), "src/renderer/App.tsx"), "utf8");

  it("does not apply a permission acknowledgement to a replacement session", () => {
    const answerPerm = app.slice(app.indexOf("const answerPerm"), app.indexOf("const answerPlan"));
    expect(answerPerm).toContain("const gateSessionId = session.chrome.sessionId");
    expect(answerPerm).toContain("chromeRef.current.sessionId !== gateSessionId");
    expect(answerPerm.indexOf("chromeRef.current.sessionId !== gateSessionId"))
      .toBeLessThan(answerPerm.indexOf('type: "drop-perm"'));
  });

  it("clears only the exact plan that originated the accepted send", () => {
    const answerPlan = app.slice(app.indexOf("const answerPlan"), app.indexOf("// Centralized catalog presenter"));
    expect(answerPlan).toContain("const pendingPlan = session.chrome.plan");
    expect(answerPlan).toContain("chromeRef.current.sessionId !== gateSessionId");
    expect(answerPlan).toContain("chromeRef.current.plan !== pendingPlan");
    expect(answerPlan.indexOf("chromeRef.current.plan !== pendingPlan"))
      .toBeLessThan(answerPlan.indexOf('type: "clear-plan"'));
    expect(answerPlan.indexOf("chromeRef.current.plan !== pendingPlan"))
      .toBeLessThan(answerPlan.indexOf("session.setBusy(true)"));
  });
});
