import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { killTreeAndWait } from "./builtins/process-tree.ts";

/**
 * A thin OS-level sandbox — defense-in-depth UNDER the permission engine. The
 * permission engine stays the policy brain (what the model is allowed to ask
 * for); this module is the kernel backstop (what the OS actually lets a spawned
 * command touch), so a command that slips past a string-glob `match` rule still
 * can't write outside the workspace or reach the network when policy forbids it.
 *
 * Stateless by design: one resolved {@link SandboxPolicy} value is threaded to
 * every command-spawning seam (`bash`, background jobs, the build gate, verify)
 * exactly like `checkPermission` already is — no manager layer, no process state.
 *
 * Backends:
 *  - macOS: Apple's `sandbox-exec` (Seatbelt) with a generated profile.
 *  - Linux: `bwrap` (bubblewrap) with a bind-mount argv.
 *  - anything else / missing binary: unavailable — the engine emits ONE human
 *    warning and commands run UNSANDBOXED (never silently "sandboxed").
 */

export type SandboxMode = "off" | "read-only" | "workspace-write";
export type SandboxNetwork = "on" | "off";
export type SandboxBackend = "seatbelt" | "bwrap" | "none";

/** The config surface `resolveSandboxPolicy` reads (matches `config.sandbox`). */
export interface SandboxConfig {
  mode: SandboxMode;
  network: SandboxNetwork;
  writablePaths: string[];
}

/**
 * The resolved, thread-everywhere sandbox value. `available:false` means a mode
 * was requested but no backend exists here (win32, or a missing binary) — the
 * engine surfaces `warning` once and `wrapCommand` degrades to the base argv.
 */
export interface SandboxPolicy {
  mode: SandboxMode;
  network: SandboxNetwork;
  /** Absolute roots that stay writable under `workspace-write` (deduped). */
  writablePaths: string[];
  backend: SandboxBackend;
  /** True when the requested mode can actually be enforced here. */
  available: boolean;
  /** Human-readable reason commands are UNSANDBOXED (only when unavailable). */
  warning?: string;
}

/** Injectable environment probes so the resolver is unit-testable off-platform. */
export interface SandboxResolveOptions {
  /** Session working directory (always a writable root under workspace-write). */
  cwd: string;
  /** Extra app state dirs to keep writable (vibeConfigDir, ~/.cache, <cwd>/.vibe). */
  stateDirs?: string[];
  /** Override `process.platform` (tests). */
  platform?: NodeJS.Platform;
  /** Override binary discovery (tests); returns a path or null/undefined. */
  which?: (bin: string) => string | null | undefined;
  /** Override `process.env` (tests) — read for the `VIBE_SANDBOX` override. */
  env?: Record<string, string | undefined>;
  /**
   * Override the Linux `bwrap` user-namespace smoke test (tests). Returns true
   * when a minimal `bwrap` launch actually succeeds. The default probes the real
   * binary ONCE (cached): binary presence alone over-reports availability on a
   * hardened kernel with unprivileged user namespaces disabled, where bwrap is
   * installed yet EPERMs every launch.
   */
  smokeBwrap?: () => boolean;
}

/** Fixed safety limits for `/loop --until-cmd`. These are deliberately not
 * derived from the model-facing bash tool or the user's sandbox config. */
export const READ_ONLY_COMMAND_TIMEOUT_MS = 30_000;
export const READ_ONLY_COMMAND_OUTPUT_CAP = 8 * 1024;

export interface ReadOnlyCommandResult {
  code: number;
  /** Combined stdout/stderr, retained up to {@link READ_ONLY_COMMAND_OUTPUT_CAP}. */
  output: string;
}

/** Test-only platform/process probes. Production callers should omit this. */
export interface ReadOnlyCommandRunnerDeps {
  platform?: NodeJS.Platform;
  which?: (bin: string) => string | null | undefined;
  smokeBwrap?: () => boolean;
  timeoutMs?: number;
  killGraceMs?: number;
}

export interface ReadOnlyCommandOptions {
  signal?: AbortSignal;
  /** Injectable probes keep unavailable/timeout behavior deterministic in tests. */
  deps?: ReadOnlyCommandRunnerDeps;
}

function dedupeAbsolute(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    const abs = resolve(p);
    if (!seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  }
  return out;
}

