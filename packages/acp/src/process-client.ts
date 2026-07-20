import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  ACP_VIBE_METHODS,
  VibeAcpCapabilitiesResponseSchema,
  VibeAcpCommandResponseSchema,
  VibeAcpDecisionResponseSchema,
  VibeAcpReplayResponseSchema,
  VibeAcpSnapshotResponseSchema,
  type ApiV1Command,
  type ApiV1Cursor,
  type ApiV1DecisionRequest,
} from "@vibe/protocol";
import { boundedNdJsonStream } from "./bounded-stream.ts";

export type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";

export interface AcpProcessClientOptions {
  cwd: string;
  executable?: string;
  onUpdate?: (notification: SessionNotification) => void | Promise<void>;
  onStderr?: (text: string) => void;
  spawnProcess?: typeof spawn;
}

export class AcpProcessClient {
  readonly #options: AcpProcessClientOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #connection: acp.ClientConnection | undefined;

  constructor(options: AcpProcessClientOptions) { this.#options = options; }

  async start(): Promise<this> {
    if (this.#connection) return this;
    const spawnProcess = this.#options.spawnProcess ?? spawn;
    const child = spawnProcess(this.#options.executable ?? "vibe", ["acp", "--cwd", this.#options.cwd], {
      cwd: this.#options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.#child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.#options.onStderr?.(chunk));
    const app = acp.client({ name: "vibe-vscode" })
      .onNotification("session/update", async ({ params }) => { await this.#options.onUpdate?.(params); });
    const stream = boundedNdJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    this.#connection = app.connect(stream);
    await this.#connection.agent.request("initialize", {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "vibe-vscode", version: "0.6.14" },
    });
    return this;
  }

  get agent(): acp.ClientContext {
    if (!this.#connection) throw new Error("ACP client is not started");
    return this.#connection.agent;
  }

  async createSession(): Promise<string> {
    return (await this.agent.request("session/new", { cwd: this.#options.cwd, mcpServers: [] })).sessionId;
  }
  async loadSession(sessionId: string): Promise<void> {
    await this.agent.request("session/load", { sessionId, cwd: this.#options.cwd, mcpServers: [] });
  }
  async resumeSession(sessionId: string): Promise<void> {
    await this.agent.request("session/resume", { sessionId, cwd: this.#options.cwd, mcpServers: [] });
  }
  async listSessions() {
    return (await this.agent.request("session/list", { cwd: this.#options.cwd })).sessions;
  }
  prompt(sessionId: string, text: string) {
    return this.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  }
  cancel(sessionId: string): Promise<void> {
    return this.agent.notify("session/cancel", { sessionId });
  }
  async capabilities() {
    return VibeAcpCapabilitiesResponseSchema.parse(await this.agent.request(ACP_VIBE_METHODS.capabilities, {}));
  }
  async command(sessionId: string, command: ApiV1Command) {
    return VibeAcpCommandResponseSchema.parse(await this.agent.request(ACP_VIBE_METHODS.command, { sessionId, command }));
  }
  async decision(sessionId: string, request: ApiV1DecisionRequest) {
    return VibeAcpDecisionResponseSchema.parse(await this.agent.request(ACP_VIBE_METHODS.decision, { sessionId, request }));
  }
  async snapshot(sessionId: string) {
    return VibeAcpSnapshotResponseSchema.parse(await this.agent.request(ACP_VIBE_METHODS.snapshot, { sessionId }));
  }
  async replay(sessionId: string, cursor?: ApiV1Cursor) {
    return VibeAcpReplayResponseSchema.parse(await this.agent.request(ACP_VIBE_METHODS.replay, { sessionId, ...(cursor ? { cursor } : {}) }));
  }

  async dispose(): Promise<void> {
    this.#connection?.close();
    this.#connection = undefined;
    const child = this.#child;
    this.#child = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
  }
}
