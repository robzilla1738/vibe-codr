#!/usr/bin/env bun
/**
 * vibecodr-engine-host — NDJSON stdio bridge for the macOS SwiftUI app.
 *
 * Speaks the protocol documented in packages/macos-bridge/src/protocol.ts.
 * The Swift app spawns this process and exchanges EngineCommand / UIEvent
 * over stdin/stdout as newline-delimited JSON.
 */
import { runHost } from "../src/host.ts";

await runHost();
