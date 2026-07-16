# UI preview harness

Runs the real renderer in a plain browser with a mocked `window.vibe` bridge —
no Electron, no engine host — so visual states can be exercised, reviewed, and
screenshotted deterministically.

```bash
# serve the renderer with the mock bridge
npm run ui:preview

# open a scenario
open "http://localhost:4517/?scenario=chat"

# screenshot every scenario (needs `npx playwright install chromium` once)
npm run ui:shots -- tools/ui-preview/shots
```

Scenarios: `welcome`, `splash` (quiet empty home + composer), `chat`, `table`,
`docs`, `sources`, `busy`, `permission`, `plan`, `gate`, `mode`, `queue`,
`onboarding`, `slash`, `catalog`, `catalog-draft`, `mention`, `attachments`,
`jobs`, `inspector`, `changes`, `toast`, `density-quiet`, `density-verbose`, `ctx-hot`,
`sessions`, `settings`, `git` — plus `&theme=<name>` for any registered TUI theme (e.g.
`?scenario=chat&theme=opencode`). Shots also capture `busy-narrow`, `busy-wide`,
`light`, and `theme-opencode`. `attachments` previews the dropped-image and
file-reference composer state, including Finder-style URI path fallback. The
`inspector` exercises Session, while `changes` opens the expanded master-detail
changed-files review with recursive navigation, totals, and numbered Diff/File content;
`settings` remains a full-workspace tool; `git` and `inspector` exercise the
right-side activity surface; `sessions` covers the persistent Board/List manager.
Live app chrome (not fully mirrored in every mock
scenario) also includes the workspace dock, shared Session/Changes/Git/Terminal/Jobs
activity sidebar, and changed-files footer chip — prefer `npm run dev` or E2E when
checking panel switching, persistent native PTY behavior, reserved chat space,
or native Finder actions.

Dev tooling only: nothing in this folder ships in the app bundle, and the mock
event timelines live entirely in `mock-vibe.ts`.
