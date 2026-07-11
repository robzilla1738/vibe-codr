import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { vibeConfigDir } from "./memory.ts";
import type { DoctorCheck } from "./introspect.ts";

/**
 * Lightweight "is there a newer release?" check. Everything is injectable
 * (clock, fetch, cache path, env) so the semantics are unit-tested without the
 * network or the real disk. The request carries NO user data — a plain GET to
 * the public GitHub releases API with default headers — and every failure is
 * silent: an update check must never break or slow down the CLI.
 */

// Origin slug (`git remote get-url origin` → github.com/<owner>/<repo>).
const GITHUB_OWNER = "robzilla1738";
const GITHUB_REPO = "vibe-codr";
const RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3_000;

/** Default cache location — beside the rest of the user-global vibe-codr state. */
export function updateCacheFile(): string {
  return join(vibeConfigDir(), "update-check.json");
}

export interface UpdateCache {
  /** When the latest-version lookup last succeeded (ms epoch). */
  checkedAt: number;
  /** The latest published release version (no leading `v`). */
  latest: string;
  /** The running version at the time of the check — lets `/doctor` render the
   * "current → latest" line without re-plumbing the version into core. */
  current: string;
}

type Channel = "dev" | "rc" | "other" | "none";
interface Parsed {
  major: number;
  minor: number;
  patch: number;
  pre: Channel;
}

function parse(v: string): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  const tag = (m[4] ?? "").toLowerCase();
  const pre: Channel = tag.startsWith("dev")
    ? "dev"
    : tag.startsWith("rc")
      ? "rc"
      : tag
        ? "other"
        : "none";
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

/**
 * Is `latest` a newer release than `current`? Core version compared numerically
 * first; on a tie the prerelease channel decides. Documented semantics:
 * - A `-dev` build is treated as slightly AHEAD of its own base version (an
 *   unreleased build of X is not "behind" the released X), so a released X never
 *   claims an update against `X-dev`. Only a higher CORE version updates a dev
 *   build (e.g. `0.0.0-dev` → `0.1.0`).
 * - A `-rc`/other prerelease is BEHIND the final X, so the final release of the
 *   same core version IS an update (`0.3.0-rc.1` → `0.3.0`).
 * - An unparseable version on either side never nags (returns false).
 */
export function isNewer(current: string, latest: string): boolean {
  const c = parse(current);
  const l = parse(latest);
  if (!c || !l) return false;
  const coreCmp = l.major - c.major || l.minor - c.minor || l.patch - c.patch;
  if (coreCmp !== 0) return coreCmp > 0;
  const weight = (p: Channel): number => (p === "dev" ? 1 : p === "none" ? 0 : -1);
  return weight(l.pre) > weight(c.pre);
}

/** Fetch the latest published release version (no leading `v`), or null on any
 * failure. Plain GET, no auth, no user data, bounded by a 3s timeout. */
export async function fetchLatestVersion(
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string | null> {
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(RELEASES_API, {
      signal: AbortSignal.timeout(deps.timeoutMs ?? FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { tag_name?: string; name?: string };
    const tag = json.tag_name ?? json.name;
    return tag ? tag.replace(/^v/, "").trim() : null;
  } catch {
    return null;
  }
}

/** Read the cached check, tolerating a missing or corrupt file (returns null). */
export async function readUpdateCache(
  file: string = updateCacheFile(),
): Promise<UpdateCache | null> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Partial<UpdateCache>;
    if (raw && typeof raw.latest === "string" && typeof raw.checkedAt === "number") {
      return {
        checkedAt: raw.checkedAt,
        latest: raw.latest,
        current: typeof raw.current === "string" ? raw.current : "",
      };
    }
  } catch {
    // missing / corrupt → treat as "never checked"
  }
  return null;
}

async function writeUpdateCache(cache: UpdateCache, file: string): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    // BUG-079: temp+rename so a crash mid-write cannot leave corrupt JSON.
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(cache));
    const { rename, rm } = await import("node:fs/promises");
    try {
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  } catch {
    // best-effort; a write failure just means we re-check next time
  }
}

export interface CheckForUpdateOptions {
  /** The running version to compare against. */
  current: string;
  /** `config.update.check`; when false the whole check is a no-op (returns null). */
  enabled?: boolean;
  now?: () => number;
  fetchImpl?: typeof fetch;
  cacheFile?: string;
  env?: Record<string, string | undefined>;
  ttlMs?: number;
  timeoutMs?: number;
}

export interface UpdateStatus {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

/**
 * Combine cache + fetch into an update status, honoring the 24h TTL. Gated OFF
 * (returns null) by `enabled === false` or `$VIBE_NO_UPDATE_CHECK`. On a cache
 * miss it fetches once and persists `{checkedAt, latest, current}`; a fetch
 * failure falls back to a stale cached value when present, else null.
 */
export async function checkForUpdate(opts: CheckForUpdateOptions): Promise<UpdateStatus | null> {
  const env = opts.env ?? process.env;
  if (opts.enabled === false || env.VIBE_NO_UPDATE_CHECK) return null;
  const now = opts.now ?? Date.now;
  const cacheFile = opts.cacheFile ?? updateCacheFile();
  const ttl = opts.ttlMs ?? CACHE_TTL_MS;

  const cached = await readUpdateCache(cacheFile);
  let latest: string | null = null;
  if (cached && now() - cached.checkedAt < ttl) {
    latest = cached.latest;
    // The cache's `current` is only rewritten on a fetch (≤ once per TTL), so an
    // upgrade WITHIN the window leaves it lagging the running binary. Reconcile
    // it here (this runs at startup with the live `current`) so `/doctor`, which
    // reads `current` from disk with no access to the live version in core,
    // never nags about an update that is already installed.
    if (cached.current !== opts.current) {
      await writeUpdateCache(
        { checkedAt: cached.checkedAt, latest: cached.latest, current: opts.current },
        cacheFile,
      );
    }
  } else {
    latest = await fetchLatestVersion({
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    if (latest) {
      await writeUpdateCache({ checkedAt: now(), latest, current: opts.current }, cacheFile);
    } else if (cached) {
      latest = cached.latest; // stale-on-failure: keep the last known good value
    }
  }
  if (!latest) return null;
  return { current: opts.current, latest, updateAvailable: isNewer(opts.current, latest) };
}

/** `/doctor` line for the update status, read from the cache (no network). Uses
 * `ok:null` for both "not checked" and "update available" — an available update
 * is informational (○), not a failure (✗) — and `ok:true` when up to date. */
export function updateDoctorCheck(cache: UpdateCache | null): DoctorCheck {
  if (!cache?.current) {
    return { label: "updates", ok: null, detail: "not checked yet" };
  }
  if (isNewer(cache.current, cache.latest)) {
    return {
      label: "updates",
      ok: null,
      detail: `update available: ${cache.current} → ${cache.latest} (run: vibe upgrade)`,
    };
  }
  return { label: "updates", ok: true, detail: `up to date (${cache.current})` };
}
