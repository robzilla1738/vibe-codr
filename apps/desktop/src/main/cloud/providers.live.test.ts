import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { CloudProviderId, ProviderCredentials, SandboxProvider } from "../../shared/cloud";
import { E2BSandboxProvider, VercelSandboxProvider } from "./providers";

const live = process.env.VIBE_LIVE_CLOUD === "1";
const e2bLive = live && Boolean(process.env.E2B_API_KEY?.trim());
const vercelLive = live && ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"].every((name) => Boolean(process.env[name]?.trim()));

describe("paid cloud provider contract", () => {
  test.skipIf(!e2bLive)("E2B create/upload/start/reconnect/suspend/resume/download/destroy", async () => {
    await exercise(new E2BSandboxProvider(), { apiKey: required("E2B_API_KEY") }, "e2b");
  }, 240_000);

  test.skipIf(!vercelLive)("Vercel create/upload/start/reconnect/suspend/resume/download/destroy", async () => {
    await exercise(new VercelSandboxProvider(), {
      token: required("VERCEL_TOKEN"),
      teamId: required("VERCEL_TEAM_ID"),
      projectId: required("VERCEL_PROJECT_ID"),
    }, "vercel");
  }, 240_000);
});

async function exercise(
  provider: SandboxProvider,
  credentials: NonNullable<ProviderCredentials[CloudProviderId]>,
  id: CloudProviderId,
): Promise<void> {
  await provider.connectAccount(credentials);
  expect(await provider.test()).toMatchObject({ ok: true });
  const sessionId = randomUUID();
  const sandbox = await provider.create({
    name: `vibe-contract-${id}-${Date.now()}`,
    workspaceId: `contract-${sessionId}`,
    sessionId,
    timeoutMs: 10 * 60_000,
    allowedDomains: ["registry.npmjs.org"],
  });
  try {
    await expect(provider.findByName(sandbox.name)).resolves.toMatchObject({ id: sandbox.id });
    await provider.upload(sandbox.id, "/tmp/vibe-provider-input.txt", Buffer.from("cloud-provider-contract"));
    expect(Buffer.from(await provider.download(sandbox.id, "/tmp/vibe-provider-input.txt")).toString()).toBe("cloud-provider-contract");
    expect(await provider.run(sandbox.id, "sh", ["-lc", "printf resumed >/tmp/vibe-provider-output.txt"])).toMatchObject({ exitCode: 0 });
    expect(Buffer.from(await waitForFile(provider, sandbox.id, "/tmp/vibe-provider-output.txt")).toString()).toBe("resumed");
    expect(await provider.run(sandbox.id, "sh", ["-lc", "id -u >/tmp/vibe-provider-control-uid.txt"], undefined, { privileged: true })).toMatchObject({ exitCode: 0 });
    expect(Buffer.from(await waitForFile(provider, sandbox.id, "/tmp/vibe-provider-control-uid.txt")).toString().trim()).toBe("0");
    expect(await provider.run(sandbox.id, "node", ["-e", "fetch('https://registry.npmjs.org/ws').then(r=>{if(!r.ok)throw Error(String(r.status));require('fs').writeFileSync('/tmp/vibe-provider-egress.txt','allowed')}).catch(e=>{console.error(e);process.exit(1)})"])).toMatchObject({ exitCode: 0 });
    expect(Buffer.from(await waitForFile(provider, sandbox.id, "/tmp/vibe-provider-egress.txt")).toString()).toBe("allowed");
    const daemon = await provider.start(sandbox.id, "sh", ["-lc", "trap 'exit 0' TERM INT; while :; do sleep 1; done"]);
    await daemon.kill();
    await expect(daemon.wait()).resolves.toMatchObject({ exitCode: expect.any(Number) });
    expect((await provider.domain(sandbox.id, 8787)).url).toMatch(/^https:\/\//);
    expect(await provider.get(sandbox.id)).not.toBeNull();

    await provider.suspend(sandbox.id);
    expect(await provider.resume(sandbox.id)).not.toBeNull();
    expect(await provider.run(sandbox.id, "sh", ["-lc", "printf again >/tmp/vibe-provider-resumed.txt"])).toMatchObject({ exitCode: 0 });
    const resumed = await waitForFile(provider, sandbox.id, "/tmp/vibe-provider-resumed.txt");
    expect(Buffer.from(resumed).toString()).toBe("again");
  } finally {
    await provider.destroy(sandbox.id);
  }
  expect(await provider.get(sandbox.id)).toBeNull();
  expect(await provider.findByName(sandbox.name)).toBeNull();
}

async function waitForFile(provider: SandboxProvider, sandboxId: string, path: string): Promise<Uint8Array> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await provider.download(sandboxId, path);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${path}`);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the live cloud contract suite`);
  return value;
}
