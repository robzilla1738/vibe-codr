# Security policy

## Reporting a vulnerability

Please don't open a public issue for security problems. Instead, use
[GitHub's private vulnerability reporting](https://github.com/robzilla1738/vibe-codr/security/advisories/new)
so there's time to fix it before details are public.

You can expect an initial response within a few days. If the report is valid,
you'll get credit in the fix's release notes unless you'd rather stay
anonymous.

## What counts

vibe-codr executes shell commands, edits files, and fetches URLs on behalf of
a language model, so the interesting bugs are usually about containment:

- Bypasses of the permission layer (a deny rule that an equivalent path or
  command spelling can evade, a tool that runs without gating in `ask` mode)
- Escapes from the opt-in OS sandbox (Seatbelt / bubblewrap)
- SSRF in `webfetch` or the search stack (the DNS-rebinding and private-IP
  guards are supposed to hold)
- Prompt-injection paths that turn fetched web content into unauthorized tool
  use
- Secrets leaking into session files, crash logs, or the transcript

## Supported versions

Only the latest release gets fixes. There's no backporting; upgrading is
cheap (`vibe upgrade`).
