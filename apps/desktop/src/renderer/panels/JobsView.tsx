import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { belowBreakpoint } from "../../shared/breakpoints";
import { jobsForDisplay } from "../../shared/live-list-bounds";
import type { LocalRuntimeLaunchQueueItem } from "../../shared/local-runtime";
import type { ActivityInfo, JobInfo } from "../../shared/types";
import { CopyButton } from "../CopyButton";
import { IconLink } from "../icons";
import { ActivityPanelHeader } from "../layout/ActivityPanelHeader";
import { ExternalLink } from "../primitives";

function statusLabel(status: JobInfo["status"]): string {
  if (status === "running") return "Running";
  if (status === "killed") return "Killed";
  return "Exited";
}

function focusableIn(root: ParentNode | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => {
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  });
}

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

/** Render job output with clickable http(s) URLs. */
function JobOutputText({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <ExternalLink key={`url-${index}`} href={part} className="job-output-link">
            {part}
          </ExternalLink>
        ) : (
          <span key={`t-${index}`}>{part}</span>
        ),
      )}
    </>
  );
}

/** Live output pane — follows new tails unless the user scrolls up. */
function JobTerminal({
  jobId,
  status,
  output,
}: {
  jobId: string;
  status: JobInfo["status"];
  output: string;
}) {
  const scrollerRef = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  const running = status === "running";

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !follow) return;
    el.scrollTop = el.scrollHeight;
  }, [output, follow, jobId]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setFollow(distance < 28);
  };

  return (
    <div className={`job-terminal${running ? " is-live" : ""}`}>
      <div className="job-terminal-bar">
        <span className="job-terminal-label">
          {running ? "Live output" : "Output"}
          {running && follow ? <span className="job-terminal-follow">following</span> : null}
          {running && !follow ? (
            <button
              type="button"
              className="job-terminal-resume"
              onClick={() => {
                setFollow(true);
                const el = scrollerRef.current;
                if (el) el.scrollTop = el.scrollHeight;
              }}
            >
              Jump to latest
            </button>
          ) : null}
        </span>
        {output ? <CopyButton text={output} label="Copy output" /> : null}
      </div>
      <pre
        ref={scrollerRef}
        className="job-output"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-scrollable live output region
        tabIndex={0}
        aria-label={running ? "Live job output" : "Job output"}
        aria-live={running ? "polite" : undefined}
        aria-relevant={running ? "additions text" : undefined}
        onScroll={onScroll}
      >
        {output ? (
          <JobOutputText text={output} />
        ) : (
          <span className="job-output-empty">
            {running ? "Waiting for output…" : "No output captured."}
          </span>
        )}
        {running ? <span className="job-output-cursor" aria-hidden /> : null}
      </pre>
    </div>
  );
}

