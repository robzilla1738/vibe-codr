import type { EngineCommand } from "../shared/commands";
import type { HostEventFrame, HostRpcParams, RpcMethod } from "../shared/protocol";
import type { PerformancePhaseSample } from "../shared/performance";
import type { EngineSnapshot } from "../shared/types";
import type { EngineStartOptions } from "./engine-bridge";

export type EngineTransportEventHandler = (event: unknown, frame?: Omit<HostEventFrame, "type" | "event">) => void;
export type EngineTransportFatalHandler = (message: string) => void;
export type EngineTransportReadyHandler = (sessionId: string, info?: {
  protocolVersion: number;
  engineRevision: string;
  capabilities: string[];
  hostInstanceId: string;
}) => void;
export type EngineTransportResyncHandler = (snapshot: EngineSnapshot) => void;

/** Provider-neutral presentation-shell boundary. Local child-process and remote
 * WebSocket transports carry the exact same host command/event protocol. */
export interface EngineTransport {
  readonly isRunning: boolean;
  readonly isReady: boolean;
  onEvent: EngineTransportEventHandler | null;
  onFatal: EngineTransportFatalHandler | null;
  onReady: EngineTransportReadyHandler | null;
  onResync: EngineTransportResyncHandler | null;
  onPerformancePhase: ((sample: PerformancePhaseSample) => void) | null;
  start(options: EngineStartOptions): Promise<string>;
  stop(): Promise<void>;
  disposeForQuit(): Promise<void>;
  send(command: EngineCommand): void;
  rpc(method: RpcMethod, params?: HostRpcParams): Promise<unknown>;
}
