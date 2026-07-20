import type {
  LocalRuntimeNotificationKind,
  LocalRuntimeNotificationTarget,
  LocalRuntimeNotificationTransition,
} from "../shared/local-runtime";

export interface NativeNotificationPayload {
  title: string;
  body: string;
  silent: boolean;
}

export interface NativeNotificationAdapter {
  isSupported(): boolean;
  show(payload: NativeNotificationPayload, onClick: () => void): void;
}

export interface NotificationTargetLabels {
  projectTitle: string;
  sessionTitle: string;
}

const BODY_COPY: Record<LocalRuntimeNotificationKind, string> = {
  permission: "needs permission",
  question: "has a question",
  "plan-review": "has a plan to review",
  failure: "needs attention",
  completed: "finished",
};

/** Converts content-free runtime transitions into private native notifications.
 * The adapter is injected so unit tests never touch the OS notification center. */
export class LocalRuntimeNotificationRouter {
  readonly #seen = new Map<string, true>();

  constructor(private readonly options: {
    adapter: NativeNotificationAdapter;
    labelsFor: (target: LocalRuntimeNotificationTarget) => NotificationTargetLabels;
    activate: (target: LocalRuntimeNotificationTarget) => void;
    maxDedupeEntries?: number;
  }) {}

  observe(transition: LocalRuntimeNotificationTransition): void {
    const target = { cwd: transition.cwd, sessionId: transition.sessionId };
    const key = `${transition.cwd}\0${transition.sessionId}\0${transition.kind}\0${transition.transitionId}`;
    if (this.#seen.has(key)) return;
    this.#remember(key);
    try {
      if (!this.options.adapter.isSupported()) return;
      const labels = this.options.labelsFor(target);
      const projectTitle = safeLabel(labels.projectTitle, "Project");
      const sessionTitle = safeLabel(labels.sessionTitle, "Background session");
      this.options.adapter.show({
        title: "Vibe Codr",
        body: `${projectTitle} · ${sessionTitle} ${BODY_COPY[transition.kind]}`,
        silent: false,
      }, () => this.options.activate(target));
    } catch {
      // OS notification support is best-effort and must never break the runtime event path.
    }
  }

  #remember(key: string): void {
    this.#seen.set(key, true);
    const max = Math.max(16, this.options.maxDedupeEntries ?? 512);
    while (this.#seen.size > max) {
      const oldest = this.#seen.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#seen.delete(oldest);
    }
  }
}

function safeLabel(value: string, fallback: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return (clean || fallback).slice(0, 80);
}
