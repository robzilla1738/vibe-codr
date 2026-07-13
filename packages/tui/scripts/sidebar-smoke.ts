/**
 * Wide-terminal layout smoke (sidebar removed): asserts Tasks/Subagents stay
 * inline in the chat column — no right session column. Registers OpenTUI's
 * Solid JSX transform before importing the JSX harness. Run with
 * `bun run smoke:sidebar`.
 */
const preload = "@opentui/solid/preload";
await import(preload);
const harness = "./sidebar-smoke-render.tsx";
await import(harness);