/**
 * Best-effort realpath of a writable root. Seatbelt's `subpath` (and, to a
 * lesser degree, bind mounts) match the CANONICAL path, so on macOS a `cwd` /
 * `tmpdir` under the `/var → /private/var` (or `/tmp → /private/tmp`) symlink
 * must be dereferenced or every write "inside" the root is still EPERM'd.
 * Resolves the longest EXISTING ancestor and re-appends the not-yet-created tail
 * (a state dir like `.vibe` may not exist yet). Any FS error → the lexical
 * absolute (nothing regresses). Kept OUT of the pure builders so their snapshots
 * stay deterministic; only the resolver canonicalizes.
 */
function canonicalizeRoot(path: string): string {
  const abs = resolve(path);
  try {
    let dir = abs;
    const tail: string[] = [];
    while (!existsSync(dir)) {
      const parent = dirname(dir);
      if (parent === dir) return abs; // reached root, nothing exists
      tail.unshift(basename(dir));
      dir = parent;
    }
    const real = realpathSync(dir);
    return tail.length ? join(real, ...tail) : real;
  } catch {
    return abs;
  }
}

/** One-time cache for the default bwrap user-namespace probe (runs at most once). */
let bwrapUsernsOk: boolean | undefined;

/**
 * `bwrap` on the PATH does not mean it WORKS: a minimal launch still fails when
 * unprivileged user namespaces are disabled (a common hardened-kernel default —
 * `kernel.unprivileged_userns_clone=0`), which would EPERM every sandboxed
 * command confusingly. Probe the smallest possible sandboxed invocation and
 * require exit 0. Cached so it costs at most one cheap spawn per process.
 */
