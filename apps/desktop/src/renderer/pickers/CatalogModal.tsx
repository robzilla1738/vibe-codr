import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  agentCatalogOptions,
  type CatalogOption,
  isSectionOption,
  limitCatalogOptions,
  type ModelPickerTarget,
  mcpCatalogOptions,
  modelCatalogOptions,
  modelTargetLabel,
  providerCatalogOptions,
  pushModelRecent,
  skillCatalogOptions,
} from "../../shared/catalog-draft";
import type { EngineCommand } from "../../shared/commands";
import type {
  AgentInfo,
  McpServerInfo,
  ModelSummary,
  ProviderInfo,
  SkillInfo,
} from "../../shared/types";
import { useFloatingAnchor } from "../hooks/useFloatingAnchor";
import { IconClose, IconSearch } from "../icons";

export type CatalogPicker =
  | {
      kind: "models";
      items: ModelSummary[];
      target: ModelPickerTarget;
      query?: string;
      current?: string;
    }
  | { kind: "providers"; items: ProviderInfo[]; query?: string }
  | { kind: "agents"; items: AgentInfo[]; query?: string }
  | { kind: "skills"; items: SkillInfo[]; query?: string }
  | { kind: "mcp"; items: McpServerInfo[]; query?: string };

export type CatalogChoice =
  | { kind: "command"; command: EngineCommand }
  | { kind: "prefill"; draft: string; openModelsForAgent?: string }
  | { kind: "setup-provider"; providerId?: string }
  | { kind: "line"; line: string };

/** Catalog picker plus an inline lifecycle status (I42): the popover stays
 *  open across loading → ready / error so RPC failures show inline, not just
 *  as a vanishing toast. */
export type CatalogPickerState = CatalogPicker & {
  status?: "loading" | "error";
  error?: string;
};

function catalogOptions(picker: CatalogPicker): CatalogOption[] {
  switch (picker.kind) {
    case "models":
      return modelCatalogOptions(picker.items, picker.target, picker.current);
    case "providers":
      return providerCatalogOptions(picker.items);
    case "agents":
      return agentCatalogOptions(picker.items);
    case "skills":
      return skillCatalogOptions(picker.items);
    case "mcp":
      return mcpCatalogOptions(picker.items);
  }
}

function toChoice(option: CatalogOption): CatalogChoice | null {
  if (option.command) return { kind: "command", command: option.command };
  if (option.setupProviderId !== undefined) {
    return {
      kind: "setup-provider",
      ...(option.setupProviderId ? { providerId: option.setupProviderId } : {}),
    };
  }
  if (option.prefill != null) {
    return {
      kind: "prefill",
      draft: option.prefill,
      openModelsForAgent: option.openModelsForAgent,
    };
  }
  if (option.line) return { kind: "line", line: option.line };
  return null;
}

const CATALOG_EMPTY_COPY: Record<string, string> = {
  models: "No models match this filter.",
  providers: "No providers match this filter.",
  agents: "No agents match this filter.",
  skills: "No skills match this filter.",
  mcp: "No MCP servers match this filter.",
};

function isActionable(option: CatalogOption): boolean {
  if (isSectionOption(option)) return false;
  return Boolean(
    option.command
      || option.prefill != null
      || option.setupProviderId !== undefined
      || option.line,
  );
}

function splitSecondary(secondary: string): { tag: string | null; body: string } {
  const m = secondary.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!m) return { tag: null, body: secondary };
  return { tag: m[1]!, body: m[2] ?? "" };
}

function focusableIn(root: ParentNode | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => {
    if (el.getAttribute("aria-hidden") === "true") return false;
    // offsetParent is null for fixed/portaled nodes in some engines — keep
    // visibly rendered controls even when portaled to document.body.
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  });
}

