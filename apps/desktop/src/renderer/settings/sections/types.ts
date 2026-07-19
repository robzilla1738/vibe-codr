import type { ConfigScope, VibeConfig } from "../../../shared/config-schema";

export interface SectionProps {
  config: VibeConfig;
  scope: ConfigScope;
  updateConfig: (patch: Partial<VibeConfig>) => void;
  updateNested: <K extends keyof VibeConfig>(key: K, patch: Partial<VibeConfig[K]>) => void;
  cwd: string | null;
  /** True only while this kept-mounted section is the visible settings page. */
  active?: boolean;
  /** Changes when the foreground engine session changes. */
  runtimeIdentity?: string;
  /** Keeps malformed or unfinished local editor drafts inside the dirty guard. */
  onInvalidDraftChange?: (key: string, invalid: boolean) => void;
  /** Bumped by Reset so local draft editors return to persisted values. */
  draftResetVersion?: number;
  showToast?: (message: string, severity?: "info" | "warn" | "error") => void;
}
