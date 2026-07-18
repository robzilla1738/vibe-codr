import type { EngineCommand } from "@shared/commands";

export const MOBILE_COMPOSER_MAX_ATTACHMENTS = 8;

export interface MobileComposerAttachment {
  id: string;
  name: string;
  path: string;
  token: string;
  size: number;
  mimeType?: string;
}

export function appendAttachmentTokens(commands: EngineCommand[], attachments: readonly MobileComposerAttachment[]): EngineCommand[] {
  if (attachments.length === 0) return commands;
  const tokens = attachments.map((attachment) => attachment.token).join(" ");
  return commands.map((command) => command.type === "submit-prompt"
    ? { ...command, text: [command.text, tokens].filter(Boolean).join(" ") }
    : command);
}
