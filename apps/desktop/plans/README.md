# Plans index

| Document | Purpose | Status |
|----------|---------|--------|
| [IMPROVEMENT-AUDIT.md](./IMPROVEMENT-AUDIT.md) | Verified improvement backlog and public-release hardening record | In-scope residual closed; release workflow implemented |
| [DESIGN-POLISH-AUDIT.md](./DESIGN-POLISH-AUDIT.md) | Visual/interaction polish inventory (layout, motion, focus, type, responsive) | Implemented — all 62 findings dispositioned; terminal/sidebar follow-up complete |

## Implemented (this pass)

1. Host quit-during-bootstrap preemption + process-group kill + stdin write queue (epoch-safe drain)  
2. Busy-rule send-failure policy (mid-turn incidental send)  
3. File read realpath + byte cap; gh/git capture caps; cwd allowlist after successful bootstrap  
4. Renderer: catalog cancel, /jobs exclusivity, streaming plain markdown, session memo, block retention, density toast after send  
5. CI: `test:coverage` + `smoke:bridge` in workflow/`verify:ci`; preload key contract; dock e2e; docs honesty  
6. UI polish: structural five-view activity sidebar, persistent contextual PTY,
   compact terminal typography, invariant ASCII wordmark, quiet transcript
   notices, diff/plan/task spacing, and project-rail interaction cleanup
7. Release hardening: engine commit lock, SHA-pinned Actions, symmetric config
   size limits, bounded TTL/LRU state, complete 40-field config shape, MCP/OAuth
   validation, and signed/notarized/stapled tag publishing with checksums
8. Editing-workspace polish: engine continuations separated from user turns,
   reliable native assistant Copy, master-detail Changes review, session view and
   scroll preservation, contextual project/home terminals, plan-card cleanup,
   rotating loaders, uniform rail icons/type, and the equally inset grey dock
9. Unified v0.6.1 polish: AI SDK 7 streaming, one expandable Work phase per
   turn, live Sessions state, complete model-aware Cloud handoff with opt-outs,
   and a neutral-white Vibe Dark default accent

## External or optional follow-up

- Running the implemented public release workflow requires the protected
  environment's Apple credentials.
- Engine-adjacent: edit-resubmit protocol and host protocol version emission.
- Optional product work: in-app auto-update channel, true list virtualization,
  Biome formatter enablement, and a larger macOS e2e matrix.

## Verification snapshot (2026-07-16)

622 passing unit tests (2 paid-provider tests skipped), 12 e2e scenarios, 21 source pairs, 40 config fields, coverage
floors, bridge smoke, and locked-engine packaged smoke green. See root
`VERIFICATION.md` / `ACCEPTANCE.md`.
