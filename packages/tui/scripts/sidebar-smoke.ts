/**
 * Entry for the WIDE-terminal (sidebar) render smoke test: sidebar top/bottom
 * alignment with the chat column, the Thinking/Activity trail, and transcript
 * render windowing (fold row + tap-to-reveal). Registers OpenTUI's Solid JSX
 * transform before importing the JSX harness, mirroring `smoke.ts`. Run with
 * `bun run smoke:sidebar`.
 */
const preload = "@opentui/solid/preload";
await import(preload);
const harness = "./sidebar-smoke-render.tsx";
await import(harness);
