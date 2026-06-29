import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { BackgroundJobs } from "./jobs.ts";

const cwd = () => mkdtempSync(join(tmpdir(), "vibe-jobs-"));
import { join } from "node:path";

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
