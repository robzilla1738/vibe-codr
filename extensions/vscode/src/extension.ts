import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { AcpProcessClient } from "@vibe/acp/client";
import type { ApiV1Decision } from "@vibe/sdk";
import { AcpSessionPresenter, type PendingDecision } from "./acp-session.ts";

let client: AcpProcessClient | undefined;
let sessionId: string | undefined;
const presenter = new AcpSessionPresenter();

async function getClient(): Promise<AcpProcessClient> {
  if (client) return client;
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) throw new Error("Open a workspace folder before starting Vibe Codr");
  const executable = vscode.workspace.getConfiguration("vibe").get<string>("executable") ?? "vibe";
  client = await new AcpProcessClient({
    cwd,
    executable,
    onUpdate: (notification) => presenter.handle(notification),
    onStderr: (text) => console.error(`[vibe-acp] ${text.trimEnd()}`),
  }).start();
  await client.capabilities();
  presenter.onDecision = resolveDecision;
  return client;
}

async function activeSession(): Promise<{ client: AcpProcessClient; sessionId: string }> {
  const current = await getClient();
  sessionId ??= await current.createSession();
  return { client: current, sessionId };
}

async function resolveDecision(pending: PendingDecision): Promise<void> {
  const current = await getClient();
  const event = pending.event;
  let decision: ApiV1Decision | undefined;
  if (event.type === "permission-request") {
    const choice = await vscode.window.showQuickPick(["Allow once", "Always allow", "Deny"], { title: String(event.toolName ?? "Permission request") });
    if (!choice) return;
    decision = { kind: "permission", id: pending.pendingId, decision: choice === "Allow once" ? "once" : choice === "Always allow" ? "always" : "deny" };
  } else if (event.type === "question-request") {
    const question = event.question as { question?: string; choices?: Array<{ label: string }> };
    const choices = question.choices?.map((choice) => choice.label) ?? [];
    const answer = choices.length
      ? await vscode.window.showQuickPick(choices, { title: question.question })
      : await vscode.window.showInputBox({ title: question.question });
    if (!answer) return;
    decision = { kind: "question", id: pending.pendingId, answers: [answer] };
  } else if (event.type === "plan-presented") {
    const choice = await vscode.window.showQuickPick(["Accept", "Keep planning"], { title: "Review Vibe plan" });
    if (!choice) return;
    decision = { kind: "plan", id: pending.pendingId, decision: choice === "Accept" ? "accept" : "keep-planning" };
  }
  if (decision) await current.decision(pending.sessionId, { idempotencyKey: randomUUID(), decision });
}

export function activate(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant("vibe.chat", async (request, _chatContext, response, token) => {
    const active = await activeSession();
    presenter.sink = { markdown: (text) => response.markdown(text), progress: (text) => response.progress(text) };
    const cancellation = token.onCancellationRequested(() => { void active.client.cancel(active.sessionId); });
    try { await active.client.prompt(active.sessionId, request.prompt); }
    finally { cancellation.dispose(); presenter.sink = undefined; }
  });
  context.subscriptions.push(
    participant,
    vscode.commands.registerCommand("vibe.newSession", async () => { sessionId = await (await getClient()).createSession(); }),
    vscode.commands.registerCommand("vibe.continueSession", async () => {
      const current = await getClient();
      const sessions = await current.listSessions();
      const picked = await vscode.window.showQuickPick(sessions.map((session) => ({ label: session.title ?? session.sessionId, description: session.updatedAt ?? undefined, sessionId: session.sessionId })), { title: "Continue Vibe session" });
      if (picked) { await current.resumeSession(picked.sessionId); sessionId = picked.sessionId; }
    }),
    vscode.commands.registerCommand("vibe.reviewDiff", async () => {
      if (!presenter.lastDiff) return void vscode.window.showInformationMessage("Vibe has not reported a diff yet.");
      const document = await vscode.workspace.openTextDocument({ content: `--- ${presenter.lastDiff.path}\n+++ ${presenter.lastDiff.path}\n${presenter.lastDiff.diff}`, language: "diff" });
      await vscode.window.showTextDocument(document, { preview: true });
    }),
    { dispose: () => { void client?.dispose(); client = undefined; sessionId = undefined; } },
  );
}

export function deactivate(): Promise<void> | undefined { return client?.dispose(); }
