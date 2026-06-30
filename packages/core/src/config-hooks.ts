import { Glob } from "bun";
import type { HookConfig } from "@vibe/config";
import type { HookBus, HookName, HookHandler } from "@vibe/plugins";

/**
 * Bridges declarative config hooks (shell command / HTTP URL) onto the in-process
 * HookBus, unlocking the Claude-Code-style extensibility ecosystem with no engine
 * surgery: each config hook becomes a HookBus handler that serializes the payload
 * to JSON, runs the command / POSTs the URL, and maps the response back onto the
 * payload — `{deny,reason}` to block a tool, `{input}` to rewrite its arguments.
 * exec/post are injectable so the wiring is unit-testable without spawning.
 */

export interface HookRunResult {
  /** Block the tool (only honored on tool.before.execute). */
  deny?: boolean;
  reason?: string;
  /** Rewrite the tool input (only honored on tool.before.execute). */
  input?: unknown;
}

export interface ConfigHookRunners {
  /** Run a shell command with `payloadJson` on stdin; return parsed stdout JSON. */
  exec?: (command: string, payloadJson: string) => Promise<HookRunResult>;
  /** POST `payload` to `url`; return parsed JSON response. */
  post?: (url: string, payload: unknown) => Promise<HookRunResult>;
  /** Per-hook wall-clock timeout (ms). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Default shell runner: spawn `sh -c command`, feed JSON on stdin, parse stdout. */
async function defaultExec(command: string, payloadJson: string, timeoutMs: number): Promise<HookRunResult> {
  const proc = Bun.spawn(["sh", "-c", command], {
    stdin: new TextEncoder().encode(payloadJson),
    stdout: "pipe",
    stderr: "ignore",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return parseHookOutput(out);
}

/** Default HTTP runner: POST JSON, parse JSON response. */
async function defaultPost(url: string, payload: unknown, timeoutMs: number): Promise<HookRunResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return {};
  return parseHookOutput((await res.text()).trim());
}

/** Parse a hook's textual output into a result (empty/non-JSON → no-op). */
export function parseHookOutput(text: string): HookRunResult {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const result: HookRunResult = {};
    if (parsed.deny === true) result.deny = true;
    if (typeof parsed.reason === "string") result.reason = parsed.reason;
    if ("input" in parsed) result.input = parsed.input;
    return result;
  } catch {
    return {}; // non-JSON output (e.g. a log line) is not a directive
  }
}

/** Whether a tool name matches the hook's glob matcher (no matcher = all). */
function matches(matcher: string | undefined, toolName: unknown): boolean {
  if (!matcher) return true;
  if (typeof toolName !== "string") return false;
  return new Glob(matcher).match(toolName);
}

/**
 * Register every config hook as a HookBus handler. Returns nothing; handler
 * errors are isolated by the HookBus. `onError` (optional) is notified of a
 * misconfigured hook (no command/url).
 */
export function registerConfigHooks(
  hooks: HookConfig[],
  bus: HookBus,
  runners: ConfigHookRunners = {},
): void {
  const timeoutMs = runners.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const exec = runners.exec ?? ((cmd, json) => defaultExec(cmd, json, timeoutMs));
  const post = runners.post ?? ((url, payload) => defaultPost(url, payload, timeoutMs));

  for (const hook of hooks) {
    if (!hook.command && !hook.url) continue; // nothing to run
    const handler = (async (payload: unknown) => {
      // Tool events: only fire when the matcher matches the tool name.
      const isToolEvent = hook.event === "tool.before.execute" || hook.event === "tool.after.execute";
      if (isToolEvent && !matches(hook.matcher, (payload as { toolName?: unknown }).toolName)) {
        return undefined;
      }
      const run = hook.command
        ? exec(hook.command, JSON.stringify(payload))
        : post(hook.url!, payload);
      // Fire-and-forget hooks can't deny or rewrite; don't await them.
      if (hook.async) {
        void run.catch(() => undefined);
        return undefined;
      }
      const result = await run;
      // deny/reason/input only apply to the vetoable tool.before.execute payload.
      if (hook.event === "tool.before.execute") {
        const p = payload as { deny?: boolean; reason?: string; input?: unknown };
        if (result.deny) {
          p.deny = true;
          if (result.reason) p.reason = result.reason;
        }
        if ("input" in result) p.input = result.input;
        return p;
      }
      return undefined;
    }) as HookHandler<HookName>;
    bus.on(hook.event as HookName, handler);
  }
}
