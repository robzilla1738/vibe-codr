import type { ReactNode } from "react";
import { IconClose } from "../icons";

export function ActivityPanelHeader({
  titleId,
  title,
  subtitle,
  onClose,
  closeLabel,
  actions,
}: {
  titleId: string;
  title: ReactNode;
  subtitle: ReactNode;
  onClose: () => void;
  closeLabel: string;
  actions?: ReactNode;
}) {
  return (
    <header className="activity-panel-header sidebar-heading-row">
      <div className="sidebar-heading-copy">
        <p className="sidebar-eyebrow">Workspace</p>
        <h2 id={titleId} className="sidebar-heading-title">{title}</h2>
        <p className="sidebar-heading-sub">{subtitle}</p>
      </div>
      <div className="activity-panel-header-actions">
        {actions}
        <button
          type="button"
          className="icon-button sidebar-close"
          onClick={onClose}
          aria-label={closeLabel}
          title={closeLabel}
        >
          <IconClose size={14} />
        </button>
      </div>
    </header>
  );
}
