# Desktop agent peer audit

This audit compares Vibe Codr with the current source—not screenshots or product
copy—of:

- [OpenCode](https://github.com/anomalyco/opencode) at
  `c9db6e9a1fe181fad2259689ef4ad9a5e89fbd5b`
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) at
  `367810a942f180d03042f6c976108ab6c266d52f`

The review focused on session ownership, turn/message/part structure, streaming,
tool and approval lifecycle, transcript presentation, composer continuity,
recovery, and diagnostics. Provider breadth and visual imitation were out of
scope.

## Patterns adopted

| Peer signal | Vibe Codr change |
| --- | --- |
| OpenCode treats messages and parts as stable persisted records and publishes part updates independently. | The canonical protocol now carries turn, message, and part ids, revisions, timestamps, phases, lifecycle, output paths, and sources. Live events and hydration use the same identities. |
| OpenCode exposes explicit session status and correlates permission requests to session work. | Tool calls now distinguish queued, running, waiting for approval, succeeded, failed, and cancelled. Permission requests name the exact tool call and turn. |
| Hermes keeps reactive state per session and never interprets watchdog silence as completion. | Drafts, attachments, and prompt history are project/session scoped. A quiet running turn gets a non-terminal status hint while `engine-idle` remains authoritative. |
| Hermes presents live tools chronologically but preserves compact completed output and file artifacts. | Completed turns have one lossless Work disclosure, structured source/output-path metadata, real turn duration, and an always-primary final answer. |
| Both peers keep async UI work tied to its originating session. | Late submit, paste, replay, and turn-scoped frames are rejected when their project/session/turn identity no longer matches. |

## Bugs and structural weaknesses fixed

- An engine error or incidental command failure could clear Desktop busy while
  follow-up queue work still existed.
- Compound UI transitions crossed IPC as separate commands and could interleave
  with another sender.
- Root session files could represent different saves after interruption. Saves
  now commit a complete hashed generation with an atomic manifest and recover a
  previous complete generation when necessary.
- History hydration invented `+1` changed-line counts when exact counts were not
  persisted.
- Renderer plans, questions, activities, transcript blocks, diagnostics, and
  per-session composer state had inconsistent retention boundaries.
- Completed output offered both Process and Evidence controls for the same
  chronology, and duration was inferred by summing tool time.
- Repeated deterministic tool failures could consume turns indefinitely. The
  fourth identical deterministic attempt is stopped, while transient research
  tools and permission denials remain exempt.

## Deliberate differences

- Vibe Codr remains a presentation shell over the NDJSON engine protocol. It
  does not copy OpenCode's embedded server/database architecture or fork core
  behavior into Electron.
- The existing workspace dock and one edge-attached activity sidebar remain the
  desktop navigation grammar; peer pane layouts were evidence for state
  isolation, not a reason to replace Vibe Codr's established surface.
- Full raw reasoning and tool output stay available under density controls and
  Work disclosure. The default hierarchy is compact, but persistence is
  lossless.

## Follow-on opportunities

The highest-value remaining peer ideas are richer inline artifact previews and
more visible background-session tiles. They should be built on the structured
output paths and multi-runtime state now in place, without adding another
session store or bypassing the engine protocol.
