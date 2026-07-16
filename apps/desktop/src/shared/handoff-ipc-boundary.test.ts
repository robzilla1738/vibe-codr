import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("handoff IPC boundary", () => {
  const source = readFileSync(join(process.cwd(), "src", "main", "index.ts"), "utf8");

  it("blocks bootstrap before transport replacement while a handoff is active", () => {
    const handler = source.slice(source.indexOf('ipcMain.handle(\n    "engine:bootstrap"'), source.indexOf('ipcMain.handle("engine:send"'));
    expect(handler).toContain("cloudManager.ownershipTransitioning");
    expect(handler.indexOf("cloudManager.ownershipTransitioning")).toBeLessThan(handler.indexOf("bridge.start"));
  });

  it("keeps approval and abort controls available during the engine-idle wait", () => {
    expect(source).toContain('"resolve-permission"');
    expect(source).toContain('"resolve-plan"');
    expect(source).toContain('"resolve-external-capability"');
    expect(source).toContain("!HANDOFF_CONTROL_COMMANDS.has(command?.type)");
  });

  it("keeps cloud model credentials fixed to the reviewed handoff boundary", () => {
    expect(source).toContain("bridge.isRemote");
    expect(source).toContain('message.command.type === "set-model"');
    expect(source).toContain('message.command.type === "set-subagent-model"');
    expect(source).toContain('message.command.type === "set-agent-model"');
    expect(source).toContain('message.command.name === "model"');
    expect(source).toContain('!/^(?:|refresh(?:\\s|$))/i.test(message.command.args.trim())');
    expect(source).toContain('message.command.name === "vision"');
    expect(source).toContain('/^model(?:\\s|$)/i.test(message.command.args.trim())');
    expect(source).toContain("Return this session to Local before changing model access");
  });

  it("blocks cloud reconnect while ownership is changing", () => {
    const handler = source.slice(source.indexOf('ipcMain.handle("cloud:reconnect"'), source.indexOf('ipcMain.handle("cloud:resumeLocal"'));
    expect(handler).toContain("cloudManager.ownershipTransitionActive");
    expect(handler.indexOf("cloudManager.ownershipTransitionActive")).toBeLessThan(handler.indexOf("cloudManager.reconnect"));
  });
});

