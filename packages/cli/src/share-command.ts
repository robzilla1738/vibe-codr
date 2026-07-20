import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderSessionShareHtml, SessionStore } from "@vibe/core";

export async function runShareCommand(options: {
  cwd: string;
  sessionId?: string;
  output?: string;
}): Promise<{ path: string; sessionId: string }> {
  const store = new SessionStore(options.cwd);
  const sessionId = options.sessionId ?? await store.latestId();
  if (!sessionId) throw new Error("No saved session is available to share");
  const session = await store.load(sessionId);
  if (!session) throw new Error("Saved session was not found");
  const path = resolve(options.output ?? `vibe-session-${sessionId}.html`);
  const html = renderSessionShareHtml(session, { cwd: options.cwd });
  await writeFile(path, html, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
  return { path, sessionId };
}
