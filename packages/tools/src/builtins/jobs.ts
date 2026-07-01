import { z } from "zod";
import { drainTextStream, type JobInfo, type ToolDefinition } from "@vibe/shared";
import { killTree } from "./process-tree.ts";

interface Job {
  id: string;
  command: string;
  proc: ReturnType<typeof Bun.spawn>;
  output: string;
  status: "running" | "exited" | "killed";
  exitCode: number | null;
  pid?: number;
  /** Localhost server URLs detected in the output so far (deduped). */
  servers: string[];
}

/** Extract localhost server URLs printed by dev servers (vite/next/etc.). */
function detectServers(output: string): string[] {
  const urls = new Set<string>();
  const full =
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{2,5}[^\s)'"<>]*/gi;
  for (const m of output.matchAll(full)) urls.add(m[0].replace(/[.,]+$/, ""));
  // Bare "localhost:3000" / "127.0.0.1:8080" → assume http.
  const bare = /(?:^|\s)((?:localhost|127\.0\.0\.1):\d{2,5})\b/gi;
  for (const m of output.matchAll(bare)) urls.add(`http://${m[1]}`);
  return [...urls];
}

/** Cap on the sticky detected-server list per job (bounds high-cardinality output). */
const MAX_SERVERS = 64;

/**
 * Process-wide registry of background shell jobs. Lets the agent start a
 * long-running command (build, watcher, server) and keep working, polling with
 * `job_status` and stopping with `job_kill`. `onChange` fires when a job starts,
 * exits, is killed, or first exposes a localhost server — so the engine can push
 * a `jobs-changed` event to the TUI's `/jobs` sub-view.
 */
export class BackgroundJobs {
  #jobs = new Map<string, Job>();
  #seq = 0;
  #onChange?: () => void;

  constructor(opts?: { onChange?: () => void }) {
    this.#onChange = opts?.onChange;
  }

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
      pid: proc.pid,
      servers: [],
    };
    this.#jobs.set(job.id, job);
    this.#onChange?.();

    // Keep the last 100k chars as a rolling tail (no marker — the UI adds a `…`
    // prefix at display time via `tail()`) and surface dev-server URLs live.
    const append = (text: string) => {
      job.output += text;
      if (job.output.length > 100_000) job.output = job.output.slice(-100_000);
      // Surface a newly-bound dev-server URL as soon as it's printed. MERGE new
      // URLs into the sticky list rather than replacing it from the (truncated)
      // buffer — otherwise a server URL printed early scrolls out of the 100k
      // window and vanishes from `/jobs` while the server is still running.
      let added = false;
      for (const url of detectServers(job.output)) {
        if (!job.servers.includes(url)) {
          job.servers.push(url);
          // Bound the sticky list: a job that logs many distinct URLs (ephemeral
          // ports, request paths) must not grow it without limit. Keep the most
          // recent — real dev-server URLs are stable and stay.
          if (job.servers.length > MAX_SERVERS) job.servers.shift();
          added = true;
        }
      }
      if (added) this.#onChange?.();
    };
    // Fire-and-forget pumps: a stream error (e.g. broken pipe) must not become
    // an unhandled rejection — record it in the job's output instead.
    Promise.all([drainTextStream(proc.stdout, append), drainTextStream(proc.stderr, append)]).catch(
      (err) => {
        job.output += `\n[stream error: ${(err as Error).message}]`;
      },
    );
    proc.exited
      .then((code) => {
        if (job.status === "running") job.status = "exited";
        job.exitCode = code;
        this.#onChange?.();
      })
      .catch(() => {
        if (job.status === "running") job.status = "exited";
        this.#onChange?.();
      });
    return job;
  }

  get(id: string): Job | undefined {
    return this.#jobs.get(id);
  }

  list(): Job[] {
    return [...this.#jobs.values()];
  }

  /** UI-facing snapshot of every job (id, command, status, pid, servers, tail). */
  snapshot(): JobInfo[] {
    return this.list().map((j) => ({
      id: j.id,
      command: j.command,
      status: j.status,
      exitCode: j.exitCode,
      ...(j.pid ? { pid: j.pid } : {}),
      servers: j.servers,
      outputTail: tail(j.output, 2000),
    }));
  }

  kill(id: string): boolean {
    const job = this.#jobs.get(id);
    if (!job) return false;
    if (job.status === "running") {
      killTree(job.proc.pid);
      job.status = "killed";
      this.#onChange?.();
    }
    return true;
  }

  /** Reap every still-running job (process teardown) — a background dev server
   * must not outlive the CLI as an orphan. */
  killAll(): void {
    for (const [id, job] of this.#jobs) {
      if (job.status === "running") this.kill(id);
    }
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
