import { z } from "zod";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { drainTextStream, type JobInfo, type ToolDefinition } from "@vibe/shared";
import { killTree, killTreeAndWait } from "./process-tree.ts";
import { type SandboxPolicy, wrapCommand } from "../sandbox.ts";

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
  /** Tail of already-scanned output, re-prepended to the next chunk so a URL
   * split across two writes still matches (see SCAN_OVERLAP). */
  scanCarry: string;
}

interface Monitor {
  id: string;
  command: string;
  cwd: string;
  intervalMs: number;
  durable: boolean;
  active: boolean;
  lastJobId?: string;
  lastRunAt?: number;
  timer?: ReturnType<typeof setInterval>;
}

export interface BackgroundJobStartOptions {
  dangerouslyUnsandboxed?: boolean;
}

export function backgroundJobArgv(
  command: string,
  cwd: string,
  sandbox: SandboxPolicy | undefined,
  opts: BackgroundJobStartOptions = {},
): string[] {
  return sandbox && !opts.dangerouslyUnsandboxed
    ? wrapCommand(sandbox, { cwd, command })
    : ["bash", "-lc", command];
}

/** Extract localhost server URLs printed by dev servers (vite/next/etc.). */
function detectServers(output: string): string[] {
  const urls = new Set<string>();
  const full = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{2,5}[^\s)'"<>]*/gi;
  for (const m of output.matchAll(full)) urls.add(m[0].replace(/[.,]+$/, ""));
  // Bare "localhost:3000" / "127.0.0.1:8080" → assume http.
  const bare = /(?:^|\s)((?:localhost|127\.0\.0\.1):\d{2,5})\b/gi;
  for (const m of output.matchAll(bare)) urls.add(`http://${m[1]}`);
  return [...urls];
}

/** Cap on the sticky detected-server list per job (bounds high-cardinality output). */
const MAX_SERVERS = 64;

/** Chars of already-scanned tail re-scanned with each new chunk. Big enough for
 * any realistic dev-server URL to span a chunk boundary and still match whole;
 * a URL longer than this that straddles a boundary may be detected with a
 * truncated path — acceptable, the origin part is what matters. */
