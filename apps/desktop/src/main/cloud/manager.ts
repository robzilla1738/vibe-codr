import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { globalConfigPath, projectConfigPath, readConfigFile, writeConfigFileValidated } from "../../shared/config-io";
import { validateConfig } from "../../shared/config-validate";
import { cloudSessionNeedsRuntimeRepair, isCloudSessionMutationLocked, isCloudSessionRemoteOwned } from "../../shared/cloud";
import { parseCloudSettingsPatch } from "../../shared/cloud-settings";
import type {
  CloudCommandHandle,
  CloudCommandResult,
  CloudFailureDetails,
  CloudProviderId,
  CloudSandboxCreateOptions,
  CloudSandboxRecord,
  CloudSessionCatalogEntry,
  CloudSessionStatus,
  CloudSettingsPublic,
  CloudStartupStage,
  CloudStatusEvent,
  ProviderCredentials,
  SandboxProvider,
} from "../../shared/cloud";
import type { EngineSnapshot } from "../../shared/types";
import type { HandoffPreparation, PortableSessionArchiveV1 } from "../../shared/handoff";
import type { EngineTransportController } from "../engine-transport-controller";
import { CloudSessionCatalog } from "./catalog";
import { CloudCredentialStore, type ProtectedStringStorage } from "./credential-store";
import {
  CLOUD_MODEL_ACCESS_VERSION,
  CLOUD_RUNTIME_PROFILE_VERSION,
  CLOUD_RUNTIME_REVISION,
  createCloudRuntimeProfile,
  sealCloudModelAccess,
  type CloudRuntimeProfileV1,
} from "./cloud-runtime";
import { assertPublicProviderDomains } from "./domain-validation";
import {
  ambientCloudModelEnvironment,
  cloudModelEnvironment,
  cloudModelRouteHostname,
  configuredCloudFallbackModels,
  configuredCloudModels,
  subscriptionAuthProviderForModelProvider,
  subscriptionCredentialEnvironment,
} from "./model-environment";
import { E2BSandboxProvider, sanitizeCloudCommandOutput, VercelSandboxProvider } from "./providers";
import { assertCloudSessionContinuity, cloudProjectStateRoot } from "./session-continuity";
import {
  applyWorkspaceTransfer,
  assembleReturnTransfer,
  createWorkspaceTransfer,
  rollbackWorkspaceApplication,
  type RemoteWorkspaceSnapshotV1,
  type WorkspaceApplyResult,
} from "./workspace-transfer";

const CLOUD_PORT = 8787;
const MAX_RETURN_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const PROVIDER_REQUEST_TIMEOUT_MS = 60_000;
const SETUP_TIMEOUT_MS = 5 * 60_000;
const AGENT_HEALTH_TIMEOUT_MS = 120_000;
const CLOUD_APPEARANCE_SYNC_ERROR_PREFIX = "Cloud appearance could not sync to this Mac:";
const DEFAULT_DOMAINS = [
  "registry.npmjs.org",
  "nodejs.org",
  "github.com",
  "objects.githubusercontent.com",
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
];

interface HandoffRequest {
  cwd: string;
  provider: CloudProviderId;
  instruction?: string;
  additionalInclusions?: string[];
  includeModelCredentials?: boolean;
}

interface CloudSettingsFileV1 extends CloudSettingsPublic { schemaVersion: 1 }
export interface CloudRuntimeLocation { isPackaged: boolean; appPath: string; resourcesPath: string }

export class CloudManager {
  readonly #catalog: CloudSessionCatalog;
  readonly #credentials: CloudCredentialStore;
  readonly #providers: Record<CloudProviderId, SandboxProvider>;
  readonly #settingsPath: string;
  #idleSessionId: string | null = null;
  #engineEventSequence = 0;
  #idleEventSequence = 0;
  #ownershipTransitionDepth = 0;
  #ownershipUnresolved = false;
  #idleWaiters = new Map<string, Set<() => void>>();
  #settingsMutationChain = Promise.resolve();
  #appearanceMutationChain = Promise.resolve();
  #remoteSessionId: string | null = null;

  onStatus: ((event: CloudStatusEvent) => void) | null = null;

  constructor(private readonly transport: EngineTransportController, userData: string, protectedStorage?: ProtectedStringStorage) {
    this.#catalog = new CloudSessionCatalog(join(userData, "cloud", "sessions.json"));
    this.#credentials = new CloudCredentialStore(join(userData, "cloud", "credentials.enc.json"), protectedStorage);
    this.#settingsPath = join(userData, "cloud", "settings.json");
    this.#providers = { e2b: new E2BSandboxProvider(), vercel: new VercelSandboxProvider() };
  }

  runtimeLocation: CloudRuntimeLocation = {
    isPackaged: false,
    appPath: process.env.VIBE_ELECTRON_ROOT ?? process.cwd(),
    resourcesPath: process.env.VIBE_ELECTRON_ROOT ?? process.cwd(),
  };

  async settings(): Promise<CloudSettingsPublic> {
    const settings = await this.#readSettings();
    const readiness = await this.#credentials.readiness();
    return {
      ...settings,
      providers: {
        e2b: { ...settings.providers.e2b, configured: readiness.e2b },
        vercel: { ...settings.providers.vercel, configured: readiness.vercel },
      },
    };
  }

  async updateSettings(patch: unknown): Promise<CloudSettingsPublic> {
    const validated = parseCloudSettingsPatch(patch);
    await this.#mutateSettings((current) => ({ ...current, ...validated, schemaVersion: 1 }));
    return this.settings();
  }

