import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CloudCommandHandle, CloudCommandResult, SandboxProvider } from "../../shared/cloud";
import {
  awaitRemoteEngineReady,
  CloudManager,
  createFreshNamedSandbox,
  retryTransient,
  rollbackProvisionalHandoff,
  runRequired,
  superviseCloudAgent,
} from "./manager";
import { sanitizeCloudCommandOutput } from "./providers";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

test("history mutations hold the same mutex that excludes ownership handoffs", async () => {
  const manager = new CloudManager({} as never, await mkdtemp(join(tmpdir(), "vibe-cloud-history-lock-")));
  let release: (() => void) | undefined;
  const mutation = manager.runHistoryMutation("/workspace", undefined, () => new Promise<void>((resolve) => {
    release = resolve;
  }));
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));

  await expect(manager.handoffToCloud({ cwd: "/workspace", provider: "e2b" }))
    .rejects.toThrow("A session handoff is already in progress");
  release?.();
  await mutation;
});

describe("cloud command supervision", () => {
  test("reports a finite setup command's nonzero exit immediately", async () => {
    const provider = providerWithRun({ exitCode: 127, stdout: "", stderr: "node: not found\n" });

    await expect(runRequired(
      provider,
      "sandbox",
      "node",
      ["bootstrap.mjs"],
      undefined,
      { timeoutMs: 1_000 },
      "setup-failed",
      "restoring",
    )).rejects.toMatchObject({
      message: "Cloud workspace restore failed: node: not found",
      details: { code: "setup-failed", stage: "restoring", retryable: true, diagnostic: "node: not found" },
    });
  });

  test("reports the actual exception instead of a Node.js stack footer", async () => {
    const provider = providerWithRun({
      exitCode: 1,
      stdout: "",
      stderr: "node:internal/fs/promises:639\nError: EACCES: permission denied, open '/return.json'\n    at async open (node:internal/fs/promises:639:25)\nNode.js v24.18.0\n",
    });

    await expect(runRequired(
      provider,
      "sandbox",
      "node",
      ["export.mjs"],
      undefined,
      { timeoutMs: 1_000 },
      "setup-failed",
      "packaging",
    )).rejects.toMatchObject({
      message: "Cloud workspace packaging failed: Error: EACCES: permission denied, open '/return.json'",
    });
  });

  test("redacts secrets and retains only a bounded output tail", () => {
    const secret = "e2b_extremely_sensitive_value";
    const output = `${"x".repeat(80 * 1024)}\nauthorization: Bearer token-value\n${secret}`;
    const sanitized = sanitizeCloudCommandOutput(output, { API_TOKEN: secret });

    expect(Buffer.byteLength(sanitized, "utf8")).toBeLessThanOrEqual(64 * 1024 + 64);
    expect(sanitized).toContain("output truncated");
    expect(sanitized).not.toContain(secret);
    expect(sanitized).not.toContain("token-value");
    expect(sanitized).toContain("authorization: Bearer [redacted]");
  });

  test("surfaces daemon exit output instead of waiting for a health timeout", async () => {
    const daemon = handleWithResult({ exitCode: 1, stdout: "", stderr: "Cannot find module node-pty\n" });

    await expect(superviseCloudAgent(daemon, "http://127.0.0.1:9", "token", {}, 5_000)).rejects.toMatchObject({
      message: "Cloud agent exited before it became healthy: Cannot find module node-pty",
      details: { code: "daemon-exited", stage: "starting-agent", retryable: true },
    });
  });

  test("kills a still-running daemon when authenticated health times out", async () => {
    const kill = vi.fn(async () => undefined);
    const daemon: CloudCommandHandle = { wait: () => new Promise(() => undefined), kill, detach: async () => undefined };

    await expect(superviseCloudAgent(daemon, "http://127.0.0.1:9", "token", {}, 25)).rejects.toMatchObject({
      details: { code: "health-timeout", stage: "checking-health", retryable: true },
    });
    expect(kill).toHaveBeenCalledOnce();
  });

  test("accepts only an authenticated healthy agent", async () => {
    const server = createServer((request, response) => {
      response.statusCode = request.url === "/health" && request.headers.authorization === "Bearer secret" ? 200 : 401;
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    const detach = vi.fn(async () => undefined);
    const daemon: CloudCommandHandle = { wait: () => new Promise(() => undefined), kill: async () => undefined, detach };

    await expect(superviseCloudAgent(daemon, `http://127.0.0.1:${address.port}`, "secret", {}, 1_000)).resolves.toBeUndefined();
    expect(detach).not.toHaveBeenCalled();
  });

  test("rejects a healthy daemon that dropped required model credentials", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, environment: ["PATH"] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    const kill = vi.fn(async () => undefined);
    const daemon: CloudCommandHandle = { wait: () => new Promise(() => undefined), kill, detach: async () => undefined };

    await expect(superviseCloudAgent(
      daemon,
      `http://127.0.0.1:${address.port}`,
      "secret",
      {},
      1_000,
      ["CROF_API_KEY"],
    )).rejects.toMatchObject({
      message: "Cloud agent started without required model access: CROF_API_KEY",
      details: { code: "setup-failed", stage: "checking-health", retryable: false },
    });
    expect(kill).toHaveBeenCalledOnce();
  });

  test("surfaces a final-workload resume failure without waiting for timeout", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 503;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: false, error: "requested session not found: ses_expected" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    const kill = vi.fn(async () => undefined);
    const daemon: CloudCommandHandle = { wait: () => new Promise(() => undefined), kill, detach: async () => undefined };

    await expect(superviseCloudAgent(
      daemon,
      `http://127.0.0.1:${address.port}`,
      "secret",
      {},
      5_000,
    )).rejects.toMatchObject({
      message: "Cloud agent rejected the imported session: requested session not found: ses_expected",
      details: { code: "setup-failed", stage: "checking-health", retryable: false },
    });
    expect(kill).toHaveBeenCalledOnce();
  });

  test("keeps daemon supervision through the remote engine handshake", async () => {
    const detach = vi.fn(async () => undefined);
    const daemon: CloudCommandHandle = { wait: () => new Promise(() => undefined), kill: async () => undefined, detach };
    await expect(awaitRemoteEngineReady(daemon, Promise.resolve("session"))).resolves.toBe("session");
    expect(detach).toHaveBeenCalledOnce();
  });

  test("retries safe transient provider calls with 1/2/4-style bounded attempts", async () => {
    const operation = vi.fn(async () => {
      if (operation.mock.calls.length < 4) throw new Error("503 temporarily unavailable");
      return "ready";
    });

    await expect(retryTransient("create sandbox", operation, [0, 0, 0])).resolves.toBe("ready");
    expect(operation).toHaveBeenCalledTimes(4);
  });

  test("does not retry permanent provider failures", async () => {
    const operation = vi.fn(async () => { throw new Error("invalid API key"); });

    await expect(retryTransient("create sandbox", operation, [0, 0, 0])).rejects.toThrow("invalid API key");
    expect(operation).toHaveBeenCalledOnce();
  });

  test("replaces a stale same-name sandbox before a fresh handoff", async () => {
    const order: string[] = [];
    const provider = {
      findByName: vi.fn(async () => ({ id: "stale", name: "vibe-session", state: "running" })),
      destroy: vi.fn(async (id: string) => { order.push(`destroy:${id}`); }),
      create: vi.fn(async () => {
        order.push("create");
        return { id: "fresh", name: "vibe-session", state: "running" };
      }),
    } as unknown as SandboxProvider;

    await expect(createFreshNamedSandbox(provider, {
      name: "vibe-session",
      workspaceId: "workspace",
      sessionId: "ses_expected",
      timeoutMs: 60_000,
    })).resolves.toMatchObject({ id: "fresh" });
    expect(order).toEqual(["destroy:stale", "create"]);
  });

  test("aborts a timed-out provider mutation before retrying", async () => {
    let active = 0;
    let maxActive = 0;
    const operation = vi.fn((signal: AbortSignal) => new Promise<string>((resolve, reject) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const attempt = operation.mock.calls.length;
      if (attempt === 2) {
        active -= 1;
        resolve("ready");
        return;
      }
      signal.addEventListener("abort", () => {
        active -= 1;
        reject(signal.reason);
      }, { once: true });
    }));

    await expect(retryTransient("upload runtime", operation, [0], 10)).resolves.toBe("ready");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  test("cleans up the provisional sandbox only after local ownership rollback", async () => {
    const order: string[] = [];
    const result = await rollbackProvisionalHandoff(
      async () => { order.push("abort"); return true; },
      async () => { order.push("destroy"); },
    );

    expect(order).toEqual(["abort", "destroy"]);
    expect(result).toEqual({ ownershipAborted: true, sandboxDestroyed: true });
  });

  test("fails closed and retains the sandbox when ownership rollback is ambiguous", async () => {
    const destroy = vi.fn(async () => undefined);
    const result = await rollbackProvisionalHandoff(async () => false, destroy);

    expect(destroy).not.toHaveBeenCalled();
    expect(result).toEqual({ ownershipAborted: false, sandboxDestroyed: false });
  });

  test("marks cleanup unresolved when provider deletion fails after rollback", async () => {
    const cleanupError = new Error("503 deletion unavailable");
    const result = await rollbackProvisionalHandoff(
      async () => true,
      async () => { throw cleanupError; },
    );

    expect(result).toEqual({ ownershipAborted: true, sandboxDestroyed: false, cleanupError });
  });
});

function providerWithRun(result: CloudCommandResult): SandboxProvider {
  return { run: vi.fn(async () => result) } as unknown as SandboxProvider;
}

function handleWithResult(result: CloudCommandResult): CloudCommandHandle {
  return { wait: async () => result, kill: async () => undefined, detach: async () => undefined };
}
