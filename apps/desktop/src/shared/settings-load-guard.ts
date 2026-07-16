/**
 * Decide whether a settings/memory reload may proceed after context changes
 * (scope, cwd). When the form is dirty, require an explicit discard confirm so
 * a project switch or scope flip cannot silently wipe unsaved edits.
 */
export function mayReloadSettingsContext(opts: {
  dirty: boolean;
  /** Return true if the user accepts discarding unsaved edits. */
  confirmDiscard: () => boolean;
}): boolean {
  if (!opts.dirty) return true;
  return opts.confirmDiscard();
}
