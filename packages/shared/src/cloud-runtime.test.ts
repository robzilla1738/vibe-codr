import { describe, expect, test } from "bun:test";
import {
  createCloudRuntimeProfile,
  openCloudModelAccess,
  sealCloudModelAccess,
  terminalEnvironmentWithoutModelAccess,
} from "./cloud-runtime.ts";

const token = "session-token-with-at-least-thirty-two-characters";
const profile = createCloudRuntimeProfile({
  theme: "light",
  accentColor: "#e6e6e6",
  details: "normal",
  requiredModels: ["crof/glm-5.2"],
});

describe("cloud runtime model access", () => {
  test("round trips a session-bound sealed envelope", () => {
    const envelope = sealCloudModelAccess("ses_1", token, { CROF_API_KEY: "secret" }, profile);
    expect(envelope.environmentNames).toEqual(["CROF_API_KEY"]);
    expect(JSON.stringify(envelope)).not.toContain("secret");
    expect(openCloudModelAccess(envelope, token, "ses_1")).toEqual({
      schemaVersion: 1,
      environment: { CROF_API_KEY: "secret" },
      profile,
    });
  });

  test("rejects tampering and invalid credential names", () => {
    const envelope = sealCloudModelAccess("ses_1", token, { CROF_API_KEY: "secret" }, profile);
    expect(() => openCloudModelAccess({ ...envelope, sessionId: "ses_2" }, token)).toThrow("authenticated");
    expect(() => sealCloudModelAccess("ses_1", token, { "BAD-NAME": "secret" }, profile)).toThrow("invalid");
  });

  test("keeps model access out of terminal environments", () => {
    expect(terminalEnvironmentWithoutModelAccess(
      { PATH: "/bin", CROF_API_KEY: "secret", VIBE_CLOUD_ACCESS_TOKEN: token },
      ["CROF_API_KEY"],
    )).toEqual({ PATH: "/bin" });
  });

  test("permits credential-free model validation only for Return Local recovery", () => {
    expect(() => createCloudRuntimeProfile({ theme: "light", details: "normal", requiredModels: [] })).toThrow("runtime-profile-mismatch");
    const recovery = createCloudRuntimeProfile({
      theme: "light",
      details: "normal",
      requiredModels: [],
      recoveryOnly: true,
    });
    const envelope = sealCloudModelAccess("ses_recovery", token, {}, recovery);
    expect(openCloudModelAccess(envelope, token, "ses_recovery").profile).toEqual(recovery);
  });
});