const SCAN_OVERLAP = 256;

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
  /** OS sandbox policy applied to every started job (dev servers/watchers run
   * under the same kernel backstop as foreground bash). Settable after
   * construction because the engine creates its registry before it resolves the
   * policy. */
  #sandbox?: SandboxPolicy;
  #monitors = new Map<string, Monitor>();
  #monitorSeq = 0;
  #persistencePath?: string;

  constructor(opts?: { onChange?: () => void; sandbox?: SandboxPolicy }) {
    this.#onChange = opts?.onChange;
    this.#sandbox = opts?.sandbox;
  }

  /** Set (or replace) the sandbox policy applied to subsequently-started jobs. */
  setSandbox(sandbox: SandboxPolicy | undefined): void {
    this.#sandbox = sandbox;
  }

  configurePersistence(path: string): void {
    this.#persistencePath = path;
    try {
      const rows = JSON.parse(readFileSync(path, "utf8")) as Omit<Monitor, "timer">[];
      for (const row of rows) {
        if (!row.durable || !row.active) continue;
        this.#monitors.set(row.id, { ...row });
        const n = Number(row.id.replace(/^monitor_/, ""));
        if (Number.isFinite(n)) this.#monitorSeq = Math.max(this.#monitorSeq, n);
        this.#armMonitor(this.#monitors.get(row.id)!);
      }
    } catch {
      /* no durable monitors yet */
    }
  }

  #persistMonitors(): void {
    if (!this.#persistencePath) return;
    try {
      mkdirSync(dirname(this.#persistencePath), { recursive: true });
      writeFileSync(
        this.#persistencePath,
        JSON.stringify(
          [...this.#monitors.values()].filter((m) => m.durable).map(({ timer: _timer, ...m }) => m),
        ),
        "utf8",
      );
    } catch {
      /* best-effort machine state */
    }
  }

  #armMonitor(monitor: Monitor): void {
    if (monitor.timer) clearInterval(monitor.timer);
    monitor.timer = setInterval(() => {
      if (!monitor.active) return;
      const previous = monitor.lastJobId ? this.#jobs.get(monitor.lastJobId) : undefined;
      if (previous?.status === "running") return; // rate limit: never overlap itself
      const job = this.start(monitor.command, monitor.cwd);
      monitor.lastJobId = job.id;
      monitor.lastRunAt = Date.now();
      this.#persistMonitors();
      this.#onChange?.();
    }, monitor.intervalMs);
  }

  startMonitor(command: string, cwd: string, intervalMs: number, durable = true): Monitor {
    const monitor: Monitor = {
      id: `monitor_${++this.#monitorSeq}`,
      command,
      cwd,
      intervalMs: Math.max(5_000, intervalMs),
      durable,
      active: true,
    };
    this.#monitors.set(monitor.id, monitor);
    this.#armMonitor(monitor);
    this.#persistMonitors();
    this.#onChange?.();
    return monitor;
  }

  stopMonitor(id: string): boolean {
    const monitor = this.#monitors.get(id);
    if (!monitor) return false;
    monitor.active = false;
    if (monitor.timer) clearInterval(monitor.timer);
    this.#monitors.delete(id);
    this.#persistMonitors();
    this.#onChange?.();
    return true;
  }

  monitorSnapshot(): {
    id: string;
    command: string;
    intervalMs: number;
    durable: boolean;
    active: boolean;
    lastJobId?: string;
    lastRunAt?: number;
  }[] {
    return [...this.#monitors.values()].map(({ timer: _timer, cwd: _cwd, ...monitor }) => ({
      ...monitor,
    }));
  }

  start(command: string, cwd: string, opts: BackgroundJobStartOptions = {}): Job {
    const argv = backgroundJobArgv(command, cwd, this.#sandbox, opts);
    const proc = Bun.spawn(argv, {
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
      scanCarry: "",
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
      // Scan ONLY the carry + new chunk, never the whole accumulated buffer:
      // rescanning the full 100k tail on every chunk is O(n²) regex over
      // untrusted job output (the known bad pattern class). The carry re-covers
      // the chunk boundary so a URL split across two writes still matches, and
      // the `includes` dedup below keeps overlap re-matches from re-announcing.
      const window = job.scanCarry + text;
      job.scanCarry = window.slice(-SCAN_OVERLAP);
      let added = false;
      for (const url of detectServers(window)) {
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

  async wait(ids: string[], mode: "any" | "all", timeoutMs = 300_000): Promise<Job[]> {
    const rows = ids.map((id) => this.#jobs.get(id)).filter((job): job is Job => !!job);
    const waits = rows
      .filter((job) => job.status === "running")
      .map((job) => job.proc.exited.catch(() => undefined));
    if (waits.length) {
      const settle = mode === "any" ? Promise.race(waits) : Promise.allSettled(waits);
      await Promise.race([
        settle,
        new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, timeoutMs))),
      ]);
    }
    return rows;
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
   * must not outlive the CLI as an orphan. Fire-and-forget SIGTERM→SIGKILL. */
  killAll(): void {
    for (const [id, job] of this.#jobs) {
      if (job.status === "running") this.kill(id);
    }
    for (const monitor of this.#monitors.values()) if (monitor.timer) clearInterval(monitor.timer);
  }

  /** Reap every still-running job AND await the SIGKILL escalation. On the
   * shutdown path the CLI process exits right after this resolves, so the plain
   * fire-and-forget `killTree` timer would be cancelled before it escalated,
   * leaving a stuck child (e.g. a dev server ignoring SIGTERM) orphaned. Awaiting
   * `killTreeAndWait` guarantees the whole tree is gone before the process exits. */
  async killAllAndWait(graceMs = 1_500): Promise<void> {
    const trees: Promise<void>[] = [];
    for (const [, job] of this.#jobs) {
      if (job.status === "running") {
        job.status = "killed";
        trees.push(killTreeAndWait(job.proc.pid, graceMs));
      }
    }
    if (trees.length) this.#onChange?.();
    for (const monitor of this.#monitors.values()) if (monitor.timer) clearInterval(monitor.timer);
    await Promise.all(trees);
  }
}

function tail(s: string, n = 4000): string {
  return s.length > n ? `…${s.slice(-n)}` : s;
}

/** Build the background-job tools bound to a shared registry. */
export function backgroundJobTools(jobs: BackgroundJobs): ToolDefinition[] {
  const StatusInput = z.object({
    id: z.string().optional().describe("One job id from a background bash run."),
    ids: z.array(z.string()).optional().describe("Several job ids for wait-any/wait-all."),
    wait: z.boolean().optional(),
    waitMode: z.enum(["any", "all"]).optional(),
    timeoutMs: z.number().int().min(0).max(3_600_000).optional(),
  });

  const statusTool: ToolDefinition<z.infer<typeof StatusInput>> = {
    name: "job_status",
    description: "Check a background job's status and recent output.",
    inputSchema: StatusInput,
    readOnly: true,
    async execute({ id, ids, wait, waitMode, timeoutMs }) {
      const selected = [...new Set([...(ids ?? []), ...(id ? [id] : [])])];
      if (!selected.length) return { output: "Pass `id` or `ids`.", isError: true };
      const rows = wait
        ? await jobs.wait(selected, waitMode ?? "all", timeoutMs ?? 300_000)
        : selected.map((value) => jobs.get(value)).filter((job): job is Job => !!job);
      if (!rows.length) return { output: `No such job: ${selected.join(", ")}`, isError: true };
      return {
        output: rows
          .map((job) => {
            const head = `${job.id} [${job.status}${job.exitCode !== null ? ` exit ${job.exitCode}` : ""}] ${job.command}`;
            return `${head}\n${tail(job.output) || "(no output yet)"}`;
          })
          .join("\n\n"),
      };
    },
  };

  const KillInput = z.object({ id: z.string().optional(), ids: z.array(z.string()).optional() });
  const killTool: ToolDefinition<z.infer<typeof KillInput>> = {
    name: "job_kill",
    description: "Stop a running background job.",
    inputSchema: KillInput,
    readOnly: false,
    concurrencySafe: false,
    async execute({ id, ids }) {
      const selected = [...new Set([...(ids ?? []), ...(id ? [id] : [])])];
      const killed = selected.filter((value) => jobs.kill(value));
      return killed.length
        ? { output: `Killed: ${killed.join(", ")}.` }
        : { output: `No such job: ${selected.join(", ") || "(none)"}`, isError: true };
    },
  };

  const MonitorInput = z.object({
    command: z.string(),
    intervalMs: z.number().int().min(5_000),
    durable: z.boolean().optional(),
  });
  const monitorStart: ToolDefinition<z.infer<typeof MonitorInput>> = {
    name: "monitor_start",
    description:
      "Run a command on a rate-limited interval without overlapping prior runs. Durable monitors resume after restart.",
    inputSchema: MonitorInput,
    readOnly: false,
    concurrencySafe: false,
    async execute({ command, intervalMs, durable }, ctx) {
      const monitor = jobs.startMonitor(command, ctx.cwd, intervalMs, durable ?? true);
      return {
        output: `Started ${monitor.id} every ${monitor.intervalMs}ms${monitor.durable ? " (durable)" : ""}.`,
      };
    },
  };
  const MonitorId = z.object({ id: z.string() });
  const MonitorStatus = z.object({ id: z.string().optional() });
  const monitorStatus: ToolDefinition<z.infer<typeof MonitorStatus>> = {
    name: "monitor_status",
    description: "List durable/rate-limited monitors, or inspect one by id.",
    inputSchema: MonitorStatus,
    readOnly: true,
    async execute({ id }) {
      const rows = jobs.monitorSnapshot().filter((row) => !id || row.id === id);
      return rows.length
        ? {
            output: rows
              .map(
                (row) =>
                  `${row.id} [${row.active ? "active" : "stopped"}] every ${row.intervalMs}ms: ${row.command}${row.lastJobId ? ` (last ${row.lastJobId})` : ""}`,
              )
              .join("\n"),
          }
        : {
            output: id ? `No such monitor: ${id}` : "No monitors.",
            ...(id ? { isError: true } : {}),
          };
    },
  };
  const monitorStop: ToolDefinition<z.infer<typeof MonitorId>> = {
    name: "monitor_stop",
    description: "Stop and remove a scheduled monitor.",
    inputSchema: MonitorId,
    readOnly: false,
    concurrencySafe: false,
    async execute({ id }) {
      return jobs.stopMonitor(id)
        ? { output: `Stopped ${id}.` }
        : { output: `No such monitor: ${id}`, isError: true };
    },
  };
  return [statusTool, killTool, monitorStart, monitorStatus, monitorStop];
}
