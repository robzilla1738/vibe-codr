import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Logger, RepoProfile } from "@vibe/shared";
import { killTree } from "@vibe/tools";
import type { Exec } from "./exec.ts";
import { bunExec } from "./exec.ts";
import { detectServeCommand, isWebApp, type RepoManifests } from "./codeintel.ts";

/**
 * Runtime visual verification (agentswarm's browser-verify, scoped to
 * verification): after a GREEN gate on a web app, actually boot the dev server,
 * open it in a headless Chromium, and check what static checks can't — does it
 * render, does the console stay clean, and does every visible control DO
 * something when clicked. Runtime findings (console errors, dead controls) feed
 * the same adversarial-review fix budget the diff review uses.
 *
 * `playwright` is an OPTIONAL peer dep (repo convention): imported via a
 * non-literal specifier so an absent dep degrades the whole feature to a silent
 * skip (browserVerify → null, availability surfaced only via a debug log) rather
 * than failing startup. Every step is abortable via `opts.signal` and the whole
 * pass is bounded by a wall clock; the dev-server process tree is always torn
 * down in `finally`. Honesty invariant: a failure to RUN (server never came up,
 * navigation failed) is reported as "could not run", never as a pass.
 */

// ── minimal playwright surface (typed locally; the real dep is optional) ──────

interface PwConsoleMessage {
  type(): string;
  text(): string;
}
interface PwDialog {
  dismiss(): Promise<void>;
}
interface PwLocator {
  click(opts?: { timeout?: number }): Promise<void>;
  count(): Promise<number>;
}
interface PwPage {
  on(event: "console", handler: (msg: PwConsoleMessage) => void): void;
  on(event: "pageerror", handler: (err: Error) => void): void;
  on(event: "request", handler: (req: unknown) => void): void;
  on(event: "dialog", handler: (dialog: PwDialog) => void): void;
  goto(
    url: string,
    opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit"; timeout?: number },
  ): Promise<unknown>;
  screenshot(opts?: { fullPage?: boolean }): Promise<Uint8Array>;
  evaluate<R>(expression: string): Promise<R>;
  goBack(opts?: { timeout?: number }): Promise<unknown>;
  url(): string;
  waitForTimeout(ms: number): Promise<void>;
  locator(selector: string): PwLocator;
}
interface PwBrowser {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
export interface PlaywrightModule {
  chromium: { launch(opts: { headless: boolean }): Promise<PwBrowser> };
}

/** Lazy, memoized optional-peer loader. Absent → null (feature degrades). */
let pwLoader: Promise<PlaywrightModule | null> | undefined;
export function loadPlaywright(): Promise<PlaywrightModule | null> {
  pwLoader ??= (async () => {
    try {
      // Non-literal specifier via a VARIABLE: an absent optional dep degrades,
      // never throws at boot. A cast (`"playwright" as string`) is NOT enough —
      // it erases at transpile time, leaving a literal import("playwright") that
      // `bun build --compile` statically bundles, and playwright-core's own
      // optional requires (chromium-bidi) then fail the whole binary build.
      const specifier = "playwright";
      return (await import(specifier)) as unknown as PlaywrightModule;
    } catch {
      return null;
    }
  })();
  return pwLoader;
}

// ── result + options ─────────────────────────────────────────────────────────

export interface DeadControl {
  /** Accessible text / label of the control (or its tag when unlabeled). */
  text: string;
  /** A human selector for the control (tag + label / index). */
  selector: string;
}

export interface BrowserVerifyResult {
  /** Playwright resolved and we attempted the check. */
  available: boolean;
  /** The page actually loaded and we inspected it (false = "could not run"). */
  ran: boolean;
  /** Why the check couldn't run (set only when `ran` is false). */
  reason?: string;
  url?: string;
  /** Absolute path to the written PNG (.vibe/verify/<ts>.png). */
  screenshotPath?: string;
  /** The same screenshot as base64 (no data: prefix). */
  screenshotBase64?: string;
  consoleErrors: string[];
  deadControls: DeadControl[];
  pagesChecked: number;
}

export interface BrowserVerifyOptions {
  /** Abort the whole pass (external turn signal). */
  signal?: AbortSignal;
  /** Overall wall-clock bound (ms). Default 90s. */
  timeoutMs?: number;
  /** Test seam: skip dev-server boot + teardown and inspect this URL directly. */
  urlOverride?: string;
  /** Test seam: inject the playwright loader (return null to simulate absence). */
  loadPlaywright?: () => Promise<PlaywrightModule | null>;
  /** Exec used for the pre-serve build step (defaults to the local Bun runner). */
  exec?: Exec;
  /** Debug sink; availability + skip reasons surface only here. */
  log?: Pick<Logger, "debug">;
}

// ── abort helpers ────────────────────────────────────────────────────────────

/** Race a promise against an AbortSignal. On abort, reject so the caller maps
 * to could-not-run / null; the underlying playwright op may still finish in the
 * background but `finally` closes the browser + kills the server tree.
 * Also races a hard deadline so a native hang that starves the AbortController
 * timer still unwinds (belt-and-suspenders under suite load). BUG-117. */
function raceAbort<T>(
  p: Promise<T>,
  signal: AbortSignal,
  label: string,
  hardMs = 60_000,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(`aborted during ${label}`));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => done(() => reject(new Error(`aborted during ${label}`)));
    const hardTimer = setTimeout(
      () => done(() => reject(new Error(`timed out during ${label}`))),
      hardMs,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => done(() => resolve(v)),
      (err) => done(() => reject(err)),
    );
  });
}

