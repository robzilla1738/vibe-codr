import type { ReactNode } from "react";
import { externalHref } from "../shared/sources";

export {
  MetaRow,
  StatusDot,
  projectName,
  formatGitLine,
  formatGoalLine,
  formatChromeSummary,
  subagentLabel,
} from "./panels/activity-shared";

/** Safe external link via the host bridge (markdown, sources, jobs, plans). */
export function ExternalLink({
  href,
  children,
  className,
}: {
  href?: string;
  children?: ReactNode;
  className?: string;
}) {
  const safeHref = externalHref(href);
  if (!safeHref) return <span className={className}>{children}</span>;
  return (
    <a
      href={safeHref}
      className={className}
      title={safeHref}
      onClick={(event) => {
        event.preventDefault();
        void window.vibe.openExternal(safeHref).catch(() => {
          // The URL stays in the title so it can still be copied if the OS
          // refuses to launch a browser. Avoid an unhandled IPC rejection.
        });
      }}
    >
      {children}
    </a>
  );
}
