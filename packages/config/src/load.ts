import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@vibe/shared";
import { ConfigSchema, type Config, type PermissionRule } from "./schema.ts";

/** Deep-merge plain objects (arrays are replaced, not concatenated). */
function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Partial<T>,
): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Strip `//` line and `/* *\/` block comments so config files may use JSONC.
 * String-aware single pass: a `//` or `/*` inside a JSON string value (e.g. a
 * URL "http://…", a path "a//b", or a regex) is preserved verbatim — only
 * comments outside string literals are removed.
 */
function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch; // keep the newline so line/column reporting stays sane
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        // Escape sequence: copy the escaped char verbatim so a `\"` doesn't end
        // the string and a `\\` is handled correctly.
        if (next !== undefined) {
          out += next;
          i++;
        }
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      inLine = true;
      i++;
    } else if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Remove trailing commas (`, }` / `, ]`) so config files may use JSONC's other
 * common convenience — `JSON.parse` rejects them. String-aware: a comma inside a
 * string value is never touched. Runs on already comment-stripped input.
 */
function stripTrailingCommas(input: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        if (input[i + 1] !== undefined) out += input[++i];
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      // Look ahead past whitespace: a comma immediately before `}`/`]` is trailing.
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j]!)) j++;
      if (input[j] === "}" || input[j] === "]") continue; // drop the trailing comma
    }
    out += ch;
  }
  return out;
}

async function readConfigFile(
  path: string,
): Promise<Record<string, unknown> | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    const raw = await file.text();
    return JSON.parse(stripTrailingCommas(stripJsonComments(raw))) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(
      `Failed to parse config at ${path}: ${(err as Error).message}`,
    );
  }
}

export interface LoadOptions {
  /** Project root to search for `.vibe/config.json`. Defaults to cwd. */
  cwd?: string;
  /** Highest-precedence overrides (e.g. from CLI flags). */
  overrides?: Partial<Config>;
}

/**
 * The user-global config path (`~/.config/vibe-codr/config.json`).
 *
 * Honors `$XDG_CONFIG_HOME` (the XDG Base Directory spec — `~/.config` is just its
 * default), read at call-time. This is also what makes the path overridable in
 * tests: Bun's `os.homedir()` caches at startup and ignores a runtime
 * `process.env.HOME`, so HOME can't isolate the config — `XDG_CONFIG_HOME` (read
 * here every call) can, which keeps the suite off the developer's real config.
 */
export function globalConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "vibe-codr", "config.json");
}

/** The project-local config path (`<cwd>/.vibe/config.json`). */
export function projectConfigPath(cwd: string): string {
  return join(cwd, ".vibe", "config.json");
}

/** Locations searched, lowest precedence first. */
export function configLocations(cwd: string): string[] {
  return [globalConfigPath(), projectConfigPath(cwd)];
}

/**
 * Deep-merge for *writes*: like {@link deepMerge}, but a `null` patch value
 * DELETES that key from the result (so callers can clear a persisted setting,
 * e.g. resetting `subagent.model` to "inherit the main model"). `undefined` is
 * skipped (no-op), matching `deepMerge`.
 */
