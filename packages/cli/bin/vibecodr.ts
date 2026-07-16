#!/usr/bin/env bun
import { installCrashHandlers } from "@vibe/core";
import { run } from "../src/index.ts";
import { VERSION } from "../src/version.ts";

// First thing: bind fatal-error handlers so an uncaught crash restores the
// terminal, writes a redacted crash log, and prints its path (SIGINT stays the
// TUI's — graceful exit).
installCrashHandlers({ version: VERSION });

run(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`vibecodr: ${(err as Error).message}\n`);
    process.exit(1);
  });
