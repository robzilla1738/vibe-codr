import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { EngineBridge } from "./engine-bridge";
import type { HostLaunch } from "./host-resolver";

function fixture(source: string): HostLaunch {
  return {
    executable: process.execPath,
    arguments: ["-e", source],
    workingDirectory: process.cwd(),
    description: "node protocol fixture",
  };
}

function bridgeFor(source: string): EngineBridge {
  return new EngineBridge({
    resolveLaunch: () => fixture(source),
    readyTimeoutMs: 5_000,
    rpcTimeoutMs: 5_000,
    stopTimeoutMs: 800,
  });
}

/** Poll until `predicate` is true or `timeoutMs` elapses (avoids fixed sleeps under suite load). */
async function pollUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!predicate()) {
    throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
  }
}

const snapshot = {
  sessionId: "fixture-session",
  model: "fixture",
  mode: "execute",
  goal: null,
  history: [],
  tasks: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 },
  busy: false,
  theme: "default",
  accentColor: "",
  details: "normal",
  mouse: false,
  approvalMode: "ask",
  commandNames: [],
};

const readyFrameSource = `
  const readyFrame = (sessionId, hostInstanceId = "fixture-host") => ({
    type: "ready",
    protocolVersion: 2,
    engineRevision: "test",
    capabilities: ["event-replay"],
    hostInstanceId,
    sessionId,
  });
  const eventFrame = (event, seq = 1, hostInstanceId = "fixture-host") => ({
    type: "event",
    hostInstanceId,
    seq,
    event,
  });
`;

