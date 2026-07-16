import { type ReactNode, useLayoutEffect } from "react";
import type { WorkspaceDockTarget } from "./WorkspaceDock";

export type ActivitySidebarTarget = Exclude<WorkspaceDockTarget, "files">;

const TABS: Array<{ target: ActivitySidebarTarget; label: string }> = [
  { target: "session", label: "Session" },
  { target: "changes", label: "Changes" },
  { target: "git", label: "Git" },
  { target: "terminal", label: "Terminal" },
  { target: "jobs", label: "Jobs" },
];

export function ActivitySidebar({
  active,
  closing = false,
  changedCount,
  jobCount,
  onSelect,
  onClose,
  children,
}: {
  active: ActivitySidebarTarget;
  closing?: boolean;
  changedCount: number;
  jobCount: number;
  onSelect: (target: ActivitySidebarTarget) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const inTextEntry =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;
      if (inTextEntry) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    // Bubble so nested controls can consume Escape before the sidebar does.
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <aside
      className={`activity-sidebar${closing ? " is-closing" : ""}`}
      data-active={active}
      aria-label="Workspace tools"
      aria-hidden={closing || undefined}
      inert={closing}
    >
      <nav className="activity-sidebar-tabs" aria-label="Activity sidebar views">
        {TABS.map((tab) => {
          const count = tab.target === "changes"
            ? changedCount
            : tab.target === "jobs"
              ? jobCount
              : 0;
          return (
            <button
              key={tab.target}
              type="button"
              className={`activity-sidebar-tab${active === tab.target ? " is-active" : ""}`}
              aria-current={active === tab.target ? "page" : undefined}
              onClick={() => onSelect(tab.target)}
            >
              <span>{tab.label}</span>
              {count > 0 ? <span className="activity-sidebar-tab-count">{count}</span> : null}
            </button>
          );
        })}
      </nav>
      <div className="activity-sidebar-content">{children}</div>
    </aside>
  );
}
