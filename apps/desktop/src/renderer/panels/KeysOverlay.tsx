import { useRef } from "react";
import { createPortal } from "react-dom";
import { ESSENTIAL_KEYS } from "../../shared/keys-help";
import { IconClose } from "../icons";
import { useFocusTrap } from "../hooks/useFocusTrap";

/** Dedicated keyboard cheatsheet overlay (I57) — replaces the /keys transcript
 *  notice with a dismissible panel so power features stay discoverable. */
export function KeysOverlay({ onClose }: { onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusTrap(true, rootRef, onClose);

  return createPortal(
    <div className="keys-overlay-root">
      <button
        type="button"
        className="keys-overlay-scrim"
        onClick={onClose}
        aria-label="Close keyboard shortcuts"
        tabIndex={-1}
      />
      <div
        ref={rootRef}
        className="keys-overlay popover-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="keys-overlay-title"
        tabIndex={-1}
      >
        <div className="keys-overlay-header">
          <h2 id="keys-overlay-title">Keyboard</h2>
          <button
            type="button"
            className="keys-close icon-button"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
          >
            <IconClose size={15} />
          </button>
        </div>
        <ul className="keys-list">
          {ESSENTIAL_KEYS.map((k) => (
            <li key={k.keys}>
              <kbd className="action-kbd keys-kbd">{k.keys}</kbd>
              <span className="keys-action">{k.action}</span>
            </li>
          ))}
        </ul>
        <p className="keys-footer">
          /details quiet|normal|verbose · /help for all slash commands.<br />
          With a command catalog open, Tab cycles between the catalog and the composer.
        </p>
      </div>
    </div>,
    document.body,
  );
}
