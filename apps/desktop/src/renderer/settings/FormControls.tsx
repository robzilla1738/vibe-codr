/**
 * Reusable form primitives for the Settings panel.
 *
 * All styling is token-driven (no literal hex) and follows the existing design
 * system: --font-sans for labels, --font-mono for code values, hairline borders
 * + --edge-highlight for resting surfaces, focus rings via :focus-visible.
 */

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useState,
} from "react";
import { formatKeyValueLines, parseKeyValueLines } from "../../shared/key-value-lines";

interface SettingFieldA11y {
  labelId: string;
  descriptionId?: string;
}

const SettingFieldA11yContext = createContext<SettingFieldA11y | null>(null);

function useSettingFieldA11y(): SettingFieldA11y | null {
  return useContext(SettingFieldA11yContext);
}

// ── Field wrapper ────────────────────────────────────────────────────────

export function SettingField({
  label,
  description,
  children,
  htmlFor,
}: {
  label: string;
  description?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  const generatedId = useId();
  const labelId = `${generatedId}-label`;
  const descriptionId = description ? `${generatedId}-description` : undefined;
  return (
    <div className="setting-field">
      <div className="setting-field-label">
        <span id={labelId} className="setting-field-name">{label}</span>
        {description && <p id={descriptionId} className="setting-field-desc">{description}</p>}
      </div>
      <SettingFieldA11yContext.Provider value={{ labelId, descriptionId }}>
        <div
          id={htmlFor}
          className="setting-field-control"
          role="group"
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
        >
          {children}
        </div>
      </SettingFieldA11yContext.Provider>
    </div>
  );
}

// ── Text input ───────────────────────────────────────────────────────────

export function TextInput({
  value,
  onChange,
  placeholder,
  monospace,
  disabled,
  type = "text",
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  monospace?: boolean;
  disabled?: boolean;
  type?: "text" | "password" | "number" | "url";
  id?: string;
}) {
  const fieldA11y = useSettingFieldA11y();
  return (
    <input
      id={id}
      type={type}
      className={`setting-input${monospace ? " is-mono" : ""}`}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      aria-labelledby={fieldA11y?.labelId}
      aria-describedby={fieldA11y?.descriptionId}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// ── Number input ─────────────────────────────────────────────────────────

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  disabled,
  id,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}) {
  const fieldA11y = useSettingFieldA11y();
  return (
    <input
      id={id}
      type="number"
      className="setting-input"
      value={value ?? ""}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      disabled={disabled}
      aria-labelledby={fieldA11y?.labelId}
      aria-describedby={fieldA11y?.descriptionId}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "") { onChange(undefined); return; }
        const n = Number(v);
        onChange(Number.isFinite(n) ? n : undefined);
      }}
    />
  );
}

// ── Select ───────────────────────────────────────────────────────────────

export function SelectInput<T extends string>({
  value,
  onChange,
  options,
  disabled,
  id,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
  id?: string;
}) {
  const fieldA11y = useSettingFieldA11y();
  return (
    <select
      id={id}
      className="setting-select"
      value={value}
      disabled={disabled}
      aria-labelledby={fieldA11y?.labelId}
      aria-describedby={fieldA11y?.descriptionId}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

// ── Toggle switch ────────────────────────────────────────────────────────

export function ToggleSwitch({
  checked,
  onChange,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  const generatedId = useId();
  const fieldA11y = useSettingFieldA11y();
  const switchId = id ?? generatedId;
  return (
    <button
      type="button"
      id={switchId}
      role="switch"
      aria-checked={checked}
      aria-labelledby={fieldA11y?.labelId}
      aria-describedby={fieldA11y?.descriptionId}
      className={`setting-toggle${checked ? " is-on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="setting-toggle-thumb" />
    </button>
  );
}

// ── Textarea ─────────────────────────────────────────────────────────────

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 6,
  monospace,
  disabled,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  monospace?: boolean;
  disabled?: boolean;
  id?: string;
}) {
  const fieldA11y = useSettingFieldA11y();
  return (
    <textarea
      id={id}
      className={`setting-textarea${monospace ? " is-mono" : ""}`}
      value={value}
      placeholder={placeholder}
      rows={rows}
      disabled={disabled}
      aria-labelledby={fieldA11y?.labelId}
      aria-describedby={fieldA11y?.descriptionId}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * Draft-preserving editor for environment variables and HTTP headers. Invalid
 * partial lines stay visible with an inline error and are never silently
 * discarded from the controlled config object.
 */
export function KeyValueTextArea({
  value,
  onChange,
  separator,
  resetKey,
  placeholder,
  rows = 3,
  trimValues = separator === ":",
  onInvalidDraftChange,
}: {
  value: Record<string, string> | undefined;
  onChange: (value: Record<string, string> | undefined) => void;
  separator: "=" | ":";
  resetKey: string;
  placeholder?: string;
  rows?: number;
  trimValues?: boolean;
  onInvalidDraftChange?: (key: string, invalid: boolean) => void;
}) {
  const fieldA11y = useSettingFieldA11y();
  const errorId = `${useId()}-error`;
  const formatted = formatKeyValueLines(value ?? {}, separator);
  const [draft, setDraft] = useState(formatted);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(formatted);
    setError(null);
    onInvalidDraftChange?.(resetKey, false);
    return () => onInvalidDraftChange?.(resetKey, false);
  }, [formatted, resetKey, onInvalidDraftChange]);

  return (
    <>
      <textarea
        className="setting-textarea is-mono"
        value={draft}
        placeholder={placeholder}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-labelledby={fieldA11y?.labelId}
        aria-describedby={
          [fieldA11y?.descriptionId, error ? errorId : undefined].filter(Boolean).join(" ")
          || undefined
        }
        aria-errormessage={error ? errorId : undefined}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const parsed = parseKeyValueLines(next, separator, { trimValues });
          if (!parsed.ok) {
            setError(parsed.error);
            onInvalidDraftChange?.(resetKey, true);
            return;
          }
          setError(null);
          onInvalidDraftChange?.(resetKey, false);
          onChange(Object.keys(parsed.value).length ? parsed.value : undefined);
        }}
      />
      {error ? <div id={errorId} className="settings-save-error" role="alert">{error}</div> : null}
    </>
  );
}

// ── Section card ─────────────────────────────────────────────────────────

export function SettingSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="setting-section">
      <div className="setting-section-header">
        <h3 className="setting-section-title">{title}</h3>
        {description && <p className="setting-section-desc">{description}</p>}
      </div>
      <div className="setting-section-body">{children}</div>
    </section>
  );
}

// ── Row of actions ───────────────────────────────────────────────────────

export function SettingActions({ children }: { children: ReactNode }) {
  return <div className="setting-actions">{children}</div>;
}

// ── Badge ────────────────────────────────────────────────────────────────

export function SettingBadge({ children, tone }: { children: ReactNode; tone?: "neutral" | "warn" | "danger" }) {
  return (
    <span className={`setting-badge${tone ? ` is-${tone}` : ""}`}>{children}</span>
  );
}
