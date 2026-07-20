/** Stable, non-secret v2 frames used by every transport implementation. */
export const GOLDEN_HOST_WIRE_MESSAGES = [
  { op: "bootstrap", cwd: "/tmp/project", mode: "plan", clientExtension: "preserved" },
  { op: "send", command: { type: "submit-prompt", text: "hello", clientExtension: 1 } },
  { op: "rpc", id: 1, method: "snapshot" },
  { op: "rpc", id: 2, method: "replayEvents", params: { hostInstanceId: "host-1", afterSeq: 0 } },
  { op: "shutdown" },
  {
    type: "ready",
    protocolVersion: 2,
    engineRevision: "golden",
    capabilities: ["event-replay"],
    hostInstanceId: "host-1",
    sessionId: "session-1",
  },
  {
    type: "event",
    hostInstanceId: "host-1",
    seq: 1,
    event: { type: "notice", level: "info", message: "ready", eventExtension: true },
  },
  { type: "resp", id: 1, ok: true, value: null },
  { type: "resp", id: 2, ok: false, error: "not bootstrapped" },
  { type: "fatal", message: "invalid protocol message" },
] as const;

export const GOLDEN_HOST_WIRE_LINES = GOLDEN_HOST_WIRE_MESSAGES.map((message) =>
  JSON.stringify(message),
);
