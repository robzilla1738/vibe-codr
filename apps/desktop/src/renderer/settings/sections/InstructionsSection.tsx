import { useCallback, useEffect, useRef, useState } from "react";
import type { ConfigScope } from "../../../shared/config-schema";
import { mayReloadSettingsContext } from "../../../shared/settings-load-guard";
import type { SectionProps } from "./types";
import { SettingField, SettingSection, TextArea } from "../FormControls";

export function InstructionsSection({
  scope,
  cwd,
  onBindDirty,
  onDirtyChange,
}: SectionProps & {
  onBindDirty?: (isDirty: () => boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [activeScope, setActiveScope] = useState<ConfigScope>(scope);
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [path, setPath] = useState("");
  const [exists, setExists] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const loadSeq = useRef(0);
  const savedTimer = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const contentRef = useRef(content);
  dirtyRef.current = content !== original;
  contentRef.current = content;
  const prevCwdRef = useRef(cwd);
  const prevOuterScopeRef = useRef(scope);
  /** Context that produced `content`; cancelled navigation cannot retarget Save. */
  const loadedContextRef = useRef<{ scope: ConfigScope; cwd?: string } | null>(null);

  const load = useCallback(async (loadScope: ConfigScope) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setSaving(false);
    setLoadError(null);
    setSaveError(null);
    setSaved(false);
    if (savedTimer.current != null) {
      window.clearTimeout(savedTimer.current);
      savedTimer.current = null;
    }
    try {
      const targetCwd = loadScope === "project" ? cwd ?? undefined : undefined;
      const res = await window.vibe.readMemory({ scope: loadScope, cwd: targetCwd });
      if (seq !== loadSeq.current) return;
      if (!res.ok) { setLoadError(res.error); setLoading(false); return; }
      setContent(res.content);
      setOriginal(res.content);
      setPath(res.path);
      setExists(res.exists);
      loadedContextRef.current = { scope: loadScope, cwd: targetCwd };
      setLoading(false);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setLoadError(err instanceof Error ? err.message : "Failed to load");
      setLoading(false);
    }
  }, [cwd]);

  // Keep the dirty binder live for the lifetime of this mount. Do not clear to
  // `() => false` on unmount — SettingsFormArea keeps this section mounted
  // (hidden) across nav switches so drafts survive; SettingsView clears the
  // shell guard when the whole settings surface closes.
  useEffect(() => {
    if (prevOuterScopeRef.current === scope) return;
    prevOuterScopeRef.current = scope;
    // SettingsView already ran the combined config/instructions dirty guard.
    setActiveScope(scope);
  }, [scope]);

  useEffect(() => {
    onBindDirty?.(() => dirtyRef.current);
  }, [onBindDirty]);

  useEffect(() => () => {
    loadSeq.current += 1;
    if (savedTimer.current != null) window.clearTimeout(savedTimer.current);
  }, []);

  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;
    // activeScope changes already confirm in switchScope; only block silent cwd reloads.
    if (cwdChanged && dirtyRef.current) {
      const ok = mayReloadSettingsContext({
        dirty: true,
        confirmDiscard: () => window.confirm("Discard unsaved instructions?"),
      });
      if (!ok) return;
    }
    void load(activeScope);
  }, [activeScope, load, cwd]);

  const switchScope = (next: ConfigScope) => {
    if (next === activeScope) return;
    if (dirtyRef.current) {
      const ok = window.confirm("Discard unsaved instructions?");
      if (!ok) return;
    }
    setActiveScope(next);
  };

  const save = useCallback(async () => {
    const seq = loadSeq.current;
    const savedContent = content;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const target = loadedContextRef.current ?? {
        scope: activeScope,
        cwd: activeScope === "project" ? cwd ?? undefined : undefined,
      };
      const res = await window.vibe.writeMemory({ scope: target.scope, cwd: target.cwd, content: savedContent });
      if (seq !== loadSeq.current) return;
      if (!res.ok) { setSaveError(res.error); setSaving(false); return; }
      setOriginal(savedContent);
      setExists(true);
      setSaving(false);
      const isCurrent = contentRef.current === savedContent;
      setSaved(isCurrent);
      if (savedTimer.current != null) window.clearTimeout(savedTimer.current);
      savedTimer.current = isCurrent
        ? window.setTimeout(() => {
            savedTimer.current = null;
            setSaved(false);
          }, 2000)
        : null;
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setSaveError(err instanceof Error ? err.message : "Failed to save");
      setSaving(false);
    }
  }, [activeScope, cwd, content]);

  const updateContent = useCallback((next: string) => {
    setContent(next);
    setSaved(false);
    if (savedTimer.current != null) {
      window.clearTimeout(savedTimer.current);
      savedTimer.current = null;
    }
  }, []);

  const dirty = content !== original;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  return (
    <SettingSection
      title="Custom Instructions"
      description="Project memory injected into the agent's system prompt. The engine reads VIBE.md, AGENTS.md, and CLAUDE.md from the repo root and ~/.config/vibe-codr/VIBE.md globally."
    >
      <div className="setting-scope-toggle" role="tablist" aria-label="Instructions scope">
        <button type="button" role="tab" aria-selected={activeScope === "global"} className={`settings-scope-btn${activeScope === "global" ? " active" : ""}`} onClick={() => switchScope("global")}>
          Global (~/.config/vibe-codr/VIBE.md)
        </button>
        <button type="button" role="tab" aria-selected={activeScope === "project"} className={`settings-scope-btn${activeScope === "project" ? " active" : ""}`} onClick={() => switchScope("project")} disabled={!cwd}>
          Project (VIBE.md)
        </button>
      </div>
      {loading ? (
        <p className="setting-empty"><span className="spinner" aria-hidden /> Loading…</p>
      ) : loadError ? (
        <div className="settings-save-error" role="alert">{loadError}</div>
      ) : (
        <>
          <SettingField
            label={exists ? "File content" : "Create file"}
            description={path}
          >
            <TextArea
              value={content}
              onChange={updateContent}
              placeholder={"# Project instructions\n\nDescribe your project conventions, coding style, and any rules the agent should follow.\n\n- Use TypeScript strict mode\n- Prefer functional components\n- Run tests before declaring done"}
              rows={16}
              monospace
            />
          </SettingField>
          {saveError && <div className="settings-save-error" role="alert">{saveError}</div>}
          <div className="setting-actions">
            {dirty && <span className="settings-dirty-indicator">Unsaved</span>}
            {saved && <span className="settings-clean-indicator">Saved</span>}
            <button type="button" className="button" onClick={() => setContent(original)} disabled={!dirty || saving}>
              Reset
            </button>
            <button type="button" className="button primary" onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      )}
    </SettingSection>
  );
}
