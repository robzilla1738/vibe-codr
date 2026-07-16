#!/usr/bin/env bun
import { startCloudAgent } from "../src/server.ts";

const provider = process.argv[2];
if (provider !== "e2b" && provider !== "vercel") {
  throw new Error("usage: cloud-agentd <e2b|vercel>");
}
startCloudAgent({ cloudProvider: provider });