function mergeForWrite(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) {
      delete out[key];
      continue;
    }
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = mergeForWrite(existing, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Merge `patch` into the user-global config file (creating it if absent) and
 * write it back. Used by onboarding and the in-chat `/model` command to persist
 * model/provider/key changes outside any project. A `null` value in `patch`
 * deletes that key (clearing a setting). Returns the object that was written.
 */
/** Serializes concurrent global-config writes. The engine fires `#persistConfig`
 * without awaiting, so two rapid settings changes (e.g. `/model` then `/reasoning`)
 * would otherwise both read the same `existing` and the later write would clobber
 * the earlier one's key. Chaining makes each write see the prior write's result. */
let writeChain: Promise<unknown> = Promise.resolve();

export function writeGlobalConfig(
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const run = async (): Promise<Record<string, unknown>> => {
    // Test-run backstop: under `bun test` (NODE_ENV=test) the suite MUST be
    // pointed at a throwaway XDG_CONFIG_HOME (the root test-preload does this).
    // Bun only reads bunfig.toml from the cwd, so `cd packages/x && bun test`
    // silently skips the preload — and tests that persist settings then write
    // the DEVELOPER'S REAL ~/.config/vibe-codr/config.json (this happened:
    // fixture keys and accent colors accreted into a real config). Refusing
    // here turns that silent corruption into a loud failure.
    if (process.env.NODE_ENV === "test" && !process.env.XDG_CONFIG_HOME) {
      throw new ConfigError(
        "refusing to write the real global config from a test run — set XDG_CONFIG_HOME " +
          "to a temp dir (the root test-preload does this; run `bun test` from the repo root)",
      );
    }
    const path = globalConfigPath();
    const existing = (await readConfigFile(path)) ?? {};
    const merged = mergeForWrite(existing, patch);
    // Validate BEFORE persisting: a patch with an invalid value (e.g. a custom
    // provider baseURL typed without a scheme, `localhost:1234`) must not be
    // written to disk — every subsequent non-`setup` run would then throw
    // ConfigError on load and the CLI would be bricked until the user discovers
    // `vibe setup`. Reject the write here so the caller (onboarding) can re-prompt.
    const check = ConfigSchema.safeParse(merged);
    if (!check.success) {
      throw new ConfigError(
        `Refusing to write invalid configuration: ${check.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      );
    }
    await Bun.write(path, `${JSON.stringify(merged, null, 2)}\n`);
    return merged;
  };
  const result = writeChain.then(run, run);
  // Advance the chain past this write's settlement, swallowing errors so one
  // failed write doesn't wedge every subsequent persist.
  writeChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Append a permission `rule` to the PROJECT config's `permissions` array
 * (`<cwd>/.vibe/config.json`, creating the file and the array if absent) and
 * write it back. Used by the interactive "always (remember for this project)"
 * permission decision to persist a scoped grant so a daily-driven command isn't
 * re-approved every session.
 *
 * Mirrors {@link writeGlobalConfig}'s discipline: it serializes through the same
 * write chain (so a concurrent `/model` persist can't clobber it) and VALIDATES
 * the merged result against `ConfigSchema` BEFORE writing — a rule that would
 * brick the config (invalid `action`, non-string `tool`) is REJECTED, leaving
 * the on-disk file untouched. An exact-duplicate rule is a no-op (never
 * accumulates copies). Unlike the global write there is no XDG test backstop:
 * the path is cwd-scoped, so a test's temp cwd already isolates it from any real
 * project.
 */
export function appendProjectPermission(
  cwd: string,
  rule: PermissionRule,
): Promise<Record<string, unknown>> {
  const run = async (): Promise<Record<string, unknown>> => {
    const path = projectConfigPath(cwd);
    const existing = (await readConfigFile(path)) ?? {};
    const current = Array.isArray(existing.permissions) ? existing.permissions : [];
    const key = JSON.stringify(rule);
    const permissions = current.some((r) => JSON.stringify(r) === key)
      ? current
      : [...current, rule];
    const merged = { ...existing, permissions };
    const check = ConfigSchema.safeParse(merged);
    if (!check.success) {
      throw new ConfigError(
        `Refusing to write invalid permission rule: ${check.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      );
    }
    await Bun.write(path, `${JSON.stringify(merged, null, 2)}\n`);
    return merged;
  };
  const result = writeChain.then(run, run);
  writeChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Report top-level config keys that no schema field recognizes, per file.
 * `ConfigSchema` has no `.strict()` (forward-compat), so a misspelled top-level
 * key (`"modle"`, `"complaction"`) is silently dropped by `loadConfig` and the
 * setting never takes effect. `/doctor` surfaces these as a soft warning. Only
 * TOP-LEVEL keys are checked — nested union schemas make deep strictness fragile.
 * Best-effort: an unreadable/unparseable file contributes nothing.
 */
export async function configUnknownKeys(cwd: string): Promise<{ path: string; keys: string[] }[]> {
  const known = new Set(Object.keys(ConfigSchema.shape));
  const out: { path: string; keys: string[] }[] = [];
  for (const path of configLocations(cwd)) {
    const parsed = await readConfigFile(path).catch(() => null);
    if (!parsed) continue;
    const unknown = Object.keys(parsed).filter((k) => !known.has(k));
    if (unknown.length) out.push({ path, keys: unknown });
  }
  return out;
}

/**
 * Load and validate config by deep-merging: schema defaults -> global ->
 * project -> CLI overrides. Throws `ConfigError` on invalid files/values.
 */
/** Fields a repo-local `.vibe/config.json` must not be able to set on an
 * untrusted clone: they grant code execution or redirect credentialed traffic
 * merely by running `vibe` in the directory. Dropped from the PROJECT layer
 * unless `security.trustProjectConfig` is set in the trusted (global/CLI)
 * layer. `approvalMode` is dropped only when it RELAXES to `auto`. */
function sanitizeUntrustedProjectConfig(project: Record<string, unknown>): {
  clean: Record<string, unknown>;
  dropped: string[];
} {
  const clean = { ...project };
  const dropped: string[] = [];
  // `hooks` (shell exec on lifecycle events), `plugins` (module import), and the
  // project's own `security` block (must never influence the merged trust state)
  // are removed outright.
  for (const key of ["hooks", "plugins", "security"] as const) {
    if (key in clean) {
      delete clean[key];
      if (key !== "security") dropped.push(key);
    }
  }
  if (clean.approvalMode === "auto") {
    delete clean.approvalMode;
    dropped.push("approvalMode:auto");
  }
  // Drop the whole `providers` block. Every field is a redirect or a
  // credential-disclosure vector: `baseURL` reroutes a credentialed request to
  // an attacker (env-var keys mean even a never-declared provider has a real key
  // attached); `tokenFile`/`tokenPath` make the client READ AN ARBITRARY LOCAL
  // FILE (`~/.ssh/id_rsa`, `~/.aws/credentials`) and transmit it as the auth
  // credential; `apiKey`/`headers` can route the user's prompt content through
  // an attacker's provider account. With `baseURL` gone a project provider is
  // useless anyway — a user who wants project-local providers trusts the repo.
  if (isPlainObject(clean.providers) && Object.keys(clean.providers as Record<string, unknown>).length) {
    delete clean.providers;
    dropped.push("providers");
  }
  // Drop ALL MCP servers. Stdio (`command`) runs an arbitrary local command at
  // bootstrap; a REMOTE (`url`) server is ALSO dangerous — `connectAll` dials
  // every server at boot and the handshake sends its headers, so a project
  // shipping `headers:{Authorization:"Bearer ${ANTHROPIC_API_KEY}"}` (or a
  // `${VAR}` in the url) exfiltrates env secrets on connect, no model needed.
  if (isPlainObject(clean.mcp) && isPlainObject((clean.mcp as Record<string, unknown>).servers)) {
    const mcp = { ...(clean.mcp as Record<string, unknown>) };
    if (Object.keys(mcp.servers as Record<string, unknown>).length) {
      mcp.servers = {};
      clean.mcp = mcp;
      dropped.push("mcp.servers");
    }
  }
  // Drop `lsp.servers` entries carrying a `command` OR `args` — the language
  // server is spawned (no permission prompt) the first time the agent edits a
  // matching file. A `command` is direct RCE; a command-less `args` override
  // REPLACES the detected binary's args (`--query-driver=/tmp/evil`, a
  // plugin/config path), which is spawn-arg injection into that binary.
  if (isPlainObject(clean.lsp) && isPlainObject((clean.lsp as Record<string, unknown>).servers)) {
    const lsp = { ...(clean.lsp as Record<string, unknown>) };
    const servers: Record<string, unknown> = {};
    let droppedCmd = false;
    for (const [lang, entry] of Object.entries(lsp.servers as Record<string, unknown>)) {
      if (isPlainObject(entry) && ("command" in entry || "args" in entry)) droppedCmd = true;
      else servers[lang] = entry;
    }
    if (droppedCmd) {
      lsp.servers = servers;
      clean.lsp = lsp;
      dropped.push("lsp.servers (command/args)");
    }
  }
  // Drop the exec-carrying `verify` fields — `verify.command` with `verify.auto`
  // auto-runs after a mutating turn with no prompt (config-injected exec). Keep
  // the benign `maxRetries` tuning.
  if (isPlainObject(clean.verify)) {
    const verify = { ...(clean.verify as Record<string, unknown>) };
    let strippedExec = false;
    if ("command" in verify) {
      delete verify.command;
      strippedExec = true;
    }
    if (verify.auto === true) {
      delete verify.auto;
      strippedExec = true;
    }
    if (strippedExec) {
      clean.verify = verify;
      dropped.push("verify.command");
    }
  }
  // Drop the project's `sandbox` block — a project must not be able to WEAKEN
  // the kernel backstop the user opted into (mode:off, network:on, a broad
  // writablePath). A stricter sandbox is a trust decision, not a project one.
  if ("sandbox" in clean) {
    delete clean.sandbox;
    dropped.push("sandbox");
  }
  // Strip only the SSRF-loosening webfetch keys — a project raising the default
  // private-host block (allowPrivateHosts / allowHosts to metadata endpoints)
  // could, with repo-borne prompt injection, exfil cloud IAM creds. Other
  // webfetch tuning (timeout, caps) is harmless and kept.
  if (isPlainObject(clean.webfetch)) {
    const wf = { ...(clean.webfetch as Record<string, unknown>) };
    let loosened = false;
    if (wf.allowPrivateHosts === true) {
      delete wf.allowPrivateHosts;
      loosened = true;
    }
    if ("allowHosts" in wf) {
      delete wf.allowHosts;
      loosened = true;
    }
    if (loosened) {
      clean.webfetch = wf;
      dropped.push("webfetch (SSRF allowlist)");
    }
  }
  return { clean, dropped };
}

/** Security notices (dropped untrusted project-config fields) attached to a
 * loaded config, surfaced by the engine at bootstrap. Keyed by the returned
 * object so there is no signature change and no global mutable state. */
const securityNotices = new WeakMap<object, string[]>();

/** The security notices recorded for a config loaded by {@link loadConfig}
 * (empty when the project layer was trusted or set nothing sensitive). */
export function configSecurityNotices(config: object): string[] {
  return securityNotices.get(config) ?? [];
}

export async function loadConfig(opts: LoadOptions = {}): Promise<Config> {
  const cwd = opts.cwd ?? process.cwd();
  let merged: Record<string, unknown> = {};
  // Trust is decided by the GLOBAL/CLI layer only — a project file can't
  // authorize its own sensitive fields. Read the flag before the project merge.
  const globalRaw = (await readConfigFile(globalConfigPath()).catch(() => null)) ?? {};
  const overridesRaw = (opts.overrides as Record<string, unknown> | undefined) ?? {};
  const trustFrom = (layer: Record<string, unknown>): boolean =>
    isPlainObject(layer.security) &&
    (layer.security as Record<string, unknown>).trustProjectConfig === true;
  const trustProject = trustFrom(overridesRaw) || trustFrom(globalRaw);
  const droppedProjectFields: string[] = [];
  const projectPath = projectConfigPath(cwd);

  // `permissions` is the one array that must UNION across layers, not replace:
  // deepMerge's replace semantics would let a repo-local `.vibe/config.json`
  // (which travels with a cloned, possibly untrusted repo) silently discard the
  // user's global deny kill-switches just by declaring its own `permissions`.
  // Concatenation is safe — deny is absolute within the merged array regardless
  // of position — and still lets a project ADD its own allows/asks/denies.
  const permissionLayers: unknown[] = [];
  // Whether ANY layer declared a `permissions` key — so the final rebuild from
  // the (filtered, union'd) permissionLayers fires even when the result is
  // empty. Without this, an untrusted project shipping ONLY an allow rule on a
  // machine with no global config left permissionLayers empty, the rebuild was
  // skipped, and the raw allow rule survived via deepMerge (a live gate bypass).
  let sawPermissions = false;
  const collectPermissions = (layer: Record<string, unknown>): void => {
    if (Array.isArray(layer.permissions)) {
      sawPermissions = true;
      permissionLayers.push(...layer.permissions);
    }
  };

  for (const path of configLocations(cwd)) {
    let fileConfig = await readConfigFile(path);
    if (fileConfig) {
      const untrustedProject = path === projectPath && !trustProject;
      // The union merge already stops a project from STRIPPING a global deny.
      // A project ADDING a BROAD allow — `tool:"*"` or an unscoped name-only
      // rule — silently widens access like `approvalMode:auto` (which the
      // sanitizer drops), so those are dropped from an untrusted project. A
      // glob-scoped allow (`match`) can be just as broad (`match:"*"`) and is
      // repo-authored, so keep only literal `matchExact` allows: that is exactly
      // the shape the app's own "always-allow (this project)" grant persists via
      // appendProjectPermission. The raw array is removed from the merged
      // fileConfig so deepMerge can't carry a dropped rule past the rebuild below.
      if (untrustedProject && Array.isArray(fileConfig.permissions)) {
        sawPermissions = true;
        const raw = fileConfig.permissions as {
          action?: string;
          tool?: string;
          match?: string;
          matchExact?: string;
        }[];
        const isUntrustedAllow = (r: {
          action?: string;
          tool?: string;
          match?: string;
          matchExact?: string;
        }): boolean =>
          r?.action === "allow" &&
          (r.tool === "*" ||
            r.match !== undefined ||
            r.matchExact === undefined);
        const kept = raw.filter((r) => !isUntrustedAllow(r));
        if (kept.length !== raw.length) droppedProjectFields.push("permissions (untrusted allow rules)");
        permissionLayers.push(...kept);
        fileConfig = { ...fileConfig };
        delete fileConfig.permissions;
      } else {
        collectPermissions(fileConfig);
      }
      if (untrustedProject) {
        const { clean, dropped } = sanitizeUntrustedProjectConfig(fileConfig);
        fileConfig = clean;
        droppedProjectFields.push(...dropped);
      }
      merged = deepMerge(merged, fileConfig);
    }
  }

  if (opts.overrides) {
    collectPermissions(opts.overrides as Record<string, unknown>);
    merged = deepMerge(merged, opts.overrides as Record<string, unknown>);
  }

  if (sawPermissions) {
    // Dedup exact-duplicate rules (same JSON shape) so layered files that both
    // declare a common rule don't accumulate copies; order stays global-first.
    const seen = new Set<string>();
    merged.permissions = permissionLayers.filter((rule) => {
      const key = JSON.stringify(rule);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(
      `Invalid configuration: ${result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  // Deep-clone: Zod's object/array `.default()` values are SHARED by reference
  // across every parse, so without this two loaded configs (or two defaultConfig()
  // calls) would alias the same nested `providers`/`mcp.servers`/`webfetch.
  // allowHosts` — the engine mutates several of these (e.g. `/model key` writes
  // `providers[id]`), which would then leak across configs (and pollute tests).
  const config = structuredClone(result.data);
  if (droppedProjectFields.length) {
    securityNotices.set(config, [
      `Ignored untrusted project config (${cwd}/.vibe/config.json): ${droppedProjectFields.join(", ")}. ` +
        "These can execute code or redirect credentialed traffic. Set security.trustProjectConfig:true " +
        "in your global config to honor them.",
    ]);
  }
  return config;
}

/** Synchronous defaults, useful for tests and headless boot before disk read. */
export function defaultConfig(): Config {
  // Clone so each caller gets an independent config (see loadConfig above) —
  // otherwise every defaultConfig() shares the schema's default object instances.
  return structuredClone(ConfigSchema.parse({}));
}
