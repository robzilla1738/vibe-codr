/**
 * `vibe upgrade` — detect how this build was installed and PRINT the right
 * update instructions (it never self-mutates; honest and simple for v1).
 *
 * Channel detection is by `process.execPath`:
 * - A compiled standalone binary (`bun build --compile`) runs as ITSELF, so
 *   execPath's basename is the app name (`vibecodr`) → GitHub Releases channel.
 * - A bun runtime — a source checkout (`bun bin/vibecodr.ts`) OR a `bun add -g`
 *   / `npm i -g` install whose bin has a `#!/usr/bin/env bun` shebang — runs as
 *   the `bun` interpreter, so execPath's basename is `bun` → package channel.
 */

const REPO_SLUG = "robzilla1738/vibe-codr";
const RELEASES_URL = `https://github.com/${REPO_SLUG}/releases/latest`;

export type UpgradeChannel = "bun" | "binary";

export function detectChannel(execPath: string): UpgradeChannel {
  // Split on both separators so a Windows path is parsed correctly even when
  // this runs on POSIX (node's basename only honors the host separator).
  const base = (execPath.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
  return base === "bun" || base.startsWith("bun-") ? "bun" : "binary";
}

export function upgradeInstructions(opts: { execPath: string; version: string }): string {
  if (detectChannel(opts.execPath) === "bun") {
    return [
      `vibe-codr ${opts.version} — installed via bun/npm (or run from source).`,
      "",
      "Update to the latest release:",
      "  bun add -g vibe-codr@latest",
      "  # or: npm install -g vibe-codr@latest",
    ].join("\n");
  }
  return [
    `vibe-codr ${opts.version} — standalone binary.`,
    "",
    "Download the latest binary for your platform:",
    `  ${RELEASES_URL}`,
    "",
    "Verify its checksum against SHA256SUMS, then replace this executable.",
  ].join("\n");
}
