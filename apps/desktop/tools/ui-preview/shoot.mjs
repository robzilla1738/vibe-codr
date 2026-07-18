/**
 * Screenshot every UI-preview scenario with headless Chromium.
 *
 *   node tools/ui-preview/shoot.mjs [outDir]
 *
 * Expects the preview dev server to be running:
 *   npx vite --config tools/ui-preview/vite.config.ts
 */
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const BASE = process.env.PREVIEW_URL ?? "http://localhost:4517";
const OUT = process.argv[2] ?? "tools/ui-preview/shots";

/** [name, query, viewport] — wide viewports exercise the Session panel layout. */
const SHOTS = [
  ["welcome", "scenario=welcome", { width: 1440, height: 900 }],
  ["splash", "scenario=splash", { width: 1440, height: 900 }],
  ["splash-compact", "scenario=splash", { width: 700, height: 900 }],
  ["chat", "scenario=chat", { width: 1440, height: 900 }],
  ["table", "scenario=table", { width: 1440, height: 900 }],
  ["docs", "scenario=docs", { width: 1440, height: 900 }],
  ["sources", "scenario=sources", { width: 1440, height: 900 }],
  ["busy", "scenario=busy", { width: 1440, height: 900 }],
  ["busy-narrow", "scenario=busy", { width: 1100, height: 900 }],
  ["busy-wide", "scenario=busy", { width: 1720, height: 1000 }],
  ["permission", "scenario=permission", { width: 1440, height: 900 }],
  ["plan", "scenario=plan", { width: 1440, height: 900 }],
  ["gate", "scenario=gate", { width: 1440, height: 900 }],
  ["mode", "scenario=mode", { width: 1440, height: 900 }],
  ["queue", "scenario=queue", { width: 1440, height: 900 }],
  ["onboarding", "scenario=onboarding", { width: 1440, height: 900 }],
  ["slash", "scenario=slash", { width: 1440, height: 900 }],
  ["catalog", "scenario=catalog", { width: 1440, height: 900 }],
  ["catalog-draft", "scenario=catalog-draft", { width: 1440, height: 900 }],
  ["mention", "scenario=mention", { width: 1440, height: 900 }],
  ["attachments", "scenario=attachments", { width: 1440, height: 900 }],
  ["cloud-progress", "scenario=cloud-progress", { width: 1440, height: 900 }],
  ["cloud-failure", "scenario=cloud-failure", { width: 1440, height: 900 }],
  ["jobs", "scenario=jobs", { width: 1440, height: 900 }],
  ["inspector", "scenario=inspector", { width: 1720, height: 1000 }],
  ["changes", "scenario=changes", { width: 1720, height: 1000 }],
  ["changes-compact", "scenario=changes", { width: 700, height: 900 }],
  ["changes-light", "scenario=changes&theme=light", { width: 1720, height: 1000 }],
  ["toast", "scenario=toast", { width: 1440, height: 900 }],
  ["density-quiet", "scenario=density-quiet", { width: 1440, height: 900 }],
  ["density-verbose", "scenario=density-verbose", { width: 1440, height: 900 }],
  ["ctx-hot", "scenario=ctx-hot", { width: 1100, height: 900 }],
  ["light", "scenario=light&theme=light", { width: 1440, height: 900 }],
  ["theme-tokyonight", "scenario=chat&theme=tokyonight", { width: 1440, height: 900 }],
  ["settings", "scenario=settings", { width: 1440, height: 900 }],
  ["settings-narrow", "scenario=settings", { width: 900, height: 900 }],
  ["sessions", "scenario=sessions", { width: 1440, height: 900 }],
  ["sessions-narrow", "scenario=sessions", { width: 700, height: 900 }],
  ["git", "scenario=git", { width: 1440, height: 900 }],
];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
let failures = 0;

for (const [name, query, viewport] of SHOTS) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  await page.goto(`${BASE}/?${query}`, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction(() => window.__previewSettled === true, undefined, { timeout: 20_000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${name}.png`, animations: "disabled" });
    console.log(`✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`✗ ${name}: ${err instanceof Error ? err.message : err}`);
  }
  await page.close();
}

await browser.close();
if (failures > 0) {
  console.error(`ui:shots failed: ${failures} scenario(s)`);
  process.exitCode = 1;
}
