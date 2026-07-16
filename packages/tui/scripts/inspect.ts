/**
 * Entry for the visual render inspector. Registers OpenTUI's Solid JSX transform
 * before importing the JSX harness, mirroring `smoke.ts`. Run with
 * `bun packages/tui/scripts/inspect.ts`.
 */
const preload = "@opentui/solid/preload";
await import(preload);
const harness = "./inspect-render.tsx";
await import(harness);
