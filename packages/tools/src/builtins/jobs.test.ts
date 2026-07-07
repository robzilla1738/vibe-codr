import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundJobs, backgroundJobArgv } from "./jobs.ts";
import type { SandboxPolicy } from "../sandbox.ts";

const cwd = () => mkdtempSync(join(tmpdir(), "vibe-jobs-"));

function sandbox(): SandboxPolicy {
  return {
    mode: "workspace-write",
    network: "off",
    writablePaths: ["/work"],
    backend: "bwrap",
    available: true,
  };
}

test("background job argv honors dangerouslyUnsandboxed", () => {
  const wrapped = backgroundJobArgv("echo hi", "/work", sandbox());
  expect(wrapped[0]).toBe("bwrap");
  expect(wrapped).toContain("--unshare-net");
  expect(backgroundJobArgv("echo hi", "/work", sandbox(), { dangerouslyUnsandboxed: true })).toEqual([
    "bash",
    "-lc",
    "echo hi",
  ]);
});

test("a background job runs and transitions to exited with captured output", async () => {
  const jobs = new BackgroundJobs();
  const job = jobs.start("echo hello-bg", cwd());
  expect(job.status).toBe("running");
  expect(job.id).toBe("job_1");

  await job.proc.exited;
  // Give the output pump a tick to flush.
  await new Promise((r) => setTimeout(r, 20));
  const after = jobs.get(job.id);
  expect(after?.status).toBe("exited");
  expect(after?.exitCode).toBe(0);
  expect(after?.output).toContain("hello-bg");
});

test("multibyte UTF-8 output is captured intact", async () => {
  const jobs = new BackgroundJobs();
  const job = jobs.start("printf 'café — déjà vu 🚀\\n'", cwd());
  await job.proc.exited;
  await new Promise((r) => setTimeout(r, 20));
  // Streaming decode must not corrupt multibyte characters into `�`.
  expect(jobs.get(job.id)?.output).toContain("café — déjà vu 🚀");
});

test("a long job can be killed", async () => {
  const jobs = new BackgroundJobs();
  const job = jobs.start("sleep 30", cwd());
  expect(job.status).toBe("running");
  expect(jobs.kill(job.id)).toBe(true);
  expect(jobs.get(job.id)?.status).toBe("killed");
});

test("killing an unknown job returns false", () => {
  const jobs = new BackgroundJobs();
  expect(jobs.kill("job_999")).toBe(false);
});

test("a detected server URL survives output truncation (sticky server list)", async () => {
  const jobs = new BackgroundJobs();
  // Print the server URL first (its own chunk), then flood >100k chars so the URL
  // scrolls out of the retained buffer. It must remain in the sticky server list.
  const job = jobs.start(
    `echo "  ➜  Local:   http://localhost:5173/"; sleep 0.1; for i in $(seq 1 60000); do echo "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx $i"; done`,
    cwd(),
  );
  await job.proc.exited;
  await new Promise((r) => setTimeout(r, 80));
  const after = jobs.get(job.id);
  // The URL scrolled out of the 100k buffer window…
  expect(after!.output.includes("localhost:5173")).toBe(false);
  // …but it stays in the accumulated server list (recomputing from the truncated
  // buffer would have dropped it).
  expect(after!.servers.some((u) => u.includes("localhost:5173"))).toBe(true);
});

test("a server URL split across two output chunks is still detected (scan-overlap carry)", async () => {
  const jobs = new BackgroundJobs();
  // Two writes separated by a sleep land as separate stream chunks. The tail-only
  // scan (which replaced the O(n²) full-buffer rescan) must still see the URL
  // whole via the carry window spanning the chunk boundary.
  const job = jobs.start(
    `printf 'Local:   http://localho'; sleep 0.3; printf 'st:5173/\\n'`,
    cwd(),
  );
  await job.proc.exited;
  await new Promise((r) => setTimeout(r, 80));
  const after = jobs.get(job.id);
  expect(after!.servers.some((u) => u.includes("localhost:5173"))).toBe(true);
});

test("an already-detected server is not re-announced when its URL is printed again", async () => {
  let changes = 0;
  const jobs = new BackgroundJobs({ onChange: () => changes++ });
  // Same URL in two separate chunks: the second sighting must neither duplicate
  // the sticky list entry nor fire another onChange (re-announce) — the overlap
  // window makes re-matches near the boundary possible, so dedup must hold.
  const job = jobs.start(
    `echo "http://localhost:5173/"; sleep 0.3; echo "http://localhost:5173/"`,
    cwd(),
  );
  await job.proc.exited;
  await new Promise((r) => setTimeout(r, 80));
  const after = jobs.get(job.id);
  expect(after!.servers).toEqual(["http://localhost:5173/"]);
  // Exactly: start + first URL detection + exit. A re-announce would add a 4th.
  expect(changes).toBe(3);
});

test("the sticky server list is bounded under high-cardinality URL output", async () => {
  const jobs = new BackgroundJobs();
  // Print 300 distinct localhost URLs (varying ports) — the list must stay bounded.
  const job = jobs.start(
    `for p in $(seq 1 300); do echo "http://localhost:$((3000+p))/"; done`,
    cwd(),
  );
  await job.proc.exited;
  await new Promise((r) => setTimeout(r, 60));
  const after = jobs.get(job.id);
  expect(after!.servers.length).toBeLessThanOrEqual(64); // capped, not 300
  expect(after!.servers.length).toBeGreaterThan(0);
});
