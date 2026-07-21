import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ExternalCapabilityResolution, PendingCapabilityRequest, ToolDefinition } from "@vibe/shared";

export type ExternalCapabilityRequester = (request: PendingCapabilityRequest) => Promise<ExternalCapabilityResolution>;

const input = z.object({
  action: z.enum(["open-url", "open-path", "open-application", "reveal-path"]),
  target: z.string().min(1).max(4_096).refine((value) => !value.includes("\0"), "NUL is not allowed"),
}).strict();

/** Machine-bound macOS action. Execution is deliberately delegated through the
 * durable external-capability boundary; cloud runtimes never gain local shell. */
export function macosTool(request: ExternalCapabilityRequester): ToolDefinition<z.infer<typeof input>> {
  return {
    name: "macos",
    description: "Ask the user's Mac to open a URL, path, application, or reveal a path. The action pauses for explicit local approval.",
    inputSchema: input,
    readOnly: false,
    concurrencySafe: false,
    modes: ["execute"],
    async execute(arguments_, context) {
      const pending: PendingCapabilityRequest = {
        id: `cap_${randomUUID()}`,
        integration: "macos",
        toolName: "macos",
        arguments: { action: arguments_.action, target: arguments_.target },
        approvalScope: "once",
        originatingTurn: context.toolCallId,
        status: "pending",
        createdAt: Date.now(),
      };
      const resolution = await request(pending);
      if (resolution.status === "denied") return { output: resolution.error ?? "The Mac action was denied", isError: true };
      return { output: { status: "resolved", result: resolution.result ?? null } };
    },
  };
}