// ── tunables ─────────────────────────────────────────────────────────────────

/** Deterministic base port; a small scan finds the first free one from here. */
const BASE_PORT = 43117;
const PORT_SCAN = 25;
/** How long to wait for the dev server to bind (its own deadline, not the abort). */
const SERVER_DEADLINE_MS = 30_000;
/** Pre-serve build bound (production-serve scripts need a build first). */
const BUILD_TIMEOUT_SEC = 180;
/** Max controls clicked per page — the first N are the signal. */
const MAX_CONTROLS = 25;
/** Cap on collected console errors (memory bound; display is capped separately). */
const MAX_CONSOLE = 50;
const CLICK_TIMEOUT_MS = 1_500;
const SETTLE_MS = 150;
const GOTO_TIMEOUT_MS = 15_000;
const GOBACK_TIMEOUT_MS = 4_000;

interface ControlDesc {
  idx: number;
  text: string;
  tag: string;
}

// ── the pass ─────────────────────────────────────────────────────────────────

/**
 * Boot the app, render it headless, and collect runtime findings. Returns null
 * (silent skip) when the feature doesn't apply: not a web app, no serve command,
 * playwright unavailable, or aborted. Returns a "could not run" result (never a
 * pass) when the server never came up or navigation failed for a non-abort
 * reason. Never throws.
 */
