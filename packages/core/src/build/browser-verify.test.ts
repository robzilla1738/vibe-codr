import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoProfile } from "@vibe/shared";
import {
  browserVerify,
  formatBrowserVerify,
  type BrowserVerifyResult,
  type PlaywrightModule,
} from "./browser-verify.ts";

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeProfile(over: Partial<RepoProfile> = {}): RepoProfile {
  return {
    greenfield: false,
    primaryLanguage: "TypeScript",
    packageManager: "npm",
    framework: "React",
    commands: {},
    monorepo: { tool: null, packages: [] },
    git: { isRepo: true, branch: "main", dirty: false },
    conventions: [],
    manifestFiles: ["package.json"],
    ...over,
  };
}

function tempCwd(pkg?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "vibe-browser-verify-"));
  if (pkg) writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
}

/** A non-null fake playwright module so degradation tests can pass the peer-dep
 * gate WITHOUT depending on the real dep being present. It's never used past the
 * serve-detection early-exits these tests exercise. */
const fakePlaywright = (): Promise<PlaywrightModule> =>
  Promise.resolve({
    chromium: { launch: async () => ({ newPage: async () => ({}), close: async () => {} }) },
  } as unknown as PlaywrightModule);

// ── degradation paths (no real browser needed) ───────────────────────────────

test("non-web profile → null (silent skip)", async () => {
  const cwd = tempCwd({ scripts: { dev: "vite" }, dependencies: { react: "^18" } });
  const result = await browserVerify(cwd, makeProfile({ framework: null }), {
    loadPlaywright: fakePlaywright,
  });
  expect(result).toBeNull();
});

test("no serve script → null (silent skip)", async () => {
  // Web app, playwright present, but package.json has no dev/serve/start script.
  const cwd = tempCwd({ scripts: { build: "vite build" }, dependencies: { react: "^18" } });
  const result = await browserVerify(cwd, makeProfile(), { loadPlaywright: fakePlaywright });
  expect(result).toBeNull();
});

test("no package.json → null (silent skip)", async () => {
  const cwd = tempCwd(); // no package.json written
  const result = await browserVerify(cwd, makeProfile(), { loadPlaywright: fakePlaywright });
  expect(result).toBeNull();
});

test("playwright absent → null (silent skip)", async () => {
  const cwd = tempCwd({ scripts: { dev: "vite" }, dependencies: { react: "^18" } });
  const result = await browserVerify(cwd, makeProfile(), {
    loadPlaywright: async () => null,
  });
  expect(result).toBeNull();
});

test("already-aborted signal → null (silent skip)", async () => {
  const cwd = tempCwd({ scripts: { dev: "vite" }, dependencies: { react: "^18" } });
  const result = await browserVerify(cwd, makeProfile(), {
    signal: AbortSignal.abort(),
    loadPlaywright: fakePlaywright,
  });
  expect(result).toBeNull();
});

// ── formatBrowserVerify renderings ────────────────────────────────────────────

test("formatBrowserVerify: pass rendering", () => {
  const result: BrowserVerifyResult = {
    available: true,
    ran: true,
    url: "http://127.0.0.1:43117/",
    screenshotPath: "/tmp/x/.vibe/verify/shot.png",
    consoleErrors: [],
    deadControls: [],
    pagesChecked: 1,
  };
  const out = formatBrowserVerify(result);
  expect(out).toContain("rendered OK");
  expect(out).toContain("0 console errors");
  expect(out).toContain("0 dead controls");
  expect(out).toContain("shot.png");
  expect(out).not.toContain("could not run");
});

test("formatBrowserVerify: fail rendering lists errors + dead controls (capped)", () => {
  const result: BrowserVerifyResult = {
    available: true,
    ran: true,
    url: "http://127.0.0.1:43117/",
    consoleErrors: Array.from({ length: 8 }, (_, i) => `error ${i}`),
    deadControls: [{ text: "Save", selector: 'button "Save"' }],
    pagesChecked: 1,
  };
  const out = formatBrowserVerify(result);
  expect(out).toContain("1 dead control"); // singular, not "controls"
  expect(out).toContain("Save");
  expect(out).toContain("Console errors:");
  expect(out).toContain("…(3 more)"); // 8 errors, cap 5 → 3 more, explicit marker
  expect(out).not.toContain("could not run");
});

test("formatBrowserVerify: could-not-run is honest (never a pass)", () => {
  const ranFail: BrowserVerifyResult = {
    available: true,
    ran: false,
    reason: "dev server did not respond at http://127.0.0.1:43117/ within 30s",
    consoleErrors: [],
    deadControls: [],
    pagesChecked: 0,
  };
  const out = formatBrowserVerify(ranFail);
  expect(out).toContain("could not run");
  expect(out).toContain("dev server did not respond");
  expect(out).not.toContain("rendered OK");

  const unavailable: BrowserVerifyResult = {
    available: false,
    ran: false,
    consoleErrors: [],
    deadControls: [],
    pagesChecked: 0,
  };
  expect(formatBrowserVerify(unavailable)).toContain("could not run");
  expect(formatBrowserVerify(unavailable)).toContain("playwright unavailable");
});

/**
 * BUG-117: wall-clock abort must race chromium.launch — a never-resolving
 * launch used to hang the gate until the bun test timeout. raceAbort maps the
 * abort to could-not-run so production turns unwind. Removing raceAbort makes
 * this test hang past the assertion window.
 */
