/**
 * Entry for the TUI render smoke test. Registers OpenTUI's Solid JSX transform
 * (a Bun plugin) before importing the JSX harness, mirroring how `tui.ts` loads
 * `app.tsx` at runtime. Run with `bun run smoke:tui`.
 */
const preload = "@opentui/solid/preload";
await import(preload);
const harness = "./smoke-render.tsx";
await import(harness);
