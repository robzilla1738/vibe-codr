/** Compact environment card for the chat surface. Keep workspace tools grouped
 * here so the project rail can stay focused on navigation and sessions.
 *
 * Contract (UI.md / design-system): Session · Changes · Git · Terminal · Jobs ·
 * Files on the chat surface — no topbar duplicates, no Local/Files double Finder
 * entry, no commit/compare noise that belongs inside the Git end panel.
 */

import type { ReactNode } from "react";
import { changedFilesTotals } from "../../shared/changed-files";
import type { ChangedFile } from "../../shared/reducer";
import {
  IconFile,
  IconFolderOpen,
  IconGitBranch,
  IconJobs,
  IconPanel,
  IconTerminal,
} from "../icons";

export type WorkspaceDockTarget =
  | "session"
  | "changes"
  | "git"
  | "terminal"
  | "jobs"
  | "files";

export function WorkspaceDock({
  changedFiles,
  cwd,
  project,
  branch,
  executionTarget,
  sessionOpen,
  changesOpen,
  gitOpen,
  terminalOpen,
  jobsOpen,
  emptyHome,
  onOpen,
}: {
  changedFiles: ChangedFile[];
  cwd: string | null;
  project: string;
  branch: string | null;
  executionTarget: "local" | "cloud";
  sessionOpen: boolean;
  /** True when Session end panel is open focused on file review. */
  changesOpen?: boolean;
  gitOpen: boolean;
  terminalOpen: boolean;
  jobsOpen: boolean;
  /** Quiet toolbar treatment for the centered welcome/empty-session state. */
  emptyHome?: boolean;
  onOpen: (target: WorkspaceDockTarget) => void;
}) {
  const totals = changedFilesTotals(changedFiles);
  const hasChanges = totals.count > 0;

  return (
    <aside
      className="workspace-dock"
      data-empty-home={emptyHome || undefined}
      aria-label="Environment"
    >
      <div className="workspace-dock-header">
        <div className="workspace-dock-header-copy">
          <span className="workspace-dock-eyebrow">Environment</span>
          <span className="workspace-dock-project" title={project}>{project}</span>
        </div>
      </div>
      <nav className="workspace-dock-nav" aria-label="Workspace tools">
        <DockRow
          label="Session"
          ariaLabel="Show session panel"
          title="Open session details"
          active={sessionOpen && !changesOpen}
          onClick={() => onOpen("session")}
          icon={<IconPanel size={15} />}
        />
        <DockRow
          label="Changes"
          ariaLabel="Show session changes"
          title={
            hasChanges
              ? totals.unknownCount > 0
                ? `Review ${totals.count} changed file${totals.count === 1 ? "" : "s"}`
                : `Review ${totals.count} file${totals.count === 1 ? "" : "s"} · +${totals.added} −${totals.removed}`
              : "Review session changes"
          }
          active={!!changesOpen}
          meta={
            hasChanges && totals.unknownCount === 0 ? (
              <span className="workspace-dock-meta">
                <span className="diff-add-count">+{totals.added}</span>
                <span className="diff-del-count">−{totals.removed}</span>
              </span>
            ) : undefined
          }
          onClick={() => onOpen("changes")}
          icon={<IconFile size={15} />}
        />
        <DockRow
          label={branch ? `Git · ${branch}` : "Git"}
          ariaLabel="Open git panel"
          title={cwd
            ? executionTarget === "cloud"
              ? "Local Git pauses while Cloud owns this session"
              : "Branches, commit, remotes, PRs"
            : "Open a project first"}
          active={gitOpen}
          disabled={!cwd}
          onClick={() => onOpen("git")}
          icon={<IconGitBranch size={15} />}
        />
        <DockRow
          label="Terminal"
          ariaLabel="Open project terminal"
          title={executionTarget === "cloud"
            ? "Open the persistent terminal in the Cloud workspace"
            : "Open an interactive shell in this project"}
          active={terminalOpen}
          disabled={!cwd}
          onClick={() => onOpen("terminal")}
          icon={<IconTerminal size={15} />}
        />
        <DockRow
          label="Jobs"
          ariaLabel="Toggle background jobs"
          title="Background jobs and local servers"
          active={jobsOpen}
          onClick={() => onOpen("jobs")}
          icon={<IconJobs size={15} />}
        />
        <DockRow
          label="Files"
          ariaLabel="Reveal project in Finder"
          title={cwd
            ? executionTarget === "cloud" ? "Reveal the local base in Finder" : "Reveal project in Finder"
            : "Open a project first"}
          disabled={!cwd}
          onClick={() => onOpen("files")}
          icon={<IconFolderOpen size={15} />}
        />
      </nav>
    </aside>
  );
}

function DockRow({
  label,
  ariaLabel,
  title,
  icon,
  meta,
  active,
  disabled,
  onClick,
}: {
  label: string;
  /** Accessible name (may be richer than the visible label). */
  ariaLabel: string;
  title: string;
  icon: ReactNode;
  meta?: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`workspace-dock-row${active ? " is-active" : ""}`}
      aria-label={ariaLabel}
      aria-current={active ? "true" : undefined}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="workspace-dock-row-icon" aria-hidden>
        {icon}
      </span>
      <span className="workspace-dock-row-label">{label}</span>
      {meta ? <span className="workspace-dock-row-meta">{meta}</span> : null}
    </button>
  );
}