test("BUG-117: hung chromium.launch returns could-not-run within wall-clock (raceAbort)", async () => {
  const cwd = tempCwd();
  // Never resolves — simulates a wedged browser binary.
  const hungLaunch = new Promise<never>(() => {});
  const start = Date.now();
  const result = await browserVerify(cwd, makeProfile(), {
    urlOverride: "http://127.0.0.1:9/",
    timeoutMs: 400,
    loadPlaywright: async () =>
      ({
        chromium: {
          launch: async () => hungLaunch,
        },
      }) as unknown as PlaywrightModule,
  });
  const elapsed = Date.now() - start;
  expect(result).not.toBeNull();
  expect(result!.available).toBe(true);
  expect(result!.ran).toBe(false);
  expect(formatBrowserVerify(result!)).toContain("could not run");
  // Must return near the wall-clock, not sit until a 20s/90s outer timeout.
  expect(elapsed).toBeLessThan(5_000);
});

test("BUG-117: hung page.goto returns could-not-run within wall-clock (raceAbort)", async () => {
  const cwd = tempCwd();
  const hungGoto = new Promise<never>(() => {});
  const start = Date.now();
  const result = await browserVerify(cwd, makeProfile(), {
    urlOverride: "http://127.0.0.1:9/",
    timeoutMs: 400,
    loadPlaywright: async () =>
      ({
        chromium: {
          launch: async () => ({
            newPage: async () => ({
              on: () => {},
              goto: async () => hungGoto,
              waitForTimeout: async () => {},
              screenshot: async () => new Uint8Array([1]),
              evaluate: async () => [],
              locator: () => ({ count: async () => 0, click: async () => {} }),
              url: () => "http://127.0.0.1:9/",
              goBack: async () => {},
            }),
            close: async () => {},
          }),
        },
      }) as unknown as PlaywrightModule,
  });
  const elapsed = Date.now() - start;
  expect(result).not.toBeNull();
  expect(result!.ran).toBe(false);
  expect(formatBrowserVerify(result!)).toContain("could not run");
  expect(elapsed).toBeLessThan(5_000);
});

// ── real browser tier (skips gracefully when playwright/chromium is unavailable) ─

async function playwrightReady(): Promise<boolean> {
  try {
    const pw = (await import("playwright" as string)) as unknown as PlaywrightModule;
    const browser = await pw.chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const PW_READY = await playwrightReady();
const browserTest = PW_READY ? test : test.skip;

browserTest(
  "real browser: screenshot written, dead control flagged, live control + console.error captured",
  async () => {
    const cwd = tempCwd(); // urlOverride skips boot/teardown; no package.json needed
    // A tiny page: a dead button (no handler), a live button (onclick mutates the
    // DOM), and a console.error at load.
    const html =
      "<!doctype html><html><body>" +
      '<button id="dead">Dead Button</button>' +
      '<button id="live" onclick="document.body.appendChild(document.createElement(\'div\'))">Live Button</button>' +
      '<script>console.error("boom from the page")</script>' +
      "</body></html>";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
    });
    try {
      const url = `http://127.0.0.1:${server.port}/`;
      // Bound wall-clock so a wedged chromium.launch cannot hang forever
      // (raceAbort maps the abort to could-not-run). Under full-suite load
      // launch can take >15s; keep bun timeout generous and wall-clock tight
      // enough to still fail closed if chromium is dead.
      const result = await browserVerify(cwd, makeProfile(), {
        urlOverride: url,
        timeoutMs: 45_000,
      });
      expect(result).not.toBeNull();
      const r = result!;
      expect(r.available).toBe(true);
      expect(r.ran).toBe(true);

      // (a) screenshot written to .vibe/verify + returned as base64.
      expect(r.screenshotPath).toBeDefined();
      expect(existsSync(r.screenshotPath!)).toBe(true);
      expect(r.screenshotBase64?.length ?? 0).toBeGreaterThan(0);

      // (b) the page's console.error is captured.
      expect(r.consoleErrors.some((e) => e.includes("boom from the page"))).toBe(true);

      // (c) the dead button is flagged; the live one (mutates DOM) is not.
      const deadTexts = r.deadControls.map((d) => d.text).join(" | ");
      expect(deadTexts).toContain("Dead Button");
      expect(deadTexts).not.toContain("Live Button");
    } finally {
      server.stop(true);
    }
  },
  60_000,
);

browserTest(
  "real browser: server that never comes up → honest 'could not run' (not a pass)",
  async () => {
    // A web app whose serve command binds a port we never actually serve: point
    // the poll at a closed port with a tight overall bound so it fails fast.
    const cwd = tempCwd();
    const result = await browserVerify(cwd, makeProfile(), {
      // urlOverride is up-front, so simulate the boot-failure path via a bad URL
      // and a short wall clock: goto against a dead port throws → could-not-run.
      urlOverride: "http://127.0.0.1:1/", // port 1 is not listening
      timeoutMs: 12_000,
    });
    expect(result).not.toBeNull();
    expect(result!.available).toBe(true);
    expect(result!.ran).toBe(false);
    expect(formatBrowserVerify(result!)).toContain("could not run");
  },
  45_000,
);
