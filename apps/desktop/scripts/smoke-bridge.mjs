#!/usr/bin/env node
/**
 * Smoke: spawn vibecodr-engine-host, bootstrap cwd, snapshot + project index, shutdown.
 * Usage: node scripts/smoke-bridge.mjs [cwd]
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = process.argv[2] || process.cwd();
const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = process.env.VIBE_CODR_ROOT || [
  resolve(electronRoot, "..", ".."),
  resolve(electronRoot, "..", "cli"),
  resolve(electronRoot, "..", "vibe-codr"),
  join(homedir(), "Code", "vibe-codr"),
  join(homedir(), "code", "vibe-codr"),
].find((candidate) => existsSync(join(candidate, "package.json"))) || join(homedir(), "Code", "vibe-codr");
const bin = join(
  root,
  "dist",
  process.platform === "win32" ? "vibecodr-engine-host.exe" : "vibecodr-engine-host",
);
if (!existsSync(bin)) {
  console.error("missing host:", bin);
  process.exit(1);
}

const proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], cwd: root });
const rl = createInterface({ input: proc.stdout });

let ready = false;
let snapshotOk = false;
let projectsOk = false;
let providersOk = false;
let finishing = false;

// Overall wall-clock so a hung RPC after ready cannot leave the smoke script stuck forever.
const overallTimer = setTimeout(() => {
  finish(1, ready
    ? "smoke-bridge timed out waiting for snapshot/listProjects/listProviders after ready"
    : "smoke-bridge timed out waiting for ready");
}, 60_000);
overallTimer.unref();

function finish(code, error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(overallTimer);
  if (error) console.error(error);

  const forceTimer = setTimeout(() => {
    proc.kill("SIGKILL");
  }, 2_000);
  forceTimer.unref();

  proc.once("exit", () => {
    clearTimeout(forceTimer);
    process.exit(code);
  });

  if (proc.exitCode !== null) process.exit(code);
  if (code === 0 && proc.stdin.writable) {
    proc.stdin.end(`${JSON.stringify({ op: "shutdown" })}\n`);
  } else {
    proc.kill();
  }
}

function finishIfReady() {
  if (!snapshotOk || !projectsOk || !providersOk) return;
  finish(0);
}

rl.on("line", (line) => {
  console.log("←", line.slice(0, 200));
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "ready") {
    ready = true;
    proc.stdin.write(`${JSON.stringify({ op: "rpc", id: 1, method: "snapshot" })}\n`);
    proc.stdin.write(`${JSON.stringify({ op: "rpc", id: 2, method: "listProjects" })}\n`);
    proc.stdin.write(`${JSON.stringify({ op: "rpc", id: 3, method: "listProviders" })}\n`);
  }
  if (msg.type === "resp" && msg.id === 1) {
    if (!msg.ok) {
      finish(1, `snapshot failed: ${msg.error ?? "unknown error"}`);
      return;
    }
    console.log("snapshot ok session=", msg.value?.sessionId);
    snapshotOk = true;
    finishIfReady();
  }
  if (msg.type === "resp" && msg.id === 2) {
    if (!msg.ok || !Array.isArray(msg.value)) {
      finish(1, `project index failed: ${msg.error || "invalid response"}`);
      return;
    }
    const invalidProject = msg.value.find(
      (project) => typeof project?.cwd !== "string" || !Array.isArray(project.sessions),
    );
    if (invalidProject) {
      finish(1, "project index contained an invalid project entry");
      return;
    }
    // The active cwd may be intentionally archived, so listProjects can
    // correctly omit it. This smoke validates the RPC contract, not user state.
    console.log("project index ok projects=", msg.value.length);
    projectsOk = true;
    finishIfReady();
  }
  if (msg.type === "resp" && msg.id === 3) {
    if (!msg.ok || !Array.isArray(msg.value)) {
      finish(1, `provider catalog failed: ${msg.error || "invalid response"}`);
      return;
    }
    const ids = new Set(msg.value.map((provider) => provider?.id));
    const required = ["openai", "amazon-bedrock", "google-vertex", "nous", "opencode-zen"];
    if (msg.value.length < 190 || required.some((id) => !ids.has(id))) {
      finish(1, `provider catalog incomplete: ${msg.value.length} providers`);
      return;
    }
    console.log("provider catalog ok providers=", msg.value.length);
    providersOk = true;
    finishIfReady();
  }
});

proc.stderr.on("data", (d) => process.stderr.write(d));
proc.stdin.write(`${JSON.stringify({ op: "bootstrap", cwd })}\n`);

setTimeout(() => {
  if (!ready) {
    finish(1, "timeout waiting for ready");
  }
}, 45000);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => finish(1, `interrupted by ${signal}`));
}
