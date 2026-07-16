import { useEffect, useRef, useState } from "react";
import { queueRowsForDisplay } from "../../shared/live-list-bounds";
import type { PendingPerm } from "../../shared/reducer";
import {
  permissionDetail,
  permissionKind,
  permissionPreview,
} from "../../shared/tool-icons";
import type { QueuedItem, StructuredQuestion } from "../../shared/types";
import { CopyButton } from "../CopyButton";
import { IconRemove, IconSteer } from "../icons";
import { ExternalLink } from "../primitives";
import { MarkdownView } from "../transcript/MarkdownView";

function ActionKbd({ children }: { children: string }) {
  return <kbd className="action-kbd">{children}</kbd>;
}

const PREVIEW_MAX_LINES = 8;

export function PermissionCard({
  perm,
  count,
  onDecide,
  /** Incremented by App when the user presses N — first kick opens deny reason, second confirms. */
  denyKick = 0,
}: {
  perm: PendingPerm;
  count: number;
  onDecide: (decision: "once" | "always" | "always-project" | "deny", feedback?: string) => void;
  denyKick?: number;
}) {
  const onceRef = useRef<HTMLButtonElement>(null);
  const denyBtnRef = useRef<HTMLButtonElement>(null);
  const denyInputRef = useRef<HTMLInputElement>(null);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [denyReason, setDenyReason] = useState("");
  const [denyOpen, setDenyOpen] = useState(false);
  const lastDenyKick = useRef(0);
  // Move focus to the primary action when a new permission card appears so the
  // decision is obvious instead of letting typed prose route into the composer
  // (I35). preventScroll avoids yanking the viewport.
  useEffect(() => {
    onceRef.current?.focus({ preventScroll: true });
    setDenyReason("");
    setDenyOpen(false);
    setPreviewExpanded(false);
    // Baseline: ignore kicks that happened before this card.
    lastDenyKick.current = denyKick;
  }, [perm.id]); // eslint-disable-line react-hooks/exhaustive-deps -- only reset on new perm

  // After opening deny, keep focus on the Deny *button* (not the text field) so a
  // second N still hits the App keyboard path / button handler. Users Tab into
  // the reason field to type free text; Enter there confirms.
  useEffect(() => {
    if (!denyOpen) return;
    denyBtnRef.current?.focus({ preventScroll: true });
  }, [denyOpen]);

  const confirmDeny = () => {
    onDecide("deny", denyReason.trim() || denyInputRef.current?.value.trim() || undefined);
  };

  // Global N kicks from App (first opens, second confirms) when focus is not in
  // a free-text reason field. When focus *is* in the reason field, N types "n"
  // and Enter confirms — handled on the input below.
  useEffect(() => {
    if (denyKick <= lastDenyKick.current) return;
    lastDenyKick.current = denyKick;
    setDenyOpen((open) => {
      if (!open) return true;
      queueMicrotask(() => confirmDeny());
      return open;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to kicks
  }, [denyKick]);

  const preview = permissionPreview(perm.toolName, perm.input);
  let payload = "";
  try {
    payload = (JSON.stringify(perm.input, null, 2) ?? "").slice(0, 800);
  } catch {
    payload = String(perm.input);
  }
  const allPreviewLines = preview?.lines ?? [];
  const previewLines = previewExpanded
    ? allPreviewLines
    : allPreviewLines.slice(0, PREVIEW_MAX_LINES);
  const previewClipped = allPreviewLines.length > PREVIEW_MAX_LINES;
  const kind = permissionKind(perm.toolName);
  const detail = permissionDetail(perm.toolName, perm.input);
  const isCommand =
    perm.toolName.toLowerCase() === "bash" || perm.toolName.toLowerCase() === "shell";

  const submitDeny = () => {
    if (!denyOpen) {
      setDenyOpen(true);
      return;
    }
    confirmDeny();
  };

  return (
    <div className="card perm" role="region" aria-labelledby="permission-card-title">
      <header className="card-head">
        <p className="card-eyebrow">
          Needs your approval{count > 1 ? ` · 1 of ${count}` : ""}
        </p>
        <h3 id="permission-card-title">{kind}</h3>
        {detail ? (
          <p className={`perm-detail${isCommand ? " is-command" : ""}`}>{detail}</p>
        ) : null}
      </header>

      {preview && previewLines.length > 0 ? (
        <div className="tool-body permission-preview">
          {previewLines.map((l, i) => (
            <div
              key={i}
              className={
                preview.diff
                  ? l.startsWith("+")
                    ? "diff-add"
                    : l.startsWith("-")
                      ? "diff-del"
                      : undefined
                  : undefined
              }
            >
              {l}
            </div>
          ))}
          {previewClipped && !previewExpanded ? (
            <button
              type="button"
              className="permission-preview-more"
              onClick={() => setPreviewExpanded(true)}
            >
              Expand preview
            </button>
          ) : null}
          {previewExpanded && allPreviewLines.length > PREVIEW_MAX_LINES ? (
            <button
              type="button"
              className="permission-preview-more"
              onClick={() => setPreviewExpanded(false)}
            >
              Show fewer
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="card-actions perm-actions">
        <button
          type="button"
          ref={onceRef}
          className="chip primary"
          onClick={() => onDecide("once")}
          aria-keyshortcuts="y"
        >
          Allow once <ActionKbd>Y</ActionKbd>
        </button>
        <button
          type="button"
          className="chip"
          onClick={() => onDecide("always")}
          aria-keyshortcuts="a"
          title="Allow this exact request for the rest of this session (A)"
        >
          For session <ActionKbd>A</ActionKbd>
        </button>
        <button
          type="button"
          className="chip"
          onClick={() => onDecide("always-project")}
          aria-keyshortcuts="Meta+p"
          title="Allow this exact request for this project and future sessions (⌘P)"
        >
          For project <ActionKbd>⌘P</ActionKbd>
        </button>
        <button
          type="button"
          ref={denyBtnRef}
          className="chip danger"
          onClick={submitDeny}
          onKeyDown={(event) => {
            // Second N while Deny is focused confirms without depending on App
            // (App only routes N when focus is not a free-text input).
            if (denyOpen && (event.key === "n" || event.key === "N") && !event.metaKey && !event.ctrlKey && !event.altKey) {
              event.preventDefault();
              event.stopPropagation();
              confirmDeny();
            }
          }}
          aria-keyshortcuts="n"
          aria-expanded={denyOpen}
        >
          {denyOpen ? "Confirm deny" : "Deny"} <ActionKbd>N</ActionKbd>
        </button>
      </div>

      {denyOpen ? (
        <label className="perm-deny-reason is-open">
          <span className="sr-only">Optional deny reason</span>
          <input
            ref={denyInputRef}
            type="text"
            value={denyReason}
            onChange={(event) => setDenyReason(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                confirmDeny();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setDenyOpen(false);
                setDenyReason("");
                denyBtnRef.current?.focus({ preventScroll: true });
              }
            }}
            placeholder="Why deny? Optional — press Enter to confirm"
            aria-label="Optional reason for denying"
          />
        </label>
      ) : null}

      <details className="decision-details">
        <summary>Technical details</summary>
        <pre className="decision-payload">{payload}</pre>
      </details>
    </div>
  );
}

export function PlanCard({
  plan,
  hasDraft,
  onAccept,
  onAcceptYolo,
  onKeep,
}: {
  plan: {
    text: string;
    sources?: { url: string; title?: string }[];
    assumptions?: string[];
    ungrounded?: boolean;
  };
  /** Whether the composer holds a revision in progress (honest Esc label, I36). */
  hasDraft?: boolean;
  onAccept: () => void;
  onAcceptYolo: () => void;
  onKeep: () => void;
}) {
  const hasEvidence =
    (plan.sources && plan.sources.length > 0) ||
    (plan.assumptions && plan.assumptions.length > 0);

  return (
    <div className="card plan" role="region" aria-labelledby="plan-card-title">
      <header className="card-head">
        <h3 id="plan-card-title">Review plan</h3>
      </header>

      <div className="plan-review-scroll">
        {plan.ungrounded && (
          <div className="notice warn" role="status">
            This plan was presented without the research the request called for.
          </div>
        )}

        <div className="plan-text has-copy">
          {plan.text ? <CopyButton text={plan.text} label="Copy plan" /> : null}
          <div className="md">
            <MarkdownView>{plan.text}</MarkdownView>
          </div>
        </div>

        {hasEvidence ? (
          <div className="plan-evidence-stack">
            {plan.sources && plan.sources.length > 0 ? (
              <div className="plan-evidence">
                <h4>Sources</h4>
                <ol className="plan-sources">
                  {plan.sources.map((source) => (
                    <li key={source.url}>
                      <ExternalLink href={source.url}>
                        {source.title || source.url}
                      </ExternalLink>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            {plan.assumptions && plan.assumptions.length > 0 ? (
              <div className="plan-evidence assumptions">
                <h4>Assumptions to verify</h4>
                <ul>
                  {plan.assumptions.map((assumption, index) => (
                    <li key={index}>{assumption}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="card-actions plan-actions">
        <button
          type="button"
          className="chip primary"
          onClick={onAccept}
          aria-keyshortcuts="Enter"
        >
          <span className="action-label">Accept</span>
          <ActionKbd>Enter</ActionKbd>
        </button>
        <button
          type="button"
          className="chip"
          onClick={onKeep}
          aria-keyshortcuts="Escape"
          title={
            hasDraft
              ? "Esc clears your feedback, press again to keep planning"
              : "Keep planning without accepting"
          }
        >
          <span className="action-label">{hasDraft ? "Clear feedback" : "Keep planning"}</span>
          <ActionKbd>Esc</ActionKbd>
        </button>
        <span className="card-actions-sep" aria-hidden />
        <button
          type="button"
          className="chip caution"
          onClick={onAcceptYolo}
          aria-keyshortcuts="Meta+y"
          title="Accept the plan and switch this session to YOLO until you change modes"
        >
          <span className="action-label">Accept + auto-approve</span>
          <ActionKbd>⌘Y</ActionKbd>
        </button>
      </div>
    </div>
  );
}

export function QuestionCard({
  question,
  onAnswer,
}: {
  question: StructuredQuestion;
  onAnswer: (answers: string[], freeform?: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [freeform, setFreeform] = useState("");
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setSelected([]);
    setFreeform("");
    firstRef.current?.focus({ preventScroll: true });
  }, [question.id]);

  const toggle = (label: string) => {
    setSelected((current) => question.multiple
      ? current.includes(label) ? current.filter((value) => value !== label) : [...current, label]
      : [label]);
  };
  const canSubmit = selected.length > 0 || (question.allowFreeform && freeform.trim().length > 0);

  return (
    <div className="card plan" role="group" aria-labelledby="question-card-title">
      <header className="card-head">
        <h3 id="question-card-title">{question.header || "Quick question"}</h3>
      </header>
      <div className="plan-review-scroll">
        <div className="plan-text"><p>{question.question}</p></div>
        {question.choices.length > 0 ? (
          <div className="card-actions" role={question.multiple ? "group" : "radiogroup"} aria-label="Answer choices">
            {question.choices.map((choice, index) => {
              const active = selected.includes(choice.label);
              return (
                <button
                  ref={index === 0 ? firstRef : undefined}
                  key={choice.label}
                  type="button"
                  className={`chip${active ? " primary" : ""}`}
                  role={question.multiple ? "checkbox" : "radio"}
                  aria-checked={active}
                  onClick={() => toggle(choice.label)}
                  title={choice.description}
                >
                  {choice.label}
                </button>
              );
            })}
          </div>
        ) : null}
        {question.allowFreeform ? (
          <label className="permission-feedback">
            <span>Additional context</span>
            <input
              value={freeform}
              onChange={(event) => setFreeform(event.target.value)}
              placeholder="Type an answer"
              aria-label="Free-form answer"
              onKeyDown={(event) => {
                if (event.key === "Enter" && canSubmit) onAnswer(selected, freeform.trim() || undefined);
              }}
            />
          </label>
        ) : null}
      </div>
      <div className="card-actions plan-actions">
        <button
          type="button"
          className="chip primary"
          disabled={!canSubmit}
          onClick={() => onAnswer(selected, freeform.trim() || undefined)}
        >
          <span className="action-label">Continue</span>
          <ActionKbd>Enter</ActionKbd>
        </button>
      </div>
    </div>
  );
}

export function QueuePanel({
  pending,
  totalCount = pending.length,
  onSteer,
  onDequeue,
}: {
  pending: QueuedItem[];
  totalCount?: number;
  onSteer: (id: string) => void;
  onDequeue: (id: string) => void;
}) {
  if (pending.length === 0) return null;
  const visible = queueRowsForDisplay(pending);

  const renderRow = (q: QueuedItem) => (
    <li key={q.id} className="queue-row">
      <span className="queue-row-mark" aria-hidden />
      <span className="queue-label">{q.label}</span>
      <div className="queue-actions hover-reveal">
        <button
          type="button"
          className="queue-action"
          onClick={() => onSteer(q.id)}
          title="Steer — run this next"
          aria-label={`Steer ${q.label} to front of queue`}
        >
          <IconSteer size={13} />
        </button>
        <button
          type="button"
          className="queue-action queue-action-remove"
          onClick={() => onDequeue(q.id)}
          title="Remove from queue"
          aria-label={`Remove ${q.label} from queue`}
        >
          <IconRemove size={14} />
        </button>
      </div>
    </li>
  );

  return (
    <div className="composer-queue-tray" role="region" aria-label="Queued prompts">
      <div className="queue-tray-bar">
        <span className="queue-tray-count">{totalCount} queued</span>
      </div>
      <ul id="composer-queue-items" className="queue-items">
        {visible.head.map(renderRow)}
        {totalCount > visible.head.length + visible.tail.length ? (
          <li className="queue-row queue-row-omitted">
            {totalCount - visible.head.length - visible.tail.length} middle queued items omitted from this view
          </li>
        ) : null}
        {visible.tail.map(renderRow)}
      </ul>
    </div>
  );
}
