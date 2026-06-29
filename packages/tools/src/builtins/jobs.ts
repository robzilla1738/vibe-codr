import { z } from "zod";
import type { ToolDefinition } from "@vibe/shared";

interface Job {
  id: string;
  command: string;
  proc: ReturnType<typeof Bun.spawn>;
  output: string;
  status: "running" | "exited" | "killed";
  exitCode: number | null;
}

/**
 * Process-wide registry of background shell jobs. Lets the agent start a
 * long-running command (build, watcher, server) and keep working, polling with
 * `job_status` and stopping with `job_kill`.
 */
export class BackgroundJobs {
  #jobs = new Map<string, Job>();
  #seq = 0;

  start(command: string, cwd: string): Job {
    const proc = Bun.spawn(["bash", "-lc", command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const job: Job = {
      id: `job_${++this.#seq}`,
      command,
      proc,
      output: "",
      status: "running",
      exitCode: null,
    };
    this.#jobs.set(job.id, job);

    const pump = async (stream: ReadableStream<Uint8Array>) => {
      // One decoder per stream with streaming mode so multibyte UTF-8 split
      // across chunk boundaries isn't corrupted into `�`.
      const decoder = new TextDecoder();
      const append = (text: string) => {
        if (!text) return;
        job.output += text;
        if (job.output.length > 100_000) job.output = job.output.slice(-100_000);
      };
      for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }));
      append(decoder.decode()); // flush trailing bytes
    };
    // Fire-and-forget pumps: a stream error (e.g. broken pipe) must not become
    // an unhandled rejection — record it in the job's output instead.
    Promise.all([pump(proc.stdout), pump(proc.stderr)]).catch((err) => {
      job.output += `\n[stream error: ${(err as Error).message}]`;
    });
    proc.exited
      .then((code) => {
        if (job.status === "running") job.status = "exited";
        job.exitCode = code;
      })
      .catch(() => {
        if (job.status === "running") job.status = "exited";
      });
    return job;
  }

  get(id: string): Job | undefined {
    return this.#jobs.get(id);
  }

  list(): Job[] {
    return [...this.#jobs.values()];
  }

  kill(id: string): boolean {
    const job = this.#jobs.get(id);
    if (!job) return false;
    if (job.status === "running") {
      job.proc.kill();
      job.status = "killed";
    }
    return true;
  }
}

function tail(s: string, n = 4000): string {
  return s.length > n ? `…${s.slice(-n)}` : s;
}

/** Build the background-job tools bound to a shared registry. */
export function backgroundJobTools(jobs: BackgroundJobs): ToolDefinition[] {
  const StatusInput = z.object({ id: z.string().describe("Job id from a background bash run.") });

  const statusTool: ToolDefinition<z.infer<typeof StatusInput>> = {
    name: "job_status",
    description: "Check a background job's status and recent output.",
    inputSchema: StatusInput,
    readOnly: true,
    async execute({ id }) {
      const job = jobs.get(id);
      if (!job) return { output: `No such job: ${id}`, isError: true };
      const head = `${job.id} [${job.status}${job.exitCode !== null ? ` exit ${job.exitCode}` : ""}] ${job.command}`;
      return { output: `${head}\n${tail(job.output) || "(no output yet)"}` };
    },
  };

  const killTool: ToolDefinition<z.infer<typeof StatusInput>> = {
    name: "job_kill",
    description: "Stop a running background job.",
    inputSchema: StatusInput,
    readOnly: false,
    concurrencySafe: false,
    async execute({ id }) {
      return jobs.kill(id)
        ? { output: `Killed ${id}.` }
        : { output: `No such job: ${id}`, isError: true };
    },
  };

  return [statusTool, killTool];
}
