import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ElectronApplication, _electron as electron, expect, type Page, test } from "@playwright/test";

const root = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(root, "test", "fixtures", "vibe-codr");
const projectDir = join(root, "test", "fixtures", "project");
const editor = join(root, "test", "fixtures", "editor.mjs");
const icon = join(root, "test", "fixtures", "icon.png");
let app: ElectronApplication;
let page: Page;
let userData: string;

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), "vbcode-electron-e2e-"));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env,
      VIBE_CODR_ROOT: fixtureRoot,
      VISUAL: `${process.execPath} ${editor}`,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  page = await app.firstWindow();
  // The host-authorized recent project opens automatically. Renderer storage
  // remains only a restore hint and never self-authorizes a filesystem root.
  await expect(page.getByRole("textbox", { name: "Task message" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Open a project" })).toHaveCount(0);
});

test.afterAll(async () => {
  await app?.close();
  rmSync(userData, { recursive: true, force: true });
});

async function submit(text: string) {
  const composer = page.getByRole("textbox", { name: "Task message" });
  await composer.fill(text);
  await composer.press("Enter");
}

test("keeps empty, focus, and 200% zoom states usable", async () => {
  const invalidRpc = await page.evaluate(() => (window as any).vibe.rpc("not-a-method"));
  expect(invalidRpc).toMatchObject({ ok: false, error: "Invalid RPC request" });

  const jobs = page.getByRole("button", { name: "Toggle background jobs" });
  await jobs.focus();
  const focusStyle = await jobs.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outline: style.outlineStyle, shadow: style.boxShadow };
  });
  expect(focusStyle.outline).toBe("none");
  // Two-layer keyboard focus ring: surface gap + accent halo (no inset).
  expect(focusStyle.shadow).not.toBe("none");
  expect(focusStyle.shadow).toContain("0px 0px 0px 4px");

  await jobs.click();
  await expect(page.getByText(/Background commands, subagents, task batches, and monitors appear here/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Task message" })).toBeVisible();

  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await expect(page.getByRole("textbox", { name: "Task message" })).toBeVisible();
  await expect(jobs).toBeVisible();
  await page.evaluate(() => { document.documentElement.style.zoom = ""; });

  await page.emulateMedia({ reducedMotion: "reduce" });
  const duration = await jobs.evaluate((element) => getComputedStyle(element).animationDuration);
  expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.01);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await page.setViewportSize({ width: 820, height: 620 });
  await expect(page.getByRole("textbox", { name: "Task message" })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 820 });
});

