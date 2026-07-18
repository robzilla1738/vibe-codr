import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./useRemoteSession.ts", import.meta.url), "utf8");

describe("remote session continuity wiring", () => {
  it("does not clear busy merely because the transport disconnected", () => {
    const start = source.indexOf("client.onDisconnect =");
    const end = source.indexOf("client.onConnectionState", start);
    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, end)).not.toContain('type: "set-busy"');
  });

  it("buffers live events while reconnect snapshot state is rehydrated", () => {
    const start = source.indexOf("client.onReady =");
    const end = source.indexOf("client.onDisconnect =", start);
    const reconnect = source.slice(start, end);
    expect(reconnect.indexOf("bootstrapHandoff.current = true")).toBeGreaterThan(-1);
    expect(reconnect.indexOf("bootstrapHandoff.current = true")).toBeLessThan(reconnect.indexOf("await client.snapshot()"));
    expect(reconnect).toContain('dispatchTranscript({ type: "replace"');
    expect(reconnect).toContain("for (const event of queuedEvents) handleEvent(event)");
  });
});