export function CatalogModal({
  picker,
  closing = false,
  onClose,
  onChoose,
  onToggleModelTarget,
  autoFocusSearch = true,
  draftLinked = false,
  anchorRef,
  onRetry,
}: {
  picker: CatalogPickerState;
  closing?: boolean;
  onClose: () => void;
  onChoose: (choice: CatalogChoice) => void;
  onToggleModelTarget?: () => void;
  autoFocusSearch?: boolean;
  /** Composer draft owns the filter — search looks linked, not idle. */
  draftLinked?: boolean;
  /** Positions the portaled popover above this element (composer stack). */
  anchorRef: RefObject<HTMLElement | null>;
  /** Re-run the catalog fetch from an inline error state (I42). */
  onRetry?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState(picker.query ?? "");
  const box = useFloatingAnchor(anchorRef, true);
  const allOptions = useMemo(() => catalogOptions(picker), [picker]);
  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return allOptions;
    // Keep sections when they have matching children
    const filtered: CatalogOption[] = [];
    let currentSection: CatalogOption | null = null;
    let sectionHasMatch = false;
    let pendingSection: CatalogOption | null = null;

    for (const opt of allOptions) {
      if (isSectionOption(opt)) {
        if (pendingSection && sectionHasMatch) {
          filtered.push(pendingSection);
        }
        pendingSection = opt;
        currentSection = opt;
        sectionHasMatch = false;
        continue;
      }
      if (`${opt.primary} ${opt.secondary}`.toLowerCase().includes(normalized)) {
        if (pendingSection) {
          // First match after a section header — emit the header
          filtered.push(pendingSection);
          pendingSection = null;
          sectionHasMatch = true;
        }
        filtered.push(opt);
        sectionHasMatch = true;
      }
    }

    // If no sections matched but plain options did, filtered is already populated
    // If sections exist but filter narrows to zero actionable, return empty
    void currentSection;
    return filtered;
  }, [allOptions, query]);
  const limited = useMemo(() => limitCatalogOptions(filteredOptions), [filteredOptions]);
  const options = limited.options;

  // Memoize so selection-reset effect does not re-fire every render (new array
  // identity would snap keyboard/hover selection back to the first item).
  const actionable = useMemo(
    () => options.flatMap((option, index) => (isActionable(option) ? [index] : [])),
    [options],
  );
  const optionsIdentity = useMemo(() => options.map((o) => o.key).join("\0"), [options]);
  const actionableKey = useMemo(() => actionable.join(","), [actionable]);
  const modelTargetKey = picker.kind === "models" ? String(picker.target) : "";
  const modelCurrentKey = picker.kind === "models" ? (picker.current ?? "") : "";

  const canToggleTarget =
    picker.kind === "models" && typeof picker.target === "string" && Boolean(onToggleModelTarget);

  const focusOption = (index: number) => {
    setSelected(index);
    window.requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLButtonElement>(`[data-option-index="${index}"]`)
        ?.focus();
    });
  };

  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    if (autoFocusSearch) {
      window.requestAnimationFrame(() =>
        rootRef.current?.querySelector<HTMLInputElement>("[data-catalog-search]")?.focus(),
      );
    }
    return () => {
      if (autoFocusSearch) triggerRef.current?.focus();
    };
  }, [autoFocusSearch]);

  useEffect(() => {
    if (closing && autoFocusSearch) triggerRef.current?.focus();
  }, [autoFocusSearch, closing]);

  // Keep keyboard focus inside the catalog (and composer when draft-linked).
  useEffect(() => {
    if (!box || closing) return;

    const trapTargets = (): HTMLElement[] => {
      const catalog = focusableIn(rootRef.current);
      if (!draftLinked) return catalog;
      const composer = focusableIn(document.getElementById("composer"));
      // Prefer catalog controls first so Tab cycles catalog → composer → catalog.
      return [...catalog, ...composer];
    };

    const pullFocusBack = () => {
      const targets = trapTargets();
      const fallback =
        rootRef.current?.querySelector<HTMLElement>("[data-catalog-search]") ??
        targets[0] ??
        rootRef.current;
      fallback?.focus();
    };

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      if (draftLinked && document.getElementById("composer")?.contains(target)) return;
      pullFocusBack();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const targets = trapTargets();
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

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [box, draftLinked, canToggleTarget, closing]);

  useEffect(() => {
    setQuery(picker.query ?? "");
  }, [picker.query, picker.kind]);

  useEffect(() => {
    const cur =
      picker.kind === "models"
        ? options.findIndex((o) => o.key === picker.current && o.key !== "__clear__")
        : -1;
    const first = actionableKey ? Number(actionableKey.split(",")[0]) : 0;
    setSelected(cur >= 0 ? cur : first);
    // Only reset when the list / filter / target / current model identity changes —
    // not on unrelated re-renders (floating box, hover, etc.).
  }, [query, picker.kind, modelTargetKey, modelCurrentKey, optionsIdentity, actionableKey, options, picker]);

  const move = (direction: 1 | -1) => {
    if (!actionable.length) return;
    const current = actionable.indexOf(selected);
    const next = actionable[(current + direction + actionable.length) % actionable.length] ?? actionable[0]!;
    setSelected(next);
    window.requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLButtonElement>(`[data-option-index="${next}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  };

  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const chooseRef = useRef<(option: CatalogOption) => void>(() => {});
  const moveRef = useRef(move);
  moveRef.current = move;

  useEffect(() => {
    const onNav = (event: Event) => {
      const direction = (event as CustomEvent<1 | -1>).detail;
      if (direction === 1 || direction === -1) moveRef.current(direction);
    };
    const onConfirm = () => {
      const option = optionsRef.current[selectedRef.current];
      if (option && isActionable(option)) chooseRef.current(option);
    };
    window.addEventListener("vibe-catalog-nav", onNav);
    window.addEventListener("vibe-catalog-confirm", onConfirm);
    return () => {
      window.removeEventListener("vibe-catalog-nav", onNav);
      window.removeEventListener("vibe-catalog-confirm", onConfirm);
    };
  }, []);

  const choose = (option: CatalogOption) => {
    // Track recent for main model picker (opencode-style)
    if (picker.kind === "models" && option.key && !option.key.startsWith("__")) {
      pushModelRecent(option.key);
    }
    const choice = toChoice(option);
    if (choice) onChoose(choice);
  };
  chooseRef.current = choose;

  const title =
    picker.kind === "models"
      ? `Models · ${modelTargetLabel(picker.target)}`
      : picker.kind[0]!.toUpperCase() + picker.kind.slice(1);

  if (!box) return null;

  return createPortal(
    <div
      ref={rootRef}
      className={`catalog-popover popover-surface catalog-popover-portal${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="catalog-title"
      aria-hidden={closing || undefined}
      inert={closing}
      style={{
        left: box.left,
        width: box.width,
        bottom: window.innerHeight - box.top + 10,
        maxHeight: Math.min(440, Math.max(180, box.top - 24)),
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          move(-1);
        } else if (event.key === "Home" && actionable.length) {
          event.preventDefault();
          focusOption(actionable[0]!);
        } else if (event.key === "End" && actionable.length) {
          event.preventDefault();
          focusOption(actionable.at(-1)!);
        } else if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (event.key === "Enter") {
          const option = options[selected];
          if (option && isActionable(option)) {
            event.preventDefault();
            choose(option);
          }
        }
      }}
    >
      <div className="catalog-popover-header popover-header">
        <div className="catalog-header-title">
          <h2 id="catalog-title">{title}</h2>
          {draftLinked ? (
            <span className="catalog-draft-hint">Filtering from composer</span>
          ) : null}
        </div>
        <div className="catalog-header-actions">
          {canToggleTarget && (
            <button
              type="button"
              className="catalog-target"
              onClick={onToggleModelTarget}
              aria-label={`Model target ${picker.target === "main" ? "Main" : "Subagents"}. Activate to switch.`}
              title="Switch model target"
            >
              {picker.target === "main" ? "Main" : "Subagents"}
            </button>
          )}
          <button type="button" className="catalog-close" onClick={onClose} aria-label={`Close ${title}`}>
            <IconClose size={14} />
          </button>
        </div>
      </div>

      <label className={`catalog-search${draftLinked ? " is-draft-linked" : ""}`}>
        <span className="sr-only">Filter {picker.kind}</span>
        <IconSearch size={14} />
        <input
          data-catalog-search
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={
            draftLinked
              ? "Type in composer to filter…"
              : `Filter ${picker.kind}…`
          }
          autoComplete="off"
          aria-controls="catalog-results"
          aria-autocomplete="list"
          aria-activedescendant={
            actionable.length ? `catalog-option-${selected}` : undefined
          }
        />
        {query && (
          <button
            type="button"
            className="catalog-search-clear"
            onClick={() => setQuery("")}
            aria-label="Clear filter"
          >
            <IconClose size={13} />
          </button>
        )}
      </label>

      <div
        id="catalog-results"
        className="catalog-list popover-body"
        role={picker.status ? "status" : actionable.length ? "listbox" : "list"}
        aria-label={`${picker.kind} results`}
      >
        {picker.status === "loading" ? (
          <div className="catalog-status" role="status" aria-live="polite">
            <span className="spinner catalog-status-spinner" aria-hidden />
            <span>Loading {picker.kind}…</span>
          </div>
        ) : picker.status === "error" ? (
          <div className="catalog-status is-error" role="alert">
            <div className="catalog-status-message">
              {picker.error ? `Couldn’t load ${picker.kind} · ${picker.error}` : `Couldn’t load ${picker.kind}.`}
            </div>
            {onRetry ? (
              <button type="button" className="catalog-retry" onClick={onRetry}>
                Retry
              </button>
            ) : null}
          </div>
        ) : (
          <>
            {options.map((option, index) => {
              if (isSectionOption(option)) {
                return (
                  <div key={option.key} className="catalog-section" role="presentation">
                    {option.primary}
                  </div>
                );
              }
              const { tag, body } = splitSecondary(option.secondary);
              if (!isActionable(option)) {
                return (
                  <div key={option.key} className="catalog-row is-static" role="listitem">
                    <span className="catalog-row-primary">{option.primary}</span>
                    {(tag || body) ? (
                      <span className="catalog-row-secondary">
                        {tag ? <span className="catalog-tag">{tag}</span> : null}
                        {body}
                      </span>
                    ) : null}
                  </div>
                );
              }
              return (
                <button
                  key={option.key}
                  id={`catalog-option-${index}`}
                  type="button"
                  className={`catalog-row${index === selected ? " selected" : ""}`}
                  data-catalog-option
                  data-option-index={index}
                  role="option"
                  aria-selected={index === selected}
                  aria-current={picker.kind === "models" && option.key === picker.current ? "true" : undefined}
                  onFocus={() => setSelected(index)}
                  onMouseMove={() => setSelected(index)}
                  onClick={() => choose(option)}
                >
                  <span className="catalog-row-primary">
                    {option.primary}
                    {option.free ? <span className="catalog-tag free">Free</span> : null}
                    {picker.kind === "models" && option.key === picker.current ? (
                      <span className="catalog-current">Current</span>
                    ) : null}
                  </span>
                  {(tag || body) && (
                    <span className="catalog-row-secondary">
                      {tag ? <span className="catalog-tag">{tag}</span> : null}
                      {body}
                    </span>
                  )}
                </button>
              );
            })}
            {limited.omitted > 0 ? (
              <div className="catalog-limit-note" role="status">
                {limited.omitted.toLocaleString()} more results. Type to narrow the list.
              </div>
            ) : null}
            {options.length === 0 && (
              <div className="catalog-empty" role="status">
                <div>{CATALOG_EMPTY_COPY[picker.kind] ?? "Nothing matches this filter."}</div>
                {query && <div className="catalog-empty-hint">Try different keywords or clear the filter</div>}
              </div>
            )}
          </>
        )}
      </div>

      <div className="catalog-popover-footer popover-footer">
        <span>
          <kbd className="action-kbd">↑↓</kbd> navigate
        </span>
        <span>
          <kbd className="action-kbd">Enter</kbd> choose
        </span>
        <span>
          <kbd className="action-kbd">Esc</kbd> close
        </span>
        {picker.kind === "models" && typeof picker.target === "string" && canToggleTarget ? (
          <span>
            Main/Subagents toggle in header
          </span>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
