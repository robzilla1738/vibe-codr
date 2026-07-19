#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const assets = resolve("out/renderer/assets");
const rendererNotices = resolve("out/renderer/THIRD_PARTY_LICENSES.txt");
if (!existsSync(assets)) {
  console.error("Renderer assets missing — run `npm run build` before verify:bundle");
  process.exit(1);
}
if (!existsSync(rendererNotices) || (await stat(rendererNotices)).size < 1_000) {
  console.error("Renderer third-party notices missing — production chunks must keep extracted license text");
  process.exit(1);
}
const files = (await readdir(assets)).filter((name) => name.endsWith(".js"));
if (files.length === 0) {
  console.error("No renderer JS chunks found under out/renderer/assets — run `npm run build`");
  process.exit(1);
}
const sizes = await Promise.all(files.map(async (name) => ({ name, bytes: (await stat(join(assets, name))).size })));
const total = sizes.reduce((sum, item) => sum + item.bytes, 0);
const largest = sizes.reduce((max, item) => Math.max(max, item.bytes), 0);
// xterm is a project-terminal feature and is code-split from chat startup.
// Keep the initial/largest chunk on the existing budget while allowing the
// shipped aggregate to include the isolated terminal runtime.
// The continuity-safe handoff, grouped command palette, and shared presence
// lifecycle, provider subscription auth, and the guided provider/settings flow
// bring the current aggregate baseline to ~2.822 MB across startup and lazy
// activity/settings/terminal/provider-catalog chunks. Keep a narrow 1 KB
// regression allowance;
// The complete canonical slash catalog and descriptive value submenus add less
// than 1 KB to startup. Keep a narrow 2 KB allowance for that user-visible
// discovery contract rather than dropping command help from the shipped UI.
// The cross-project Sessions manager is deferred into its own ~33 KB chunk;
// only route ownership and the rail destination stay in startup. Account for
// that intentional product surface with the same narrow ~2 KB regression room.
// Fail-closed Cloud recovery mutation guards now live in both the startup rail
// and deferred Sessions chunk. Allow their measured <2 KB aggregate cost while
// keeping the startup/largest-chunk ceiling unchanged.
// Live session-state derivation and reviewed model-credential handoff add under
// 8 KB across deferred surfaces. Cloud handoff remains off the startup path;
// retain a narrow 2 KB allowance over the measured v0.6.1 aggregate.
// The versioned appearance override adds 31 measured bytes across the deferred
// handoff/settings surfaces. Keep a 1 KB allowance rather than weakening the
// unchanged startup/largest-chunk ceiling.
// Actionable live Sessions insight adds ~0.5 KB over the previous aggregate
// ceiling. Keep a narrow 3 KB product-surface allowance while leaving the
// startup/largest-chunk ceiling unchanged.
// Local-only performance sampling and the opt-in provider-tier control add
// 422 measured bytes across startup/settings. Keep a sub-1 KB allowance while
// leaving the startup/largest-chunk ceiling unchanged.
// Runtime continuity adds ~5 KB to the already-deferred Sessions workspace and
// ~8 KB to the already-deferred Advanced Settings surface. Startup changes by
// less than 1 KB (0.05%); the aggregate allowance grows by 20 KB (0.7%) to
// cover deterministic minifier variance between Linux and macOS runners while
// preserving the existing startup/largest-chunk ceiling.
const totalBudget = 2_912_000;
const chunkBudget = 2_120_000;

if (total > totalBudget || largest > chunkBudget) {
  console.error(`Renderer bundle budget exceeded: ${total} total bytes, ${largest} largest chunk`);
  process.exit(1);
}

console.log(`Renderer bundle budget OK: ${total} total bytes, ${largest} largest chunk`);
console.log(`Renderer third-party notices OK: ${rendererNotices}`);

// Host binary budget when present (pack / copy-host). Not required for verify
// after a renderer-only build, but fail loud if an oversized host is staged.
const hostCandidates = [
  resolve("resources/vibecodr-engine-host"),
  resolve("release/mac-arm64/Vibe Codr.app/Contents/Resources/vibecodr-engine-host"),
  resolve("release/mac/Vibe Codr.app/Contents/Resources/vibecodr-engine-host"),
  resolve("release/win-unpacked/resources/vibecodr-engine-host.exe"),
];
const hostBudget = 120 * 1024 * 1024; // 120 MiB — fail if a huge accidental binary is shipped
for (const host of hostCandidates) {
  if (!existsSync(host)) continue;
  const bytes = (await stat(host)).size;
  if (bytes > hostBudget) {
    console.error(`Host binary budget exceeded: ${host} is ${bytes} bytes (max ${hostBudget})`);
    process.exit(1);
  }
  console.log(`Host binary budget OK: ${host} (${bytes} bytes)`);
  break;
}