  async connect<P extends CloudProviderId>(provider: P, credentials: NonNullable<ProviderCredentials[P]>) {
    if (!this.#credentials.isAvailable()) throw new Error("Cloud setup requires OS-protected credential storage");
    const resolvedCredentials = await this.#providers[provider].connectAccount(credentials);
    const result = await this.#providers[provider].test();
    if (!result.ok) throw new Error(result.error);
    await this.#credentials.set(provider, resolvedCredentials as NonNullable<ProviderCredentials[P]>);
    await this.#mutateSettings((settings) => {
      settings.providers[provider] = { configured: true, lastTest: Date.now(), ...(result.account ? { account: result.account } : {}) };
      settings.lastProvider = provider;
      return settings;
    });
    return this.settings();
  }

  async disconnect(provider: CloudProviderId): Promise<CloudSettingsPublic> {
    const sessions = (await this.#catalog.list()).filter((entry) => entry.provider === provider);
    if (sessions.length) {
      throw new Error(`Return or delete all ${provider === "e2b" ? "E2B" : "Vercel"} cloud sessions before removing these credentials`);
    }
    await this.#credentials.remove(provider);
    await this.#mutateSettings((settings) => {
      settings.providers[provider] = { configured: false };
      return settings;
    });
    return this.settings();
  }

  async test(provider: CloudProviderId) {
    await this.#loadProvider(provider);
    const result = await this.#providers[provider].test();
    await this.#mutateSettings((settings) => {
      settings.providers[provider] = result.ok
        ? { configured: true, lastTest: Date.now(), ...(result.account ? { account: result.account } : {}) }
        : { configured: true, lastTest: Date.now(), error: result.error };
      return settings;
    });
    return result;
  }

  async listSessions(): Promise<CloudSessionCatalogEntry[]> {
    await this.#recoverInterruptedOutboundHandoffs();
    const sessions = await this.#catalog.list();
    this.#ownershipUnresolved = sessions.some((entry) =>
      entry.status === "handoff-interrupted" && entry.handoffTransition !== undefined);
    return sessions;
  }

  /** Main-process authority for project/session history mutations. The check
   * and mutation share the ownership-transition mutex, closing both directions
   * of the check-then-handoff race. Renderer guards remain UX only. */
  async runHistoryMutation<T>(
    cwd: string,
    sessionId: string | undefined,
    mutation: () => Promise<T>,
  ): Promise<T> {
    return this.#withOwnershipTransition(async () => {
      const sourceRoot = resolve(cwd);
      const locked = (await this.#catalog.list()).some((entry) =>
        resolve(entry.sourceRoot) === sourceRoot
        && (sessionId === undefined || entry.sessionId === sessionId)
        && isCloudSessionMutationLocked(entry.status));
      if (locked) {
        throw new Error("Return Cloud-owned or interrupted sessions to Local before changing their recovery history");
      }
      return mutation();
    });
  }

  get ownershipTransitioning(): boolean { return this.#ownershipTransitionDepth > 0 || this.#ownershipUnresolved; }
  get ownershipTransitionActive(): boolean { return this.#ownershipTransitionDepth > 0; }

  async saveCredentialBinding(input: { id?: string; label: string; kind: "environment" | "file" | "brokered"; value: string }): Promise<CloudSettingsPublic> {
    if (!this.#credentials.isAvailable()) throw new Error("Cloud credential bindings require OS-protected storage");
    const label = input.label.trim();
    if (!label || !input.value) throw new Error("Credential label and value are required");
    if (input.kind === "environment" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) throw new Error("Environment binding label must be an environment variable name");
    const id = input.id?.trim() || randomUUID();
    await this.#credentials.setBinding(id, input.value);
    await this.#mutateSettings((settings) => {
      settings.credentialBindings = [...settings.credentialBindings.filter((item) => item.id !== id), { id, label, kind: input.kind, ready: true }];
      return settings;
    });
    return this.settings();
  }

  async removeCredentialBinding(id: string): Promise<CloudSettingsPublic> {
    await this.#credentials.removeBinding(id);
    await this.#mutateSettings((settings) => {
      settings.credentialBindings = settings.credentialBindings.filter((item) => item.id !== id);
      return settings;
    });
    return this.settings();
  }

  observeEngineEvent(event: unknown): void {
    if (!event || typeof event !== "object" || !("type" in event)) return;
    const typed = event as { type?: unknown; sessionId?: unknown };
    const type = typed.type;
    const sessionId = typeof typed.sessionId === "string" ? typed.sessionId : null;
    if (this.transport.isRemote && this.#remoteSessionId && (type === "theme-changed" || type === "accent-changed" || type === "details-changed")) {
      const appearanceEvent = event as Record<string, unknown>;
      const appearancePatch = type === "theme-changed" && typeof appearanceEvent.theme === "string"
        ? { theme: appearanceEvent.theme }
        : type === "accent-changed" && typeof appearanceEvent.accent === "string"
          ? { accentColor: appearanceEvent.accent }
          : type === "details-changed" && ["quiet", "normal", "verbose"].includes(String(appearanceEvent.details))
            ? { details: appearanceEvent.details as "quiet" | "normal" | "verbose" }
            : null;
      if (appearancePatch) {
        const appearanceSessionId = this.#remoteSessionId;
        void this.#mirrorCloudAppearance(appearanceSessionId, appearancePatch).catch(() => undefined);
      }
    }
    if (sessionId) this.#engineEventSequence += 1;
    if (type === "external-capability-pending" && sessionId) {
      const request = (event as { request?: { integration?: unknown; toolName?: unknown } }).request;
      const label = typeof request?.integration === "string" ? request.integration : "a local integration";
      void this.#catalog.patch(sessionId, {
        status: "needs-local",
        error: `Needs your Mac for ${label}${typeof request?.toolName === "string" ? ` · ${request.toolName}` : ""}`,
      }).then(() => this.#emit(sessionId, "needs-local", `Needs your Mac for ${label}`)).catch(() => undefined);
      return;
    }
    if (type === "external-capability-resolved" && sessionId) {
      void this.#catalog.patch(sessionId, { status: "running", error: undefined })
        .then(() => this.#emit(sessionId, "running", "Cloud session resumed after local capability resolution"))
        .catch(() => undefined);
      return;
    }
    if (type === "engine-idle") {
      if (!sessionId) return;
      this.#idleSessionId = sessionId;
      this.#idleEventSequence = this.#engineEventSequence;
      for (const resolve of this.#idleWaiters.get(sessionId) ?? []) resolve();
      this.#idleWaiters.delete(sessionId);
      return;
    }
    if (type === "user-message" || type === "assistant-text-delta" || type === "tool-call-started" || type === "reasoning-delta") {
      if (!sessionId || this.#idleSessionId === sessionId) this.#idleSessionId = null;
    }
  }

  handoffToCloud(request: HandoffRequest): Promise<CloudSessionCatalogEntry> {
    return this.#withOwnershipTransition(() => this.#handoffToCloud(request));
  }

  async #handoffToCloud(request: HandoffRequest): Promise<CloudSessionCatalogEntry> {
    const settings = await this.settings();
    if (!settings.experimentalEnabled) throw new Error("Cloud sessions are still disabled in Settings");
    if (!this.#credentials.isAvailable()) throw new Error("Cloud handoff requires OS-protected credential storage");
    await this.#loadProvider(request.provider);
    const provider = this.#providers[request.provider];
    const revision = await engineRevision(this.runtimeLocation);
    const eventSequence = this.#engineEventSequence;
    let snapshot = await this.transport.local.rpc("snapshot") as EngineSnapshot;
    const handoffStartedAt = Date.now();
    this.#emit(snapshot.sessionId, "preparing", "Waiting for a safe engine boundary", 0.05, "waiting", handoffStartedAt);
    let preparation: HandoffPreparation | undefined;
    let sandboxId: string | undefined;
    let accessToken: string | undefined;
    let catalogPersisted = false;
    let ownershipCommitted = false;
    let commitAttempted = false;
    try {
      await stageOperation("waiting", "setup-failed", () => this.#waitForEngineIdle(snapshot, eventSequence));
      const settledSnapshot = await this.transport.local.rpc("snapshot") as EngineSnapshot;
      if (settledSnapshot.sessionId !== snapshot.sessionId) {
        throw new Error("The active session changed while Cloud handoff was waiting for engine-idle");
      }
      snapshot = settledSnapshot;
      const agents = await this.transport.local.rpc("listAgents");
      const [globalResult, projectResult] = await Promise.all([
        readConfigFile(globalConfigPath()),
        readConfigFile(projectConfigPath(request.cwd)),
      ]);
      const requiredModels = [...new Set([
        snapshot.model,
        snapshot.subagentModel,
        ...configuredCloudModels(globalResult?.config, projectResult?.config),
        ...(Array.isArray(agents)
          ? agents.map((agent) => agent && typeof agent === "object" && "model" in agent && typeof agent.model === "string" ? agent.model : undefined)
          : []),
      ].filter((model): model is string => Boolean(model)))];
      const modelAccess = await stageOperation("verifying", "missing-credential", () => this.#cloudModelEnvironment(
        settings,
        requiredModels,
        request.cwd,
        configuredCloudFallbackModels(globalResult?.config, projectResult?.config),
        request.includeModelCredentials ?? settings.transferModelCredentials,
      ));
      const models = modelAccess.models;
      const modelEnvironment = modelAccess.environment;
      const runtimeProfile = createCloudRuntimeProfile({
        theme: snapshot.theme,
        accentColor: snapshot.accentColor,
        details: snapshot.details,
        requiredModels: models,
      });
      await assertPublicProviderDomains(settings.allowedDomains);
      const prior = await this.#catalog.get(snapshot.sessionId);
      if (prior) {
        const action = isCloudSessionRemoteOwned(prior.status) ? "reconnect or resume it locally" : "delete the retained cloud copy";
        throw new Error(`This session already has a cloud record; ${action} before starting another handoff`);
      }
      await this.#catalog.put({
        sessionId: snapshot.sessionId,
        model: snapshot.model,
        models,
        optionalModels: modelAccess.optionalModels,
        credentialEnvironment: Object.keys(modelEnvironment).sort(),
        providerDomains: modelAccess.domains,
        runtimeRevision: CLOUD_RUNTIME_REVISION,
        runtimeProfileVersion: CLOUD_RUNTIME_PROFILE_VERSION,
        modelAccessVersion: CLOUD_MODEL_ACCESS_VERSION,
        appearance: appearanceFromProfile(runtimeProfile),
        workspaceId: createHash("sha256").update(resolve(request.cwd)).digest("hex").slice(0, 24),
        sourceRoot: request.cwd,
        provider: request.provider,
        sandboxId: "",
        sandboxName: "",
        ownershipGeneration: 0,
        status: "preparing",
        baseFingerprint: "",
        handoffTransition: {
          direction: "local-to-cloud",
          target: { kind: "cloud", provider: request.provider },
          phase: "intent",
          startedAt: Date.now(),
        },
        updatedAt: Date.now(),
      });
      catalogPersisted = true;
      preparation = await this.transport.local.rpc("prepareHandoff", {
        target: { kind: "cloud", provider: request.provider },
      }) as HandoffPreparation;
      await this.#catalog.patch(snapshot.sessionId, {
        ownershipGeneration: preparation.ownershipGeneration,
        handoffTransition: {
          direction: "local-to-cloud",
          target: { kind: "cloud", provider: request.provider },
          phase: "prepared",
          nonce: preparation.nonce,
          ownershipGeneration: preparation.ownershipGeneration,
          startedAt: Date.now(),
        },
      });
      const engine = await this.transport.local.rpc("exportPortableSession", {
        engineRevision: revision,
        ownershipGeneration: preparation.ownershipGeneration,
      }) as PortableSessionArchiveV1;
      if (engine.sessionId !== snapshot.sessionId || resolve(engine.sourceRoot) !== resolve(request.cwd)) {
        throw new Error("The active engine session does not belong to the selected workspace");
      }
      this.#emit(snapshot.sessionId, "transferring", "Building a verified workspace package", 0.14, "packaging", handoffStartedAt);
      const transfer = await createWorkspaceTransfer({
        cwd: request.cwd,
        sessionId: snapshot.sessionId,
        ownershipGeneration: preparation.ownershipGeneration,
        engineRevision: revision,
        engine,
        portableCapabilities: ["git", "terminal", "jobs", "skills", "plugins", "hooks", "http-mcp", "portable-stdio-mcp"],
        relayOnlyCapabilities: ["macos-apps", "local-browser", "ollama", "lm-studio", "local-mcp"],
        additionalExclusions: settings.additionalExclusions,
      });
      const runtime = await findRuntimeArtifact(revision, this.runtimeLocation);
      const sandboxName = `vibe-${transfer.manifest.workspaceId}-${snapshot.sessionId.slice(-8)}`;
      await this.#catalog.patch(snapshot.sessionId, { sandboxName });
      this.#emit(snapshot.sessionId, "transferring", `Creating ${request.provider === "e2b" ? "E2B" : "Vercel"} sandbox`, 0.26, "creating", handoffStartedAt);
      const sandbox = await stageOperation("creating", "provider-unavailable", async () =>
        await retryTransient("create sandbox", async (signal) => await createFreshNamedSandbox(provider, {
          name: sandboxName,
          workspaceId: transfer.manifest.workspaceId,
          sessionId: snapshot.sessionId,
          timeoutMs: settings.autoPauseMinutes * 60 * 1_000,
          allowedDomains: [...new Set([...DEFAULT_DOMAINS, ...settings.allowedDomains, ...modelAccess.domains])],
          signal,
        })),
      );
      sandboxId = sandbox.id;
      await this.#catalog.patch(snapshot.sessionId, { sandboxId: sandbox.id, sandboxName: sandbox.name });
      const base = request.provider === "e2b" ? "/home/user/vibe" : "/vercel/sandbox/vibe";
      this.#emit(snapshot.sessionId, "transferring", `Uploading verified runtime and workspace`, 0.36, "uploading", handoffStartedAt);
      accessToken = randomBytes(36).toString("base64url");
      const modelAccessEnvelope = sealCloudModelAccess(snapshot.sessionId, accessToken, modelEnvironment, runtimeProfile);
      await stageOperation(
        "uploading",
        "provider-unavailable",
        () => Promise.all([
          retryTransient("upload runtime", (signal) => provider.upload(sandbox.id, `${base}/runtime.tar.gz`, runtime.data, signal)),
          retryTransient("upload workspace", (signal) => provider.upload(sandbox.id, `${base}/handoff.json`, Buffer.from(JSON.stringify(transfer)), signal)),
          retryTransient("upload protected model access", (signal) => provider.upload(sandbox.id, `${base}/model-access.json`, Buffer.from(JSON.stringify(modelAccessEnvelope)), signal)),
        ]).then(() => undefined),
      );
      await this.#credentials.setSessionSecret(snapshot.sessionId, accessToken);
      await this.#credentials.setSessionEnvironment(snapshot.sessionId, modelEnvironment);
      this.#emit(snapshot.sessionId, "starting", "Verifying the cloud runtime", 0.48, "verifying", handoffStartedAt);
      await runRequired(provider, sandbox.id, "sh", ["-lc", `set -eu; rm -rf '${base}/runtime'; mkdir -p '${base}/runtime'; tar -xzf '${base}/runtime.tar.gz' -C '${base}/runtime'; cd '${base}/runtime'; sh install-runtime.sh`], undefined, {
        privileged: true,
        timeoutMs: SETUP_TIMEOUT_MS,
      }, "runtime-incompatible", "verifying");
      this.#emit(snapshot.sessionId, "starting", "Restoring workspace and session state", 0.61, "restoring", handoffStartedAt);
      await runRequired(provider, sandbox.id, "sh", ["restore-session.sh", `${base}/handoff.json`, `${base}/project`, revision], {
        VIBE_CLOUD_PROVIDER: request.provider,
        VIBE_CLOUD_RUNTIME: "1",
        VIBE_STATE_DIR: `${base}/state`,
      }, {
        privileged: true,
        cwd: `${base}/runtime`,
        timeoutMs: SETUP_TIMEOUT_MS,
      }, "setup-failed", "restoring");
      this.#emit(snapshot.sessionId, "starting", "Verifying every configured cloud model", 0.68, "verifying", handoffStartedAt);
      await runRequired(provider, sandbox.id, "sh", ["probe-models.sh", `${base}/model-access.json`, `${base}/project`, snapshot.sessionId], {
        VIBE_CLOUD_ACCESS_TOKEN: accessToken,
        VIBE_CLOUD_RUNTIME: "1",
        VIBE_STATE_DIR: `${base}/state`,
      }, {
        privileged: true,
        cwd: `${base}/runtime`,
        timeoutMs: SETUP_TIMEOUT_MS,
      }, "invalid-credential", "verifying", modelEnvironment);
      const daemonEnvironment = {
        VIBE_CLOUD_ACCESS_TOKEN: accessToken,
        VIBE_CLOUD_PROVIDER: request.provider,
        VIBE_CLOUD_EXPECTED_SESSION_ID: snapshot.sessionId,
        VIBE_WORKSPACE_ROOT: `${base}/project`,
        VIBE_CLOUD_AGENT_PORT: String(CLOUD_PORT),
        VIBE_STATE_DIR: `${base}/state`,
      };
      this.#emit(snapshot.sessionId, "starting", "Starting the cloud agent", 0.72, "starting-agent", handoffStartedAt);
      const daemon = await stageOperation(
        "starting-agent",
        "provider-unavailable",
        () => withAbortDeadline(
          (signal) => provider.start(sandbox.id, "sh", ["start.sh", request.provider, `${base}/model-access.json`], daemonEnvironment, {
            privileged: true,
            cwd: `${base}/runtime`,
            timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS,
            signal,
          }),
          PROVIDER_REQUEST_TIMEOUT_MS,
          "Cloud agent start request timed out",
        ),
      );
      const endpoint = await stageOperation(
        "checking-health",
        "provider-unavailable",
        () => withDeadline(provider.domain(sandbox.id, CLOUD_PORT), PROVIDER_REQUEST_TIMEOUT_MS, "Cloud endpoint request timed out"),
      );
      this.#emit(snapshot.sessionId, "starting", "Checking the authenticated cloud agent", 0.82, "checking-health", handoffStartedAt);
      await superviseCloudAgent(
        daemon,
        endpoint.url,
        accessToken,
        endpoint.headers,
        AGENT_HEALTH_TIMEOUT_MS,
        Object.keys(modelEnvironment),
        models,
      );
      const url = endpoint.url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
      this.#emit(snapshot.sessionId, "starting", "Connecting this window to the cloud session", 0.91, "connecting", handoffStartedAt);
      await awaitRemoteEngineReady(
        daemon,
        this.transport.switchToRemote(
          { url, accessToken, ...(endpoint.headers ? { headers: endpoint.headers } : {}) },
          { cwd: `${base}/project`, resume: snapshot.sessionId },
          { preserveLocal: true, sourceCwd: request.cwd },
        ),
      );
      const remoteSnapshot = await this.transport.snapshotForHandoff();
      assertCloudSessionContinuity(snapshot, remoteSnapshot, {
        sourceRoot: request.cwd,
        sourceStateRoot: engine.sourceStateRoot,
        targetRoot: `${base}/project`,
        targetStateRoot: cloudProjectStateRoot(`${base}/state`, `${base}/project`),
      });
      this.#remoteSessionId = snapshot.sessionId;
      const entry: CloudSessionCatalogEntry = {
        sessionId: snapshot.sessionId,
        model: snapshot.model,
        models,
        optionalModels: modelAccess.optionalModels,
        credentialEnvironment: Object.keys(modelEnvironment).sort(),
        providerDomains: modelAccess.domains,
        runtimeRevision: CLOUD_RUNTIME_REVISION,
        runtimeProfileVersion: CLOUD_RUNTIME_PROFILE_VERSION,
        modelAccessVersion: CLOUD_MODEL_ACCESS_VERSION,
        appearance: appearanceFromProfile(runtimeProfile),
        workspaceId: transfer.manifest.workspaceId,
        sourceRoot: request.cwd,
        provider: request.provider,
        sandboxId: sandbox.id,
        sandboxName: sandbox.name,
        ownershipGeneration: preparation.ownershipGeneration,
        status: "starting",
        baseFingerprint: transfer.manifest.sourceRootFingerprint,
        baseHead: transfer.manifest.git.head,
        exclusionRules: transfer.manifest.exclusionRules,
        excludedPaths: transfer.manifest.excludedPaths,
        remoteUrl: url,
        handoffTransition: {
          direction: "local-to-cloud",
          target: { kind: "cloud", provider: request.provider },
          phase: "prepared",
          nonce: preparation.nonce,
          ownershipGeneration: preparation.ownershipGeneration,
          startedAt: Date.now(),
        },
        updatedAt: Date.now(),
      };
      // Persist the recovery pointer before crossing the commit boundary. If
      // the app exits after this write, startup reconnects to the provisional
      // cloud owner while the local ownership record remains fail-closed.
      await this.#catalog.put(entry);
      commitAttempted = true;
      await this.transport.local.rpc("commitHandoff", {
        cwd: request.cwd,
        sessionId: snapshot.sessionId,
        nonce: preparation.nonce,
      });
      ownershipCommitted = true;
      await this.transport.completeLocalHandoff();
      if (request.instruction?.trim()) {
        this.transport.send({ type: "submit-prompt", text: request.instruction.trim() });
      }
      const running = await this.#catalog.patch(snapshot.sessionId, { status: "running", error: undefined, handoffTransition: undefined });
      this.#emit(snapshot.sessionId, "running", "Cloud session is ready", 1, "connecting", handoffStartedAt);
      return running;
    } catch (error) {
      let reportedError: unknown = error;
      if (ownershipCommitted) {
        // The cloud side is authoritative now. Never destroy it or roll the
        // generation back because a late UI/catalog operation failed.
        await this.transport.completeLocalHandoff().catch(() => undefined);
        if (catalogPersisted) {
          await this.#catalog.patch(snapshot.sessionId, { status: "recoverable-error", error: message(error) }).catch(() => undefined);
        }
      } else if (!commitAttempted) {
        const provisionalSandboxId = sandboxId;
        const rollback = await rollbackProvisionalHandoff(
          async () => {
            if (!preparation) return true;
            try {
              await this.transport.local.rpc("abortHandoff", {
                cwd: request.cwd,
                sessionId: snapshot.sessionId,
                nonce: preparation.nonce,
              });
              return true;
            } catch {
              try {
                const recovery = await this.transport.abortInterruptedLocalHandoff(
                  request.cwd,
                  snapshot.sessionId,
                  { kind: "cloud", provider: request.provider },
                  preparation.ownershipGeneration,
                );
                return recovery.outcome === "aborted";
              } catch { return false; }
            }
          },
          provisionalSandboxId ? () => provider.destroy(provisionalSandboxId) : undefined,
        );
        const preparationAborted = rollback.ownershipAborted;
        if (preparationAborted) {
          if (this.transport.isRemote) await this.transport.stop().catch(() => undefined);
          if (rollback.cleanupError) {
            const cleanupError = rollback.cleanupError;
            const prior = cloudFailureDetails(error);
            reportedError = new CloudOperationError(`Cloud handoff stopped, but provisional sandbox cleanup still needs attention: ${message(cleanupError)}`, {
              code: "cleanup-pending",
              stage: prior?.stage ?? "creating",
              retryable: false,
              diagnostic: message(cleanupError),
            });
            if (catalogPersisted) {
              await this.#catalog.patch(snapshot.sessionId, {
                status: "cleanup-pending",
                handoffTransition: undefined,
                error: `Provisional sandbox cleanup needs retry: ${message(cleanupError)}`,
              }).catch(() => undefined);
            }
          }
          if (rollback.sandboxDestroyed) {
            if (catalogPersisted) await this.#catalog.remove(snapshot.sessionId).catch(() => undefined);
            if (accessToken) await this.#credentials.removeSessionSecret(snapshot.sessionId).catch(() => undefined);
          }
        } else if (catalogPersisted) {
          this.#ownershipUnresolved = true;
          const prior = cloudFailureDetails(error);
          reportedError = new CloudOperationError("Cloud handoff stopped before local ownership rollback could be confirmed. Use Cloud recovery before trying again.", {
            code: "cleanup-pending",
            stage: prior?.stage ?? "waiting",
            retryable: false,
            diagnostic: message(error),
          });
          await this.#catalog.patch(snapshot.sessionId, {
            status: "handoff-interrupted",
            error: `Local ownership preparation needs recovery: ${message(error)}`,
          }).catch(() => undefined);
        }
      } else {
        // The commit request crossed the ownership boundary but its response
        // was lost. Preserve both sides and let startup recovery determine the
        // authoritative owner instead of destroying a possibly committed cloud owner.
        if (catalogPersisted) {
          await this.#catalog.patch(snapshot.sessionId, {
            status: "handoff-interrupted",
            error: `Cloud ownership commit needs recovery: ${message(error)}`,
          }).catch(() => undefined);
        }
        this.#ownershipUnresolved = true;
        await this.#recoverInterruptedOutboundHandoffs(true).catch(() => undefined);
        const unresolved = await this.#catalog.get(snapshot.sessionId).catch(() => null);
        this.#ownershipUnresolved = unresolved?.handoffTransition !== undefined;
        if (!unresolved && this.transport.isRemote) await this.transport.stop().catch(() => undefined);
      }
      const failure = cloudFailureDetails(reportedError);
      this.#emit(
        snapshot.sessionId,
        "recoverable-error",
        message(reportedError),
        failure ? progressForStage(failure.stage) : undefined,
        failure?.stage,
        handoffStartedAt,
      );
      throw reportedError;
    }
  }

  reconnect(sessionId: string): Promise<string> {
    return this.#withOwnershipTransition(() => this.#reconnectTracked(sessionId), true);
  }

  async #reconnectTracked(sessionId: string, allowLegacyCredentialless = false): Promise<string> {
    try {
      return await this.#reconnect(sessionId, allowLegacyCredentialless);
    } catch (error) {
      // Reconnect failures do not transfer ownership back to this Mac. Keep the
      // cloud session authoritative, but make its degraded state durable and
      // visible instead of leaving a stale "running" catalog row behind.
      const current = await this.#catalog.get(sessionId).catch(() => null);
      const status = current?.handoffTransition ? "handoff-interrupted" : "recoverable-error";
      await this.#catalog.patch(sessionId, { status, error: message(error) }).catch(() => undefined);
      this.#emit(sessionId, status, message(error));
      throw error;
    }
  }

  async #reconnect(sessionId: string, allowLegacyCredentialless = false): Promise<string> {
    await this.#recoverInterruptedOutboundHandoffs(true);
    const entry = await this.#catalog.get(sessionId);
    if (!entry) throw new Error("Cloud session is not in this desktop's catalog");
    const token = await this.#credentials.getSessionSecret(sessionId);
    if (!token) throw new Error("Cloud session access token is unavailable");
    await this.#loadProvider(entry.provider);
    const provider = this.#providers[entry.provider];
    const settings = await this.#readSettings();
    let sandbox = await provider.resume(entry.sandboxId, settings.autoPauseMinutes * 60 * 1_000);
    if (!sandbox) {
      const error = "Cloud sandbox no longer exists. Recover the last local base from Settings → Cloud.";
      await this.#catalog.patch(sessionId, { status: "lost", error });
      this.#emit(sessionId, "lost", error);
      throw new Error(error);
    }
    const base = entry.provider === "e2b" ? "/home/user/vibe" : "/vercel/sandbox/vibe";
    const needsRepair = cloudSessionNeedsRuntimeRepair(
      entry,
      CLOUD_RUNTIME_REVISION,
      CLOUD_RUNTIME_PROFILE_VERSION,
      CLOUD_MODEL_ACCESS_VERSION,
    );
    if (needsRepair && allowLegacyCredentialless) {
      const recovered = await this.#connectLegacyRuntimeForReturn(entry, provider, token, base);
      if (recovered) return recovered;
    }
    if (needsRepair) {
      this.#emit(sessionId, "starting", "Repairing this Cloud session in place", 0.48, "verifying");
    }
    let daemon: CloudCommandHandle | undefined;
    let expectedEnvironmentNames: string[] = [];
    let repairedProfile: CloudRuntimeProfileV1 | undefined;
    let runtimeDirectory = `${base}/runtime`;
    let legacyRecoveryRuntime = false;
    let stagedRepair = false;
    if (needsRepair || sandbox.needsDaemonRestart) {
      const models = entry.models?.length ? entry.models : entry.model ? [entry.model] : [];
      if (!models.length) throw legacyRepairError("This Cloud session does not record a model. Return it to Local from Settings → Cloud.");
      const modelEnvironment = allowLegacyCredentialless
        ? {}
        : await this.#credentials.getSessionEnvironment(sessionId);
      if (!modelEnvironment) {
        throw legacyRepairError("This Cloud session does not have a protected model-access snapshot. Return it to Local before reconnecting.");
      }
      if (!allowLegacyCredentialless && !entry.providerDomains?.length) {
        throw legacyRepairError("This Cloud session does not have a reviewed provider route. Return it to Local before reconnecting.");
      }
      const approvedEnvironment = [...(entry.credentialEnvironment ?? [])].sort();
      const pinnedEnvironment = Object.keys(modelEnvironment).sort();
      if (!allowLegacyCredentialless && (approvedEnvironment.length !== pinnedEnvironment.length
        || approvedEnvironment.some((name, index) => name !== pinnedEnvironment[index]))) {
        throw legacyRepairError("The protected Cloud model-access snapshot no longer matches the reviewed handoff. Return it to Local before reconnecting.");
      }
      expectedEnvironmentNames = Object.keys(modelEnvironment);
      if (!allowLegacyCredentialless) await assertPublicProviderDomains(entry.providerDomains ?? []);
      repairedProfile = await this.#runtimeProfileForEntry(
        entry,
        allowLegacyCredentialless ? [] : models,
        allowLegacyCredentialless,
      );
      if (needsRepair && !allowLegacyCredentialless) {
        await this.#quiesceLegacyRuntime(entry, provider, token, base);
        await provider.suspend(entry.sandboxId);
        sandbox = await provider.resume(entry.sandboxId, settings.autoPauseMinutes * 60 * 1_000);
        if (!sandbox) throw legacyRepairError("Cloud sandbox disappeared during in-place repair");
      }
      const envelope = sealCloudModelAccess(sessionId, token, modelEnvironment, repairedProfile);
      if (needsRepair && allowLegacyCredentialless) {
        const previousRuntime = `${base}/runtime-previous`;
        runtimeDirectory = await remoteDirectoryExists(provider, entry.sandboxId, previousRuntime)
          ? previousRuntime
          : `${base}/runtime`;
        legacyRecoveryRuntime = !(await runtimeSupportsModelEnvelope(provider, entry.sandboxId, runtimeDirectory));
        await stopExistingCloudRuntime(provider, entry.sandboxId);
      } else if (needsRepair) {
        const revision = await engineRevision(this.runtimeLocation);
        const runtime = await findRuntimeArtifact(revision, this.runtimeLocation);
        await provider.upload(entry.sandboxId, `${base}/runtime.tar.gz`, runtime.data);
        runtimeDirectory = `${base}/runtime-next`;
        await runRequired(provider, entry.sandboxId, "sh", ["-lc", `set -eu; rm -rf '${runtimeDirectory}'; mkdir -p '${runtimeDirectory}'; tar -xzf '${base}/runtime.tar.gz' -C '${runtimeDirectory}'; cd '${runtimeDirectory}'; sh install-runtime.sh`], undefined, {
          privileged: true,
          timeoutMs: SETUP_TIMEOUT_MS,
        }, "legacy-session-repair-failed", "verifying");
      }
      if (!legacyRecoveryRuntime) {
        await provider.upload(entry.sandboxId, `${base}/model-access.json`, Buffer.from(JSON.stringify(envelope)));
      }
      if (!allowLegacyCredentialless) {
        await runRequired(provider, entry.sandboxId, "sh", ["probe-models.sh", `${base}/model-access.json`, `${base}/project`, sessionId], {
          VIBE_CLOUD_ACCESS_TOKEN: token,
          VIBE_CLOUD_RUNTIME: "1",
          VIBE_STATE_DIR: `${base}/state`,
        }, {
          privileged: true,
          cwd: runtimeDirectory,
          timeoutMs: SETUP_TIMEOUT_MS,
        }, needsRepair ? "legacy-session-repair-failed" : "invalid-credential", "verifying", modelEnvironment);
      }
      if (needsRepair && !allowLegacyCredentialless) {
        await stopExistingCloudRuntime(provider, entry.sandboxId);
        await swapStagedCloudRuntime(provider, entry.sandboxId, base);
        runtimeDirectory = `${base}/runtime`;
        stagedRepair = true;
      }
      daemon = await provider.start(entry.sandboxId, "sh", legacyRecoveryRuntime
        ? ["start.sh", entry.provider]
        : ["start.sh", entry.provider, `${base}/model-access.json`], {
        VIBE_CLOUD_ACCESS_TOKEN: token,
        VIBE_CLOUD_PROVIDER: entry.provider,
        VIBE_CLOUD_EXPECTED_SESSION_ID: sessionId,
        VIBE_WORKSPACE_ROOT: `${base}/project`,
        VIBE_CLOUD_AGENT_PORT: String(CLOUD_PORT),
        VIBE_STATE_DIR: `${base}/state`,
      }, { privileged: true, cwd: runtimeDirectory, timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS });
    }
    const endpoint = await provider.domain(entry.sandboxId, CLOUD_PORT);
    if (daemon && !legacyRecoveryRuntime) {
      await superviseCloudAgent(
        daemon,
        endpoint.url,
        token,
        endpoint.headers,
        AGENT_HEALTH_TIMEOUT_MS,
        allowLegacyCredentialless ? [] : expectedEnvironmentNames,
        allowLegacyCredentialless ? [] : entry.models?.length ? entry.models : entry.model ? [entry.model] : [],
      );
    }
    const url = endpoint.url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    const reconnect = this.transport.switchToRemote(
      { url, accessToken: token, ...(endpoint.headers ? { headers: endpoint.headers } : {}) },
      { cwd: `${base}/project`, resume: sessionId },
      { preserveLocal: entry.handoffTransition?.direction === "cloud-to-local", sourceCwd: entry.sourceRoot },
    );
    const id = daemon ? await awaitRemoteEngineReady(daemon, reconnect) : await reconnect;
    this.#remoteSessionId = id;
    if (entry.handoffTransition?.direction === "cloud-to-local") {
      const recovered = await this.#recoverInterruptedReturn(entry, id);
      this.#ownershipUnresolved = false;
      return recovered;
    }
    await this.#catalog.patch(sessionId, {
      remoteUrl: url,
      status: "running",
      error: undefined,
      ...(repairedProfile ? {
        runtimeRevision: CLOUD_RUNTIME_REVISION,
        runtimeProfileVersion: CLOUD_RUNTIME_PROFILE_VERSION,
        modelAccessVersion: CLOUD_MODEL_ACCESS_VERSION,
        appearance: appearanceFromProfile(repairedProfile),
      } : {}),
    });
    if (stagedRepair) await cleanupPreviousCloudRuntime(provider, entry.sandboxId, base).catch(() => undefined);
    return id;
  }

  resumeLocally(sessionId: string, keepCloudCopy = false): Promise<{ sessionId: string; cwd: string; divergent: boolean; recoveryPath?: string }> {
    return this.#withOwnershipTransition(() => this.#resumeLocally(sessionId, keepCloudCopy));
  }

  async #resumeLocally(sessionId: string, keepCloudCopy = false): Promise<{ sessionId: string; cwd: string; divergent: boolean; recoveryPath?: string }> {
    const entry = await this.#catalog.get(sessionId);
    if (!entry) throw new Error("Cloud session is not in this desktop's catalog");
    const settings = await this.#readSettings();
    const preserveCloudCopy = keepCloudCopy || !settings.deleteOnReturn;
    if (shouldReconnectRemoteSession(this.transport.isRemote, this.transport.isReady, this.#remoteSessionId, sessionId)) {
      await this.#reconnectTracked(sessionId, true);
    }
    await this.#loadProvider(entry.provider);
    const provider = this.#providers[entry.provider];
    const revision = await engineRevision(this.runtimeLocation);
    let preparation: HandoffPreparation | undefined;
    let provisionalLocal = false;
    let portableImported = false;
    let remoteOwnershipCommitted = false;
    let remoteCommitAttempted = false;
    let localImportPending = false;
    let applied: WorkspaceApplyResult | undefined;
    let cwd = entry.sourceRoot;
    let postCommitWarning: string | undefined;
    try {
      this.#emit(sessionId, "syncing-back", "Waiting for cloud engine-idle", 0.05);
      const eventSequence = this.#engineEventSequence;
      const snapshot = await this.transport.rpc("snapshot") as EngineSnapshot;
      await this.#waitForEngineIdle(snapshot, eventSequence);
      await this.#catalog.patch(sessionId, {
        status: "syncing-back",
        handoffTransition: {
          direction: "cloud-to-local",
          target: { kind: "local" },
          phase: "intent",
          startedAt: Date.now(),
        },
      });
      preparation = await this.transport.rpc("prepareHandoff", {
        target: { kind: "local" },
        expectedGeneration: entry.ownershipGeneration,
      }) as HandoffPreparation;
      await this.#catalog.patch(sessionId, {
        status: "syncing-back",
        handoffTransition: {
          direction: "cloud-to-local",
          target: { kind: "local" },
          phase: "prepared",
          nonce: preparation.nonce,
          ownershipGeneration: preparation.ownershipGeneration,
          startedAt: Date.now(),
        },
      });
      const engine = await this.transport.rpc("exportPortableSession", {
        engineRevision: revision,
        ownershipGeneration: preparation.ownershipGeneration,
      }) as PortableSessionArchiveV1;
      const base = entry.provider === "e2b" ? "/home/user/vibe" : "/vercel/sandbox/vibe";
      if (
        engine.sessionId !== sessionId
        || engine.ownershipGeneration !== preparation.ownershipGeneration
        || engine.executionTarget.kind !== "local"
        || engine.engineRevision !== revision
        || resolve(engine.sourceRoot) !== resolve(`${base}/project`)
      ) {
        throw new Error("The cloud engine returned portable state for a different session, generation, target, root, or revision");
      }
      const output = `${base}/return-${preparation.ownershipGeneration}.json`;
      this.#emit(sessionId, "syncing-back", "Packaging cloud workspace changes", 0.22);
      await runRequired(provider, entry.sandboxId, "sh", ["export-workspace.sh", `${base}/project`, `${base}/handoff.json`, output], undefined, {
        privileged: true,
        cwd: `${base}/runtime`,
        timeoutMs: SETUP_TIMEOUT_MS,
      }, "setup-failed", "packaging");
      const data = await waitForRemoteFile(provider, entry.sandboxId, output, 120_000, MAX_RETURN_SNAPSHOT_BYTES, "cloud return package");
      const remote = JSON.parse(Buffer.from(data).toString("utf8")) as RemoteWorkspaceSnapshotV1;
      const transfer = assembleReturnTransfer({
        snapshot: remote,
        engine,
        workspaceId: entry.workspaceId,
        sessionId,
        ownershipGeneration: preparation.ownershipGeneration,
        engineRevision: revision,
        sourceRoot: entry.sourceRoot,
        baseFingerprint: entry.baseFingerprint,
        exclusionRules: entry.exclusionRules,
        excludedPaths: entry.excludedPaths,
      });
      this.#emit(sessionId, "syncing-back", "Verifying and staging local return", 0.48);
      applied = await applyWorkspaceTransfer(
        entry.sourceRoot,
        transfer,
        [...(entry.exclusionRules ?? []), ...settings.additionalExclusions],
        async (preparedApply) => {
          const preparedCwd = preparedApply.kind === "diverged" ? preparedApply.worktreePath : entry.sourceRoot;
          await this.#catalog.patch(sessionId, {
            handoffTransition: {
              direction: "cloud-to-local",
              target: { kind: "local" },
              phase: "prepared",
              nonce: preparation!.nonce,
              ownershipGeneration: preparation!.ownershipGeneration,
              localCwd: preparedCwd,
              applied: {
                kind: preparedApply.kind,
                path: preparedApply.kind === "applied" ? preparedApply.recoveryPath : preparedApply.worktreePath,
              },
              startedAt: Date.now(),
            },
          });
        },
      );
      cwd = applied.kind === "diverged" ? applied.worktreePath : entry.sourceRoot;
      await this.#catalog.patch(sessionId, {
        handoffTransition: {
          direction: "cloud-to-local",
          target: { kind: "local" },
          phase: "prepared",
          nonce: preparation.nonce,
          ownershipGeneration: preparation.ownershipGeneration,
          localCwd: cwd,
          portableImported: true,
          applied: { kind: applied.kind, path: applied.kind === "applied" ? applied.recoveryPath : applied.worktreePath },
          startedAt: Date.now(),
        },
      });
      await this.transport.importPortableSession(cwd, engine, revision, true);
      portableImported = true;
      await this.#appearanceMutationChain;
      await this.#catalog.patch(sessionId, {
        handoffTransition: {
          direction: "cloud-to-local",
          target: { kind: "local" },
          phase: "committing",
          nonce: preparation.nonce,
          ownershipGeneration: preparation.ownershipGeneration,
          localCwd: cwd,
          portableImported: true,
          applied: { kind: applied.kind, path: applied.kind === "applied" ? applied.recoveryPath : applied.worktreePath },
          startedAt: Date.now(),
        },
      });
      await this.transport.startProvisionalLocal({ cwd, resume: sessionId });
      provisionalLocal = true;
      remoteCommitAttempted = true;
      await this.transport.rpc("commitHandoff", {
        cwd: `${base}/project`,
        sessionId,
        nonce: preparation.nonce,
      });
      remoteOwnershipCommitted = true;
      try {
        await this.transport.commitPortableImport(cwd, sessionId, preparation.ownershipGeneration);
      } catch (error) {
        localImportPending = true;
        postCommitWarning = `Local recovery backup cleanup is pending: ${message(error)}`;
      }
      portableImported = false;
      await this.transport.completeRemoteHandoff();
      this.#remoteSessionId = null;
      provisionalLocal = false;
    } catch (error) {
      if (remoteOwnershipCommitted) {
        postCommitWarning = `Cloud ownership returned locally, but final detach needs recovery: ${message(error)}`;
        await this.transport.completeRemoteHandoff().catch(() => undefined);
        provisionalLocal = false;
      } else if (remoteCommitAttempted) {
        // The commit request may have won even though its response was lost.
        // Preserve the journaled workspace, portable import, and both engines;
        // reconnect recovery resolves the authoritative generation first.
        this.#ownershipUnresolved = true;
        await this.#catalog.patch(sessionId, {
          status: "handoff-interrupted",
          error: `Local ownership commit needs recovery: ${message(error)}`,
        }).catch(() => undefined);
        this.#emit(sessionId, "recoverable-error", message(error));
        throw error;
      } else {
        if (provisionalLocal) await this.transport.local.detachForHandoff().catch(() => undefined);
        if (portableImported && preparation) {
          await this.transport.abortPortableImport(cwd, sessionId, preparation.ownershipGeneration).catch(() => undefined);
        }
        if (applied) await rollbackWorkspaceApplication(entry.sourceRoot, applied).catch(() => undefined);
      }
      let remoteAbortConfirmed = preparation === undefined;
      if (!remoteOwnershipCommitted && !remoteCommitAttempted && preparation && this.transport.isRemote) {
        try {
          await this.transport.rpc("abortHandoff", {
            sessionId,
            nonce: preparation.nonce,
          });
          remoteAbortConfirmed = true;
        } catch (abortError) {
          this.#ownershipUnresolved = true;
          await this.#catalog.patch(sessionId, {
            status: "handoff-interrupted",
            error: `Return rollback needs ownership recovery: ${message(abortError)}`,
          }).catch(() => undefined);
          this.#emit(sessionId, "recoverable-error", "Return ownership needs recovery before continuing");
          throw error;
        }
      }
      if (!remoteOwnershipCommitted && !remoteCommitAttempted) {
        if (preparation && !remoteAbortConfirmed) {
          this.#ownershipUnresolved = true;
          await this.#catalog.patch(sessionId, {
            status: "handoff-interrupted",
            error: "Return rollback could not prove that remote ownership was aborted.",
          }).catch(() => undefined);
          throw error;
        }
        await this.#catalog.patch(sessionId, {
          status: "running",
          handoffTransition: undefined,
          error: `Return was rolled back safely: ${message(error)}`,
        }).catch(() => undefined);
        this.#emit(sessionId, "recoverable-error", message(error));
        throw error;
      }
    }
    if (!applied || !preparation) throw new Error("Cloud return completed without a verified local workspace");
    if (localImportPending) {
      try { await provider.suspend(entry.sandboxId); }
      catch (error) { postCommitWarning = `${postCommitWarning ?? "Local import cleanup is pending"}; cloud suspend also failed: ${message(error)}`; }
      await this.#catalog.patch(sessionId, {
        status: "cleanup-pending",
        ownershipGeneration: preparation.ownershipGeneration,
        localRecoveryCwd: cwd,
        localImportPending: true,
        error: postCommitWarning,
        handoffTransition: undefined,
      });
    } else try {
      if (preserveCloudCopy) {
        await provider.suspend(entry.sandboxId);
        await this.#catalog.patch(sessionId, {
          status: "suspended",
          ownershipGeneration: preparation.ownershipGeneration,
          localRecoveryCwd: cwd,
          localImportPending: false,
          handoffTransition: undefined,
        });
      } else {
        await provider.destroy(entry.sandboxId);
        await this.#credentials.removeSessionSecret(sessionId);
        await this.#catalog.remove(sessionId);
      }
    } catch (error) {
      postCommitWarning = `Resumed locally; cloud cleanup needs attention: ${message(error)}`;
      await this.#catalog.patch(sessionId, {
        status: "cleanup-pending",
        ownershipGeneration: preparation.ownershipGeneration,
        localRecoveryCwd: cwd,
        localImportPending: false,
        error: message(error),
        handoffTransition: undefined,
      }).catch(() => undefined);
    }
    const resumedMessage = applied.kind === "diverged" ? "Resumed locally in a safe review worktree" : "Resumed locally";
    this.#emit(sessionId, "running", postCommitWarning ? `${resumedMessage}. ${postCommitWarning}` : resumedMessage, 1);
    return {
      sessionId,
      cwd,
      divergent: applied.kind === "diverged",
      ...(applied.kind === "applied" ? { recoveryPath: applied.recoveryPath } : {}),
    };
  }

  async deleteCloudCopy(sessionId: string): Promise<void> {
    const entry = await this.#catalog.get(sessionId);
    if (!entry) return;
    if (entry.status === "lost") throw new Error("Recover the last local base before clearing this missing sandbox record");
    if (entry.handoffTransition) {
      throw new Error("Resolve the interrupted handoff before deleting its cloud copy");
    }
    if (entry.status !== "suspended" && entry.status !== "cleanup-pending") {
      throw new Error("Resume this cloud session locally before deleting its cloud copy");
    }
    if (entry.localImportPending) {
      await this.transport.commitPortableImport(
        entry.localRecoveryCwd ?? entry.sourceRoot,
        sessionId,
        entry.ownershipGeneration,
      );
      await this.#catalog.patch(sessionId, { localImportPending: false, error: undefined });
    }
    await this.#loadProvider(entry.provider);
    try {
      await this.#providers[entry.provider].destroy(entry.sandboxId);
    } catch (error) {
      if (!/not.found|404|no longer exists/i.test(message(error))) throw error;
    }
    await this.#credentials.removeSessionSecret(sessionId);
    await this.#catalog.remove(sessionId);
  }

  async recoverLostSession(sessionId: string): Promise<{ sessionId: string; cwd: string }> {
    const entry = await this.#catalog.get(sessionId);
    if (entry?.status !== "lost") throw new Error("This session does not have a provider-confirmed missing sandbox");
    await this.transport.recoverLostCloudOwnership(
      entry.sourceRoot,
      sessionId,
      entry.provider,
      entry.ownershipGeneration,
    );
    await this.#credentials.removeSessionSecret(sessionId);
    await this.#catalog.remove(sessionId);
    return { sessionId, cwd: entry.sourceRoot };
  }

  async #recoverInterruptedOutboundHandoffs(allowDuringTransition = false): Promise<void> {
    if (this.#ownershipTransitionDepth > 0 && !allowDuringTransition) return;
    const interrupted = (await this.#catalog.list()).filter(
      (entry) => entry.handoffTransition?.direction === "local-to-cloud",
    );
    for (const entry of interrupted) {
      const transition = entry.handoffTransition!;
      let ownershipAborted = false;
      try {
        const recovery = await this.transport.abortInterruptedLocalHandoff(
          entry.sourceRoot,
          entry.sessionId,
          transition.target,
          transition.ownershipGeneration,
        );
        if (recovery.outcome === "already-committed") {
          await this.#catalog.patch(entry.sessionId, {
            status: "recoverable-error",
            ownershipGeneration: recovery.generation,
            handoffTransition: undefined,
            error: "Cloud ownership completed while the desktop was interrupted. Reconnect to continue.",
          });
          continue;
        }
        ownershipAborted = true;
        let sandboxId = entry.sandboxId;
        if (!sandboxId && entry.sandboxName) {
          await this.#loadProvider(entry.provider);
          const discovered = await this.#providers[entry.provider].findByName(entry.sandboxName);
          if (discovered) {
            sandboxId = discovered.id;
            await this.#catalog.patch(entry.sessionId, { sandboxId, sandboxName: discovered.name });
          }
        }
        await this.#catalog.patch(entry.sessionId, {
          status: "cleanup-pending",
          handoffTransition: undefined,
          error: sandboxId ? "Removing the provisional cloud sandbox after an interrupted handoff." : undefined,
        });
        if (sandboxId) {
          await this.#loadProvider(entry.provider);
          await this.#providers[entry.provider].destroy(sandboxId);
        }
        await this.#credentials.removeSessionSecret(entry.sessionId).catch(() => undefined);
        await this.#catalog.remove(entry.sessionId);
      } catch (error) {
        if (ownershipAborted) {
          await this.#catalog.patch(entry.sessionId, {
            status: "cleanup-pending",
            handoffTransition: undefined,
            error: `Provisional sandbox cleanup needs retry: ${message(error)}`,
          });
          continue;
        }
        let recoverableSandboxId = entry.sandboxId;
        let sandboxLookupCompleted = false;
        if (!recoverableSandboxId && entry.sandboxName) {
          try {
            await this.#loadProvider(entry.provider);
            const discovered = await this.#providers[entry.provider].findByName(entry.sandboxName);
            sandboxLookupCompleted = true;
            if (discovered) {
              recoverableSandboxId = discovered.id;
              await this.#catalog.patch(entry.sessionId, { sandboxId: discovered.id, sandboxName: discovered.name });
            }
          } catch { /* preserve the transition for another recovery attempt */ }
        }
        if (!recoverableSandboxId && transition.phase === "intent" && (!entry.sandboxName || sandboxLookupCompleted)) {
          // No sandbox means the commit boundary was unreachable. A mismatch
          // here means prepare itself never completed, so the intent is stale.
          await this.#catalog.remove(entry.sessionId);
        } else {
          await this.#catalog.patch(entry.sessionId, {
            status: "handoff-interrupted",
            error: `Interrupted handoff needs recovery: ${message(error)}`,
          });
        }
      }
    }
    const remaining = await this.#catalog.list();
    this.#ownershipUnresolved = remaining.some((entry) =>
      entry.status === "handoff-interrupted" && entry.handoffTransition !== undefined);
  }

  async #recoverInterruptedReturn(entry: CloudSessionCatalogEntry, connectedSessionId: string): Promise<string> {
    const transition = entry.handoffTransition;
    if (transition?.direction !== "cloud-to-local") return connectedSessionId;
    let aborted = false;
    try {
      if (transition.nonce) {
        await this.transport.rpc("abortHandoff", {
          cwd: entry.provider === "e2b" ? "/home/user/vibe/project" : "/vercel/sandbox/vibe/project",
          sessionId: entry.sessionId,
          nonce: transition.nonce,
        });
      } else {
        await this.transport.rpc("abortInterruptedHandoff", {
          sessionId: entry.sessionId,
          target: transition.target,
          ...(transition.ownershipGeneration === undefined ? {} : { expectedGeneration: transition.ownershipGeneration }),
        });
      }
      aborted = true;
    } catch (error) {
      if (transition.phase === "intent") {
        // The intent may have been persisted before prepare ran at all.
        aborted = true;
      } else if (transition.phase !== "committing" || !transition.portableImported || !transition.localCwd || transition.ownershipGeneration === undefined) {
        await this.#catalog.patch(entry.sessionId, {
          status: "recoverable-error",
          error: `Interrupted return could not be resolved safely: ${message(error)}`,
        });
        throw error;
      }
    }
    if (aborted) {
      if (transition.portableImported && transition.localCwd && transition.ownershipGeneration !== undefined) {
        await this.transport.abortPortableImport(
          transition.localCwd,
          entry.sessionId,
          transition.ownershipGeneration,
        );
      }
      let preservedRecoveryPath: string | undefined;
      if (transition.applied) {
        preservedRecoveryPath = await rollbackWorkspaceApplication(
          entry.sourceRoot,
          transition.applied.kind === "applied"
            ? { kind: "applied", recoveryPath: transition.applied.path }
            : { kind: "diverged", worktreePath: transition.applied.path },
        );
      }
      await this.#catalog.patch(entry.sessionId, {
        status: "running",
        handoffTransition: undefined,
        error: preservedRecoveryPath
          ? `Local changes made after the interruption were preserved at ${preservedRecoveryPath}; the return was rolled back safely.`
          : "An interrupted local return was rolled back safely.",
      });
      return connectedSessionId;
    }

    // The remote commit won the race: finish the already-journaled local
    // import and make the local engine authoritative without modifying files.
    await this.transport.commitPortableImport(
      transition.localCwd!,
      entry.sessionId,
      transition.ownershipGeneration!,
    );
    await this.transport.completeRemoteHandoff();
    this.#remoteSessionId = null;
    const localId = await this.transport.start({ cwd: transition.localCwd!, resume: entry.sessionId });
    await this.#loadProvider(entry.provider);
    await this.#providers[entry.provider].suspend(entry.sandboxId).catch(() => undefined);
    await this.#catalog.patch(entry.sessionId, {
      status: "cleanup-pending",
      handoffTransition: undefined,
      localRecoveryCwd: transition.localCwd,
      localImportPending: false,
      error: "The interrupted return completed locally. The retained cloud copy can now be deleted.",
    });
    return localId;
  }

  async #waitForEngineIdle(snapshot: EngineSnapshot, eventSequenceBeforeSnapshot: number): Promise<void> {
    if (!snapshot.busy) {
      this.#idleSessionId = snapshot.sessionId;
      return;
    }
    // An idle event can arrive after the host produced the busy snapshot but
    // before the RPC continuation runs. Preserve that exact-session wakeup.
    if (this.#idleEventSequence > eventSequenceBeforeSnapshot && this.#idleSessionId === snapshot.sessionId) return;
    // Otherwise ignore an idle observation retained from before this request.
    this.#idleSessionId = null;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiters = this.#idleWaiters.get(snapshot.sessionId);
        waiters?.delete(done);
        if (waiters?.size === 0) this.#idleWaiters.delete(snapshot.sessionId);
        reject(new Error("Timed out waiting for engine-idle"));
      }, 30 * 60_000);
      const done = () => { clearTimeout(timeout); resolve(); };
      const waiters = this.#idleWaiters.get(snapshot.sessionId) ?? new Set<() => void>();
      waiters.add(done);
      this.#idleWaiters.set(snapshot.sessionId, waiters);
    });
  }

  async #withOwnershipTransition<T>(operation: () => Promise<T>, allowUnresolved = false): Promise<T> {
    if (this.#ownershipTransitionDepth > 0 || this.#ownershipUnresolved && !allowUnresolved) {
      throw new Error(this.#ownershipUnresolved
        ? "Session ownership recovery is required before continuing"
        : "A session handoff is already in progress");
    }
    this.#ownershipTransitionDepth += 1;
    try { return await operation(); }
    finally { this.#ownershipTransitionDepth -= 1; }
  }

  async #loadProvider(provider: CloudProviderId): Promise<void> {
    const credentials = await this.#credentials.get(provider);
    if (!credentials) throw new Error(`${provider === "e2b" ? "E2B" : "Vercel"} is not connected`);
    await this.#providers[provider].connectAccount(credentials as never);
  }

  async #mutateSettings(mutation: (settings: CloudSettingsFileV1) => CloudSettingsFileV1): Promise<void> {
    const run = this.#settingsMutationChain.then(async () => {
      const settings = await this.#readSettings();
      await this.#writeSettings(mutation(settings));
    });
    this.#settingsMutationChain = run.catch(() => undefined);
    await run;
  }

  async #boundEnvironment(settings: CloudSettingsPublic): Promise<Record<string, string>> {
    const environment: Record<string, string> = {};
    for (const binding of settings.credentialBindings) {
      if (binding.kind !== "environment") continue;
      const value = await this.#credentials.getBinding(binding.id);
      if (value) environment[binding.label] = value;
    }
    return environment;
  }

  async #cloudModelEnvironment(
    settings: CloudSettingsPublic,
    models: string[],
    cwd: string,
    optionalModels: string[] = [],
    includeAutomaticCredentials = true,
  ): Promise<{ environment: Record<string, string>; models: string[]; optionalModels: string[]; domains: string[] }> {
    if (!models.length) throw new Error("Cloud handoff requires at least one configured model");
    const requiredProviderIds = new Set(models.map((model) => model.split("/", 1)[0]));
    if (requiredProviderIds.has("xai") && requiredProviderIds.has("xai-oauth")) {
      throw new Error("Cloud handoff cannot mix xAI API-key and Grok subscription routes in one session. Choose one xAI credential scope before handing off.");
    }
    // XAI_API_KEY is shared by the API-key and subscription adapters. Pick one
    // scope for the sandbox and discard only incompatible optional fallbacks;
    // an optional route must never make an otherwise valid primary fail.
    const xaiCredentialScope = requiredProviderIds.has("xai-oauth")
      ? "xai-oauth"
      : requiredProviderIds.has("xai")
        ? "xai"
        : optionalModels
          .map((model) => model.split("/", 1)[0])
          .find((providerId) => providerId === "xai" || providerId === "xai-oauth");
    const compatibleOptionalModels = optionalModels.filter((model) => {
      const providerId = model.split("/", 1)[0];
      return (providerId !== "xai" && providerId !== "xai-oauth") || providerId === xaiCredentialScope;
    });
    const [bound, globalResult, projectResult] = await Promise.all([
      this.#boundEnvironment(settings),
      readConfigFile(globalConfigPath()),
      readConfigFile(projectConfigPath(cwd)),
    ]);
    if (includeAutomaticCredentials) {
      Object.assign(bound, ambientCloudModelEnvironment([...models, ...compatibleOptionalModels], process.env));
    }
    for (const providerId of includeAutomaticCredentials
      ? [...new Set([...models, ...compatibleOptionalModels].map((model) => model.split("/", 1)[0]))]
      : []) {
      const authProviderId = subscriptionAuthProviderForModelProvider(providerId);
      if (!authProviderId) continue;
      const credential = await this.transport.local.rpc("exportProviderAuth", { providerId: authProviderId }) as {
        providerId: "openai-codex" | "xai-oauth";
        access: string;
        accountId?: string;
      } | null;
      if (!credential) continue;
      Object.assign(bound, subscriptionCredentialEnvironment(authProviderId, credential));
    }

    const environment: Record<string, string> = {};
    const domains = new Set<string>();
    const resolveModel = (model: string): { candidate: Record<string, string>; hostname: string } => {
      const candidate = cloudModelEnvironment(
        model,
        globalResult?.config,
        projectResult?.config,
        bound,
        { includeConfiguredCredentials: includeAutomaticCredentials },
      );
      for (const [name, value] of Object.entries(candidate)) {
        if (environment[name] !== undefined && environment[name] !== value) {
          throw new Error(`Configured models require conflicting values for ${name}. Return to Local and use one credential scope before handing off.`);
        }
      }
      const hostname = cloudModelRouteHostname(
        model,
        globalResult?.config,
        projectResult?.config,
        candidate,
        { includeConfiguredCredentials: includeAutomaticCredentials },
      );
      if (!hostname) {
        throw new Error(`${model.split("/", 1)[0]} does not expose a fixed HTTPS endpoint for Cloud egress. Choose a provider with an explicit cloud endpoint before handing off.`);
      }
      return { candidate, hostname };
    };
    const mergeModel = ({ candidate, hostname }: { candidate: Record<string, string>; hostname: string }): void => {
      for (const [name, value] of Object.entries(candidate)) {
        environment[name] = value;
      }
      domains.add(hostname);
    };
    const validatedDomains = new Set<string>();
    const validateModel = async (model: string): Promise<ReturnType<typeof resolveModel>> => {
      const resolved = resolveModel(model);
      if (!validatedDomains.has(resolved.hostname)) {
        await assertPublicProviderDomains([resolved.hostname]);
        validatedDomains.add(resolved.hostname);
      }
      return resolved;
    };
    try {
      for (const model of models) mergeModel(await validateModel(model));
    } catch (error) {
      if (!includeAutomaticCredentials) {
        throw new Error(
          `Model access was excluded from this handoff. Enable “Include model access” or add the required environment key under Settings → Cloud → Credential bindings. ${message(error)}`,
        );
      }
      throw error;
    }
    const resolvedModels = [...models];
    const resolvedOptionalModels: string[] = [];
    for (const model of compatibleOptionalModels) {
      if (resolvedModels.includes(model)) continue;
      try {
        mergeModel(await validateModel(model));
        resolvedModels.push(model);
        resolvedOptionalModels.push(model);
      } catch {
        // Fallbacks are intentionally optional in the engine. An unavailable
        // fallback must not block a usable primary Cloud route.
      }
    }
    return { environment, models: resolvedModels, optionalModels: resolvedOptionalModels, domains: [...domains] };
  }

  async #runtimeProfileForEntry(
    entry: CloudSessionCatalogEntry,
    requiredModels: string[],
    recoveryOnly = false,
  ): Promise<CloudRuntimeProfileV1> {
    if (entry.appearance) {
      return createCloudRuntimeProfile({ ...entry.appearance, requiredModels, ...(recoveryOnly ? { recoveryOnly: true } : {}) });
    }
    // Pre-profile (0.6.2) runtimes booted with the remote default, which is the
    // defect this migration repairs. That snapshot has no intent provenance,
    // so the Mac's application-wide appearance is the migration authority.
    // Once cataloged, all later Cloud changes are mirrored in both directions.
    const globalResult = await readConfigFile(globalConfigPath());
    return createCloudRuntimeProfile({
      theme: globalResult?.config.theme ?? "graphite",
      accentColor: globalResult?.config.accentColor ?? "#e6e6e6",
      details: globalResult?.config.details ?? "normal",
      requiredModels,
      ...(recoveryOnly ? { recoveryOnly: true } : {}),
    });
  }

  async #connectLegacyRuntimeForReturn(
    entry: CloudSessionCatalogEntry,
    provider: SandboxProvider,
    token: string,
    base: string,
  ): Promise<string | null> {
    const endpoint = await provider.domain(entry.sandboxId, CLOUD_PORT);
    const state = await inspectLegacyCloudAgent(endpoint.url, token, endpoint.headers);
    if (!state) {
      if (await legacyCloudAgentProcessRunning(provider, entry.sandboxId)) {
        throw legacyRepairError("The legacy Cloud agent is still running but its authenticated health endpoint is unavailable; recovery was deferred without stopping it");
      }
      return null;
    }
    const url = endpoint.url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    const id = await this.transport.switchToRemote(
      { url, accessToken: token, ...(endpoint.headers ? { headers: endpoint.headers } : {}) },
      { cwd: `${base}/project`, resume: entry.sessionId },
      { preserveLocal: true },
    );
    this.#remoteSessionId = id;
    if (entry.handoffTransition?.direction === "cloud-to-local") {
      const recovered = await this.#recoverInterruptedReturn(entry, id);
      this.#ownershipUnresolved = false;
      return recovered;
    }
    return id;
  }

  async #quiesceLegacyRuntime(
    entry: CloudSessionCatalogEntry,
    provider: SandboxProvider,
    token: string,
    base: string,
  ): Promise<void> {
    const endpoint = await provider.domain(entry.sandboxId, CLOUD_PORT);
    const state = await inspectLegacyCloudAgent(endpoint.url, token, endpoint.headers);
    if (!state) {
      if (await legacyCloudAgentProcessRunning(provider, entry.sandboxId)) {
        throw legacyRepairError("The legacy Cloud agent is still running but its authenticated health endpoint is unavailable; repair was deferred without stopping it");
      }
      return;
    }
    if (state.terminals > 0) {
      throw legacyRepairError(`Cloud runtime repair is waiting for ${state.terminals} active terminal${state.terminals === 1 ? "" : "s"}. Return this session to Local or close the terminal before reconnecting.`);
    }
    if (!state.engine) return;
    const url = endpoint.url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    try {
      const id = await this.transport.switchToRemote(
        { url, accessToken: token, ...(endpoint.headers ? { headers: endpoint.headers } : {}) },
        { cwd: `${base}/project`, resume: entry.sessionId },
        { preserveLocal: true },
      );
      if (id !== entry.sessionId) throw legacyRepairError(`Legacy Cloud runtime resumed ${id} instead of ${entry.sessionId}`);
      this.#remoteSessionId = id;
      const eventSequence = this.#engineEventSequence;
      const snapshot = await this.transport.rpc("snapshot") as EngineSnapshot;
      await this.#waitForEngineIdle(snapshot, eventSequence);
      await this.transport.stop();
      this.#remoteSessionId = null;
      await waitForLegacyEngineStopped(endpoint.url, token, endpoint.headers);
    } catch (error) {
      if (this.transport.isRemote) await this.transport.disconnectRemote().catch(() => undefined);
      this.#remoteSessionId = null;
      throw error;
    }
  }

  async #mirrorCloudAppearance(
    sessionId: string,
    patch: Partial<NonNullable<CloudSessionCatalogEntry["appearance"]>>,
  ): Promise<void> {
    const run = this.#appearanceMutationChain.catch(() => undefined).then(async () => {
      try {
        const entry = await this.#catalog.get(sessionId);
        if (!entry || !isCloudSessionRemoteOwned(entry.status)) return;
        const current = entry.appearance ?? appearanceFromProfile(await this.#runtimeProfileForEntry(
          entry,
          entry.models?.length ? entry.models : entry.model ? [entry.model] : [],
        ));
        const appearance = { ...current, ...patch };
        const result = await writeConfigFileValidated(globalConfigPath(), patch, validateConfig);
        if (!result.ok) throw new Error(result.error);
        const recoveredAppearanceSync = entry.status === "recoverable-error"
          && entry.error?.startsWith(CLOUD_APPEARANCE_SYNC_ERROR_PREFIX) === true;
        await this.#catalog.patch(sessionId, {
          appearance,
          ...(recoveredAppearanceSync ? { status: "running", error: undefined } : {}),
        });
        if (recoveredAppearanceSync) this.#emit(sessionId, "running", "Cloud appearance synchronized");
      } catch (error) {
        const detail = `${CLOUD_APPEARANCE_SYNC_ERROR_PREFIX} ${message(error)}`;
        await this.#catalog.patch(sessionId, { status: "recoverable-error", error: detail }).catch(() => undefined);
        this.#emit(sessionId, "recoverable-error", detail);
        throw error;
      }
    });
    this.#appearanceMutationChain = run.catch(() => undefined);
    await run;
  }

  #emit(
    sessionId: string,
    status: CloudSessionStatus,
    messageText: string,
    progress?: number,
    stage?: CloudStartupStage,
    startedAt?: number,
  ): void {
    this.onStatus?.({
      sessionId,
      status,
      message: messageText,
      ...(progress === undefined ? {} : { progress }),
      ...(stage === undefined ? {} : { stage }),
      ...(startedAt === undefined ? {} : { startedAt }),
    });
  }

  async #readSettings(): Promise<CloudSettingsFileV1> {
    try {
      const value = JSON.parse(await readFile(this.#settingsPath, "utf8")) as CloudSettingsFileV1;
      if (value.schemaVersion !== 1) throw new Error();
      return {
        ...value,
        transferModelCredentials: value.transferModelCredentials !== false,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cloud settings are corrupt");
      return {
        schemaVersion: 1,
        experimentalEnabled: false,
        transferModelCredentials: true,
        lastProvider: "e2b",
        autoPauseMinutes: 10,
        deleteOnReturn: true,
        providers: { e2b: { configured: false }, vercel: { configured: false } },
        credentialBindings: [],
        allowedDomains: [],
        additionalExclusions: [],
      };
    }
  }

  async #writeSettings(value: CloudSettingsFileV1): Promise<void> {
    const parent = dirname(this.#settingsPath);
    await mkdir(parent, { recursive: true });
    const tmp = `${this.#settingsPath}.${process.pid}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const file = await open(tmp, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, this.#settingsPath);
      renamed = true;
      let directory: Awaited<ReturnType<typeof open>> | undefined;
      try {
        directory = await open(parent, "r");
        await directory.sync();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
      } finally {
        await directory?.close();
      }
    } finally {
      if (!renamed) await unlink(tmp).catch(() => undefined);
    }
  }
}

export function shouldReconnectRemoteSession(
  isRemote: boolean,
  isReady: boolean,
  activeSessionId: string | null,
  requestedSessionId: string,
): boolean {
  return !isRemote || !isReady || activeSessionId !== requestedSessionId;
}

export class CloudOperationError extends Error {
  constructor(messageText: string, readonly details: CloudFailureDetails) {
    super(messageText);
    this.name = "CloudOperationError";
  }
}

export function cloudFailureDetails(error: unknown): CloudFailureDetails | undefined {
  return error instanceof CloudOperationError ? error.details : undefined;
}

export async function rollbackProvisionalHandoff(
  abortOwnership: () => Promise<boolean>,
  destroySandbox?: () => Promise<void>,
): Promise<{ ownershipAborted: boolean; sandboxDestroyed: boolean; cleanupError?: unknown }> {
  let ownershipAborted = false;
  try { ownershipAborted = await abortOwnership(); }
  catch { return { ownershipAborted: false, sandboxDestroyed: false }; }
  if (!ownershipAborted) return { ownershipAborted: false, sandboxDestroyed: false };
  if (!destroySandbox) return { ownershipAborted: true, sandboxDestroyed: true };
  try {
    await destroySandbox();
    return { ownershipAborted: true, sandboxDestroyed: true };
  } catch (cleanupError) {
    return { ownershipAborted: true, sandboxDestroyed: false, cleanupError };
  }
}

async function stageOperation<T>(
  stage: CloudStartupStage,
  code: CloudFailureDetails["code"],
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CloudOperationError) throw error;
    throw new CloudOperationError(`Cloud ${stageLabel(stage)} failed: ${message(error)}`, {
      code,
      stage,
      retryable: true,
      diagnostic: message(error),
    });
  }
}

export async function runRequired(
  provider: SandboxProvider,
  id: string,
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  options: Parameters<SandboxProvider["run"]>[4],
  code: CloudFailureDetails["code"],
  stage: CloudStartupStage,
  redactionEnvironment?: Record<string, string>,
): Promise<CloudCommandResult> {
  let result: CloudCommandResult;
  try {
    result = await provider.run(id, command, args, env, options);
  } catch (error) {
    const diagnostic = sanitizeCloudCommandOutput(message(error), redactionEnvironment);
    throw new CloudOperationError(`Cloud ${stageLabel(stage)} failed: ${diagnostic}`, {
      code,
      stage,
      retryable: true,
      diagnostic,
    });
  }
  if (redactionEnvironment) {
    result = {
      ...result,
      stdout: sanitizeCloudCommandOutput(result.stdout, redactionEnvironment),
      stderr: sanitizeCloudCommandOutput(result.stderr, redactionEnvironment),
    };
  }
  if (result.exitCode === 0) return result;
  const diagnostic = commandDiagnostic(result);
  throw new CloudOperationError(`Cloud ${stageLabel(stage)} failed${diagnostic ? `: ${diagnosticSummary(diagnostic)}` : ` with exit code ${result.exitCode}`}`, {
    code,
    stage,
    retryable: true,
    ...(diagnostic ? { diagnostic } : {}),
  });
}

export async function stopExistingCloudRuntime(provider: SandboxProvider, sandboxId: string): Promise<void> {
  await runRequired(provider, sandboxId, "sh", ["-lc", [
    "set -eu",
    "command -v pkill >/dev/null 2>&1 || { echo 'pkill is required for Cloud runtime repair' >&2; exit 1; }",
    "pkill -TERM -f '[c]loud-agentd\\.mjs' 2>/dev/null || true",
    "if id -u vibe-workload >/dev/null 2>&1; then pkill -TERM -u \"$(id -u vibe-workload)\" 2>/dev/null || true; fi",
    "if id -u vibe-terminal >/dev/null 2>&1; then pkill -TERM -u \"$(id -u vibe-terminal)\" 2>/dev/null || true; fi",
    "sleep 1",
    "pkill -KILL -f '[c]loud-agentd\\.mjs' 2>/dev/null || true",
    "if id -u vibe-workload >/dev/null 2>&1; then pkill -KILL -u \"$(id -u vibe-workload)\" 2>/dev/null || true; fi",
    "if id -u vibe-terminal >/dev/null 2>&1; then pkill -KILL -u \"$(id -u vibe-terminal)\" 2>/dev/null || true; fi",
  ].join("; ")], undefined, {
    privileged: true,
    timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS,
  }, "legacy-session-repair-failed", "verifying");
}

export async function inspectLegacyCloudAgent(
  endpoint: string,
  accessToken: string,
  providerHeaders: Record<string, string> = {},
): Promise<{ engine: boolean; terminals: number } | null> {
  try {
    const response = await fetch(new URL("/health", endpoint), {
      headers: { ...providerHeaders, authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw legacyRepairError("The legacy Cloud runtime rejected this session's protected access token");
    }
    const payload = await response.json().catch(() => null) as { engine?: unknown; terminals?: unknown; error?: unknown } | null;
    if (!response.ok && (!payload || typeof payload.engine !== "boolean")) return null;
    if (!payload || typeof payload.engine !== "boolean") {
      throw legacyRepairError("The legacy Cloud runtime returned an invalid health response");
    }
    if (typeof payload.error === "string" && payload.error.trim()) {
      throw legacyRepairError(`The legacy Cloud runtime is not healthy: ${payload.error.trim()}`);
    }
    return {
      engine: payload.engine,
      terminals: typeof payload.terminals === "number" && Number.isSafeInteger(payload.terminals) && payload.terminals >= 0
        ? payload.terminals
        : 0,
    };
  } catch (error) {
    if (error instanceof CloudOperationError) throw error;
    if (error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError")) return null;
    throw error;
  }
}

export async function waitForLegacyEngineStopped(
  endpoint: string,
  accessToken: string,
  providerHeaders: Record<string, string> = {},
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await inspectLegacyCloudAgent(endpoint, accessToken, providerHeaders);
    if (!state?.engine) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw legacyRepairError("The legacy Cloud engine did not finish its graceful shutdown; repair was deferred without forcing it to stop");
}

async function legacyCloudAgentProcessRunning(provider: SandboxProvider, sandboxId: string): Promise<boolean> {
  const result = await provider.run(sandboxId, "sh", ["-lc", "pgrep -f '[c]loud-agentd\\.mjs' >/dev/null"], undefined, {
    privileged: true,
    timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS,
  });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw legacyRepairError(commandDiagnostic(result) || "Could not inspect the legacy Cloud agent process");
}

async function remoteDirectoryExists(provider: SandboxProvider, sandboxId: string, path: string): Promise<boolean> {
  const result = await provider.run(sandboxId, "sh", ["-lc", `test -d '${path}'`], undefined, {
    privileged: true,
    timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS,
  });
  return result.exitCode === 0;
}

async function runtimeSupportsModelEnvelope(
  provider: SandboxProvider,
  sandboxId: string,
  runtimeDirectory: string,
): Promise<boolean> {
  const result = await provider.run(sandboxId, "sh", ["-lc", "grep -q 'model-access-envelope' start.sh"], undefined, {
    privileged: true,
    cwd: runtimeDirectory,
    timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS,
  });
  return result.exitCode === 0;
}

export async function swapStagedCloudRuntime(provider: SandboxProvider, sandboxId: string, base: string): Promise<void> {
  await runRequired(provider, sandboxId, "sh", ["-lc", [
    "set -eu",
    `test -d '${base}/runtime-next'`,
    `if [ -d '${base}/runtime' ]; then if [ ! -d '${base}/runtime-previous' ]; then mv '${base}/runtime' '${base}/runtime-previous'; else rm -rf '${base}/runtime-failed'; mv '${base}/runtime' '${base}/runtime-failed'; fi; elif [ ! -d '${base}/runtime-previous' ]; then echo 'legacy-session-repair-failed: current and previous runtimes are both missing' >&2; exit 1; fi`,
    `mv '${base}/runtime-next' '${base}/runtime'`,
  ].join("; ")], undefined, {
    privileged: true,
    timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS,
  }, "legacy-session-repair-failed", "verifying");
}

async function cleanupPreviousCloudRuntime(provider: SandboxProvider, sandboxId: string, base: string): Promise<void> {
  const result = await provider.run(sandboxId, "rm", ["-rf", `${base}/runtime-previous`, `${base}/runtime-failed`], undefined, {
    privileged: true,
    timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) throw new Error(commandDiagnostic(result) || "Cloud runtime rollback cleanup failed");
}

/**
 * A local-to-cloud handoff has not crossed the ownership boundary yet, so its
 * sandbox must start clean. Reusing a same-named sandbox can reconnect to an
 * agent left running by an earlier failed attempt; that agent still owns its
 * old engine process and can report a replacement session even after the new
 * portable archive was imported successfully.
 *
 * Destroying the stale provisional sandbox is also safe when a provider create
 * timed out after succeeding remotely: the retry recreates the same isolated
 * target before any local ownership commit has occurred.
 */
export async function createFreshNamedSandbox(
  provider: SandboxProvider,
  options: CloudSandboxCreateOptions,
): Promise<CloudSandboxRecord> {
  const stale = await provider.findByName(options.name);
  if (stale) await provider.destroy(stale.id);
  return provider.create(options);
}

export async function superviseCloudAgent(
  daemon: CloudCommandHandle,
  endpoint: string,
  accessToken: string,
  providerHeaders: Record<string, string> = {},
  healthTimeoutMs = AGENT_HEALTH_TIMEOUT_MS,
  expectedEnvironmentNames: readonly string[] = [],
  expectedModels: readonly string[] = [],
): Promise<void> {
  const healthController = new AbortController();
  const exited = daemon.wait().then(
    (result) => ({ kind: "exit" as const, result }),
    (error) => ({ kind: "wait-error" as const, error }),
  );
  const healthy = waitForCloudAgent(
    endpoint,
    accessToken,
    providerHeaders,
    expectedEnvironmentNames,
    expectedModels,
    healthTimeoutMs,
    healthController.signal,
  ).then(
    () => ({ kind: "healthy" as const }),
    (error) => ({ kind: "health-error" as const, error }),
  );
  const outcome = await Promise.race([exited, healthy]);
  if (outcome.kind === "healthy") return;
  healthController.abort();
  if (outcome.kind === "health-error") {
    await daemon.kill().catch(() => undefined);
    throw outcome.error;
  }
  if (outcome.kind === "wait-error") {
    throw new CloudOperationError(`Cloud agent stopped before it became healthy: ${message(outcome.error)}`, {
      code: "daemon-exited",
      stage: "starting-agent",
      retryable: true,
      diagnostic: message(outcome.error),
    });
  }
  const diagnostic = commandDiagnostic(outcome.result);
  const diagnosticCode = diagnostic ? cloudRuntimeErrorCode(diagnostic) : "daemon-exited";
  throw new CloudOperationError(`Cloud agent exited before it became healthy${diagnostic ? `: ${diagnosticSummary(diagnostic)}` : ` with exit code ${outcome.result.exitCode}`}`, {
    code: diagnosticCode === "setup-failed" ? "daemon-exited" : diagnosticCode,
    stage: "starting-agent",
    retryable: true,
    ...(diagnostic ? { diagnostic } : {}),
  });
}

export async function awaitRemoteEngineReady<T>(daemon: CloudCommandHandle, remoteReady: Promise<T>): Promise<T> {
  const outcome = await Promise.race([
    remoteReady.then(
      (value) => ({ kind: "ready" as const, value }),
      (error) => ({ kind: "remote-error" as const, error }),
    ),
    daemon.wait().then(
      (result) => ({ kind: "exit" as const, result }),
      (error) => ({ kind: "wait-error" as const, error }),
    ),
  ]);
  if (outcome.kind === "ready") {
    try { await daemon.detach(); }
    catch (error) {
      throw new CloudOperationError(`Cloud agent connected, but startup supervision could not detach safely: ${message(error)}`, {
        code: "provider-unavailable",
        stage: "connecting",
        retryable: true,
        diagnostic: message(error),
      });
    }
    return outcome.value;
  }
  if (outcome.kind === "remote-error") throw outcome.error;
  if (outcome.kind === "wait-error") {
    throw new CloudOperationError(`Cloud agent stopped during the engine connection: ${message(outcome.error)}`, {
      code: "daemon-exited",
      stage: "connecting",
      retryable: true,
      diagnostic: message(outcome.error),
    });
  }
  const diagnostic = commandDiagnostic(outcome.result);
  throw new CloudOperationError(`Cloud agent exited during the engine connection${diagnostic ? `: ${diagnosticSummary(diagnostic)}` : ` with exit code ${outcome.result.exitCode}`}`, {
    code: "daemon-exited",
    stage: "connecting",
    retryable: true,
    ...(diagnostic ? { diagnostic } : {}),
  });
}

async function waitForRemoteFile(
  provider: SandboxProvider,
  id: string,
  path: string,
  timeoutMs: number,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const size = await provider.size(id, path);
      if (size > maxBytes) throw new Error(`Remote file exceeds the ${Math.floor(maxBytes / (1024 * 1024)) || 1} MiB safety limit`);
      const data = await provider.download(id, path);
      if (data.byteLength !== size || data.byteLength > maxBytes) throw new Error("Remote file changed while downloading");
      return data;
    } catch (error) {
      if (error instanceof Error && /safety limit|changed while downloading/.test(error.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForCloudAgent(
  endpoint: string,
  accessToken: string,
  providerHeaders: Record<string, string> = {},
  expectedEnvironmentNames: readonly string[] = [],
  expectedModels: readonly string[] = [],
  timeoutMs = AGENT_HEALTH_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<void> {
  const health = new URL("/health", endpoint);
  const deadline = Date.now() + timeoutMs;
  let lastDiagnostic = "The health endpoint did not respond";
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason;
    try {
      const response = await fetch(health, {
        headers: { ...providerHeaders, authorization: `Bearer ${accessToken}` },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
      });
      const payload = await response.json().catch(() => null) as {
        error?: unknown;
        modelAccess?: { version?: unknown; validated?: unknown; environment?: unknown; requiredModels?: unknown };
      } | null;
      if (response.ok) {
        if (payload?.modelAccess?.version !== 1 || payload.modelAccess.validated !== true) {
          throw new CloudOperationError("Cloud agent did not validate model access in the resumed engine", {
            code: "runtime-profile-mismatch",
            stage: "checking-health",
            retryable: false,
            diagnostic: "Engine model-access readiness was not confirmed",
          });
        }
        const environment = Array.isArray(payload.modelAccess.environment)
          ? payload.modelAccess.environment.filter((name): name is string => typeof name === "string")
          : [];
        const missing = expectedEnvironmentNames.filter((name) => !environment.includes(name));
        if (missing.length) {
          throw new CloudOperationError(
            `Cloud agent started without required model access: ${missing.join(", ")}`,
            {
              code: "missing-credential",
              stage: "checking-health",
              retryable: false,
              diagnostic: `Missing environment bindings: ${missing.join(", ")}`,
            },
          );
        }
        const requiredModels = Array.isArray(payload.modelAccess.requiredModels)
          ? payload.modelAccess.requiredModels.filter((model): model is string => typeof model === "string")
          : [];
        const expected = [...new Set(expectedModels)].sort();
        const actual = [...new Set(requiredModels)].sort();
        if (expected.length !== actual.length || expected.some((model, index) => model !== actual[index])) {
          throw new CloudOperationError("Cloud agent resumed with a different required-model profile", {
            code: "runtime-profile-mismatch",
            stage: "checking-health",
            retryable: false,
            diagnostic: `Expected ${expected.join(", ") || "no models"}; received ${actual.join(", ") || "no models"}`,
          });
        }
        return;
      }
      if (typeof payload?.error === "string" && payload.error.trim()) {
        const diagnostic = payload.error.trim();
        throw new CloudOperationError(`Cloud agent rejected the imported session: ${payload.error.trim()}`, {
          code: cloudRuntimeErrorCode(diagnostic),
          stage: "checking-health",
          retryable: false,
          diagnostic,
        });
      }
      lastDiagnostic = `Health endpoint returned HTTP ${response.status}`;
    } catch (error) {
      if (error instanceof CloudOperationError) throw error;
      lastDiagnostic = message(error);
    }
    if (signal?.aborted) throw signal.reason;
    const remaining = deadline - Date.now();
    if (remaining > 0) await abortableDelay(Math.min(1_000, remaining), signal);
  }
  throw new CloudOperationError("Cloud agent did not become healthy in time", {
    code: "health-timeout",
    stage: "checking-health",
    retryable: true,
    diagnostic: lastDiagnostic,
  });
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, delayMs));
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    const abort = () => { clearTimeout(timer); cleanup(); reject(signal.reason); };
    function cleanup() { signal?.removeEventListener("abort", abort); }
    function done() { cleanup(); resolve(); }
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function retryTransient<T>(
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
  delays = [1_000, 2_000, 4_000],
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await withAbortDeadline(operation, timeoutMs, `${label} timed out`);
    } catch (error) {
      lastError = error;
      if (attempt === delays.length || !isTransientCloudError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
  throw lastError;
}

function withAbortDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(timeoutMessage)), timeoutMs);
  timeout.unref?.();
  return operation(controller.signal).finally(() => clearTimeout(timeout));
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error(timeoutMessage)), timeoutMs);
    timeout.unref?.();
    operation.then(
      (value) => { clearTimeout(timeout); resolvePromise(value); },
      (error) => { clearTimeout(timeout); rejectPromise(error); },
    );
  });
}

function isTransientCloudError(error: unknown): boolean {
  return /\b(?:429|5\d\d)\b|timed? ?out|econn|etimedout|temporar|unavailable|rate.?limit|socket|network/i.test(message(error));
}

function commandDiagnostic(result: CloudCommandResult): string {
  return (result.stderr.trim() || result.stdout.trim()).slice(-64 * 1024);
}

function diagnosticSummary(value: string): string {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const explicitError = [...lines].reverse().find((line) => /^(?:Error|[A-Za-z]+Error)(?:\s*\[[^\]]+\])?:\s+/.test(line));
  return (explicitError ?? lines.at(-1) ?? "unknown error").slice(0, 500);
}

function stageLabel(stage: CloudStartupStage): string {
  return ({
    waiting: "engine-idle wait",
    packaging: "workspace packaging",
    creating: "sandbox creation",
    uploading: "upload",
    verifying: "runtime verification",
    restoring: "workspace restore",
    "starting-agent": "agent startup",
    "checking-health": "health check",
    connecting: "connection",
  })[stage];
}

function progressForStage(stage: CloudStartupStage): number {
  return ({
    waiting: 0.05,
    packaging: 0.14,
    creating: 0.26,
    uploading: 0.36,
    verifying: 0.48,
    restoring: 0.61,
    "starting-agent": 0.72,
    "checking-health": 0.82,
    connecting: 0.91,
  })[stage];
}

function appearanceFromProfile(profile: CloudRuntimeProfileV1): NonNullable<CloudSessionCatalogEntry["appearance"]> {
  return {
    theme: profile.theme,
    accentColor: profile.accentColor ?? "",
    details: profile.details,
  };
}

function legacyRepairError(messageText: string): CloudOperationError {
  return new CloudOperationError(messageText, {
    code: "legacy-session-repair-failed",
    stage: "verifying",
    retryable: false,
    diagnostic: messageText,
  });
}

function cloudRuntimeErrorCode(value: string): CloudFailureDetails["code"] {
  if (value.includes("missing-credential:")) return "missing-credential";
  if (value.includes("invalid-credential:")) return "invalid-credential";
  if (value.includes("runtime-profile-mismatch:")) return "runtime-profile-mismatch";
  if (value.includes("legacy-session-repair-failed:")) return "legacy-session-repair-failed";
  return "setup-failed";
}

async function findRuntimeArtifact(revision: string, runtime: CloudRuntimeLocation): Promise<{ path: string; data: Buffer }> {
  const roots = runtime.isPackaged
    ? [join(runtime.resourcesPath, "cloud-runtime")]
    : [
        ...(process.env.VIBE_CODR_ROOT
          ? [resolve(process.env.VIBE_CODR_ROOT, "dist", "cloud-runtime")]
          : []),
        resolve(runtime.appPath, "..", "..", "dist", "cloud-runtime"),
        resolve(runtime.appPath, "..", "vibe-codr", "dist", "cloud-runtime"),
      ];
  for (const root of roots) {
    try {
      const name = (await readdir(root)).find((file) => file === `vibe-cloud-runtime-${revision.slice(0, 12)}.tar.gz`);
      if (!name) continue;
      const path = join(root, name);
      const data = await readFile(path);
      const expected = (await readFile(`${path}.sha256`, "utf8")).trim().split(/\s+/)[0];
      const actual = createHash("sha256").update(data).digest("hex");
      if (actual !== expected) throw new Error("Cloud runtime checksum mismatch");
      return { path, data };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("The revision-locked cloud runtime is missing. Run npm run build:cloud-runtime in vibe-codr.");
}

async function engineRevision(runtime: CloudRuntimeLocation): Promise<string> {
  const paths = runtime.isPackaged
    ? [join(runtime.resourcesPath, "app.asar", "ENGINE_COMMIT"), join(runtime.resourcesPath, "ENGINE_COMMIT")]
    : [resolve(runtime.appPath, "ENGINE_COMMIT")];
  for (const path of paths) {
    try { return (await readFile(path, "utf8")).trim(); } catch { /* next */ }
  }
  throw new Error("ENGINE_COMMIT is missing from the desktop package");
}

function message(error: unknown): string {
  return sanitizeCloudCommandOutput(error instanceof Error ? error.message : String(error));
}