function defaultBwrapSmoke(): boolean {
  if (bwrapUsernsOk !== undefined) return bwrapUsernsOk;
  try {
    const proc = Bun.spawnSync(["bwrap", "--ro-bind", "/", "/", "true"], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    bwrapUsernsOk = proc.success;
  } catch {
    bwrapUsernsOk = false;
  }
  return bwrapUsernsOk;
}

/**
 * Resolve config + the live environment into the value threaded everywhere.
 * A `VIBE_SANDBOX` env override (`off|read-only|workspace-write`) wins over
 * config so a run can be tightened/loosened without editing the file. Backend
 * selection is by platform + binary presence; when a non-off mode is requested
 * but unenforceable, `available:false` + `warning` is returned (the engine emits
 * the warning ONCE — never a silent no-op).
 */
export function resolveSandboxPolicy(
  cfg: SandboxConfig,
  opts: SandboxResolveOptions,
): SandboxPolicy {
  const platform = opts.platform ?? process.platform;
  const which = opts.which ?? ((bin: string) => Bun.which(bin));
  const env = opts.env ?? process.env;

  const override = env.VIBE_SANDBOX?.trim();
  const mode: SandboxMode =
    override === "off" || override === "read-only" || override === "workspace-write"
      ? override
      : cfg.mode;
  const network = cfg.network;

  // Writable roots are computed for EVERY mode (they only bite under
  // workspace-write); `policyForChecks` upgrades read-only→workspace-write so
  // the gate can write to exactly these. Canonicalized (realpath) so a macOS
  // `/var`-symlinked cwd/tmp is actually writable under Seatbelt.
  const writablePaths = dedupeAbsolute(
    [opts.cwd, tmpdir(), ...(opts.stateDirs ?? []), ...cfg.writablePaths].map(canonicalizeRoot),
  );

  const base = { mode, network, writablePaths };

  // Off is always "available" — there is nothing to be unavailable.
  if (mode === "off") return { ...base, backend: "none", available: true };

  if (platform === "darwin") {
    if (which("sandbox-exec")) return { ...base, backend: "seatbelt", available: true };
    return {
      ...base,
      backend: "none",
      available: false,
      warning:
        "sandbox.mode is set but `sandbox-exec` was not found on this macOS host — commands run UNSANDBOXED.",
    };
  }
  if (platform === "linux") {
    if (which("bwrap")) {
      // Presence is necessary but not sufficient — a hardened kernel with
      // unprivileged user namespaces disabled has bwrap installed yet fails every
      // launch. Gate `available` on a real (cached) smoke launch so we degrade to
      // an honest warning instead of EPERM'ing every sandboxed command.
      const smoke = opts.smokeBwrap ?? defaultBwrapSmoke;
      if (smoke()) return { ...base, backend: "bwrap", available: true };
      return {
        ...base,
        backend: "none",
        available: false,
        warning:
          "sandbox.mode is set but `bwrap` (bubblewrap) is installed yet fails to launch — unprivileged user namespaces are likely disabled on this kernel (e.g. `sysctl kernel.unprivileged_userns_clone=0`). Enable them or run without the sandbox. Commands run UNSANDBOXED.",
      };
    }
    return {
      ...base,
      backend: "none",
      available: false,
      warning:
        "sandbox.mode is set but `bwrap` (bubblewrap) was not found — install bubblewrap to enable the sandbox. Commands run UNSANDBOXED.",
    };
  }
  return {
    ...base,
    backend: "none",
    available: false,
    warning: `sandbox.mode is set but OS sandboxing is unsupported on ${platform} — commands run UNSANDBOXED.`,
  };
}

/**
 * Upgrade a `read-only` policy to `workspace-write` for the engine's OWN command
 * paths (green gate, build checks, verify) — they MUST write artifacts
 * (tsbuildinfo, dist, coverage) even when the model-facing default is pinned
 * read-only. Every other field is untouched, and off/workspace-write pass
 * through unchanged. Idempotent.
 */
export function policyForChecks(policy: SandboxPolicy): SandboxPolicy {
  return policy.mode === "read-only" ? { ...policy, mode: "workspace-write" } : policy;
}

/** The writable roots granted under workspace-write — cwd is always included. */
function writableRoots(policy: SandboxPolicy, cwd: string): string[] {
  return dedupeAbsolute([cwd, ...policy.writablePaths]);
}

/** Escape a path for embedding in a Seatbelt string literal. */
function seatbeltQuote(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Build the Seatbelt profile passed to `sandbox-exec -p`. Deny-by-default, then
 * re-open the minimum: subprocesses, all reads, per-root writes (only under
 * workspace-write), and network ONLY when enabled (omitted otherwise so the
 * default-deny bites). Pure + snapshot-testable.
 */
export function seatbeltProfile(policy: SandboxPolicy, cwd: string): string {
  const lines = ["(version 1)", "(deny default)", "(allow process*)", "(allow file-read*)"];
  if (policy.mode === "workspace-write") {
    for (const root of writableRoots(policy, cwd)) {
      lines.push(`(allow file-write* (subpath ${seatbeltQuote(root)}))`);
    }
  }
  if (policy.network === "on") lines.push("(allow network*)");
  return lines.join("\n");
}

/**
 * Build the `bwrap` argv (after the `bwrap` binary, before the base command).
 * The whole FS is bound read-only, then each writable root is re-bound
 * read-write (workspace-write only), `/dev` + `/proc` are fresh, and the network
 * namespace is unshared when network is off. Pure + snapshot-testable.
 */
export function bwrapArgs(policy: SandboxPolicy, cwd: string): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  if (policy.mode === "workspace-write") {
    for (const root of writableRoots(policy, cwd)) {
      args.push("--bind", root, root);
    }
  }
  if (policy.network === "off") args.push("--unshare-net");
  return args;
}

/**
 * Wrap the base shell argv so the OS enforces the policy. The base mirrors how
 * `bash.ts`/`bunExec` spawn a command EXACTLY (`bash -lc <command>`), so an
 * off/unavailable policy returns it unchanged — sandboxing is a transparent
 * prefix, never a behavior change.
 */
export function wrapCommand(
  policy: SandboxPolicy,
  opts: { cwd: string; command: string },
): string[] {
  const base = ["bash", "-lc", opts.command];
  if (policy.mode === "off" || !policy.available) return base;
  if (policy.backend === "seatbelt") {
    return ["sandbox-exec", "-p", seatbeltProfile(policy, opts.cwd), ...base];
  }
  if (policy.backend === "bwrap") {
    return ["bwrap", ...bwrapArgs(policy, opts.cwd), ...base];
  }
  return base;
}

function abortError(): Error {
  const err = new Error("read-only command check aborted");
  err.name = "AbortError";
  return err;
}

/** Drain a byte stream while retaining at most `cap` bytes across both streams. */
async function drainCombinedBytes(
  stream: ReadableStream<Uint8Array>,
  chunks: Uint8Array[],
  state: { retained: number },
  cap: number,
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || state.retained >= cap) continue;
      const kept = value.slice(0, cap - state.retained);
      if (kept.byteLength) {
        chunks.push(kept);
        state.retained += kept.byteLength;
      }
    }
  } catch {
    // A timeout/abort cancels the process tree and closes its pipes. Preserve
    // whatever was captured before that expected cancellation race.
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * Run a user-authored stop check under a mandatory kernel sandbox.
 *
 * This is intentionally separate from `bunExec`, `policyForChecks`, and the
 * model-facing sandbox policy: loop checks are untrusted shell strings and must
 * always see a read-only filesystem with networking disabled. Missing Seatbelt
 * or bwrap is an error (fail closed); there is no unsandboxed fallback, even
 * when config or `VIBE_SANDBOX` says `off`.
 */
export async function runSandboxedReadOnlyCommand(
  command: string,
  cwd: string,
  opts: ReadOnlyCommandOptions = {},
): Promise<ReadOnlyCommandResult> {
  if (opts.signal?.aborted) throw abortError();
  const deps = opts.deps;
  const policy = resolveSandboxPolicy(
    { mode: "read-only", network: "off", writablePaths: [] },
    {
      cwd,
      platform: deps?.platform,
      which: deps?.which,
      smokeBwrap: deps?.smokeBwrap,
      // An empty environment is security-significant: the required policy must
      // ignore a process-level VIBE_SANDBOX=off override.
      env: {},
    },
  );
  if (!policy.available || policy.mode !== "read-only" || policy.backend === "none") {
    throw new Error(
      `read-only command sandbox unavailable: ${policy.warning ?? "no supported kernel backend"}`,
    );
  }

  const argv = wrapCommand(policy, { cwd, command });
  // `wrapCommand` normally degrades for unavailable policies. The explicit
  // prefix assertion makes this high-risk caller fail closed if that behavior
  // ever changes or a malformed policy slips through.
  if (argv[0] !== "sandbox-exec" && argv[0] !== "bwrap") {
    throw new Error("read-only command sandbox unavailable: refusing an unsandboxed fallback");
  }

  const proc = (() => {
    try {
      return Bun.spawn(argv, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
    } catch (err) {
      throw new Error(`read-only command sandbox failed to start: ${(err as Error).message}`);
    }
  })();

  let timedOut = false;
  let aborted = false;
  let killing: Promise<void> | undefined;
  const kill = () => (killing ??= killTreeAndWait(proc.pid, deps?.killGraceMs).catch(() => {}));
  const timeoutMs = deps?.timeoutMs ?? READ_ONLY_COMMAND_TIMEOUT_MS;
  const timer = setTimeout(() => {
    timedOut = true;
    void kill();
  }, timeoutMs);
  const onAbort = () => {
    aborted = true;
    void kill();
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  const chunks: Uint8Array[] = [];
  const state = { retained: 0 };
  const pumps = Promise.all([
    drainCombinedBytes(proc.stdout, chunks, state, READ_ONLY_COMMAND_OUTPUT_CAP),
    drainCombinedBytes(proc.stderr, chunks, state, READ_ONLY_COMMAND_OUTPUT_CAP),
  ]);
  let code: number;
  try {
    code = await proc.exited;
    await pumps;
    if (killing) await killing;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }

  const bytes = new Uint8Array(state.retained);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const output = new TextDecoder().decode(bytes);
  if (aborted) throw abortError();
  if (timedOut) {
    throw new Error(`read-only command check timed out after ${READ_ONLY_COMMAND_TIMEOUT_MS}ms`);
  }
  return { code, output };
}

/** A sandbox-denial signature in a failed command's combined output. */
const DENIAL_SIGNATURE = /EPERM|Operation not permitted|bwrap:/i;

/**
 * When a SANDBOXED command fails with a kernel-denial signature, append ONE
 * actionable line telling the user (and the model) how to unblock it — the
 * whole point of shipping the sandbox opt-in with a good denial UX. A non-error
 * exit, an off/unavailable policy, or output with no denial signature is
 * returned untouched, so this never fires on ordinary command failures.
 */
export function annotateDenial(output: string, code: number, policy: SandboxPolicy): string {
  if (code === 0) return output;
  if (policy.mode === "off" || !policy.available) return output;
  if (!DENIAL_SIGNATURE.test(output)) return output;
  return (
    `${output}\n\n[vibe sandbox] This command was blocked by the OS sandbox ` +
    `(${policy.backend}, mode:${policy.mode}, network:${policy.network}). To unblock: add the path to ` +
    `sandbox.writablePaths, set sandbox.network:"on", or re-run this exact command with ` +
    `dangerouslyUnsandboxed:true (which requires an explicit approval).`
  );
}