export async function browserVerify(
  cwd: string,
  profile: RepoProfile,
  opts: BrowserVerifyOptions = {},
): Promise<BrowserVerifyResult | null> {
  if (opts.signal?.aborted) return null;
  if (!isWebApp(profile)) return null;

  const load = opts.loadPlaywright ?? loadPlaywright;
  const pw = await load();
  if (!pw) {
    opts.log?.debug("browser-verify: playwright unavailable — skipping visual check");
    return null;
  }

  // Combine the external signal with an overall wall-clock deadline so every
  // step aborts on either. Both routes tear down. Only the EXTERNAL abort
  // (the caller's signal — e.g. Esc) maps to a null (silent skip); the internal
  // wall-clock timeout is NOT a user cancellation — the check was attempted and
  // just didn't finish, so it maps to an honest "could not run" (BUG: flaky
  // browser-verify test when system load delays browser launch past the timeout).
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, opts.timeoutMs ?? 90_000);
  timer.unref?.();
  let externallyAborted = false;
  const onExternalAbort = () => {
    externallyAborted = true;
    controller.abort();
  };
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const signal = controller.signal;

  let proc: Bun.Subprocess | undefined;
  let browser: PwBrowser | undefined;
  try {
    // 1. Resolve the URL — either the injected override (test seam) or a freshly
    //    booted dev server.
    let url: string;
    if (opts.urlOverride) {
      url = opts.urlOverride;
    } else {
      const manifests = await readManifests(cwd);
      if (!manifests) return null;
      const port = findFreePort(BASE_PORT);
      const serve = detectServeCommand(manifests, port);
      if (!serve) return null;
      if (serve.needsBuild && profile.commands.build) {
        const exec = opts.exec ?? bunExec();
        await exec(profile.commands.build, { cwd, timeoutSec: BUILD_TIMEOUT_SEC, signal });
      }
      if (signal.aborted)
        return externallyAborted ? null : couldNotRun("timed out before server boot");
      proc = Bun.spawn(["bash", "-lc", serve.cmd], {
        cwd,
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      url = `http://127.0.0.1:${port}/`;
      const up = await waitForServer(url, SERVER_DEADLINE_MS, signal);
      if (!up) {
        if (signal.aborted)
          return externallyAborted ? null : couldNotRun("timed out waiting for server");
        return couldNotRun(
          `dev server did not respond at ${url} within ${SERVER_DEADLINE_MS / 1000}s`,
        );
      }
    }
    if (signal.aborted)
      return externallyAborted ? null : couldNotRun("timed out before browser launch");

    // 2. Render + inspect. Race launch against the abort controller — chromium
    // launch can hang forever when the browser binary is missing/wedged, and
    // page.goto has its own timeout that ignores our wall-clock. Without this
    // race, the wall-clock timer aborts the controller but the in-flight
    // playwright promise keeps the gate afterTurn hung (BUG-117).
    browser = await raceAbort(
      pw.chromium.launch({ headless: true }),
      signal,
      "browser launch",
      Math.min(opts.timeoutMs ?? 90_000, 45_000),
    );
    return await inspect(browser, url, cwd, signal, opts.timeoutMs ?? 90_000);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    opts.log?.debug(`browser-verify failed: ${message}`);
    // An external (Esc) abort is a silent skip; a genuine failure OR an internal
    // wall-clock timeout (the check was attempted, just didn't finish) is an
    // honest "could not run".
    return externallyAborted ? null : couldNotRun(message);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
    try {
      await browser?.close();
    } catch {
      /* best-effort */
    }
    if (proc?.pid) {
      // Kill the whole dev-server tree (bash -lc leaves node/vite grandchildren).
      try {
        killTree(proc.pid);
      } catch {
        /* fall through to the direct kill */
      }
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

/** Open the page, screenshot it, watch the console, and click every visible
 * control to find the dead ones. Assumes the browser is launched + the URL is up. */
async function inspect(
  browser: PwBrowser,
  url: string,
  cwd: string,
  signal: AbortSignal,
  wallMs = 90_000,
): Promise<BrowserVerifyResult> {
  const page = await browser.newPage();
  const consoleErrors: string[] = [];
  let requestCount = 0;
  let dialogCount = 0;

  page.on("console", (msg) => {
    if (msg.type() === "error" && consoleErrors.length < MAX_CONSOLE)
      consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    if (consoleErrors.length < MAX_CONSOLE) consoleErrors.push(String(err?.message ?? err));
  });
  page.on("request", () => {
    requestCount++;
  });
  // Dialogs block the page until handled — dismiss them (and count as an effect).
  page.on("dialog", (dialog) => {
    dialogCount++;
    void dialog.dismiss().catch(() => {});
  });

  await raceAbort(
    page.goto(url, {
      waitUntil: "load",
      timeout: Math.min(GOTO_TIMEOUT_MS, wallMs),
    }),
    signal,
    "page navigation",
    Math.min(GOTO_TIMEOUT_MS + 2_000, wallMs),
  );
  try {
    await page.waitForTimeout(SETTLE_MS);
  } catch {
    /* ignore */
  }

  // (a) screenshot the rendered state (before any interaction perturbs it).
  const bytes = await page.screenshot({ fullPage: false });
  const dir = join(cwd, ".vibe", "verify");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = join(dir, `${stamp}.png`);
  await Bun.write(screenshotPath, bytes);
  const screenshotBase64 = Buffer.from(bytes).toString("base64");

  // (c) click every visible control; anything with no observable effect is dead.
  await page.evaluate<boolean>(INSTALL_OBSERVER);
  let controls = await page.evaluate<ControlDesc[]>(COLLECT_CONTROLS);
  const deadControls: DeadControl[] = [];
  let pagesChecked = 1;

  for (const ctl of controls) {
    if (signal.aborted) break;
    const loc = page.locator(`[data-vibe-ctl="${ctl.idx}"]`);
    let exists = 0;
    try {
      exists = await loc.count();
    } catch {
      exists = 0;
    }
    if (!exists) continue;

    const beforeUrl = page.url();
    const beforeReq = requestCount;
    const beforeDlg = dialogCount;
    try {
      await page.evaluate<void>(RESET_MUTATIONS);
    } catch {
      /* ignore */
    }
    try {
      await loc.click({ timeout: CLICK_TIMEOUT_MS });
    } catch {
      // Couldn't click (covered / detached) — counts as no observable effect.
    }
    try {
      await page.waitForTimeout(SETTLE_MS);
    } catch {
      /* ignore */
    }

    const navigated = page.url() !== beforeUrl;
    let mutations = 0;
    if (!navigated) {
      try {
        mutations = await page.evaluate<number>(READ_MUTATIONS);
      } catch {
        /* ignore */
      }
    }
    const observable =
      navigated || mutations > 0 || requestCount > beforeReq || dialogCount > beforeDlg;
    if (!observable) deadControls.push({ text: ctl.text, selector: controlSelector(ctl) });

    if (navigated) {
      pagesChecked++;
      try {
        await page.goBack({ timeout: GOBACK_TIMEOUT_MS });
        await page.evaluate<boolean>(INSTALL_OBSERVER);
        controls = await page.evaluate<ControlDesc[]>(COLLECT_CONTROLS);
      } catch {
        break; // lost the page context — stop probing rather than thrash
      }
    }
  }

  return {
    available: true,
    ran: true,
    url,
    screenshotPath,
    screenshotBase64,
    consoleErrors,
    deadControls,
    pagesChecked,
  };
}

// ── browser-side snippets (strings: this package's tsconfig has no DOM lib) ────

/** Tag each visible button/link/[role=button]/[onclick] with data-vibe-ctl and
 * return its descriptor (first MAX_CONTROLS, DOM order). */
const COLLECT_CONTROLS = `(() => {
  const MAX = ${MAX_CONTROLS};
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const nodes = Array.from(document.querySelectorAll('button, a, [role=button], [onclick]'));
  const out = [];
  let idx = 0;
  for (const el of nodes) {
    if (idx >= MAX) break;
    if (!visible(el)) continue;
    el.setAttribute('data-vibe-ctl', String(idx));
    const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.tagName || '')
      .replace(/\\s+/g, ' ').trim().slice(0, 80);
    out.push({ idx, text: label, tag: (el.tagName || '').toLowerCase() });
    idx++;
  }
  return out;
})()`;

/** Install a single tree-wide MutationObserver counting mutations into __vibeMut. */
const INSTALL_OBSERVER = `(() => {
  const w = window;
  w.__vibeMut = 0;
  if (w.__vibeObs) w.__vibeObs.disconnect();
  w.__vibeObs = new MutationObserver((muts) => { w.__vibeMut += muts.length; });
  w.__vibeObs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  return true;
})()`;

const RESET_MUTATIONS = `(() => { window.__vibeMut = 0; })()`;
const READ_MUTATIONS = `(window.__vibeMut || 0)`;

// ── formatting ───────────────────────────────────────────────────────────────

/** A compact block for notices / fix prompts. Honesty invariant: a check that
 * couldn't run says so — it never renders as a pass. Output is capped with
 * explicit truncation markers (this text lands in the model's prompt verbatim). */
export function formatBrowserVerify(result: BrowserVerifyResult): string {
  if (!result.available) return "Visual check could not run: playwright unavailable.";
  if (!result.ran) return `Visual check could not run: ${result.reason ?? "unknown reason"}.`;

  const summary =
    `Visual check: rendered OK, ${result.consoleErrors.length} console ` +
    `${plural(result.consoleErrors.length, "error")}, ${result.deadControls.length} dead ` +
    `${plural(result.deadControls.length, "control")}`;

  const sections: string[] = [];
  if (result.consoleErrors.length) {
    sections.push(`Console errors:\n${bullets(result.consoleErrors, 5, (e) => trunc(e, 200))}`);
  }
  if (result.deadControls.length) {
    sections.push(
      "Dead controls (clicked, nothing observable happened):\n" +
        bullets(result.deadControls, 10, (c) => `${c.text || c.selector} — ${c.selector}`),
    );
  }
  const shot = result.screenshotPath ? `\n(screenshot: ${result.screenshotPath})` : "";
  return sections.length ? `${summary}:\n${sections.join("\n")}${shot}` : `${summary}.${shot}`;
}

function bullets<T>(items: T[], cap: number, render: (item: T) => string): string {
  const shown = items.slice(0, cap).map((i) => `  - ${render(i)}`);
  if (items.length > cap) shown.push(`  …(${items.length - cap} more)`);
  return shown.join("\n");
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function trunc(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function couldNotRun(reason: string): BrowserVerifyResult {
  return {
    available: true,
    ran: false,
    reason,
    consoleErrors: [],
    deadControls: [],
    pagesChecked: 0,
  };
}

function controlSelector(ctl: ControlDesc): string {
  return ctl.text ? `${ctl.tag} "${trunc(ctl.text, 40)}"` : `${ctl.tag}#${ctl.idx}`;
}

/** Reconstruct just enough of RepoManifests from disk to detect the serve
 * command: package.json (required) + which lockfiles exist (for the pkg manager). */
async function readManifests(cwd: string): Promise<RepoManifests | null> {
  let packageJson: string;
  try {
    packageJson = await Bun.file(join(cwd, "package.json")).text();
  } catch {
    return null;
  }
  if (!packageJson.trim()) return null;
  const lockfiles: string[] = [];
  for (const lf of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"]) {
    if (existsSync(join(cwd, lf))) lockfiles.push(lf);
  }
  return { packageJson, lockfiles };
}

/** First free TCP port at/after `base` (deterministic, so reruns don't drift). */
function findFreePort(base: number): number {
  for (let port = base; port < base + PORT_SCAN; port++) {
    if (isPortFree(port)) return port;
  }
  return base;
}

function isPortFree(port: number): boolean {
  try {
    const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    listener.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** Poll the URL until anything answers (server bound the port) or the deadline
 * passes. Any HTTP response — even 4xx/5xx — proves the server is up. */
async function waitForServer(
  url: string,
  deadlineMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (signal.aborted) return false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_500) });
      try {
        await res.body?.cancel();
      } catch {
        /* drain best-effort */
      }
      return true;
    } catch {
      // Not up yet — back off and retry.
    }
    await sleep(300, signal);
  }
  return false;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