describe("cloud release invariants", () => {
  const manager = readFileSync(join(process.cwd(), "src", "main", "cloud", "manager.ts"), "utf8");
  const providers = readFileSync(join(process.cwd(), "src", "main", "cloud", "providers.ts"), "utf8");
  const transfer = readFileSync(join(process.cwd(), "src", "main", "cloud", "workspace-transfer.ts"), "utf8");
  const controller = readFileSync(join(process.cwd(), "src", "main", "engine-transport-controller.ts"), "utf8");
  const mainSource = readFileSync(join(process.cwd(), "src", "main", "index.ts"), "utf8");
  const appSource = readFileSync(join(process.cwd(), "src", "renderer", "App.tsx"), "utf8");
  const cloudSettings = readFileSync(join(process.cwd(), "src", "renderer", "settings", "sections", "CloudSection.tsx"), "utf8");
  const packer = readFileSync(join(process.cwd(), "scripts", "copy-cloud-runtime.mjs"), "utf8");

  it("binds portable exports to the active session and canonical workspace", () => {
    expect(manager).toContain("engine.sessionId !== snapshot.sessionId");
    expect(manager).toContain("resolve(engine.sourceRoot) !== resolve(request.cwd)");
    expect(manager).toContain("engine.ownershipGeneration !== preparation.ownershipGeneration");
    expect(manager).toContain('engine.executionTarget.kind !== "local"');
    expect(manager).toContain("resolve(engine.sourceRoot) !== resolve(");
    expect(manager).toContain("base}/project");
  });

  it("restarts and health-checks the daemon after a Vercel cold resume", () => {
    expect(providers).toContain("needsDaemonRestart: true");
    expect(manager).toContain("if (sandbox.needsDaemonRestart)");
    expect(manager).toContain('provider.start(entry.sandboxId, "sh", ["start.sh", entry.provider]');
    expect(manager).toContain("expectedEnvironmentNames");
    expect(manager).toContain("await superviseCloudAgent(");
    expect(manager).toContain("getSessionEnvironment(sessionId)");
    expect(manager).toContain("entry.providerDomains");
    expect(manager).not.toContain("refreshedEnvironment");
  });

  it("durably surfaces reconnect failures without surrendering cloud ownership", () => {
    expect(manager).toContain("#reconnectTracked");
    expect(manager).toContain('current?.handoffTransition ? "handoff-interrupted" : "recoverable-error"');
    expect(manager).toContain("instead of leaving a stale \"running\" catalog row behind");
  });

  it("serializes launch-surface project history RPCs through one controller queue", () => {
    expect(controller).toContain("#localLifecycleTail: Promise<void>");
    expect(controller).toContain("this.#localLifecycleTail.then(async () =>");
    expect(controller).toContain("this.#localLifecycleTail = operation.then");
  });

  it("health-checks the daemon before the initial remote transport switch", () => {
    const health = manager.indexOf("await superviseCloudAgent(");
    const supervisedSwitch = manager.indexOf("await awaitRemoteEngineReady(", health);
    const remoteSwitch = manager.indexOf("this.transport.switchToRemote(", supervisedSwitch);
    expect(health).toBeGreaterThan(-1);
    expect(supervisedSwitch).toBeGreaterThan(health);
    expect(remoteSwitch).toBeGreaterThan(supervisedSwitch);
    expect(manager).not.toContain("ready.json");
  });

  it("uses non-resuming E2B APIs for inspection, rediscovery, and deletion", () => {
    const get = providers.slice(providers.indexOf("async get(id:"), providers.indexOf("async findByName(name:"));
    const find = providers.slice(providers.indexOf("async findByName(name:"), providers.indexOf("async resume(id:"));
    const destroy = providers.slice(providers.indexOf("async destroy(id:"), providers.indexOf("async domain(id:"));
    expect(get).toContain("E2BSandbox.getInfo");
    expect(find).not.toContain("E2BSandbox.connect");
    expect(destroy).toContain("E2BSandbox.kill");
    expect(destroy).not.toContain("await this.#handle(");
  });

  it("preserves the configured E2B idle timeout on reconnect", () => {
    expect(manager).toContain("provider.resume(entry.sandboxId, settings.autoPauseMinutes * 60 * 1_000)");
    expect(providers).toContain("this.#timeouts.get(id) ?? DEFAULT_TIMEOUT_MS");
  });

  it("keeps ambiguous ownership fail-closed until generation recovery", () => {
    expect(manager).toContain("remoteCommitAttempted = true");
    expect(manager).toContain("this.#ownershipUnresolved = true");
    expect(manager).toContain("Session ownership recovery is required before continuing");
    expect(manager).toContain("entry.status === \"handoff-interrupted\"");
  });

  it("allows only the dedicated reconnect path through unresolved recovery", () => {
    expect(manager).toContain("get ownershipTransitionActive(): boolean");
    const handler = mainSource.slice(mainSource.indexOf('ipcMain.handle("cloud:reconnect"'), mainSource.indexOf('ipcMain.handle("cloud:resumeLocal"'));
    expect(handler).toContain("cloudManager.ownershipTransitionActive");
    expect(handler).not.toContain("cloudManager.ownershipTransitioning");
  });

  it("reports a retained provisional local engine during quit cleanup", () => {
    expect(controller).toContain("this.#active.isRunning || this.local.isRunning");
  });

  it("waits for engine-idle from the exact busy session", () => {
    expect(manager).toContain("#idleSessionId: string | null");
    expect(manager).toContain("this.#idleWaiters.get(snapshot.sessionId)");
    expect(manager).toContain('type === "assistant-text-delta"');
    expect(manager).toContain('type === "tool-call-started"');
    expect(manager).not.toContain('type === "assistant-delta"');
    expect(manager).not.toContain('type === "tool-call-start"');
  });

  it("opens transfer files without following symlinks and counts actual bytes", () => {
    expect(transfer).toContain("fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW");
    expect(transfer).toContain("totalBytes += content.byteLength");
    expect(transfer).toContain("if (bytes > MAX_FILE_BYTES) return { exceeded: true }");
  });

  it("persists outbound exclusions and diverts protected returns", () => {
    expect(manager).toContain("excludedPaths: transfer.manifest.excludedPaths");
    expect(manager).toContain("excludedPaths: entry.excludedPaths");
    expect(transfer).toContain("returnTouchesProtectedLocalPath");
    expect(transfer).toContain('reason: hard ? "sensitive or generated default" : ".vibe/cloudignore"');
  });

  it("rechecks divergence at mutation time and preserves later rollback edits", () => {
    expect(transfer).toContain("const finalFingerprint = await currentWorkspaceFingerprint");
    expect(transfer).toContain('durableWriteFile(join(recoveryPath, "applied-fingerprint")');
    expect(transfer).toContain("preserveAffectedWorkspace");
    expect(transfer).toContain("const nestedCandidates = await walkCandidates(absolute)");
  });

  it("surfaces durable local capability requests with an explicit denial path", () => {
    expect(manager).toContain('type === "external-capability-pending"');
    expect(manager).toContain('status: "needs-local"');
    expect(appSource).toContain('event.type === "external-capability-pending"');
    expect(appSource).toContain('type: "resolve-external-capability"');
    expect(appSource).toContain('decision: "deny"');
  });

  it("keeps transfer-policy drafts separate from immediate cloud settings", () => {
    expect(cloudSettings).toContain("const [policyDraft, setPolicyDraft]");
    expect(cloudSettings).toContain("const [policyDirty, setPolicyDirty]");
    expect(cloudSettings).toContain("saveTransferPolicy");
    expect(cloudSettings).toContain("onSessionRecovered");
    expect(cloudSettings).toContain("onDirtyChange?.(policyDirty)");
    expect(readFileSync(join(process.cwd(), "src/renderer/settings/SettingsPanel.tsx"), "utf8")).toContain("cloudDirtyRef.current");
  });

  it("durably records ownership and fails closed around interrupted cleanup", () => {
    const catalog = readFileSync(join(process.cwd(), "src/main/cloud/catalog.ts"), "utf8");
    expect(catalog).toContain("await file.sync()");
    expect(catalog).toContain("await directory.sync()");
    expect(manager).toContain("if (entry.handoffTransition)");
    expect(manager).toContain('entry.status !== "suspended" && entry.status !== "cleanup-pending"');
  });

  it("reconnects stopped remotes and buffers live events during hydration", () => {
    const sessionHook = readFileSync(join(process.cwd(), "src/renderer/hooks/useSession.ts"), "utf8");
    expect(manager).toContain("!this.transport.isRemote || !this.transport.isReady");
    const attach = sessionHook.slice(
      sessionHook.indexOf("const attachCurrent"),
      sessionHook.indexOf("useEffect(() =>", sessionHook.indexOf("const attachCurrent")),
    );
    expect(attach).toContain("bootstrapHandoff.current = true");
    expect(attach).toContain("bootstrapGate.current.begin()");
    expect(attach).toContain("for (const event of queuedEvents) handleEvent(event)");
  });

  it("adopts the returned cloud owner before renderer hydration", () => {
    const sheet = readFileSync(join(process.cwd(), "src/renderer/panels/CloudHandoffSheet.tsx"), "utf8");
    const completion = appSource.slice(
      appSource.indexOf("onComplete={async ({ message, executionTarget"),
      appSource.indexOf("{session.toast &&"),
    );
    expect(sheet).toContain("cloudSession: result.value");
    expect(completion).toContain('[cloudSession, ...current.filter((item) => item.sessionId !== cloudSession.sessionId)]');
    expect(completion.indexOf("setCloudSessions((current) => executionTarget"))
      .toBeLessThan(completion.indexOf("await session.attachCurrent(activeCwd)"));
  });

  it("serializes cloud settings and resolves interrupted ownership structurally", () => {
    expect(manager).toContain("#settingsMutationChain = Promise.resolve()");
    expect(manager).toContain("#mutateSettings(");
    expect(manager).toContain('recovery.outcome === "already-committed"');
    expect(manager).not.toContain("ownershipAlreadyCommitted");
    expect(manager).toContain("#idleEventSequence > eventSequenceBeforeSnapshot");
    expect(manager).toContain("Return rollback needs ownership recovery");
  });

  it("restores durable capability waits and activates recovery worktrees safely", () => {
    const sessionHook = readFileSync(join(process.cwd(), "src/renderer/hooks/useSession.ts"), "utf8");
    const runtimeGuards = readFileSync(join(process.cwd(), "src/shared/runtime-guards.ts"), "utf8");
    expect(sessionHook).toContain("snap.pendingCapabilities ?? []");
    expect(appSource).toContain("session.pendingCapabilities.find");
    expect(runtimeGuards).toContain('result.outcome === "aborted"');
    expect(mainSource).toContain("projectCwdAllowlist.add(value.cwd)");
    expect(controller).toContain("#remoteActivationEvents");
    expect(controller).toContain('method === "snapshot"');
  });

  it("isolates the cloud control plane from project workloads", () => {
    expect(manager).toContain("privileged: true");
    expect(manager).toContain("VIBE_STATE_DIR:");
    expect(manager).toContain("base}/state");
    expect(providers).toContain('user: options?.privileged ? "root" : undefined');
    expect(providers).toContain("sudo: options?.privileged === true");
    expect(transfer).toContain("assertGitHistoryExcludes(join(cwd, submodule.path), patterns, submodule.path)");
    expect(appSource).toContain("const activeCwd = resumedCwd ?? cwd");
    expect(appSource).toContain("await session.attachCurrent(activeCwd)");
  });

  it("durably records the old Git head before updating the branch", () => {
    const durableWrite = transfer.indexOf('durableWriteFile(join(recoveryPath, "old-head")');
    const updateRef = transfer.indexOf('exec("git", ["update-ref", "HEAD", fetchedHead, oldHead]');
    expect(durableWrite).toBeGreaterThan(-1);
    expect(updateRef).toBeGreaterThan(durableWrite);
  });

  it("refuses to package dirty engine runtime inputs", () => {
    expect(packer).toContain('"status", "--porcelain", "--untracked-files=all"');
    expect(packer).toContain('"packages/cloud-agentd/src"');
    expect(packer).toContain("Refusing to stage a runtime-dirty engine checkout");
  });
});
