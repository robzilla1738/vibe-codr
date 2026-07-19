import { describe, expect, it } from "vitest";
import { diagnosticLaunchKind } from "./performance";

describe("performance diagnostics redaction", () => {
  it("reduces host launch descriptions to path-free categories", () => {
    expect(diagnosticLaunchKind("compiled /Users/private/vibe/dist/vibecodr-engine-host")).toBe("compiled");
    expect(diagnosticLaunchKind("bun /Users/private/vibe/packages/macos-bridge/bin/engine-host.ts")).toBe("source");
    expect(diagnosticLaunchKind("bundled /Applications/Vibe.app/Contents/Resources/vibecodr-engine-host")).toBe("bundled");
    expect(diagnosticLaunchKind("dev resources /Users/private/host")).toBe("development");
    expect(diagnosticLaunchKind("Cloud agent")).toBe("cloud");
    expect(diagnosticLaunchKind("fake:/Users/private")).toBeUndefined();
  });
});
