import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("onboarding completion contract", () => {
  const appSource = readFileSync(join(process.cwd(), "src/renderer/App.tsx"), "utf8");
  const modalSource = readFileSync(
    join(process.cwd(), "src/renderer/panels/OnboardingModal.tsx"),
    "utf8",
  );

  it("keeps setup open until the saved provider configuration boots successfully", () => {
    const saveStart = appSource.indexOf("const saveOnboarding = useCallback");
    const saveEnd = appSource.indexOf("const openProject = useCallback", saveStart);
    const saveSource = appSource.slice(saveStart, saveEnd);

    const writeIndex = saveSource.indexOf("window.vibe.writeConfig");
    const bootstrapIndex = saveSource.indexOf("await session.bootstrap");
    const closeIndex = saveSource.indexOf("setShowOnboarding(false)");

    expect(writeIndex).toBeGreaterThan(-1);
    expect(bootstrapIndex).toBeGreaterThan(writeIndex);
    expect(saveSource).toContain("if (!bootstrapped)");
    expect(closeIndex).toBeGreaterThan(bootstrapIndex);
    expect(saveSource).toContain('window.vibe.readConfig({ scope: "global" })');
    expect(saveSource).toContain("rollbackPatch = buildConfigPatch(proposed, original)");
    expect(saveSource).toContain('patch: rollbackPatch');
    expect(saveSource).toContain("Previous settings were restored");
    expect((saveSource.match(/await session\.bootstrap\(\{ cwd \}\)/g) ?? [])).toHaveLength(3);
    expect(saveSource).toContain("The previous config file was restored, but the engine could not restart.");
  });

  it("communicates that save includes engine startup", () => {
    expect(modalSource).toContain('saving ? "Saving & starting…" : "Save & start"');
  });

  it("requires the selected subscription provider to be connected before save", () => {
    expect(modalSource).toContain("connectedSubscriptionId === subscriptionProvider.id");
    expect(modalSource).toContain("onStatusChange={handleSubscriptionStatus}");
    expect(modalSource).toContain("status.state === \"connected\" ? status.providerId : null");
  });

  it("supports focused menu setup with automatic endpoints and advanced custom transport", () => {
    expect(modalSource).toContain("initialProviderId");
    expect(modalSource).toContain("providerChoiceDefaultBaseURL(choice)");
    expect(modalSource).toContain('className="provider-endpoint-summary"');
    expect(modalSource).toContain('className="provider-advanced"');
    expect(modalSource).toContain('value="openai-responses"');
    expect(modalSource).toContain("customProviderId");
    expect(modalSource).toContain('"recommended", "Recommended"');
    expect(modalSource).toContain('"local", "Local"');
    expect(modalSource).toContain('"all", "All providers"');
  });
});
