import { z } from "zod";
import type { ToolContext, ToolDefinition } from "@vibe/shared";

const Input = z.object({
  name: z
    .string()
    .min(1)
    .describe("Package name, e.g. `react`, `@types/node` (npm) or `requests` (pypi)."),
  ecosystem: z
    .enum(["npm", "pypi"])
    .optional()
    .describe("Package registry to query. Defaults to npm."),
});

const TIMEOUT_MS = 8_000;
/** Cap registry wire bodies during stream (BUG-105) — field clip is not enough. */
const MAX_REGISTRY_CHARS = 512_000;

/** Abort on either the turn's signal or an 8s timeout, whichever fires first. */
function withTimeout(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
}

/** Stream-cap a registry response then JSON.parse (never fully buffer first). */
async function readJsonCapped(res: Response): Promise<unknown> {
  const { readCappedResponseText } = await import("./search-engines.ts");
  const text = await readCappedResponseText(res, MAX_REGISTRY_CHARS);
  return JSON.parse(text) as unknown;
}

interface NpmLatest {
  version?: string;
  description?: string;
  license?: string | { type?: string };
  homepage?: string;
  deprecated?: string;
}

// Strict package-name grammars. These gate the name BEFORE it's interpolated
// into a registry URL, so a hostile/garbled name (`../../x`, `foo?bar`, `a#b`,
// `@scope/p/extra`, whitespace) can't redirect the request to a different
// package or endpoint. Each segment must start alphanumeric, so a bare `..`
// (path traversal) is rejected outright.
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9-._~]*\/)?[a-z0-9][a-z0-9-._~]*$/i;
const PYPI_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

async function npmInfo(name: string, signal: AbortSignal): Promise<{ output: string; isError?: boolean }> {
  if (!NPM_NAME.test(name)) {
    return { output: `Invalid npm package name: "${name}".`, isError: true };
  }
  // Safe now: at most one slash (the scope separator) and only URL-safe chars,
  // so encoding that single slash is sufficient.
  const enc = name.replace("/", "%2f");
  const [latestRes, tagsRes] = await Promise.all([
    fetch(`https://registry.npmjs.org/${enc}/latest`, { signal }),
    fetch(`https://registry.npmjs.org/-/package/${enc}/dist-tags`, { signal }),
  ]);
  if (latestRes.status === 404) {
    return { output: `Package "${name}" not found on npm.`, isError: true };
  }
  if (!latestRes.ok) {
    return { output: `npm lookup failed: HTTP ${latestRes.status}.`, isError: true };
  }
  const latest = (await readJsonCapped(latestRes)) as NpmLatest;
  const tags = tagsRes.ok ? ((await readJsonCapped(tagsRes)) as Record<string, string>) : {};
  const license =
    typeof latest.license === "string" ? latest.license : latest.license?.type;
  const lines = [`npm · ${name}`, `latest: ${latest.version ?? "unknown"}`];
  if (latest.description) lines.push(`description: ${clip(latest.description.trim(), 500)}`);
  if (license) lines.push(`license: ${clip(String(license), 80)}`);
  if (latest.homepage) lines.push(`homepage: ${clip(latest.homepage, 200)}`);
  if (latest.deprecated) lines.push(`⚠ deprecated: ${clip(latest.deprecated, 300)}`);
  const otherTags = Object.entries(tags).filter(([k]) => k !== "latest");
  if (otherTags.length) {
    lines.push(
      `other dist-tags: ${clip(otherTags.map(([k, v]) => `${k}=${v}`).join(", "), 400)}`,
    );
  }
  return { output: clip(lines.join("\n"), 4000) };
}

/** BUG-094: bound registry field lengths so a hostile payload cannot flood context. */
function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

interface PypiJson {
  info?: {
    version?: string;
    summary?: string;
    license?: string;
    home_page?: string;
    project_url?: string;
    yanked?: boolean;
    yanked_reason?: string | null;
  };
}

async function pypiInfo(name: string, signal: AbortSignal): Promise<{ output: string; isError?: boolean }> {
  if (!PYPI_NAME.test(name)) {
    return { output: `Invalid PyPI package name: "${name}".`, isError: true };
  }
  const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, { signal });
  if (res.status === 404) {
    return { output: `Package "${name}" not found on PyPI.`, isError: true };
  }
  if (!res.ok) {
    return { output: `PyPI lookup failed: HTTP ${res.status}.`, isError: true };
  }
  const info = ((await readJsonCapped(res)) as PypiJson).info ?? {};
  const lines = [`pypi · ${name}`, `latest: ${info.version ?? "unknown"}`];
  if (info.summary) lines.push(`summary: ${clip(info.summary.trim(), 500)}`);
  if (info.license) lines.push(`license: ${clip(info.license, 80)}`);
  const home = info.home_page || info.project_url;
  if (home) lines.push(`homepage: ${clip(home, 200)}`);
  if (info.yanked) {
    lines.push(`⚠ yanked${info.yanked_reason ? `: ${clip(info.yanked_reason, 300)}` : ""}`);
  }
  return { output: clip(lines.join("\n"), 4000) };
}

export const packageInfoTool: ToolDefinition<z.infer<typeof Input>> = {
  name: "package_info",
  description:
    "Look up the latest published version and metadata of a package from its " +
    "registry (npm or PyPI). The authoritative, fast way to check whether a " +
    "dependency is current — prefer this over web search for version questions. " +
    "Read the project's manifest (package.json / pyproject.toml) for the pinned " +
    "range, then call this to compare against the real latest.",
  inputSchema: Input,
  readOnly: true,
    network: true,
  concurrencySafe: true,
  async execute({ name, ecosystem = "npm" }, ctx: ToolContext) {
    const signal = withTimeout(ctx.abortSignal);
    try {
      return ecosystem === "pypi"
        ? await pypiInfo(name, signal)
        : await npmInfo(name, signal);
    } catch (err) {
      if (ctx.abortSignal.aborted) return { output: "Lookup aborted." };
      const reason = (err as Error).name === "TimeoutError" ? "timed out" : (err as Error).message;
      return { output: `Package lookup failed: ${reason}.`, isError: true };
    }
  },
};