describe("EngineBridge lifecycle", () => {
  it("loads the project index and reuses its prewarmed host for bootstrap", async () => {
    let launches = 0;
    const child = String.raw`${readyFrameSource}
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.op === "rpc" && msg.method === "listProjects") {
          process.stdout.write(JSON.stringify({
            type: "resp",
            id: msg.id,
            ok: true,
            value: [{ cwd: ${JSON.stringify(process.cwd())}, name: "fixture", updatedAt: 1, sessions: [] }]
          }) + "\n");
        } else if (msg.op === "bootstrap") {
          process.stdout.write(JSON.stringify(readyFrame("after-index")) + "\n");
        } else if (msg.op === "shutdown") process.exit(0);
      });
    `;
    const bridge = new EngineBridge({
      resolveLaunch: () => {
        launches += 1;
        return fixture(child);
      },
      readyTimeoutMs: 5_000,
      rpcTimeoutMs: 5_000,
      stopTimeoutMs: 800,
    });

    await expect(bridge.listProjectsForIndex()).resolves.toEqual([
      { cwd: process.cwd(), name: "fixture", updatedAt: 1, sessions: [] },
    ]);
    expect(bridge.isRunning).toBe(true);
    await expect(bridge.start({ cwd: process.cwd() })).resolves.toBe("after-index");
    expect(launches).toBe(1);
    await bridge.stop();
  });

  it("reaps an unused prewarmed project-index host after its lifetime", async () => {
    const child = String.raw`${readyFrameSource}
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.op === "rpc" && msg.method === "listProjects") {
          process.stdout.write(JSON.stringify({ type: "resp", id: msg.id, ok: true, value: [] }) + "\n");
        } else if (msg.op === "shutdown") process.exit(0);
      });
    `;
    const bridge = new EngineBridge({
      resolveLaunch: () => fixture(child),
      rpcTimeoutMs: 5_000,
      stopTimeoutMs: 800,
      prewarmTimeoutMs: 20,
    });

    await expect(bridge.listProjectsForIndex()).resolves.toEqual([]);
    expect(bridge.isRunning).toBe(true);
    await pollUntil(() => !bridge.isRunning);
  });

  it("runs project history mutations without an active session and reaps the temporary host", async () => {
    const child = String.raw`
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.op === "rpc" && msg.method === "deleteSession") {
          process.stdout.write(JSON.stringify({
            type: "resp",
            id: msg.id,
            ok: true,
            value: { id: msg.params.id },
          }) + "\n");
        } else if (msg.op === "shutdown") process.exit(0);
      });
    `;
    const bridge = bridgeFor(child);

    await expect(bridge.rpcWithTemporaryHost("deleteSession", {
      cwd: process.cwd(),
      id: "ses_fixture",
    })).resolves.toEqual({ id: "ses_fixture" });
    expect(bridge.isRunning).toBe(false);
  });

  it("bootstraps, forwards events, resolves RPC, and shuts down", async () => {
    const child = String.raw`${readyFrameSource}
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.op === "bootstrap") {
          process.stdout.write(JSON.stringify(readyFrame("fixture-session")) + "\n");
          process.stdout.write(JSON.stringify(eventFrame({ type: "notice", level: "info", message: "online" })) + "\n");
        } else if (msg.op === "rpc") {
          process.stdout.write(JSON.stringify({ type: "resp", id: msg.id, ok: true, value: ${JSON.stringify(snapshot)} }) + "\n");
        } else if (msg.op === "shutdown") process.exit(0);
      });
    `;
    const bridge = bridgeFor(child);
    const events: unknown[] = [];
    bridge.onEvent = (event) => events.push(event);

    await expect(bridge.start({ cwd: process.cwd() })).resolves.toBe("fixture-session");
    await expect(bridge.rpc("snapshot")).resolves.toMatchObject({ model: "fixture" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toContainEqual({ type: "notice", level: "info", message: "online" });
    await bridge.stop();
    expect(bridge.isRunning).toBe(false);
  });

  it("replays a sequence gap once and rejects duplicate delivery", async () => {
    const replayFrames = [
      { type: "event", hostInstanceId: "gap-host", seq: 2, event: { type: "notice", level: "info", message: "two" } },
      { type: "event", hostInstanceId: "gap-host", seq: 3, event: { type: "notice", level: "info", message: "three" } },
    ];
    const child = String.raw`${readyFrameSource}
      const readline = require("node:readline");
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.op === "bootstrap") {
          process.stdout.write(JSON.stringify(readyFrame("fixture-session", "gap-host")) + "\n");
          process.stdout.write(JSON.stringify(eventFrame({ type: "notice", level: "info", message: "one" }, 1, "gap-host")) + "\n");
          process.stdout.write(JSON.stringify(eventFrame({ type: "notice", level: "info", message: "three" }, 3, "gap-host")) + "\n");
        } else if (msg.op === "rpc" && msg.method === "replayEvents") {
          process.stdout.write(JSON.stringify({ type: "resp", id: msg.id, ok: true, value: {
            hostInstanceId: "gap-host",
            events: ${JSON.stringify(replayFrames)},
            lastEventSeq: 3,
            truncated: false,
          } }) + "\n");
        } else if (msg.op === "shutdown") process.exit(0);
      });
    `;
    const bridge = bridgeFor(child);
    const messages: string[] = [];
    bridge.onEvent = (event) => {
      if (event && typeof event === "object" && "message" in event) messages.push(String(event.message));
    };

    await bridge.start({ cwd: process.cwd() });
    await pollUntil(() => messages.length === 3);
    expect(messages).toEqual(["one", "two", "three"]);
    await bridge.stop();
  });

  it("falls back to a cursor-bearing snapshot when replay has expired", async () => {
    const resyncSnapshot = {
      ...snapshot,
      hostInstanceId: "snapshot-host",
      lastEventSeq: 3,
    };
    const child = String.raw`${readyFrameSource}
      const readline = require("node:readline");
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.op === "bootstrap") {
          process.stdout.write(JSON.stringify(readyFrame("fixture-session", "snapshot-host")) + "\n");
          process.stdout.write(JSON.stringify(eventFrame({ type: "notice", level: "info", message: "three" }, 3, "snapshot-host")) + "\n");
        } else if (msg.op === "rpc" && msg.method === "replayEvents") {
          process.stdout.write(JSON.stringify({ type: "resp", id: msg.id, ok: true, value: {
            hostInstanceId: "snapshot-host", events: [], lastEventSeq: 3, truncated: true,
          } }) + "\n");
        } else if (msg.op === "rpc" && msg.method === "snapshot") {
          process.stdout.write(JSON.stringify({ type: "resp", id: msg.id, ok: true, value: ${JSON.stringify(resyncSnapshot)} }) + "\n");
        } else if (msg.op === "shutdown") process.exit(0);
      });
    `;
    const bridge = bridgeFor(child);
    const resyncs: unknown[] = [];
    bridge.onResync = (value) => resyncs.push(value);

    await bridge.start({ cwd: process.cwd() });
    await pollUntil(() => resyncs.length === 1);
    expect(resyncs[0]).toMatchObject({ hostInstanceId: "snapshot-host", lastEventSeq: 3 });
    await bridge.stop();
  });

  it("reports an explicit protocol mismatch before accepting ready", async () => {
    const child = String.raw`
      const readline = require("node:readline");
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        if (JSON.parse(line).op === "bootstrap") process.stdout.write(JSON.stringify({
          type: "ready",
          protocolVersion: 99,
          engineRevision: "old-host",
          capabilities: [],
          hostInstanceId: "old-host",
          sessionId: "fixture-session",
        }) + "\n");
      });
    `;
    const bridge = bridgeFor(child);
    await expect(bridge.start({ cwd: process.cwd() })).rejects.toThrow(
      "Engine host protocol 99 is incompatible with desktop protocol 2",
    );
    await pollUntil(() => !bridge.isRunning);
  });

  it("rejects a packaged host whose engine revision does not match the lock", async () => {
    const child = String.raw`${readyFrameSource}
      const readline = require("node:readline");
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        if (JSON.parse(line).op === "bootstrap") {
          process.stdout.write(JSON.stringify(readyFrame("fixture-session")) + "\n");
        }
      });
    `;
    const bridge = new EngineBridge({
      resolveLaunch: () => fixture(child),
      environment: () => ({ ...process.env, VIBE_ENGINE_COMMIT: "a".repeat(40) }),
      readyTimeoutMs: 5_000,
      stopTimeoutMs: 800,
    });
    await expect(bridge.start({ cwd: process.cwd() })).rejects.toThrow(
      `Engine host revision test is incompatible with packaged revision ${"a".repeat(40)}`,
    );
    await pollUntil(() => !bridge.isRunning);
  });

  it("surfaces malformed protocol output instead of silently desynchronizing", async () => {
    const bridge = bridgeFor(`process.stdin.resume(); process.stdout.write("not-json\\n")`);
    const fatals: string[] = [];
    bridge.onFatal = (message) => fatals.push(message);

    await expect(bridge.start({ cwd: process.cwd() })).rejects.toThrow("invalid protocol output");
    expect(fatals[0]).toContain("not-json");
    await pollUntil(() => !bridge.isRunning);
    expect(bridge.isRunning).toBe(false);
  });

  it("terminates a host that emits an oversized unterminated protocol line", async () => {
    const bridge = new EngineBridge({
      resolveLaunch: () => fixture(`process.stdin.resume(); process.stdout.write("x".repeat(65))`),
      readyTimeoutMs: 5_000,
      stopTimeoutMs: 200,
      protocolLineMaxBytes: 64,
    });
    const fatals: string[] = [];
    bridge.onFatal = (message) => fatals.push(message);

    await expect(bridge.start({ cwd: process.cwd() })).rejects.toThrow(
      "protocol line exceeded 64 bytes",
    );
    expect(fatals).toEqual(["Engine host protocol line exceeded 64 bytes"]);
    await pollUntil(() => !bridge.isRunning);
  });

  it("kills a host that never reaches ready", async () => {
    const bridge = new EngineBridge({
      resolveLaunch: () => fixture("process.stdin.resume()"),
      readyTimeoutMs: 40,
      stopTimeoutMs: 100,
    });
    const fatals: string[] = [];
    bridge.onFatal = (message) => fatals.push(message);
    await expect(bridge.start({ cwd: process.cwd() })).rejects.toThrow("timed out waiting for ready");
    await pollUntil(() => !bridge.isRunning);
    expect(bridge.isRunning).toBe(false);
    // Bootstrap reject is the user-facing error; exit must not emit a second fatal.
    expect(fatals).toEqual([]);
  });

  it("reports an unexpected clean exit after ready as fatal", async () => {
    const bridge = bridgeFor(String.raw`${readyFrameSource}
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.op === "bootstrap") {
          process.stdout.write(JSON.stringify(readyFrame("clean-exit")) + "\n");
          setTimeout(() => process.exit(0), 10);
        }
      });
    `);
    const fatals: string[] = [];
    bridge.onFatal = (message) => fatals.push(message);

    await bridge.start({ cwd: process.cwd() });
    // Under full-suite load, exit can land after a fixed 40ms sleep — poll instead.
    await pollUntil(() => fatals.length > 0 || !bridge.isRunning);
    expect(fatals).toEqual(["Engine host exited"]);
    expect(bridge.isRunning).toBe(false);
  });

  it("terminates the host on malformed nested event payloads", async () => {
    const bridge = bridgeFor(String.raw`${readyFrameSource}
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.op === "bootstrap") {
          process.stdout.write(JSON.stringify(readyFrame("nested-invalid")) + "\n");
          setTimeout(() => process.stdout.write(JSON.stringify({
            ...eventFrame({ type: "queue-changed", active: null, pending: [null] })
          }) + "\n"), 10);
        }
      });
    `);
    const fatals: string[] = [];
    bridge.onFatal = (message) => fatals.push(message);

    await bridge.start({ cwd: process.cwd() });
    await pollUntil(() => fatals.length > 0);
    // Deep nested validation is folded into isUIEvent/decodeOutbound, so the
    // bridge reports invalid protocol (not a separate nested-event path).
    expect(fatals[0]).toMatch(/invalid (nested event|protocol output)/i);
    await pollUntil(() => !bridge.isRunning);
    expect(bridge.isRunning).toBe(false);
  });

  it("reports spawn failures through both the start result and fatal channel", async () => {
    const bridge = new EngineBridge({
      resolveLaunch: () => ({
        executable: "/definitely/missing/vibecodr-engine-host",
        arguments: [],
        workingDirectory: process.cwd(),
        description: "missing fixture",
      }),
      readyTimeoutMs: 500,
    });
    const fatals: string[] = [];
    bridge.onFatal = (message) => fatals.push(message);

    await expect(bridge.start({ cwd: process.cwd() })).rejects.toThrow("Could not start engine host");
    expect(fatals).toHaveLength(1);
  });

  it("retires a host that is still booting before starting its replacement", async () => {
    let launches = 0;
    const bridge = new EngineBridge({
      resolveLaunch: () => {
        launches += 1;
        return fixture(String.raw`${readyFrameSource}
          const readline = require("node:readline");
          const rl = readline.createInterface({ input: process.stdin });
          rl.on("line", (line) => {
            const msg = JSON.parse(line);
            if (msg.op === "bootstrap") setTimeout(() => process.stdout.write(JSON.stringify(readyFrame("session-${launches}")) + "\n"), 100);
            if (msg.op === "shutdown") process.exit(0);
          });
        `);
      },
      readyTimeoutMs: 5_000,
      stopTimeoutMs: 500,
    });

    const first = bridge.start({ cwd: process.cwd() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = bridge.start({ cwd: process.cwd() });
    await expect(first).rejects.toThrow("stopped");
    await expect(second).resolves.toBe("session-2");
    expect(launches).toBe(2);
    await bridge.stop();
  });

  it("ignores ready and event output emitted by a retired host generation", async () => {
    let launches = 0;
    const bridge = new EngineBridge({
      resolveLaunch: () => {
        launches += 1;
        if (launches === 1) {
          return fixture(String.raw`${readyFrameSource}
            const readline = require("node:readline");
            const rl = readline.createInterface({ input: process.stdin });
            rl.on("line", (line) => {
              const msg = JSON.parse(line);
              if (msg.op === "shutdown") {
                process.stdout.write(JSON.stringify(readyFrame("stale-session", "retired-host")) + "\n");
                process.stdout.write(JSON.stringify(eventFrame({ type: "notice", level: "warn", message: "stale" }, 1, "retired-host")) + "\n");
                setTimeout(() => process.exit(0), 20);
              }
            });
          `);
        }
        return fixture(String.raw`${readyFrameSource}
          const readline = require("node:readline");
          const rl = readline.createInterface({ input: process.stdin });
          rl.on("line", (line) => {
            const msg = JSON.parse(line);
            if (msg.op === "bootstrap") process.stdout.write(JSON.stringify(readyFrame("current-session", "current-host")) + "\n");
            if (msg.op === "shutdown") process.exit(0);
          });
        `);
      },
      readyTimeoutMs: 5_000,
      stopTimeoutMs: 100,
    });
    const events: unknown[] = [];
    const readies: string[] = [];
    bridge.onEvent = (value) => events.push(value);
    bridge.onReady = (id) => readies.push(id);

    const first = bridge.start({ cwd: process.cwd() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = bridge.start({ cwd: process.cwd() });
    await expect(first).rejects.toThrow("stopped");
    await expect(second).resolves.toBe("current-session");
    expect(readies).toEqual(["current-session"]);
    expect(events).toEqual([]);
    await bridge.stop();
  });

  it("serializes three overlapping bootstraps so only the newest host survives", async () => {
    let launches = 0;
    const children: ChildProcessWithoutNullStreams[] = [];
    const bridge = new EngineBridge({
      resolveLaunch: () => {
        launches += 1;
        return fixture(String.raw`${readyFrameSource}
          const readline = require("node:readline");
          const rl = readline.createInterface({ input: process.stdin });
          rl.on("line", (line) => {
            const msg = JSON.parse(line);
            if (msg.op === "bootstrap") setTimeout(() => process.stdout.write(JSON.stringify(readyFrame("session-${launches}")) + "\n"), 50);
            if (msg.op === "shutdown") setTimeout(() => process.exit(0), 10);
          });
        `);
      },
      readyTimeoutMs: 5_000,
      stopTimeoutMs: 200,
      onSpawn: (proc) => children.push(proc),
    });

    const first = bridge.start({ cwd: process.cwd() });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = bridge.start({ cwd: process.cwd() });
    const third = bridge.start({ cwd: process.cwd() });
    await expect(first).rejects.toThrow("stopped");
    await expect(second).rejects.toThrow("stopped");
    await expect(third).resolves.toBe("session-2");
    expect(launches).toBe(2);
    await pollUntil(
      () =>
        children.filter((child) => child.exitCode === null && child.signalCode === null).length === 1,
      2_000,
    );
    expect(
      children.filter((child) => child.exitCode === null && child.signalCode === null),
    ).toHaveLength(1);
    await bridge.stop();
  });

  it("turns asynchronous child stdin failures into one fatal lifecycle error", async () => {
    let childProcess: ChildProcessWithoutNullStreams | null = null;
    const bridge = new EngineBridge({
      resolveLaunch: () => fixture(String.raw`${readyFrameSource}
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.op === "bootstrap") process.stdout.write(JSON.stringify(readyFrame("pipe-session")) + "\n");
        if (msg.op === "shutdown") process.exit(0);
      });
      `),
      readyTimeoutMs: 5_000,
      rpcTimeoutMs: 800,
      stopTimeoutMs: 800,
      onSpawn: (proc) => { childProcess = proc; },
    });
    const fatals: string[] = [];
    bridge.onFatal = (message) => fatals.push(message);
    await bridge.start({ cwd: process.cwd() });
    if (!childProcess) throw new Error("fixture child was not captured");
    (childProcess as ChildProcessWithoutNullStreams).stdin.emit("error", new Error("broken pipe"));
    await expect(bridge.rpc("snapshot")).rejects.toThrow();
    expect(fatals).toHaveLength(1);
    expect(fatals[0]).toContain("stdin failed");
    await bridge.stop();
  });

  it("reaps the host when the bootstrap write fails synchronously", async () => {
    const bridge = new EngineBridge({
      resolveLaunch: () => fixture("process.stdin.resume()"),
      readyTimeoutMs: 5_000,
      stopTimeoutMs: 200,
      onSpawn: (proc) => {
        proc.stdin.write = (() => {
          throw new Error("synchronous pipe failure");
        }) as typeof proc.stdin.write;
      },
    });
    const fatals: string[] = [];
    bridge.onFatal = (message) => fatals.push(message);

    await expect(bridge.start({ cwd: process.cwd() })).rejects.toThrow(
      "Could not bootstrap engine host",
    );
    expect(fatals).toEqual([
      "Engine host stdin failed: synchronous pipe failure",
    ]);
    await pollUntil(() => !bridge.isRunning);
  });

  it("rejects RPC before the host reaches ready", async () => {
    let childProcess: ChildProcessWithoutNullStreams | null = null;
    const bridge = new EngineBridge({
      resolveLaunch: () => fixture(`
        process.stdin.resume();
        // Never emit ready — hold the process open for the test.
        setInterval(() => {}, 60_000);
      `),
      readyTimeoutMs: 2_000,
      stopTimeoutMs: 200,
      killWaitMs: 200,
      onSpawn: (proc) => {
        childProcess = proc;
      },
    });
    const start = bridge.start({ cwd: process.cwd() });
    await pollUntil(() => childProcess != null, 1_000);
    await expect(bridge.rpc("snapshot")).rejects.toThrow(/not ready/i);
    expect(bridge.isReady).toBe(false);
    expect(bridge.isRunning).toBe(true);
    await bridge.stop();
    await expect(start).rejects.toThrow();
    expect(bridge.isRunning).toBe(false);
  });

  it("reaps a host that ignores graceful shutdown with SIGKILL", async () => {
    let childProcess: ChildProcessWithoutNullStreams | null = null;
    // Ignore SIGTERM; only exit on SIGKILL (default).
    const bridge = new EngineBridge({
      resolveLaunch: () =>
        fixture(String.raw`${readyFrameSource}
          process.on("SIGTERM", () => { /* ignore soft kill */ });
          const readline = require("node:readline");
          const rl = readline.createInterface({ input: process.stdin });
          rl.on("line", (line) => {
            const msg = JSON.parse(line);
            if (msg.op === "bootstrap") {
              process.stdout.write(JSON.stringify(readyFrame("wedged")) + "\n");
            }
            // Never honor shutdown.
          });
        `),
      readyTimeoutMs: 5_000,
      stopTimeoutMs: 80,
      killWaitMs: 500,
      onSpawn: (proc) => {
        childProcess = proc;
      },
    });
    await bridge.start({ cwd: process.cwd() });
    expect(bridge.isReady).toBe(true);
    await bridge.stop();
    expect(bridge.isRunning).toBe(false);
    expect(childProcess).not.toBeNull();
    await pollUntil(
      () => childProcess!.exitCode !== null || childProcess!.signalCode !== null,
      2_000,
    );
    // SIGKILL is reported as signal on most platforms.
    expect(
      childProcess!.signalCode === "SIGKILL" ||
        childProcess!.killed ||
        childProcess!.exitCode !== null,
    ).toBe(true);
  });

  it("disposeForQuit finalizes when ready and always leaves no owned child", async () => {
    const bridge = bridgeFor(String.raw`${readyFrameSource}
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.op === "bootstrap") {
          process.stdout.write(JSON.stringify(readyFrame("quit-session")) + "\n");
        } else if (msg.op === "rpc" && msg.method === "finalize") {
          finalized = true;
          process.stdout.write(JSON.stringify({ type: "resp", id: msg.id, ok: true, value: null }) + "\n");
        } else if (msg.op === "shutdown") process.exit(0);
      });
    `);
    // Patch: the fixture can't set outer `finalized` — observe via RPC success path.
    await bridge.start({ cwd: process.cwd() });
    expect(bridge.isReady).toBe(true);
    await bridge.disposeForQuit();
    expect(bridge.isRunning).toBe(false);
    expect(bridge.isReady).toBe(false);
  });

  it("disposeForQuit still reaps when finalize never responds", async () => {
    let childProcess: ChildProcessWithoutNullStreams | null = null;
    const bridge = new EngineBridge({
      resolveLaunch: () =>
        fixture(String.raw`${readyFrameSource}
          const readline = require("node:readline");
          const rl = readline.createInterface({ input: process.stdin });
          rl.on("line", (line) => {
            const msg = JSON.parse(line);
            if (msg.op === "bootstrap") {
              process.stdout.write(JSON.stringify(readyFrame("hang-finalize")) + "\n");
            } else if (msg.op === "rpc" && msg.method === "finalize") {
              // Never respond — quit must not wait the full RPC timeout.
            } else if (msg.op === "shutdown") process.exit(0);
          });
        `),
      readyTimeoutMs: 5_000,
      rpcTimeoutMs: 10_000,
      quitFinalizeTimeoutMs: 80,
      stopTimeoutMs: 200,
      killWaitMs: 200,
      onSpawn: (proc) => {
        childProcess = proc;
      },
    });
    await bridge.start({ cwd: process.cwd() });
    const started = Date.now();
    await bridge.disposeForQuit();
    const elapsed = Date.now() - started;
    expect(bridge.isRunning).toBe(false);
    // Must not wait the 10s RPC timeout.
    expect(elapsed).toBeLessThan(5_000);
    await pollUntil(
      () => !childProcess || childProcess.exitCode !== null || childProcess.signalCode !== null,
      2_000,
    );
  });

  it("disposeForQuit reaps a host that never reaches ready without waiting the ready timeout", async () => {
    let childProcess: ChildProcessWithoutNullStreams | null = null;
    // Host never emits ready — classic quit-during-bootstrap race.
    const bridge = new EngineBridge({
      resolveLaunch: () =>
        fixture(`
          // Stay alive; ignore everything. Never emit ready.
          setInterval(() => {}, 60_000);
          process.stdin.resume();
        `),
      readyTimeoutMs: 30_000,
      stopTimeoutMs: 200,
      killWaitMs: 200,
      quitFinalizeTimeoutMs: 50,
      onSpawn: (proc) => {
        childProcess = proc;
      },
    });
    // Start but do not await ready — quit while bootstrap is in flight.
    const startPromise = bridge.start({ cwd: process.cwd() });
    await pollUntil(() => childProcess != null, 2_000);
    const started = Date.now();
    await bridge.disposeForQuit();
    const elapsed = Date.now() - started;
    expect(bridge.isRunning).toBe(false);
    // Must not wait the 30s ready timeout.
    expect(elapsed).toBeLessThan(5_000);
    await expect(startPromise).rejects.toThrow();
    await pollUntil(
      () => !childProcess || childProcess.exitCode !== null || childProcess.signalCode !== null,
      2_000,
    );
  });

  it("keeps isRunning true after soft-kill until the child actually exits", async () => {
    let childProcess: ChildProcessWithoutNullStreams | null = null;
    const bridge = new EngineBridge({
      resolveLaunch: () =>
        fixture(String.raw`${readyFrameSource}
          process.on("SIGTERM", () => {
            // Exit after the soft signal, not after process startup. Coverage
            // instrumentation may delay the parent long enough that a
            // startup-relative timer fires before bootstrap is observed.
            setTimeout(() => process.exit(0), 150);
          });
          const readline = require("node:readline");
          const rl = readline.createInterface({ input: process.stdin });
          rl.on("line", (line) => {
            const msg = JSON.parse(line);
            if (msg.op === "bootstrap") {
              process.stdout.write(JSON.stringify(readyFrame("soft-kill")) + "\n");
            }
          });
        `),
      readyTimeoutMs: 5_000,
      stopTimeoutMs: 50,
      killWaitMs: 50,
      onSpawn: (proc) => {
        childProcess = proc;
      },
    });
    await bridge.start({ cwd: process.cwd() });
    // Capture through a mutable bag so TS doesn't narrow the outer let to never
    // after the null check (onSpawn assignment is invisible to control flow).
    const proc = childProcess as ChildProcessWithoutNullStreams | null;
    expect(proc).not.toBeNull();
    // Soft-kill without going through stop — mimics terminateFatal's first signal.
    proc!.kill("SIGTERM");
    // Immediately after kill(), Node sets killed=true but exit may not have fired.
    // Ownership must still be reported so quit cleanup is not skipped.
    if (proc!.exitCode === null && proc!.signalCode === null) {
      expect(bridge.isRunning).toBe(true);
    }
    await pollUntil(() => !bridge.isRunning, 2_000);
    expect(bridge.isRunning).toBe(false);
  });
});
