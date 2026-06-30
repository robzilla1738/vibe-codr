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

/** Abort on either the turn's signal or an 8s timeout, whichever fires first. */
function withTimeout(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
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
  const latest = (await latestRes.json()) as NpmLatest;
  const tags = tagsRes.ok ? ((await tagsRes.json()) as Record<string, string>) : {};
  const license =
    typeof latest.license === "string" ? latest.license : latest.license?.type;
  const lines = [`npm · ${name}`, `latest: ${latest.version ?? "unknown"}`];
  if (latest.description) lines.push(`description: ${latest.description.trim()}`);
  if (license) lines.push(`license: ${license}`);
  if (latest.homepage) lines.push(`homepage: ${latest.homepage}`);
  if (latest.deprecated) lines.push(`⚠ deprecated: ${latest.deprecated}`);
  const otherTags = Object.entries(tags).filter(([k]) => k !== "latest");
  if (otherTags.length) {
    lines.push(`other dist-tags: ${otherTags.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  return { output: lines.join("\n") };
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
  const info = ((await res.json()) as PypiJson).info ?? {};
  const lines = [`pypi · ${name}`, `latest: ${info.version ?? "unknown"}`];
  if (info.summary) lines.push(`summary: ${info.summary.trim()}`);
  if (info.license) lines.push(`license: ${info.license}`);
  const home = info.home_page || info.project_url;
  if (home) lines.push(`homepage: ${home}`);
  if (info.yanked) lines.push(`⚠ yanked${info.yanked_reason ? `: ${info.yanked_reason}` : ""}`);
  return { output: lines.join("\n") };
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
