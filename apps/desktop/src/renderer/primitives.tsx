import type { ReactNode } from "react";
import { externalHref } from "../shared/sources";
import { requestUrlOpen } from "./link-routing";

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
        requestUrlOpen(safeHref, event);
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        requestUrlOpen(safeHref, event);
      }}
    >
      {children}
    </a>
  );
}
