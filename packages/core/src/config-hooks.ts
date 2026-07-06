import { Glob } from "bun";
import { readCappedText } from "@vibe/shared";
import type { HookConfig } from "@vibe/config";
import type { HookBus, HookName, HookHandler } from "@vibe/plugins";

/**
 * Bridges declarative config hooks (shell command / HTTP URL) onto the in-process
 * HookBus, unlocking the Claude-Code-style extensibility ecosystem with no engine
 * surgery: each config hook becomes a HookBus handler that serializes the payload
 * to JSON, runs the command / POSTs the URL, and maps the response back onto the
 * payload. Four events consume a response:
 *   - `tool.before.execute` — `{deny,reason}` blocks the tool, `{input}` rewrites its arguments.
 *   - `tool.after.execute`  — `{additionalContext}` is appended to the (already-produced) result,
 *                             `{deny,reason}` hides/overrides it with an isError (the tool DID run).
 *   - `user.prompt.submit`  — `{deny}` cancels the turn, `{text}` (or a string `{input}`) rewrites the prompt.
 *   - `session.idle`        — `{continue}` (+`{reason}`) injects one more turn instead of settling idle.
 * exec/post are injectable so the wiring is unit-testable without spawning.
 */

export interface HookRunResult {
  /** Block/override: block the tool (tool.before.execute), hide+override the
   * result (tool.after.execute), or cancel the turn (user.prompt.submit). */
  deny?: boolean;
  reason?: string;
  /** Rewrite the tool input (tool.before.execute), or the prompt text when a string
   * (user.prompt.submit) — `{text}` takes precedence for a prompt rewrite. */
  input?: unknown;
  /** Rewrite the submitted prompt text (only honored on user.prompt.submit). */
  text?: string;
  /** Append to the tool result the model sees next step (tool.after.execute). */
  additionalContext?: string;
  /** Request one more turn at session.idle instead of settling idle (bounded by
   * the engine). Paired with `reason` to build the synthetic follow-up prompt. */
  continue?: boolean;
}