export function JobsView({
  jobs,
  activities = [],
  launchQueue = [],
  totalCount = jobs.length,
  onClose,
  onCancelActivity,
  onCancelLaunch,
}: {
  jobs: JobInfo[];
  activities?: ActivityInfo[];
  launchQueue?: LocalRuntimeLaunchQueueItem[];
  totalCount?: number;
  onClose?: () => void;
  onCancelActivity?: (id: string) => void;
  onCancelLaunch?: (id: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isDrawer, setIsDrawer] = useState(() => belowBreakpoint("compact"));

  useEffect(() => {
    const onResize = () => setIsDrawer(belowBreakpoint("compact"));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !isDrawer) return;
    // Capture the element that opened the drawer (e.g. the Jobs toggle) before
    // moving focus inside, so we can restore it on close (I47 — no focus orphan).
    const trigger = document.activeElement as HTMLElement | null;
    const close = root.querySelector<HTMLButtonElement>(".sidebar-close");
    (close ?? root).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const targets = focusableIn(root);
      if (targets.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const index = active ? targets.indexOf(active) : -1;
      if (index < 0) return;
      if (event.shiftKey && index === 0) {
        event.preventDefault();
        targets.at(-1)?.focus();
      } else if (!event.shiftKey && index === targets.length - 1) {
        event.preventDefault();
        targets[0]?.focus();
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Node | null;
      if (!target || root.contains(target)) return;
      const targets = focusableIn(root);
      (targets[0] ?? root).focus();
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
      // Restore focus to the opener on dismiss so keyboard users aren't orphaned.
      trigger?.focus();
    };
  }, [isDrawer]);

  const visibleJobs = jobsForDisplay(jobs);
  const orchestrationActivities = activities.filter((activity) => activity.kind !== "shell").slice(-100);
  const combinedTotal = jobs.length + orchestrationActivities.length + launchQueue.length;

  const heading = onClose ? (
    <ActivityPanelHeader
      titleId="jobs-panel-title"
      title="Background jobs"
      subtitle={combinedTotal === 0
        ? "None yet"
        : `${combinedTotal} ${combinedTotal === 1 ? "activity" : "activities"}`}
      onClose={onClose}
      closeLabel="Close jobs"
    />
  ) : null;

  if (combinedTotal === 0) {
    return (
      <div
        ref={rootRef}
        className="jobs-view"
        tabIndex={-1}
        aria-labelledby="jobs-panel-title"
      >
        {heading}
        <div className="jobs-empty">
          <p>
            Background commands, subagents, task batches, and monitors appear here.
            Output and status update while work is running.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="jobs-view"
      tabIndex={-1}
      aria-labelledby="jobs-panel-title"
      aria-label={`Background jobs and launches, ${combinedTotal} total`}
    >
      {heading}
      <div className="jobs-list">
        {launchQueue.map((request) => (
          <article key={request.id} className="job-card is-queued" aria-labelledby={`launch-label-${request.id}`}>
            <div className="job-header">
              <span className="job-status job-status-queued">Queued · {request.position}</span>
              <span className="job-command" id={`launch-label-${request.id}`}>
                Open {runtimeProjectTitle(request.cwd)}{request.sessionId ? " session" : " workspace"}
              </span>
              {onCancelLaunch ? (
                <button type="button" className="chip" onClick={() => onCancelLaunch(request.id)}>Cancel</button>
              ) : null}
            </div>
            <p className="job-queue-note">Waiting for a protected local runtime slot.</p>
          </article>
        ))}
        {orchestrationActivities.map((activity) => (
          <article
            key={activity.id}
            className={`job-card${activity.status === "running" ? " is-running" : ""}`}
            aria-labelledby={`activity-label-${activity.id}`}
          >
            <div className="job-header">
              <span className={`job-status job-status-${activity.status === "cancelled" ? "killed" : activity.status === "running" ? "running" : "exited"}`}>
                {activity.kind} · {activity.status}
              </span>
              <span className="job-command" id={`activity-label-${activity.id}`}>{activity.label}</span>
              {activity.status === "running" && onCancelActivity ? (
                <button type="button" className="chip" onClick={() => onCancelActivity(activity.id)}>Stop</button>
              ) : null}
            </div>
            {activity.metrics ? (
              <div className="job-links">
                {activity.metrics.turns != null ? <span>{activity.metrics.turns} turns</span> : null}
                {activity.metrics.toolCalls != null ? <span>{activity.metrics.toolCalls} tools</span> : null}
                {activity.metrics.inputTokens != null ? <span>{activity.metrics.inputTokens.toLocaleString()} in</span> : null}
                {activity.metrics.outputTokens != null ? <span>{activity.metrics.outputTokens.toLocaleString()} out</span> : null}
              </div>
            ) : null}
            <JobTerminal
              jobId={activity.id}
              status={activity.status === "running" ? "running" : activity.status === "cancelled" ? "killed" : "exited"}
              output={activity.outputTail || activity.summary || ""}
            />
          </article>
        ))}
        {totalCount > visibleJobs.items.length ? (
          <p className="jobs-limit-note">
            Showing {visibleJobs.items.length} entries · {totalCount - visibleJobs.items.length} older entries omitted
          </p>
        ) : null}
        {visibleJobs.items.map((j) => (
          <article
            key={j.id}
            className={`job-card${j.status === "running" ? " is-running" : ""}`}
            aria-labelledby={`job-command-${j.id}`}
          >
            <div className="job-header">
              <span
                className={`job-status job-status-${j.status}`}
                aria-label={`Status ${statusLabel(j.status)}`}
              >
                {statusLabel(j.status)}
              </span>
              <span className="job-command" id={`job-command-${j.id}`}>
                {j.command}
              </span>
              {j.status === "running" && j.pid != null ? (
                <span className="job-pid">pid {j.pid}</span>
              ) : null}
              {j.exitCode != null && j.status !== "running" ? (
                <span className="job-exit">exit {j.exitCode}</span>
              ) : null}
            </div>
            {j.servers.length > 0 ? (
              <div className="job-links" aria-label="Detected server URLs">
                {j.servers.map((server) => (
                  <ExternalLink key={server} href={server}>
                    <IconLink size={12} />
                    {server}
                  </ExternalLink>
                ))}
              </div>
            ) : null}
            <JobTerminal jobId={j.id} status={j.status} output={j.outputTail} />
          </article>
        ))}
      </div>
    </div>
  );
}

function runtimeProjectTitle(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) || "project";
}
