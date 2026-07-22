import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("handoff IPC boundary", () => {
  const source = readFileSync(join(process.cwd(), "src", "main", "index.ts"), "utf8");
  const manager = readFileSync(join(process.cwd(), "src", "main", "cloud", "manager.ts"), "utf8");
  const relay = readFileSync(join(process.cwd(), "relay", "server.ts"), "utf8");
  const controller = readFileSync(join(process.cwd(), "src", "main", "engine-transport-controller.ts"), "utf8");

  it("blocks bootstrap before transport replacement while a handoff is active", () => {
    const handler = source.slice(source.indexOf('ipcMain.handle(\n    "engine:bootstrap"'), source.indexOf('ipcMain.handle("engine:send"'));
    expect(handler).toContain("cloudManager.ownershipTransitioning");
    expect(handler.indexOf("cloudManager.ownershipTransitioning")).toBeLessThan(handler.indexOf("bridge.start"));
  });

  it("keeps approval and abort controls available during the engine-idle wait", () => {
    expect(source).toContain('"resolve-permission"');
    expect(source).toContain('"resolve-plan"');
    expect(source).toContain('"resolve-external-capability"');
    expect(source).toContain("commandAllowedDuringHandoff(command)");
    expect(source).toContain("command.commands.every");
  });

  it("keeps cloud model credentials fixed to the reviewed handoff boundary", () => {
    expect(source).toContain("bridge.isRemote");
    expect(source).toContain('command.type === "set-model"');
    expect(source).toContain('command.type === "set-subagent-model"');
    expect(source).toContain('command.type === "set-agent-model"');
    expect(source).toContain('command.name === "model"');
    expect(source).toContain('!/^(?:|refresh(?:\\s|$))/i.test(command.args.trim())');
    expect(source).toContain('command.name === "vision"');
    expect(source).toContain('/^model(?:\\s|$)/i.test(command.args.trim())');
    expect(source).toContain("command.commands.some(commandChangesRemoteModel)");
    expect(source).toContain("Return this session to Local before changing model access");
  });

  it("keeps standard xAI credentials out of Grok subscription handoffs", () => {
    const manager = readFileSync(join(process.cwd(), "src", "main", "cloud", "manager.ts"), "utf8");
    expect(manager).toContain('requiredProviderIds.has("xai") && requiredProviderIds.has("xai-oauth")');
    expect(manager).toContain('providerId === xaiCredentialScope');
    expect(manager).toContain("compatibleOptionalModels");
    const resolver = manager.slice(manager.indexOf("async #cloudModelEnvironment("), manager.indexOf("#emit(", manager.indexOf("async #cloudModelEnvironment(")));
    expect(resolver.indexOf("ambientCloudModelEnvironment")).toBeLessThan(resolver.indexOf('rpc("exportProviderAuth"'));
    expect(manager).toContain("new Set([...models, ...compatibleOptionalModels]");
    expect(resolver).toContain("new Set([...models, ...compatibleOptionalModels].map");
  });

  it("validates the per-handoff model credential preference", () => {
    const handler = source.slice(source.indexOf('ipcMain.handle("cloud:handoff"'), source.indexOf('ipcMain.handle("cloud:reconnect"'));
    expect(handler).toContain('typeof request.includeModelCredentials !== "boolean"');
    expect(handler).toContain("Invalid model credential transfer preference");
  });

  it("blocks cloud reconnect while ownership is changing", () => {
    const handler = source.slice(source.indexOf('ipcMain.handle("cloud:reconnect"'), source.indexOf('ipcMain.handle("cloud:resumeLocal"'));
    expect(handler).toContain("cloudManager.ownershipTransitionActive");
    expect(handler.indexOf("cloudManager.ownershipTransitionActive")).toBeLessThan(handler.indexOf("cloudManager.reconnect"));
  });

  it("enforces Cloud recovery ownership before main-process history mutations", () => {
    const handler = source.slice(source.indexOf('ipcMain.handle("engine:rpc"'), source.indexOf('ipcMain.handle("settings:dirty"'));
    expect(handler).toContain("cloudManager.runHistoryMutation");
    expect(handler).toContain("SESSION_HISTORY_MUTATIONS.has(message.method)");
    expect(handler).toContain("PROJECT_RECOVERY_MUTATIONS.has(message.method)");
    expect(handler).toContain('const sessionId = typeof rawSessionId === "string" ? rawSessionId.trim() : undefined');
    expect(handler).toContain("rpcParams = { ...message.params, id: sessionId }");
    expect(handler).toContain("() => bridge.projectIndexRpc(message.method, rpcParams)");
    expect(manager).toContain("Return Cloud-owned or interrupted sessions to Local");
  });

  it("authorizes renderer-scoped transcript search before reading session stores", () => {
    const handler = source.slice(source.indexOf('ipcMain.handle("engine:rpc"'), source.indexOf('ipcMain.handle("engine:stop"'));
    const searchGuard = handler.indexOf('message.method === "searchSessions"');
    const authorization = handler.indexOf("isAllowedProjectRoot(cwd)", searchGuard);
    const dispatch = handler.indexOf("bridge.projectIndexRpc(message.method", authorization);
    expect(searchGuard).toBeGreaterThan(-1);
    expect(authorization).toBeGreaterThan(searchGuard);
    expect(dispatch).toBeGreaterThan(authorization);
    expect(relay).toContain('method === "searchSessions" && params?.cwd !== undefined');
    expect(relay).toContain("!isAllowedCwd(params.cwd)");
  });

  it("drains all runtimes and serializes history mutations at phone ownership boundaries", () => {
    expect(source).toContain("await bridge.stopAllOwnedRuntimes()");
    expect(relay).toContain("await bridge.stopAllOwnedRuntimes()");
    expect(controller).toContain("this.#authBridge.disposeForQuit()");
    expect(controller).toContain("this.#indexBridge.disposeForQuit()");
    expect(controller).toContain("provisional?.disposeForQuit()");
    expect(relay).toContain('bridge.retireLocalSessionForMutation(cwd, id, method === "renameSession")');
    expect(relay).toContain("bridge.retireLocalProjectForMutation(cwd)");
    expect(relay).toContain("cloudManager.runHistoryMutation(");
    expect(controller).toContain("this.#localOwnershipEpoch += 1");
    expect(controller).toContain("ownershipEpoch !== this.#localOwnershipEpoch");
    expect(source).toContain("bridge.restoreLocalRuntimeOwnership()");
    expect(relay).toContain("bridge.restoreLocalRuntimeOwnership()");
    const release = relay.slice(
      relay.indexOf("async function releaseToDesktop"),
      relay.indexOf('process.on("message"'),
    );
    expect(release).toContain("await bridge.stopAllOwnedRuntimes()");
    expect(release).toContain("Could not return control to desktop");
    expect(release.indexOf("return;")).toBeLessThan(release.indexOf('process.send?.({ type: "mobile-released"'));
  });

  it("uses an isolated helper for portable-import rollback", () => {
    const abort = controller.slice(
      controller.indexOf("async abortPortableImport"),
      controller.indexOf("async recoverLostCloudOwnership"),
    );
    expect(abort).toContain("const helper = new EngineBridge()");
    expect(abort).toContain("helper.abortPortableImport");
    expect(abort).not.toContain("this.#locals.activeBridge");
    expect(abort).not.toContain("this.#indexBridge");
    expect(controller).toContain("abortProvisionalLocal(cwd: string, sessionId: string)");
    expect(controller).toContain("this.#locals.detachSessionForHandoff(cwd, sessionId)");
    expect(manager).toContain("this.transport.abortProvisionalLocal(cwd, sessionId)");
  });

  it("keeps the local supervisor reusable when the last macOS window closes", () => {
    const handler = source.slice(source.indexOf('app.on("window-all-closed"'));
    expect(handler).toContain("bridge.stopAllOwnedRuntimes({ preserveRemote: true })");
    expect(handler).not.toContain("bridge.disposeForQuit()");
    const secondInstance = source.slice(
      source.indexOf('app.on("second-instance"'),
      source.indexOf("app.whenReady()"),
    );
    expect(secondInstance).toContain("bridge.restoreLocalRuntimeOwnership()");
  });

  it("preserves the local supervisor after remote disconnect and every relay event cursor", () => {
    const disconnect = controller.slice(
      controller.indexOf("async disconnectRemote"),
      controller.indexOf("startProvisionalLocal"),
    );
    expect(disconnect).toContain("this.#active = this.#locals");
    expect(disconnect).toContain("this.#wire(this.#locals)");
    expect(relay).not.toContain('type === "turn-performance") return');
    expect(relay).toContain("if (controller && frame) send(controller");
    expect(relay).toContain("bridge.onResync = (snapshot)");
    expect(relay).toContain('{ type: "ready", sessionId: snapshot.sessionId');
    expect(controller).toContain("handoff.preserveLocal === false");
    expect(manager).toContain('{ preserveLocal: true, sourceCwd: entry.sourceRoot }');
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
    expect(manager).toContain("if (needsRepair || sandbox.needsDaemonRestart)");
    expect(manager).toContain('provider.start(entry.sandboxId, "sh", legacyRecoveryRuntime');
    expect(manager).toContain('["start.sh", entry.provider, `');
    expect(manager).toContain("model-access.json");
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

  it("keeps Return Local available after an appearance sync failure", () => {
    expect(manager).toContain("this.#appearanceMutationChain = run.catch(() => undefined)");
    expect(manager).toContain("await this.#appearanceMutationChain;");
    expect(manager).toContain("entry.error?.startsWith(CLOUD_APPEARANCE_SYNC_ERROR_PREFIX)");
    expect(manager).toContain('{ status: "running", error: undefined }');
  });

  it("checks legacy repair prerequisites before suspending a sandbox", () => {
    const credentials = manager.indexOf("const modelEnvironment = allowLegacyCredentialless");
    const quiesce = manager.indexOf("await this.#quiesceLegacyRuntime", credentials);
    const suspend = manager.indexOf("await provider.suspend(entry.sandboxId)", quiesce);
    expect(credentials).toBeGreaterThan(-1);
    expect(quiesce).toBeGreaterThan(credentials);
    expect(suspend).toBeGreaterThan(quiesce);
  });

  it("uses the Mac appearance as migration authority for pre-profile sessions", () => {
    expect(manager).toContain("Pre-profile (0.6.2) runtimes booted with the remote default");
    const profile = manager.slice(manager.indexOf("async #runtimeProfileForEntry"), manager.indexOf("async #connectLegacyRuntimeForReturn"));
    expect(profile.indexOf("if (entry.appearance)")).toBeLessThan(profile.indexOf("readConfigFile(globalConfigPath())"));
    expect(profile).toContain('theme: globalResult?.config.theme ?? "graphite"');
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
    expect(manager).toContain("isCloudSessionMutationLocked(entry.status)");
    expect(manager).toContain("async runHistoryMutation");
    expect(manager).toContain("return this.#withOwnershipTransition(async () =>");
  });

  it("allows only the dedicated reconnect path through unresolved recovery", () => {
    expect(manager).toContain("get ownershipTransitionActive(): boolean");
    const handler = mainSource.slice(mainSource.indexOf('ipcMain.handle("cloud:reconnect"'), mainSource.indexOf('ipcMain.handle("cloud:resumeLocal"'));
    expect(handler).toContain("cloudManager.ownershipTransitionActive");
    expect(handler).not.toContain("cloudManager.ownershipTransitioning");
  });

  it("reports a retained provisional local engine during quit cleanup", () => {
    expect(controller).toContain("this.#provisionalBridge?.isRunning === true");
    expect(controller).toContain("this.#authBridge.isRunning");
    expect(controller).toContain("this.#indexBridge.isRunning");
    expect(controller).toContain("this.#locals.activeBridge ?? this.#provisionalBridge ?? this.#indexBridge");
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
    expect(manager).toContain("shouldReconnectRemoteSession(this.transport.isRemote, this.transport.isReady, this.#remoteSessionId, sessionId)");
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
      .toBeLessThan(completion.indexOf("await session.attachCurrent("));
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
    const rpcResultGuards = readFileSync(join(process.cwd(), "src/shared/rpc-result-guards.ts"), "utf8");
    expect(sessionHook).toContain("snap.pendingCapabilities ?? []");
    expect(appSource).toContain("session.pendingCapabilities.find");
    expect(rpcResultGuards).toContain("validateRpcResult(method, value)");
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
    expect(appSource).toContain("const attached = await session.attachCurrent(");
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
