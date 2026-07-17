import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudRuntimeProfile, sealCloudModelAccess } from "@vibe/shared/cloud-runtime";

let server: Server | undefined;
afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) =>
    server!.close((error) => (error ? reject(error) : resolve())),
  );
  server = undefined;
});

test("cloud model probe generates with every exact model through the runtime registry", async () => {
  const seen: string[] = [];
  server = createServer(async (request, response) => {
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await readBody(request)) as { model?: unknown };
    seen.push(String(body.model));
    expect(request.headers.authorization).toBe("Bearer test-key");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        id: "chatcmpl-probe",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
    );
  });
  const port = await listen(server);

  const result = await runProbe(port, ["acme-gateway/code", "acme-gateway/review"]);
  expect(result.exitCode).toBe(0);
  expect(seen.sort()).toEqual(["code", "review"]);
});

test("cloud model probe rejects a model-list false positive when generation is unauthorized", async () => {
  server = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "gemma4:31b" }] }));
      return;
    }
    response.writeHead(401, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: "invalid cloud credential", type: "authentication_error" },
      }),
    );
  });
  const port = await listen(server);

  const result = await runProbe(port, ["acme-gateway/gemma4:31b"]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(
    "Cloud model preflight failed for acme-gateway/gemma4:31b",
  );
  expect(result.stderr.toString()).toContain("HTTP 401");
  expect(result.stderr.toString()).toContain("127.0.0.1");
});

async function runProbe(
  port: number,
  models: string[],
): Promise<{ exitCode: number; stderr: Buffer }> {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-cloud-model-probe-"));
  const configHome = mkdtempSync(join(tmpdir(), "vibe-cloud-model-config-"));
  const sessionId = "ses_probe";
  const accessToken = "probe-session-token-with-at-least-thirty-two-characters";
  const envelopePath = join(cwd, "model-access.json");
  writeFileSync(envelopePath, JSON.stringify(sealCloudModelAccess(
    sessionId,
    accessToken,
    {
      VIBE_PROVIDER_ACME_GATEWAY_API_KEY: "test-key",
      VIBE_PROVIDER_ACME_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/v1`,
    },
    createCloudRuntimeProfile({ theme: "light", accentColor: "#ffffff", details: "normal", requiredModels: models }),
  )));
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      join(import.meta.dirname, "..", "bin", "cloud-model-probe.ts"),
      envelopePath,
      cwd,
      sessionId,
    ],
    {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
        VIBE_CLOUD_ACCESS_TOKEN: accessToken,
      },
      stderr: "pipe",
    },
  );
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).arrayBuffer().then((value) => Buffer.from(value)),
  ]);
  return { exitCode, stderr };
}

async function listen(value: Server): Promise<number> {
  await new Promise<void>((resolve) => value.listen(0, "127.0.0.1", resolve));
  const address = value.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return address.port;
}

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}
