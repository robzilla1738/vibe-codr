import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

if (process.env.VIBE_LIVE_PACKAGED_CLOUD !== "1") {
  throw new Error("Set VIBE_LIVE_PACKAGED_CLOUD=1 to opt into the paid packaged Cloud smoke");
}
const apiKey = process.env.E2B_API_KEY?.trim();
if (!apiKey) throw new Error("E2B_API_KEY is required for the packaged Cloud smoke");

const root = resolve(import.meta.dirname, "..");
const executablePath = join(root, "release", process.arch === "arm64" ? "mac-arm64" : "mac", "Vibe Codr.app", "Contents", "MacOS", "Vibe Codr");
const temporaryRoot = await mkdtemp(join(tmpdir(), "vibecodr-cloud-packaged-"));
const project = join(temporaryRoot, "project");
const userData = join(temporaryRoot, "user-data");
await cp(join(root, "test", "fixtures", "project"), project, { recursive: true });

let app;
let page;
let cloudSessionId = "";
let returned = false;
try {
  app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  await app.evaluate(({ dialog }, selectedProject) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedProject] });
  }, project);
  page = await app.firstWindow();
  // Let the renderer finish its one-time recent-project restoration before
  // taking over the engine directly. Otherwise that startup effect can stop
  // the exact fixture host after this smoke has already bootstrapped it.
  await page.locator('[aria-label="Task message"], button:has-text("Open project")')
    .first()
    .waitFor({ state: "visible", timeout: 45_000 });
  const active = await page.evaluate(async ({ expectedProject }) => {
    // Exercise the real main-owned picker capability boundary, but bootstrap
    // directly so renderer startup restoration cannot race this smoke onto a
    // previously indexed project from the developer's normal app profile.
    const cwd = await window.vibe.openProject();
    if (cwd !== expectedProject) {
      throw new Error(`Project picker returned ${JSON.stringify(cwd)} instead of ${JSON.stringify(expectedProject)}`);
    }
    const bootstrapped = await window.vibe.bootstrap({ cwd });
    if (!bootstrapped.ok) throw new Error(bootstrapped.error);
    localStorage.setItem("vibe.lastCwd", cwd);
    const snapshot = await window.vibe.rpc("snapshot");
    if (!snapshot.ok) throw new Error(snapshot.error);
    return { cwd, sessionId: snapshot.value.sessionId };
  }, { expectedProject: project });
  if (active.cwd !== project) throw new Error("Temporary smoke project did not become active");

  const connected = await page.evaluate(async ({ key }) => {
    const result = await window.vibe.connectCloudProvider("e2b", { apiKey: key });
    if (!result.ok) throw new Error(result.error);
    const enabled = await window.vibe.updateCloudSettings({ experimentalEnabled: true, deleteOnReturn: true });
    if (!enabled.ok) throw new Error(enabled.error);
    return result.value.providers.e2b.configured;
  }, { key: apiKey });
  if (!connected) throw new Error("Packaged app did not persist the E2B connection");
  process.stdout.write("packaged Cloud smoke ok: protected provider setup passed\n");

  const handoff = await page.evaluate(async ({ cwd }) => {
    const result = await window.vibe.handoffToCloud({ cwd, provider: "e2b", includeModelCredentials: true });
    if (!result.ok) throw new Error(`${result.error}${result.details?.stage ? ` [${result.details.stage}]` : ""}`);
    return result.value;
  }, { cwd: active.cwd });
  cloudSessionId = handoff.sessionId;
  if (handoff.status !== "running") throw new Error(`Cloud handoff returned unexpected status: ${handoff.status}`);
  process.stdout.write("packaged Cloud smoke ok: verified workspace/model handoff reached running\n");

  const remoteChannels = await page.evaluate(async ({ cwd }) => {
    const preview = await window.vibe.readTextFile({ cwd, path: "README.md", maxBytes: 8_192 });
    if (!preview.ok || !preview.text.includes("# Fixture project")) {
      throw new Error(preview.ok
        ? `Cloud file preview returned the wrong file: ${JSON.stringify(preview.text.slice(0, 160))}`
        : preview.error);
    }
    let output = "";
    let terminalId = "";
    const unsubscribe = window.vibe.onTerminalEvent((event) => {
      if (event.id === terminalId && event.type === "data") output += event.data;
    });
    try {
      const opened = await window.vibe.terminalOpen({ cwd, cols: 100, rows: 30 });
      if (!opened.ok) throw new Error(opened.error);
      terminalId = opened.id;
      output += opened.replay;
      const resized = await window.vibe.terminalResize({ id: terminalId, cols: 110, rows: 32 });
      if (!resized.ok) throw new Error(resized.error);
      const written = await window.vibe.terminalWrite({ id: terminalId, data: "printf 'VIBE_CLOUD_PTY_OK\\n'\n" });
      if (!written.ok) throw new Error(written.error);
      const deadline = Date.now() + 10_000;
      while (!output.includes("VIBE_CLOUD_PTY_OK") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!output.includes("VIBE_CLOUD_PTY_OK")) throw new Error("Cloud terminal did not return command output");
      return { cwd, preview: true, terminal: true };
    } finally {
      unsubscribe();
    }
  }, { cwd: active.cwd });
  if (!remoteChannels.preview || !remoteChannels.terminal) throw new Error("Cloud workspace channels did not verify");
  process.stdout.write("packaged Cloud smoke ok: verified remote file preview and isolated PTY\n");

  const local = await page.evaluate(async ({ sessionId }) => {
    const result = await window.vibe.resumeCloudSessionLocally(sessionId, false);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }, { sessionId: cloudSessionId });
  returned = true;
  if (local.cwd !== active.cwd || local.divergent) throw new Error("Packaged Cloud return did not restore the original workspace cleanly");
  const remaining = await page.evaluate(async () => {
    const result = await window.vibe.listCloudSessions();
    if (!result.ok) throw new Error(result.error);
    return result.value.length;
  });
  if (remaining !== 0) throw new Error(`Cloud catalog retained ${remaining} session(s) after delete-on-return`);
  process.stdout.write("packaged Cloud smoke ok: verified return deleted the sandbox and restored Local\n");
} finally {
  if (page && cloudSessionId && !returned) {
    await page.evaluate(async ({ sessionId }) => {
      await window.vibe.resumeCloudSessionLocally(sessionId, false).catch(() => undefined);
    }, { sessionId: cloudSessionId }).catch(() => undefined);
  }
  await app?.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}
