import type { CloudProviderId } from "./cloud";

export interface ParsedHandoffCommand {
  target?: "cloud" | "local";
  provider?: CloudProviderId;
  instruction?: string;
}

export type HandoffCommandAction = "cloud" | "local" | "already-cloud" | "already-local";

export function resolveHandoffCommandAction(
  command: ParsedHandoffCommand,
  cloudOwned: boolean,
): HandoffCommandAction {
  const target = command.target ?? (cloudOwned ? "local" : "cloud");
  if (target === "cloud") return cloudOwned ? "already-cloud" : "cloud";
  return cloudOwned ? "local" : "already-local";
}

export function parseHandoffCommand(value: string): ParsedHandoffCommand | null {
  const match = value.trim().match(/^\/handoff(?:\s+(cloud|local))?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const target = match[1]?.toLowerCase() as "cloud" | "local" | undefined;
  let rest = match[2]?.trim() ?? "";
  let provider: CloudProviderId | undefined;
  if (target !== "local") {
    const providerMatch = rest.match(/^(e2b|vercel)(?:\s+([\s\S]*))?$/i);
    if (providerMatch) {
      provider = providerMatch[1]!.toLowerCase() as CloudProviderId;
      rest = providerMatch[2]?.trim() ?? "";
    }
  }
  return {
    ...(target ? { target } : {}),
    ...(provider ? { provider } : {}),
    ...(rest ? { instruction: rest } : {}),
  };
}
