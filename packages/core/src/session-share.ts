import { homedir } from "node:os";
import type { PersistedSession } from "./store.ts";
import { redactCrash } from "./crash.ts";

export interface SessionShareOptions {
  cwd: string;
  title?: string;
}

/** Static, script-free, redacted local share. Reasoning, tool arguments, and
 * tool results are deliberately represented only as content-free milestones. */
export function renderSessionShareHtml(session: PersistedSession, options: SessionShareOptions): string {
  const title = options.title ?? session.meta.title ?? "Vibe Codr session";
  const rows = session.history.slice(0, 20_000).map((message) => {
    const parts: string[] = [];
    for (const part of message.parts) {
      if (part.type === "text") parts.push(escapeHtml(redactText(part.text, options.cwd)));
      else if (part.type === "tool-call") parts.push(`<em>Tool started: ${escapeHtml(part.toolName)} (arguments omitted)</em>`);
      else if (part.type === "tool-result") parts.push(`<em>Tool finished: ${escapeHtml(part.toolName)} (output omitted)</em>`);
      // Reasoning is never shareable from this path.
    }
    if (!parts.length) return "";
    const role = ["user", "assistant", "system", "tool"].includes(message.role) ? message.role : "message";
    return `<article class="message ${role}"><header>${escapeHtml(role)}</header><div>${parts.join("<br>")}</div></article>`;
  }).filter(Boolean).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${escapeHtml(title)}</title><style>
:root{color-scheme:light dark;font:15px/1.55 system-ui,sans-serif}body{max-width:820px;margin:40px auto;padding:0 20px;background:#111;color:#eee}h1{font-size:22px}.meta{color:#999}.message{margin:16px 0;padding:14px 16px;border:1px solid #333;border-radius:10px;white-space:pre-wrap;overflow-wrap:anywhere}.message header{text-transform:uppercase;font-size:11px;letter-spacing:.08em;color:#999;margin-bottom:8px}.user{background:#1b1b1b}.assistant{background:#15191d}em{color:#aaa}@media(prefers-color-scheme:light){body{background:#fff;color:#171717}.message{border-color:#ddd}.user{background:#f5f5f5}.assistant{background:#f8fafc}}
</style></head><body><h1>${escapeHtml(title)}</h1><p class="meta">Local redacted export · ${new Date(session.meta.updatedAt).toISOString()} · reasoning and tool content omitted</p>${rows}</body></html>\n`;
}

export function redactSessionShareText(text: string, cwd: string): string {
  return redactText(text, cwd);
}

function redactText(text: string, cwd: string): string {
  let value = String(redactCrash(text));
  const roots: Array<[string, string]> = [[cwd, "[workspace]"], [homedir(), "[home]"]];
  for (const [root, replacement] of roots.sort((a, b) => b[0].length - a[0].length)) {
    if (!root) continue;
    value = value.replace(new RegExp(escapeRegExp(root), "g"), replacement);
  }
  value = value.replace(/\/Users\/[^/\s]+/g, "[home]");
  value = value.replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, "[home]");
  return value.slice(0, 200_000);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
