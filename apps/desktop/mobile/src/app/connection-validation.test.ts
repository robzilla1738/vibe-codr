import { describe, expect, it } from "vitest";
import { parsePairingDeepLink, validateConnectionConfig } from "./connection-validation";

const valid = (url: string) => validateConnectionConfig({
  url,
  accessToken: "pairing-token",
  cwd: "/Users/me/Code/project",
});

describe("mobile connection boundary", () => {
  it("allows private plaintext relay and public TLS endpoints", () => {
    expect(valid("ws://192.168.1.5:7788").ok).toBe(true);
    expect(valid("ws://100.100.1.2:7788").ok).toBe(true);
    expect(valid("ws://[::1]:7788").ok).toBe(true);
    expect(valid("wss://relay.example.com/mobile").ok).toBe(true);
  });

  it("rejects public plaintext, non-WebSocket, embedded credentials, and relative cwd", () => {
    expect(valid("ws://203.0.113.8:7788")).toMatchObject({ ok: false, error: expect.stringContaining("private LAN") });
    expect(valid("ws://relay.example.com:7788")).toMatchObject({ ok: false });
    expect(valid("https://relay.example.com")).toMatchObject({ ok: false });
    expect(valid("wss://user:secret@relay.example.com")).toMatchObject({ ok: false });
    expect(validateConnectionConfig({ url: "wss://relay.example.com", accessToken: "token", cwd: "relative/project" })).toMatchObject({ ok: false });
    expect(validateConnectionConfig({ url: "wss://relay.example.com", accessToken: "token", cwd: "/project", sessionId: "\0session" })).toMatchObject({ ok: false });
  });

  it("validates QR deep links through the same boundary", () => {
    const safe = `vibecodr://connect?url=${encodeURIComponent("ws://10.0.0.8:7788")}&token=token&cwd=${encodeURIComponent("C:\\Code\\project")}&session=ses_1`;
    expect(parsePairingDeepLink(safe)).toMatchObject({ ok: true, value: { sessionId: "ses_1" } });
    const unsafe = `vibecodr://connect?url=${encodeURIComponent("ws://public.example.com:7788")}&token=token&cwd=${encodeURIComponent("/project")}`;
    expect(parsePairingDeepLink(unsafe)).toMatchObject({ ok: false });
  });
});
