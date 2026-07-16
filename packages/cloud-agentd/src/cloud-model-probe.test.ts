import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

let server: Server | undefined;
afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

test("cloud model probe verifies exact Ollama Cloud model access", async () => {
  server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "gemma4:31b" }] }));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");

  const result = await runProbe(address.port);
  expect(result.exitCode).toBe(0);
});

test("cloud model probe rejects a replacement Ollama model", async () => {
  server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "glm-5.2" }] }));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");

  const result = await runProbe(address.port);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("does not provide the exact session model: gemma4:31b");
});

async function runProbe(port: number): Promise<{ exitCode: number; stderr: Buffer }> {
  const child = Bun.spawn([
    process.execPath,
    "run",
    join(import.meta.dirname, "..", "bin", "cloud-model-probe.ts"),
    JSON.stringify(["ollama/gemma4:31b"]),
  ], {
    env: { ...process.env, OLLAMA_API_KEY: "test-key", OLLAMA_BASE_URL: `http://127.0.0.1:${port}` },
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).arrayBuffer().then((value) => Buffer.from(value)),
  ]);
  return { exitCode, stderr };
}
