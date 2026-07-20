import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginWorkerClient, PluginWorkerError, resolvePluginWorkerPath } from "./worker-client.ts";

const workerPath = fileURLToPath(new URL("./worker-entry.ts", import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  delete process.env.VIBE_PLUGIN_TEST_SECRET;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("retains executable tools, commands, and hooks in a scrubbed child", async () => {
  const { root, plugin } = await fixture(`
export default { register(api) {
  api.registerTool({
    name: "isolated_echo", description: "Echo in isolation", inputSchema: { type: "object" },
    readOnly: true, concurrencySafe: true,
    async execute(input, context) { return { output: { input, cwd: context.cwd, secret: process.env.VIBE_PLUGIN_TEST_SECRET ?? null } }; }
  });
  api.registerCommand({ name: "isolated", description: "Run isolated", source: "plugin", run(args) { return { kind: "notice", message: args }; } });
  api.hooks.on("user.prompt.submit", (payload) => ({ ...payload, text: payload.text + "!" }));
} };
`);
  process.env.VIBE_PLUGIN_TEST_SECRET = "must-not-cross";
  const { client, result } = await PluginWorkerClient.start({ specifier: plugin, cwd: root, workerPath });
  expect(result.status).toBe("ready");
  expect(client.metadata).toEqual({
    tools: [{ kind: "tool", name: "isolated_echo", description: "Echo in isolation", inputSchema: { type: "object" }, readOnly: true, concurrencySafe: true }],
    commands: [{ kind: "command", name: "isolated", description: "Run isolated" }],
    hooks: ["user.prompt.submit"],
  });
  expect(JSON.stringify(client.metadata)).not.toContain("execute");
  expect(await client.callTool("isolated_echo", { value: 7 }, { cwd: "/workspace" })).toEqual({
    output: { input: { value: 7 }, cwd: "/workspace", secret: null },
  });
  expect(await client.runCommand("isolated", "hello")).toEqual({ kind: "notice", message: "hello" });
  expect(await client.runHook("user.prompt.submit", { text: "safe" })).toEqual({ text: "safe!" });
  await client.close();
});

test("returns the explicit trusted-in-process result for providers", async () => {
  const { root, plugin } = await fixture(`export default { register(api) { api.registerProvider({ id: "private-provider" }); } };`);
  const { client, result } = await PluginWorkerClient.start({ specifier: plugin, cwd: root, workerPath });
  expect(result).toEqual({ status: "trusted-in-process-approval-required", contribution: "providers" });
  expect(client.metadata).toBeNull();
  await expect(client.callTool("nope", {}, {})).rejects.toMatchObject({ code: "closed" });
});

test("packaged dispatch follows an npm bin symlink to its sibling worker", async () => {
  const root = await makeRoot();
  const packageDir = join(root, "package");
  const binDir = join(root, "bin");
  await mkdir(packageDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(join(packageDir, "vibecodr.js"), "");
  await writeFile(join(packageDir, "vibecodr-plugin-worker.js"), "");
  await symlink(join(packageDir, "vibecodr.js"), join(binDir, "vibecodr"));
  const prior = process.argv[1] ?? "";
  process.argv[1] = join(binDir, "vibecodr");
  try { expect(resolvePluginWorkerPath()).toBe(await realpath(join(packageDir, "vibecodr-plugin-worker.js"))); }
  finally { process.argv[1] = prior; }
});

test("startup and RPC deadlines terminate a hung worker with redacted errors", async () => {
  const hungRegistration = await fixture(`export default { async register() { await new Promise(() => {}); } };`, "secret-registration.mjs");
  expect(stableError("timeout", hungRegistration.plugin)(await rejected(PluginWorkerClient.start({
    specifier: hungRegistration.plugin,
    cwd: hungRegistration.root,
    workerPath,
    startupTimeoutMs: 50,
  })))).toBe(true);

  const hungCall = await fixture(`export default { register(api) { api.registerTool({ name: "hang", description: "hang", inputSchema: {}, readOnly: true, execute: async () => new Promise(() => {}) }); } };`);
  const { client } = await PluginWorkerClient.start({ specifier: hungCall.plugin, cwd: hungCall.root, workerPath, rpcTimeoutMs: 50 });
  expect(stableError("timeout", hungCall.plugin)(await rejected(client.callTool("hang", {}, {})))).toBe(true);
  await expect(client.callTool("hang", {}, {})).rejects.toMatchObject({ code: "closed" });
});

test("bounds concurrent requests and rejects every waiter on overflow", async () => {
  const hung = await fixture(`export default { register(api) { api.registerTool({ name: "hang", description: "hang", inputSchema: {}, readOnly: true, execute: async () => new Promise(() => {}) }); } };`);
  const { client } = await PluginWorkerClient.start({ specifier: hung.plugin, cwd: hung.root, workerPath });
  const calls = Array.from({ length: 65 }, () => client.callTool("hang", {}, {}).then(() => null, (error) => error));
  const errors = await Promise.all(calls);
  expect(errors.every((error) => error instanceof PluginWorkerError && error.code === "request-limit")).toBe(true);
});

test("abort kills the in-flight plugin process tree", async () => {
  const root = await makeRoot();
  const pidFile = join(root, "grandchild.pid");
  const plugin = join(root, "abort-tree.mjs");
  await writeFile(plugin, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
export default { register(api) { api.registerTool({ name: "tree", description: "tree", inputSchema: {}, readOnly: false,
  async execute() { const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]); writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); return new Promise(() => {}); }
}); } };
`);
  const { client } = await PluginWorkerClient.start({ specifier: plugin, cwd: root, workerPath });
  const controller = new AbortController();
  const call = client.callTool("tree", {}, {}, controller.signal).then(() => null, (error) => error);
  await waitFor(() => existsSync(pidFile));
  const pid = Number(await readFile(pidFile, "utf8"));
  controller.abort();
  expect(await call).toMatchObject({ code: "aborted" });
  await waitFor(() => !processExists(pid));
  expect(processExists(pid)).toBe(false);
});

test("crashes, malformed frames, oversized outputs, and secret-bearing failures stay bounded", async () => {
  const crashed = await fixture(`export default { register(api) { api.registerTool({ name: "crash", description: "crash", inputSchema: {}, readOnly: true, execute() { process.exit(7); } }); } };`);
  let started = await PluginWorkerClient.start({ specifier: crashed.plugin, cwd: crashed.root, workerPath });
  expect(stableError("crashed", crashed.plugin)(await rejected(started.client.callTool("crash", {}, {})))).toBe(true);

  const malformed = await fixture(`import { writeSync } from "node:fs"; export default { register() { writeSync(1, "not-json\\n"); } };`);
  expect(stableError("invalid-frame", malformed.plugin)(await rejected(
    PluginWorkerClient.start({ specifier: malformed.plugin, cwd: malformed.root, workerPath }),
  ))).toBe(true);

  const oversized = await fixture(`export default { register(api) { api.registerTool({ name: "huge", description: "huge", inputSchema: {}, readOnly: true, execute: async () => ({ output: "x".repeat(300000) }) }); } };`);
  started = await PluginWorkerClient.start({ specifier: oversized.plugin, cwd: oversized.root, workerPath });
  expect(stableError("output-too-large", oversized.plugin)(await rejected(started.client.callTool("huge", {}, {})))).toBe(true);

  process.env.VIBE_PLUGIN_TEST_SECRET = "raw-secret-value";
  const failed = await fixture(`export default { register() { throw new Error("raw-secret-value " + process.argv.join(" ")); } };`, "raw-secret-value.mjs");
  expect(stableError("plugin-load-failed", "raw-secret-value")(await rejected(
    PluginWorkerClient.start({ specifier: failed.plugin, cwd: failed.root, workerPath }),
  ))).toBe(true);
});

function stableError(code: string, forbidden: string): (error: unknown) => boolean {
  return (error) => error instanceof PluginWorkerError
    && error.code === code
    && error.message.length < 128
    && !error.message.includes(forbidden)
    && !error.message.includes("raw-secret-value")
    && !error.message.includes(" at ");
}

async function fixture(source: string, name = "plugin.mjs"): Promise<{ root: string; plugin: string }> {
  const root = await makeRoot();
  const plugin = join(root, name);
  await writeFile(plugin, source);
  return { root, plugin };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vibe-plugin-worker-"));
  roots.push(root);
  return root;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; return null; }
  catch (error) { return error; }
}
