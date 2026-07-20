import type { SessionNotification, SessionUpdate } from "@vibe/acp/client";

export interface VibeChatSink {
  markdown(text: string): void;
  progress(text: string): void;
}

export interface PendingDecision {
  sessionId: string;
  pendingId: string;
  event: Record<string, unknown>;
}

export class AcpSessionPresenter {
  sink: VibeChatSink | undefined;
  lastDiff: { path: string; diff: string } | undefined;
  onDecision: ((decision: PendingDecision) => void | Promise<void>) | undefined;

  async handle(notification: SessionNotification): Promise<void> {
    const update = notification.update;
    const meta = update._meta as Record<string, unknown> | null | undefined;
    const event = meta?.["vibe/event"] as Record<string, unknown> | undefined;
    const pendingId = meta?.["vibe/pendingDecisionId"];
    if (event?.type === "file-changed" && typeof event.path === "string" && typeof event.diff === "string") {
      this.lastDiff = { path: event.path, diff: event.diff };
    }
    if (typeof pendingId === "string" && event) {
      await this.onDecision?.({ sessionId: notification.sessionId, pendingId, event });
    }
    this.render(update);
  }

  render(update: SessionUpdate): void {
    if (!this.sink) return;
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      this.sink.markdown(update.content.text);
    } else if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text" && update.content.text) {
      this.sink.progress(update.content.text);
    } else if (update.sessionUpdate === "tool_call") {
      this.sink.progress(`${update.title}…`);
    } else if (update.sessionUpdate === "tool_call_update" && update.status) {
      this.sink.progress(`${update.title ?? "Tool"}: ${update.status}`);
    } else if (update.sessionUpdate === "plan") {
      const lines = update.entries.map((entry) => `- [${entry.status === "completed" ? "x" : " "}] ${entry.content}`);
      this.sink.markdown(`\n**Plan**\n${lines.join("\n")}\n`);
    }
  }
}
