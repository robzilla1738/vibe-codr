#!/usr/bin/env bun
import { run } from "../src/index.ts";

run(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`vibe: ${(err as Error).message}\n`);
    process.exit(1);
  });
