/**
 * The single source of truth for the CLI version.
 *
 * The committed value is the dev sentinel `0.0.0-dev` — it means "an unreleased
 * source/dev build". At release time `scripts/release/set-version.ts` rewrites
 * this literal (and every workspace `package.json`) to the pushed tag, so a
 * published binary/npm package reports its real version while `main` never
 * carries a stale hardcoded number. `update-check.ts` treats a `-dev` build as
 * never behind its own base version (see `isNewer`).
 */
export const VERSION = "0.7.9";
