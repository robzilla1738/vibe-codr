/**
 * Entry for the README screenshot generator. Registers OpenTUI's Solid JSX
 * transform before importing the JSX harness (mirroring `smoke.ts`), so `App`
 * renders under the test renderer. Run: `bun packages/tui/scripts/screenshot.ts <outDir>`.
 */
const preload = "@opentui/solid/preload";
await import(preload);
const harness = "./screenshot.tsx";
await import(harness);