test("renames, archives, and deletes saved sessions through host RPC", async () => {
  await expect(page.getByText("Saved one", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Saved one/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const rename = page.getByRole("textbox", { name: "Rename session" });
  await rename.fill("Renamed fixture");
  await rename.press("Enter");
  await expect(page.getByText("Renamed fixture", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /^Renamed fixture/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByText("Renamed fixture", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: /^Saved two/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Saved two", { exact: true })).toHaveCount(0);
});

test("streams reasoning, tools, diffs, markdown, telemetry, and engine-idle", async () => {
  await submit("fixture:stream");
  await expect(page.getByText("Done with markdown.")).toBeVisible();
  await page.locator(".turn-process-summary").last().click();
  await expect(page.getByRole("button", { name: /edited src\/example\.ts/ })).toBeVisible();
  await expect(page.getByText("fixture:stream")).toBeVisible();
  await expect(page.locator(".composer-metric", { hasText: "15 tok · $0.0010" })).toBeAttached();
  await expect(page.locator('.ctx-ring')).toContainText('10%');
  await expect(page.getByText("Vibe Codr is idle")).toBeAttached();
  await page.getByRole("button", { name: /Expand .*src\/example\.ts/ }).click();
  await expect(page.getByText("+ new")).toBeVisible();
  await expect(page.getByText("fixture command failed")).toBeVisible();
  const reasoning = page.getByRole("button", { name: /Expand Thought/ });
  await expect(reasoning).toBeVisible();
  await reasoning.click();
  await expect(page.getByText("Inspecting the fixture.", { exact: false })).toBeVisible();

  await submit("/details quiet");
  await submit("fixture:stream");
  await expect(page.getByText("Done with markdown.").last()).toBeVisible();
  const quietTurn = page.locator(".turn").last();
  await quietTurn.locator(".turn-process-summary").click();
  const quietFailure = quietTurn.locator("button.tool-head").filter({ hasText: "exit 1" });
  await quietFailure.click();
  await expect(quietFailure).toHaveAttribute("aria-expanded", "true");
  await expect(quietTurn.getByText("fixture command failed", { exact: true })).toBeVisible();
  await expect(quietTurn.getByRole("status", { name: /npm install, failed with no output/i })).toBeVisible();

  await submit("/details verbose");
  const verboseFailure = quietTurn.locator("button.tool-head").filter({ hasText: "exit 1" });
  await verboseFailure.click();
  await expect(verboseFailure).toHaveAttribute("aria-expanded", "false");
  await expect(quietTurn.getByText("fixture command failed", { exact: true })).toBeHidden();
});

test("shows actionable live insight in Sessions and settles it after the turn", async () => {
  await submit("fixture:live-session");
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  const live = page.locator(".session-live-summary");
  await expect(live.getByText("$ npm run typecheck", { exact: true })).toBeVisible();
  await expect(live.getByText("Tasks 0/2", { exact: true })).toBeVisible();
  await expect(live.getByText("1 agent", { exact: true })).toBeVisible();
  await expect(live.getByText("1 job", { exact: true })).toBeVisible();
  await expect(live.getByText("1 queued", { exact: true })).toBeVisible();
  await expect(live.getByText("Context 80%", { exact: true })).toBeVisible();
  await expect(live.getByText("1.5k tokens", { exact: true })).toBeVisible();
  await expect(live.getByText("$0.0123", { exact: true })).toBeVisible();
  await expect(live.getByText("Checks passed", { exact: true })).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: "Back to chat" }).click();
  await expect(page.getByRole("textbox", { name: "Task message" })).toBeVisible();
});

test("contains hostile markdown and applies CLI theme events", async () => {
  const originalUrl = page.url();
  await submit("fixture:markdown");
  await expect(page.getByRole("link", { name: "safe" })).toHaveAttribute("href", "https://example.com/path");
  await expect(page.getByRole("link", { name: "unsafe" })).toHaveCount(0);
  await expect(page.locator("script")).toHaveCount(1); // application entry script only
  expect(await page.evaluate(() => (window as unknown as { fixtureInjected?: boolean }).fixtureInjected)).toBeUndefined();
  expect(page.url()).toBe(originalUrl);

  await submit("/theme light");
  await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe("light");
  const lightRoles = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const content = getComputedStyle(document.querySelector<HTMLElement>(".content-inset")!);
    const rail = getComputedStyle(document.querySelector<HTMLElement>(".project-rail")!);
    return {
      background: root.getPropertyValue("--bg").trim(),
      elevated: root.getPropertyValue("--elevated").trim(),
      muted: root.getPropertyValue("--muted").trim(),
      contentBackground: content.backgroundColor,
      railBackground: rail.backgroundColor,
    };
  });
  expect(lightRoles).toMatchObject({
    background: "#f8f8f7",
    elevated: "#ffffff",
    muted: "#68707a",
  });
  expect(lightRoles.contentBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(lightRoles.railBackground).not.toBe("rgba(0, 0, 0, 0)");
});

test("resolves permission and plan cards from keyboard-accessible controls", async () => {
  await submit("fixture:permission");
  await expect(page.getByText("Run a command", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /once/ }).click();
  await expect(page.getByText("permission once")).toBeVisible();

  await submit("fixture:plan");
  await expect(page.getByText("Review plan")).toBeVisible();
  await expect(page.getByText("This plan was presented without the research the request called for.")).toBeVisible();
  await expect(page.getByText("The fixture is writable")).toBeVisible();
  await page.getByRole("button", { name: /Accept Enter/ }).click();
  await expect(page.getByText("plan accept")).toBeVisible();
});

test("steers/removes queued work and suppresses stale output after clear", async () => {
  await submit("fixture:queue");
  await expect(page.getByText("Queued one")).toBeVisible();
  await page.getByRole("button", { name: "Remove Queued one from queue" }).click();
  await expect(page.getByText("Queued one")).toBeHidden();

  await submit("fixture:slow");
  await submit("/clear");
  // Fixture emits STALE OUTPUT at 600ms; poll past that window without a fixed sleep
  // so slower CI (xvfb) does not flake on wall-clock alone.
  await expect
    .poll(async () => page.getByText("STALE OUTPUT").count(), {
      timeout: 3_000,
      intervals: [100, 200, 400],
    })
    .toBe(0);
});

test("renders task, subagent, source, job, and checkpoint activity in the correct surfaces", async () => {
  await submit("fixture:activity");
  await expect(page.getByText("Fixture activity complete.")).toBeVisible();
  await page.getByRole("button", { name: "Toggle background jobs" }).click();
  await expect(page.getByText("npm run dev")).toBeVisible();
  await expect(page.getByRole("link", { name: "http://localhost:4310" })).toBeVisible();
  await page.getByRole("button", { name: "Close jobs" }).click();
  await page.getByRole("button", { name: "Review live task and subagent details" }).click();
  await expect(page.locator(".sidebar-line").filter({ hasText: "Before fixture change" })).toBeVisible();
  await expect(page.getByText(/Run fixture child/)).toBeVisible();
  const subagents = page.locator("#session-panel .sidebar-section").filter({ hasText: "Subagents" }).last();
  await expect(subagents.getByTitle("Review the fixture", { exact: true })).toBeVisible();
  const subagent = subagents.locator("details.subagent-detail").filter({ hasText: "Review the fixture" });
  await subagent.locator("summary").click();
  await expect(subagent.getByText("review complete", { exact: true })).toBeVisible();
  await expect(subagent.getByRole("button", { name: "Copy result from Review the fixture" })).toBeVisible();
  await expect(page.locator("#session-panel .inspector-stream")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Session", exact: true })).toBeHidden();
  // Opening Session closes Jobs; leave Jobs closed so the transcript is interactive.
  await expect(page.getByRole("button", { name: "Dismiss jobs" })).toHaveCount(0);
  await page.locator(".turn").last().locator(".turn-process-summary").click();
  await page.getByRole("button", { name: /Expand.*search.*fixture/ }).click();
  await expect(page.getByRole("link", { name: "Fixture search" })).toBeVisible();
});

test("attaches files, pastes images, and round-trips through the external editor", async () => {
  const composer = page.getByRole("textbox", { name: "Task message" });
  await composer.fill("Read @read");
  await expect(page.getByText("@README.md")).toBeVisible();
  await composer.press("ArrowDown");
  await composer.press("Tab");
  await expect(composer).toHaveValue("Read @README.md ");

  const clipboardState = await app.evaluate(({ clipboard, nativeImage }, imagePath) => {
    clipboard.clear();
    const image = nativeImage.createFromPath(imagePath);
    clipboard.writeImage(image);
    return { empty: clipboard.readImage().isEmpty(), text: clipboard.readText() };
  }, icon);
  expect(clipboardState).toEqual({ empty: false, text: "" });
  await composer.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
  await expect(composer).toHaveValue(/@\.vibe\/clipboard\/vibe-clip-.*\.png/);
  expect(existsSync(join(projectDir, ".vibe", "clipboard"))).toBe(true);

  await composer.fill("before editor");
  await composer.press("Control+G");
  await expect(composer).toHaveValue("composed by fixture editor");
  await expect(composer).toBeFocused();
  rmSync(join(projectDir, ".vibe"), { recursive: true, force: true });
});

test("opens live model, provider, agent, skill, and MCP catalogs", async () => {
  const composer = page.getByRole("textbox", { name: "Task message" });
  await composer.fill("/model");
  await expect(page.getByRole("dialog", { name: /Models/ })).toBeVisible();
  await expect(page.getByText("Fixture Model")).toBeVisible();
  await page.keyboard.press("Escape");

  for (const [command, expected] of [
    ["/providers", "fixture"],
    ["/agents", "reviewer"],
    ["/skills", "fixture-skill"],
    ["/mcp", "fixture-mcp"],
  ] as const) {
    await composer.fill(command);
    const catalog = page.getByRole("dialog");
    await expect(catalog).toBeVisible();
    await expect(catalog.getByText(expected, { exact: false }).first()).toBeVisible();
    await page.keyboard.press("Escape");
  }
});

test("recovers from a fatal host by starting a fresh session", async () => {
  await submit("fixture:fatal");
  await expect(page.getByText("fixture host failure", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "New session" }).click();
  await expect(page.getByRole("textbox", { name: "Task message" })).toBeVisible();
  await submit("recovered");
  await expect(page.getByText("Echo: recovered")).toBeVisible();
});

test("workspace dock keeps Session/Changes/Git/Terminal/Jobs mutually exclusive", async () => {
  const jobsToggle = page.getByRole("button", { name: "Toggle background jobs" });
  await jobsToggle.click();
  const sidebar = page.getByRole("complementary", { name: "Workspace tools" });
  await expect(sidebar).toBeVisible();
  await expect(page.getByRole("region", { name: "Background jobs" })).toBeVisible();
  for (const tab of ["Session", "Changes", "Git", "Terminal", "Jobs"]) {
    await expect(sidebar.getByRole("button", { name: tab, exact: true })).toBeVisible();
  }

  await sidebar.getByRole("button", { name: "Session", exact: true }).click();
  await expect(page.getByRole("region", { name: "Session", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Background jobs" })).toHaveCount(0);

  await sidebar.getByRole("button", { name: "Git", exact: true }).click();
  await expect(page.getByRole("region", { name: "Git", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Session", exact: true })).toHaveCount(0);

  await sidebar.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".terminal-activity-rail")).toBeVisible();
  await sidebar.getByRole("button", { name: "Session", exact: true }).click();
  await expect(page.getByRole("region", { name: "Session", exact: true })).toBeVisible();
  await expect(page.locator(".terminal-activity-rail")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await expect(page.getByRole("textbox", { name: "Task message" })).toBeVisible();
});

test("opens an interactive project terminal in the shared end-panel lane", async () => {
  const inheritedPanel = page.locator(".activity-sidebar:not(.is-closing) .activity-rail");
  if (await inheritedPanel.count()) {
    await inheritedPanel.getByRole("button", { name: /^Close/ }).click();
  }
  const terminalToggle = page.getByRole("button", { name: "Open project terminal" });
  await expect(terminalToggle).toBeVisible();
  await terminalToggle.click();

  const terminalPanel = page.locator(".terminal-activity-rail");
  await expect(terminalPanel).toBeVisible();
  await expect.poll(async () => page.locator(".activity-sidebar").evaluate((sidebar) =>
    sidebar.getAnimations().filter((animation) => animation.playState === "running").length,
  )).toBe(0);
  const geometry = await page.locator(".chat-workspace > .content-inset").evaluate((content) => {
    const pane = content.querySelector<HTMLElement>(".activity-sidebar")!;
    const chat = content.querySelector<HTMLElement>(".main-column")!;
    const contentBox = content.getBoundingClientRect();
    const paneBox = pane.getBoundingClientRect();
    const chatBox = chat.getBoundingClientRect();
    const style = getComputedStyle(pane);
    return {
      topGap: paneBox.top - contentBox.top,
      rightGap: contentBox.right - paneBox.right,
      bottomGap: contentBox.bottom - paneBox.bottom,
      overlap: chatBox.right - paneBox.left,
      position: style.position,
      radius: style.borderRadius,
      shadow: style.boxShadow,
    };
  });
  expect(Math.abs(geometry.topGap)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.rightGap)).toBeLessThanOrEqual(5);
  expect(Math.abs(geometry.bottomGap)).toBeLessThanOrEqual(1);
  expect(geometry.overlap).toBeLessThanOrEqual(1);
  expect(geometry).toMatchObject({
    position: "relative",
    radius: "0px",
    shadow: "none",
  });
  const surface = page.locator(".terminal-surface");
  await expect(surface).toBeVisible();
  const sidebar = page.getByRole("complementary", { name: "Workspace tools" });
  const widthBefore = (await sidebar.boundingBox())!.width;
  const resizeHandle = page.getByRole("separator", { name: "Resize activity sidebar" });
  await resizeHandle.focus();
  await resizeHandle.press("ArrowLeft");
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(widthBefore);

  await surface.click();
  await page.keyboard.type("sleep 0.3; printf terminal-persisted");
  await page.keyboard.press("Enter");

  // Switching views detaches the renderer terminal, but the PTY keeps running.
  await sidebar.getByRole("button", { name: "Session", exact: true }).click();
  await page.waitForTimeout(500);
  await sidebar.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".xterm-rows")).toContainText("terminal-persisted", { timeout: 5_000 });

  await page.getByRole("button", { name: "Close terminal" }).click();
  await expect(terminalPanel).toBeHidden();
  await expect(terminalToggle).toBeVisible();
  await terminalToggle.click();
  await expect(page.locator(".xterm-rows")).toContainText("terminal-persisted", { timeout: 5_000 });
});