export interface ConfigHookRunners {
  /** Run a shell command with `payloadJson` on stdin; return parsed stdout JSON. */
  exec?: (command: string, payloadJson: string) => Promise<HookRunResult>;
  /** POST `payload` to `url`; return parsed JSON response. */
  post?: (url: string, payload: unknown) => Promise<HookRunResult>;
  /** Per-hook wall-clock timeout (ms). */
  timeoutMs?: number;
  /** Surface a misconfiguration (a hook with neither command nor url). Defaults
   * to `console.warn`; the engine wires it to its notice channel. */
  onWarn?: (message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Ceiling on hook stdout retained in memory (a runaway hook can't OOM the turn). */
const MAX_HOOK_OUTPUT = 1_000_000;

/**
 * Default shell runner: spawn `sh -c command`, feed JSON on stdin, parse stdout.
 *
 * The timeout is enforced on the READ, not just via `AbortSignal` on the spawn:
 * `AbortSignal.timeout` only SIGTERMs the direct `sh`, but a hook that spawns a
 * child which outlives the shell (a pipeline, a `cmd &`, a daemon) keeps the
 * inherited stdout pipe open, so a naive `await Response(stdout).text()` blocks
 * far past `timeoutMs` — indefinitely for a long-lived helper — wedging the whole
 * agent turn (the hook runs on the tool-execute path). Instead we read with a
 * cancelable reader and, on timeout, kill the shell AND cancel the read so the
 * function always returns within `timeoutMs`, parsing whatever output arrived.
 */
export async function defaultExec(
  command: string,
  payloadJson: string,
  timeoutMs: number,
): Promise<HookRunResult> {
  const proc = Bun.spawn(["sh", "-c", command], {
    stdin: new TextEncoder().encode(payloadJson),
    stdout: "pipe",
    stderr: "ignore",
  });
  const abort = new AbortController();
  const timer = setTimeout(() => {
    proc.kill(); // best-effort SIGTERM the shell (a detached child may linger)
    abort.abort(); // cancel the read too, to unblock a read wedged on the pipe
  }, timeoutMs);
  try {
    const { text } = await readCappedText(proc.stdout, {
      cap: MAX_HOOK_OUTPUT,
      signal: abort.signal,
    });
    return parseHookOutput(text.trim());
  } finally {
    clearTimeout(timer);
  }
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
  // Cap the body a hook endpoint can return (the wall clock is already bounded by
  // the abort signal above; this bounds memory). A hook's directive is tiny JSON.
  const body = res.body
    ? (await readCappedText(res.body, { cap: HOOK_BODY_CAP })).text
    : await res.text();
  return parseHookOutput(body.trim());
}

/** Cap on a `url:` hook's HTTP response body (its directive is small JSON). */
const HOOK_BODY_CAP = 256_000;

/** Parse a hook's textual output into a result (empty/non-JSON → no-op). */
export function parseHookOutput(text: string): HookRunResult {
  if (!text) return {};
  const parsed = parseHookJson(text);
  if (!parsed || Array.isArray(parsed)) return {};
  const result: HookRunResult = {};
  if (parsed.deny === true) result.deny = true;
  if (typeof parsed.reason === "string") result.reason = parsed.reason;
  if ("input" in parsed) result.input = parsed.input;
  if (typeof parsed.text === "string") result.text = parsed.text;
  if (typeof parsed.additionalContext === "string") result.additionalContext = parsed.additionalContext;
  if (parsed.continue === true) result.continue = true;
  return result;
}

function parseHookJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    // Hooks may print progress before their directive, but the directive must be
    // the final non-empty stdout line so logged payloads can't be mistaken for it.
    const lastLine = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
    if (!lastLine?.startsWith("{") || !lastLine.endsWith("}")) return undefined;
    try {
      const parsed = JSON.parse(lastLine) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // Final line is not a valid directive.
    }
    return undefined;
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
 * errors are isolated by the HookBus.
 */
export function registerConfigHooks(
  hooks: HookConfig[],
  bus: HookBus,
  runners: ConfigHookRunners = {},
): void {
  const timeoutMs = runners.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const exec = runners.exec ?? ((cmd, json) => defaultExec(cmd, json, timeoutMs));
  const post = runners.post ?? ((url, payload) => defaultPost(url, payload, timeoutMs));
  const onWarn = runners.onWarn ?? ((m: string) => console.warn(m));

  for (const hook of hooks) {
    if (!hook.command && !hook.url) {
      // A hook that names no command AND no url can never run — surface it
      // instead of dropping it silently, so a typo doesn't fail closed unseen.
      onWarn(`Ignoring "${hook.event}" hook: it has neither a command nor a url.`);
      continue;
    }
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
      // deny/reason/input veto or rewrite the tool.before.execute payload.
      if (hook.event === "tool.before.execute") {
        const p = payload as { deny?: boolean; reason?: string; input?: unknown };
        if (result.deny) {
          p.deny = true;
          if (result.reason) p.reason = result.reason;
        }
        if ("input" in result) p.input = result.input;
        return p;
      }
      // PostToolUse: the tool already ran. `additionalContext` is appended to the
      // result the model sees; `deny` (+reason) hides/overrides it with an error.
      if (hook.event === "tool.after.execute") {
        const p = payload as { deny?: boolean; reason?: string; additionalContext?: string };
        if (result.deny) {
          p.deny = true;
          if (result.reason) p.reason = result.reason;
        }
        if (typeof result.additionalContext === "string") p.additionalContext = result.additionalContext;
        return p;
      }
      // Stop-equivalent: `continue` (+reason) injects one more turn instead of
      // settling idle; the engine hard-bounds how many times this can fire.
      if (hook.event === "session.idle") {
        const p = payload as { continue?: boolean; reason?: string };
        if (result.continue) {
          p.continue = true;
          if (result.reason) p.reason = result.reason;
        }
        return p;
      }
      // A prompt hook can cancel the turn (deny) or rewrite the submitted text.
      // The engine threads `text` into recall/mentions/turn and honors `deny`.
      if (hook.event === "user.prompt.submit") {
        const p = payload as { text: string; deny?: boolean };
        if (result.deny) {
          p.deny = true;
          return p;
        }
        // Prefer an explicit `{text}`; fall back to a string `{input}`.
        if (typeof result.text === "string") p.text = result.text;
        else if (typeof result.input === "string") p.text = result.input;
        return p;
      }
      return undefined;
    }) as HookHandler<HookName>;
    bus.on(hook.event as HookName, handler);
  }
}
