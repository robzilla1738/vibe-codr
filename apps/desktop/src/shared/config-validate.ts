/**
 * Lightweight pre-write config validation — catches the most common
 * "bricking" scenarios (invalid URLs, out-of-range numbers, bad enum values)
 * so an invalid patch is rejected BEFORE it's persisted, mirroring the
 * engine's `ConfigSchema.safeParse` gate in `@vibe/config`.
 *
 * This is NOT a full schema validation (the engine does that on load); it's a
 * targeted guard against values that would make the config un-loadable. The
 * engine's Zod schema is the authority — this is a best-effort pre-flight check
 * so the Electron shell can surface a helpful error instead of silently writing
 * a config the engine will reject on the next bootstrap.
 */

import { isAbsolute } from "node:path";
import { validatePluginSpecifiers } from "./plugin-specifiers";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function httpUrlWithHost(value: unknown): true | string {
  if (value === undefined || value === null) return true; // unset optional field
  if (typeof value !== "string") return "must be a string URL";
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return "must be an http(s) URL (e.g. https://host:port/path)";
    }
    if (!u.host) return "must include a host (e.g. https://host:port/path)";
    return true;
  } catch {
    return "must be a valid http(s) URL";
  }
}

/** Expandable URL — allows `${VAR}` references (MCP url field). */
function expandableHttpUrl(value: unknown): true | string {
  if (value === undefined || value === null) return "is required for remote MCP servers";
  if (typeof value !== "string") return "must be a string URL";
  if (value.includes("${")) {
    return hasOnlyValidEnvReferences(value)
      ? true
      : `contains an invalid \${VAR} or \${VAR:-default} reference`;
  }
  return httpUrlWithHost(value);
}

const ENV_REFERENCE = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/g;

function hasOnlyValidEnvReferences(value: string): boolean {
  return !value.replace(ENV_REFERENCE, "").includes("${");
}

function checkEnvReferences(value: unknown, path: string): string[] {
  if (typeof value !== "string" || !value.includes("${")) return [];
  return hasOnlyValidEnvReferences(value)
    ? []
    : [`${path}: contains an invalid \${VAR} or \${VAR:-default} reference`];
}

function checkEnvReferencesInArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => checkEnvReferences(entry, `${path}[${index}]`));
}

function checkEnvReferencesInRecord(value: unknown, path: string): string[] {
  if (!isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    checkEnvReferences(entry, `${path}.${key}`),
  );
}

function checkNumber(
  value: unknown,
  opts: { min?: number; max?: number; integer?: boolean },
  path: string,
): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return [`${path}: must be a finite number`];
  }
  const errs: string[] = [];
  if (opts.integer && !Number.isInteger(value)) errs.push(`${path}: must be an integer`);
  if (opts.min !== undefined && value < opts.min) errs.push(`${path}: must be ≥ ${opts.min}`);
  if (opts.max !== undefined && value > opts.max) errs.push(`${path}: must be ≤ ${opts.max}`);
  return errs;
}

const ENUM_VALUES: Record<string, readonly string[]> = {
  mode: ["plan", "execute"],
  approvalMode: ["ask", "auto"],
  details: ["quiet", "normal", "verbose"],
  "sandbox.mode": ["off", "read-only", "workspace-write"],
  "sandbox.network": ["on", "off"],
  "build.commit.mode": ["checkpoint", "branch", "off"],
  "reasoning.effort": ["low", "medium", "high"],
  "budget.onExceed": ["warn", "stop"],
  "goal.checklessCompletion": ["pause", "self-report"],
};

function checkEnum(value: unknown, allowed: readonly string[], path: string): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "string" || !allowed.includes(value)) {
    return [`${path}: must be one of ${allowed.join(", ")}`];
  }
  return [];
}

function checkBoolean(value: unknown, path: string): string[] {
  return value === undefined || value === null || typeof value === "boolean"
    ? []
    : [`${path}: must be a boolean`];
}

function checkString(value: unknown, path: string): string[] {
  return value === undefined || value === null || typeof value === "string"
    ? []
    : [`${path}: must be a string`];
}

function checkStringArray(value: unknown, path: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return [`${path}: must be an array of strings`];
  }
  return [];
}

function checkNoNul(value: unknown, path: string): string[] {
  return typeof value === "string" && value.includes("\0")
    ? [`${path}: must not contain a NUL character`]
    : [];
}

function checkNoNulInArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => checkNoNul(entry, `${path}[${index}]`));
}

function checkNoNulInRecord(value: unknown, path: string): string[] {
  if (!isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    checkNoNul(entry, `${path}.${key}`),
  );
}

/** Fetch implementations reject CR/LF/NUL in header values. Catch those at
 * save time so one malformed provider or MCP header cannot break every request
 * or connection attempt after the next bootstrap. Horizontal tabs remain legal. */
function checkHttpHeaderValues(value: unknown, path: string): string[] {
  if (!isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    typeof entry === "string" && /[\0\r\n]/u.test(entry)
      ? [`${path}.${key}: must not contain CR, LF, or NUL characters`]
      : [],
  );
}

function checkStringRecord(
  value: unknown,
  path: string,
  keyPattern?: RegExp,
  keyDescription?: string,
): string[] {
  if (value === undefined || value === null) return [];
  if (!isPlainObject(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    return [`${path}: must be an object of string values`];
  }
  if (keyPattern) {
    for (const key of Object.keys(value)) {
      if (!keyPattern.test(key)) {
        return [`${path}.${key}: ${keyDescription ?? "invalid key"}`];
      }
    }
  }
  return [];
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function objectField(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): Record<string, unknown> | null {
  const value = parent[key];
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    errors.push(`${path}: must be an object`);
    return null;
  }
  return value;
}

/**
 * Validate a merged config object for the most critical constraints.
 * Returns an array of error messages (empty = valid).
 */
export function validateConfig(config: Record<string, unknown>): string[] {
  const errors: string[] = [];

  errors.push(...checkString(config.model, "model"));
  errors.push(...checkString(config.planModel, "planModel"));
  errors.push(...checkStringArray(config.modelFallbacks, "modelFallbacks"));
  errors.push(...checkBoolean(config.mouse, "mouse"));
  errors.push(...checkString(config.theme, "theme"));
  errors.push(...checkString(config.accentColor, "accentColor"));
  if (
    typeof config.accentColor === "string" &&
    config.accentColor !== "" &&
    !/^#[0-9a-f]{6}$/i.test(config.accentColor)
  ) {
    errors.push("accentColor: must be empty or a 6-digit hex color such as #8b5cf6");
  }
  errors.push(...checkStringArray(config.plugins, "plugins"));
  if (Array.isArray(config.plugins) && config.plugins.every((entry) => typeof entry === "string")) {
    errors.push(...validatePluginSpecifiers(config.plugins));
  }
  const toolDiscovery = objectField(config, "toolDiscovery", "toolDiscovery", errors);
  if (toolDiscovery) {
    errors.push(...checkEnum(toolDiscovery.mode, ["auto", "direct"], "toolDiscovery.mode"));
    errors.push(...checkStringArray(toolDiscovery.directTools, "toolDiscovery.directTools"));
  }

  // Provider baseURLs
  const providers = objectField(config, "providers", "providers", errors);
  if (providers) {
    for (const [id, prov] of Object.entries(providers)) {
      if (!isPlainObject(prov)) {
        errors.push(`providers.${id}: must be an object`);
        continue;
      }
      errors.push(...checkString(prov.apiKey, `providers.${id}.apiKey`));
      if (typeof prov.apiKey === "string" && /[\0\r\n]/u.test(prov.apiKey)) {
        errors.push(`providers.${id}.apiKey: must not contain CR, LF, or NUL characters`);
      }
      errors.push(...checkString(prov.tokenFile, `providers.${id}.tokenFile`));
      errors.push(...checkNoNul(prov.tokenFile, `providers.${id}.tokenFile`));
      errors.push(...checkString(prov.tokenPath, `providers.${id}.tokenPath`));
      errors.push(...checkNoNul(prov.tokenPath, `providers.${id}.tokenPath`));
      errors.push(...checkEnum(prov.transport, ["openai-compatible", "openai-responses"], `providers.${id}.transport`));
      errors.push(...checkStringArray(prov.models, `providers.${id}.models`));
      errors.push(...checkNoNulInArray(prov.models, `providers.${id}.models`));
      const urlCheck = httpUrlWithHost(prov.baseURL);
      if (urlCheck !== true) errors.push(`providers.${id}.baseURL: ${urlCheck}`);
      errors.push(...checkStringRecord(
        prov.headers,
        `providers.${id}.headers`,
        HTTP_HEADER_NAME,
        "must be a valid HTTP header name",
      ));
      errors.push(...checkHttpHeaderValues(prov.headers, `providers.${id}.headers`));
    }
  }

  // MCP servers: remote URL shape + stdio command required when enabled
  const mcp = objectField(config, "mcp", "mcp", errors);
  const mcpServers = mcp ? objectField(mcp, "servers", "mcp.servers", errors) : null;
  if (mcpServers) {
    for (const [name, server] of Object.entries(mcpServers)) {
      if (!isPlainObject(server)) {
        errors.push(`mcp.servers.${name}: must be an object`);
        continue;
      }
      errors.push(...checkBoolean(server.enabled, `mcp.servers.${name}.enabled`));
      errors.push(...checkNumber(server.timeoutMs, { min: 1, integer: true }, `mcp.servers.${name}.timeoutMs`));
      if ("url" in server && "command" in server) {
        errors.push(`mcp.servers.${name}: must configure exactly one transport (url or command)`);
      }
      if ("url" in server) {
        errors.push(...checkEnum(server.transport, ["http", "sse"], `mcp.servers.${name}.transport`));
        errors.push(...checkStringRecord(
          server.headers,
          `mcp.servers.${name}.headers`,
          HTTP_HEADER_NAME,
          "must be a valid HTTP header name",
        ));
        errors.push(...checkHttpHeaderValues(server.headers, `mcp.servers.${name}.headers`));
        errors.push(...checkEnvReferencesInRecord(server.headers, `mcp.servers.${name}.headers`));
        const urlCheck = expandableHttpUrl(server.url);
        if (urlCheck !== true) errors.push(`mcp.servers.${name}.url: ${urlCheck}`);
        const oauth = objectField(server, "oauth", `mcp.servers.${name}.oauth`, errors);
        if (oauth) {
          errors.push(...checkStringArray(oauth.scopes, `mcp.servers.${name}.oauth.scopes`));
          errors.push(...checkNoNulInArray(oauth.scopes, `mcp.servers.${name}.oauth.scopes`));
          errors.push(...checkString(oauth.clientId, `mcp.servers.${name}.oauth.clientId`));
          errors.push(...checkNoNul(oauth.clientId, `mcp.servers.${name}.oauth.clientId`));
          errors.push(...checkString(oauth.clientName, `mcp.servers.${name}.oauth.clientName`));
          errors.push(...checkNoNul(oauth.clientName, `mcp.servers.${name}.oauth.clientName`));
          errors.push(...checkString(oauth.tokenStore, `mcp.servers.${name}.oauth.tokenStore`));
          errors.push(...checkNoNul(oauth.tokenStore, `mcp.servers.${name}.oauth.tokenStore`));
          const redirectCheck = httpUrlWithHost(oauth.redirectUri);
          if (redirectCheck !== true) {
            errors.push(`mcp.servers.${name}.oauth.redirectUri: ${redirectCheck}`);
          }
        }
      } else {
        if (typeof server.command !== "string") {
          errors.push(`mcp.servers.${name}.command: must be a string`);
        } else if (server.enabled !== false && !server.command.trim()) {
          errors.push(`mcp.servers.${name}.command: required for enabled stdio servers`);
        }
        errors.push(...checkNoNul(server.command, `mcp.servers.${name}.command`));
      }
      if (!("url" in server)) {
        errors.push(...checkStringArray(server.args, `mcp.servers.${name}.args`));
        errors.push(...checkNoNulInArray(server.args, `mcp.servers.${name}.args`));
        errors.push(...checkString(server.cwd, `mcp.servers.${name}.cwd`));
        errors.push(...checkNoNul(server.cwd, `mcp.servers.${name}.cwd`));
        errors.push(...checkStringRecord(
          server.env,
          `mcp.servers.${name}.env`,
          ENV_NAME,
          "must be a valid environment variable name",
        ));
        errors.push(...checkNoNulInRecord(server.env, `mcp.servers.${name}.env`));
        errors.push(...checkEnvReferences(server.command, `mcp.servers.${name}.command`));
        errors.push(...checkEnvReferencesInArray(server.args, `mcp.servers.${name}.args`));
        errors.push(...checkEnvReferencesInRecord(server.env, `mcp.servers.${name}.env`));
      }
    }
  }

  // Hooks: command or url required; url must be http(s)
  if (config.hooks !== undefined && !Array.isArray(config.hooks)) {
    errors.push("hooks: must be an array");
  } else if (Array.isArray(config.hooks)) {
    config.hooks.forEach((hook, i) => {
      if (!isPlainObject(hook)) {
        errors.push(`hooks[${i}]: must be an object`);
        return;
      }
      errors.push(...checkEnum(hook.event, [
        "session.start", "user.prompt.submit", "tool.before.execute", "tool.after.execute",
        "step.finish", "assistant.message", "session.idle", "session.end",
        "subagent.start", "subagent.stop", "permission.denied", "compact.before",
        "compact.after", "goal.transition", "turn.failure",
      ], `hooks[${i}].event`));
      if (hook.event === undefined) errors.push(`hooks[${i}].event: is required`);
      errors.push(...checkString(hook.matcher, `hooks[${i}].matcher`));
      errors.push(...checkString(hook.command, `hooks[${i}].command`));
      errors.push(...checkNoNul(hook.command, `hooks[${i}].command`));
      errors.push(...checkBoolean(hook.async, `hooks[${i}].async`));
      const cmd = typeof hook.command === "string" ? hook.command.trim() : "";
      const url = hook.url;
      if (!cmd && !url) {
        errors.push(`hooks[${i}]: requires either command or url`);
      }
      if (url) {
        const urlCheck = httpUrlWithHost(url);
        if (urlCheck !== true) errors.push(`hooks[${i}].url: ${urlCheck}`);
      }
    });
  }

  // Numeric ranges (the most critical — an inverted or negative value here
  // would be rejected by the engine schema on load)
  const sa = objectField(config, "subagent", "subagent", errors);
  if (sa) {
    errors.push(...checkNumber(sa.maxDepth, { min: 1, integer: true }, "subagent.maxDepth"));
    errors.push(...checkNumber(sa.maxParallel, { min: 1, integer: true }, "subagent.maxParallel"));
    errors.push(...checkNumber(sa.maxTotal, { min: 1, integer: true }, "subagent.maxTotal"));
    errors.push(...checkNumber(sa.providerConcurrency, { min: 1, integer: true }, "subagent.providerConcurrency"));
    errors.push(...checkNumber(sa.timeoutMs, { min: 0, integer: true }, "subagent.timeoutMs"));
    errors.push(...checkNumber(sa.verifyMaxAttempts, { min: 1, max: 5, integer: true }, "subagent.verifyMaxAttempts"));
    errors.push(...checkNumber(sa.structuredMaxAttempts, { min: 1, integer: true }, "subagent.structuredMaxAttempts"));
    errors.push(...checkNumber(sa.retainCompleted, { min: 0, integer: true }, "subagent.retainCompleted"));
    errors.push(...checkNumber(sa.maxDetached, { min: 0, integer: true }, "subagent.maxDetached"));
    errors.push(...checkString(sa.model, "subagent.model"));
  }
  const c = objectField(config, "compaction", "compaction", errors);
  if (c) {
    errors.push(...checkNumber(c.threshold, { min: 0.1, max: 0.95 }, "compaction.threshold"));
    const offload = objectField(c, "offload", "compaction.offload", errors);
    if (offload) {
      errors.push(...checkBoolean(offload.enabled, "compaction.offload.enabled"));
      errors.push(...checkNumber(offload.threshold, { min: 0.1, max: 0.9 }, "compaction.offload.threshold"));
      errors.push(...checkNumber(offload.maxResultBytes, { min: 1, integer: true }, "compaction.offload.maxResultBytes"));
      errors.push(...checkNumber(offload.previewBytes, { min: 1, integer: true }, "compaction.offload.previewBytes"));
      errors.push(...checkNumber(offload.keepLiveResults, { min: 0, integer: true }, "compaction.offload.keepLiveResults"));
      errors.push(...checkNumber(offload.maxArtifactBytes, { min: 1, integer: true }, "compaction.offload.maxArtifactBytes"));
    }
  }
  errors.push(...checkNumber(config.maxSteps, { min: 1, integer: true }, "maxSteps"));
  errors.push(...checkNumber(config.streamIdleTimeoutMs, { min: 0, integer: true }, "streamIdleTimeoutMs"));
  errors.push(...checkNumber(config.itemTimeoutMs, { min: 0, integer: true }, "itemTimeoutMs"));

  // Enum fields
  errors.push(...checkEnum(config.mode, ENUM_VALUES.mode!, "mode"));
  errors.push(...checkEnum(config.approvalMode, ENUM_VALUES.approvalMode!, "approvalMode"));
  errors.push(...checkEnum(config.details, ENUM_VALUES.details!, "details"));
  const sandbox = objectField(config, "sandbox", "sandbox", errors);
  if (sandbox) {
    errors.push(...checkEnum(sandbox.mode, ENUM_VALUES["sandbox.mode"]!, "sandbox.mode"));
    errors.push(...checkEnum(sandbox.network, ENUM_VALUES["sandbox.network"]!, "sandbox.network"));
    errors.push(...checkStringArray(sandbox.writablePaths, "sandbox.writablePaths"));
    errors.push(...checkNoNulInArray(sandbox.writablePaths, "sandbox.writablePaths"));
    if (Array.isArray(sandbox.writablePaths)) {
      sandbox.writablePaths.forEach((entry, index) => {
        if (typeof entry === "string" && !isAbsolute(entry)) {
          errors.push(`sandbox.writablePaths[${index}]: must be an absolute path`);
        }
      });
    }
  }
  const reasoning = objectField(config, "reasoning", "reasoning", errors);
  if (reasoning) {
    errors.push(...checkEnum(reasoning.effort, ENUM_VALUES["reasoning.effort"]!, "reasoning.effort"));
    errors.push(...checkNumber(reasoning.budgetTokens, { min: 1, integer: true }, "reasoning.budgetTokens"));
  }
  const budget = objectField(config, "budget", "budget", errors);
  if (budget) {
    errors.push(...checkEnum(budget.onExceed, ENUM_VALUES["budget.onExceed"]!, "budget.onExceed"));
    errors.push(...checkNumber(budget.limitUSD, { min: Number.MIN_VALUE }, "budget.limitUSD"));
  }
  const retry = objectField(config, "retry", "retry", errors);
  if (retry) {
    errors.push(...checkNumber(retry.maxAttempts, { min: 0, max: 10, integer: true }, "retry.maxAttempts"));
    errors.push(...checkNumber(retry.baseDelayMs, { min: 0, max: 60_000, integer: true }, "retry.baseDelayMs"));
  }
  const goal = objectField(config, "goal", "goal", errors);
  if (goal) {
    errors.push(...checkNumber(goal.maxRounds, { min: 1, max: 100, integer: true }, "goal.maxRounds"));
    errors.push(...checkBoolean(goal.planFirst, "goal.planFirst"));
    if (goal.assessorModel !== undefined && (typeof goal.assessorModel !== "string" || goal.assessorModel.trim() === "")) {
      errors.push("goal.assessorModel: must be a non-empty string");
    }
    errors.push(...checkEnum(goal.checklessCompletion, ENUM_VALUES["goal.checklessCompletion"]!, "goal.checklessCompletion"));
  }
  const loop = objectField(config, "loop", "loop", errors);
  if (loop) {
    errors.push(...checkNumber(loop.defaultMax, { min: 0, max: 1000, integer: true }, "loop.defaultMax"));
    errors.push(...checkNumber(loop.maxUntilEvalFailures, { min: 1, max: 50, integer: true }, "loop.maxUntilEvalFailures"));
  }
  // Permissions actions (Settings surface)
  if (config.permissions !== undefined && !Array.isArray(config.permissions)) {
    errors.push("permissions: must be an array");
  } else if (Array.isArray(config.permissions)) {
    const validActions = new Set(["allow", "deny", "ask"]);
    config.permissions.forEach((rule, i) => {
      if (!isPlainObject(rule)) {
        errors.push(`permissions[${i}]: must be an object`);
        return;
      }
      if (typeof rule.tool !== "string") {
        errors.push(`permissions[${i}].tool: must be a string`);
      } else if (!rule.tool.trim()) {
        errors.push(`permissions[${i}].tool: must not be empty`);
      }
      errors.push(...checkString(rule.match, `permissions[${i}].match`));
      errors.push(...checkString(rule.matchExact, `permissions[${i}].matchExact`));
      if (typeof rule.match === "string" && typeof rule.matchExact === "string") {
        errors.push(`permissions[${i}]: match and matchExact are mutually exclusive`);
      }
      if (typeof rule.action !== "string" || !validActions.has(rule.action)) {
        errors.push(`permissions[${i}].action: must be one of allow, deny, ask`);
      }
    });
  }
  const build = objectField(config, "build", "build", errors);
  if (build) {
    errors.push(...checkBoolean(build.enabled, "build.enabled"));
    errors.push(...checkBoolean(build.visualVerify, "build.visualVerify"));
    const commit = objectField(build, "commit", "build.commit", errors);
    if (commit) {
      errors.push(...checkEnum(commit.mode, ENUM_VALUES["build.commit.mode"]!, "build.commit.mode"));
      errors.push(...checkString(commit.branchPrefix, "build.commit.branchPrefix"));
    }
    const gate = objectField(build, "gate", "build.gate", errors);
    if (gate) {
      errors.push(...checkBoolean(gate.enabled, "build.gate.enabled"));
      errors.push(...checkNumber(gate.maxRounds, { min: 0, max: 10, integer: true }, "build.gate.maxRounds"));
      errors.push(...checkNumber(gate.timeoutSec, { min: 1, integer: true }, "build.gate.timeoutSec"));
      if (gate.checks !== undefined && !Array.isArray(gate.checks)) {
        errors.push("build.gate.checks: must be an array");
      } else if (Array.isArray(gate.checks)) {
        const validChecks = ["build", "typecheck", "test", "lint"];
        for (const check of gate.checks) {
          if (typeof check !== "string" || !validChecks.includes(check)) {
            errors.push(`build.gate.checks: invalid check "${check}"`);
          }
        }
      }
    }
    const review = objectField(build, "review", "build.review", errors);
    if (review) {
      errors.push(...checkBoolean(review.enabled, "build.review.enabled"));
      errors.push(...checkBoolean(review.stubScan, "build.review.stubScan"));
      errors.push(...checkNumber(review.maxRounds, { min: 0, max: 5, integer: true }, "build.review.maxRounds"));
    }
    const recon = objectField(build, "recon", "build.recon", errors);
    if (recon) {
      errors.push(...checkBoolean(recon.enabled, "build.recon.enabled"));
      errors.push(...checkBoolean(recon.ledger, "build.recon.ledger"));
    }
    const worktrees = objectField(build, "worktrees", "build.worktrees", errors);
    if (worktrees) errors.push(...checkBoolean(worktrees.enabled, "build.worktrees.enabled"));
    const ensemble = objectField(build, "ensemble", "build.ensemble", errors);
    if (ensemble) errors.push(...checkNumber(ensemble.n, { min: 0, max: 5, integer: true }, "build.ensemble.n"));
    const models = objectField(build, "models", "build.models", errors);
    if (models) {
      errors.push(...checkString(models.cheap, "build.models.cheap"));
      errors.push(...checkString(models.strong, "build.models.strong"));
    }
  }
  const verify = objectField(config, "verify", "verify", errors);
  if (verify) {
    errors.push(...checkString(verify.command, "verify.command"));
    errors.push(...checkNoNul(verify.command, "verify.command"));
    errors.push(...checkBoolean(verify.auto, "verify.auto"));
    errors.push(...checkNumber(verify.maxRetries, { min: 0, max: 10, integer: true }, "verify.maxRetries"));
  }
  const webfetch = objectField(config, "webfetch", "webfetch", errors);
  if (webfetch) {
    errors.push(...checkBoolean(webfetch.allowPrivateHosts, "webfetch.allowPrivateHosts"));
    errors.push(...checkStringArray(webfetch.allowHosts, "webfetch.allowHosts"));
    errors.push(...checkNumber(webfetch.timeoutMs, { min: 1, integer: true }, "webfetch.timeoutMs"));
    errors.push(...checkNumber(webfetch.maxBytes, { min: 1, integer: true }, "webfetch.maxBytes"));
  }
  const search = objectField(config, "search", "search", errors);
  if (search) {
    errors.push(...checkBoolean(search.enabled, "search.enabled"));
    errors.push(...checkString(search.apiKey, "search.apiKey"));
  }
  const memory = objectField(config, "memory", "memory", errors);
  if (memory) {
    errors.push(...checkBoolean(memory.proactiveRecall, "memory.proactiveRecall"));
    errors.push(...checkBoolean(memory.sessionDigest, "memory.sessionDigest"));
    const semantic = objectField(memory, "semantic", "memory.semantic", errors);
    if (semantic) {
      errors.push(...checkBoolean(semantic.enabled, "memory.semantic.enabled"));
      errors.push(...checkString(semantic.model, "memory.semantic.model"));
    }
  }
  const caching = objectField(config, "caching", "caching", errors);
  if (caching) {
    errors.push(...checkBoolean(caching.enabled, "caching.enabled"));
    errors.push(...checkBoolean(caching.cacheTools, "caching.cacheTools"));
    errors.push(...checkBoolean(caching.cacheConversation, "caching.cacheConversation"));
  }
  const security = objectField(config, "security", "security", errors);
  if (security) errors.push(...checkBoolean(security.trustProjectConfig, "security.trustProjectConfig"));
  const checkpoints = objectField(config, "checkpoints", "checkpoints", errors);
  if (checkpoints) errors.push(...checkBoolean(checkpoints.enabled, "checkpoints.enabled"));
  const orchestration = objectField(config, "orchestration", "orchestration", errors);
  if (orchestration) errors.push(...checkBoolean(orchestration.enabled, "orchestration.enabled"));
  const plan = objectField(config, "plan", "plan", errors);
  if (plan) {
    errors.push(...checkNumber(plan.minCodeTouches, { min: 1, max: 20, integer: true }, "plan.minCodeTouches"));
    errors.push(...checkBoolean(plan.requireWebFetch, "plan.requireWebFetch"));
    errors.push(...checkBoolean(plan.requirePackageInfo, "plan.requirePackageInfo"));
    errors.push(...checkBoolean(plan.allowUngrounded, "plan.allowUngrounded"));
    errors.push(...checkNumber(plan.maxRejections, { min: 0, max: 10, integer: true }, "plan.maxRejections"));
  }
  const lsp = objectField(config, "lsp", "lsp", errors);
  if (lsp) {
    errors.push(...checkBoolean(lsp.enabled, "lsp.enabled"));
    errors.push(...checkNumber(lsp.timeoutMs, { min: 0, integer: true }, "lsp.timeoutMs"));
    errors.push(...checkNumber(lsp.idleShutdownMs, { min: 0, integer: true }, "lsp.idleShutdownMs"));
    errors.push(...checkStringArray(lsp.disabledLanguages, "lsp.disabledLanguages"));
    const servers = objectField(lsp, "servers", "lsp.servers", errors);
    if (servers) {
      for (const [language, server] of Object.entries(servers)) {
        if (!isPlainObject(server)) {
          errors.push(`lsp.servers.${language}: must be an object`);
          continue;
        }
        errors.push(...checkString(server.command, `lsp.servers.${language}.command`));
        errors.push(...checkNoNul(server.command, `lsp.servers.${language}.command`));
        errors.push(...checkStringArray(server.args, `lsp.servers.${language}.args`));
        errors.push(...checkNoNulInArray(server.args, `lsp.servers.${language}.args`));
        errors.push(...checkBoolean(server.enabled, `lsp.servers.${language}.enabled`));
      }
    }
  }
  const pricing = objectField(config, "pricing", "pricing", errors);
  if (pricing) {
    for (const [model, price] of Object.entries(pricing)) {
      if (!isPlainObject(price)) {
        errors.push(`pricing.${model}: must be an object`);
        continue;
      }
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        errors.push(...checkNumber(price[key], { min: 0 }, `pricing.${model}.${key}`));
      }
    }
  }
  const contextWindow = objectField(config, "contextWindow", "contextWindow", errors);
  if (contextWindow) {
    for (const [model, value] of Object.entries(contextWindow)) {
      errors.push(...checkNumber(value, { min: 1, integer: true }, `contextWindow.${model}`));
    }
  }
  const vision = objectField(config, "vision", "vision", errors);
  const relay = vision ? objectField(vision, "relay", "vision.relay", errors) : null;
  if (relay) {
    errors.push(...checkBoolean(relay.enabled, "vision.relay.enabled"));
    errors.push(...checkString(relay.relayModel, "vision.relay.relayModel"));
    errors.push(...checkNumber(relay.timeoutMs, { min: 1, integer: true }, "vision.relay.timeoutMs"));
    errors.push(...checkNumber(relay.maxCaptionChars, { min: 1, integer: true }, "vision.relay.maxCaptionChars"));
  }
  const update = objectField(config, "update", "update", errors);
  if (update) errors.push(...checkBoolean(update.check, "update.check"));

  return errors;
}
