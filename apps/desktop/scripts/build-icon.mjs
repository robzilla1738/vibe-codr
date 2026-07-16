#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "assets", "icon.png");
const iconset = join(root, "assets", "icon.iconset");
const out = join(root, "assets", "icon.icns");

if (!existsSync(source)) {
  console.error(`Missing icon source: ${source}`);
  process.exit(1);
}

mkdirSync(iconset, { recursive: true });
try {
  // Normalize to a square 1024 master so iconutil sizes stay crisp.
  const master = join(iconset, "master-1024.png");
  execFileSync("/usr/bin/sips", ["-z", "1024", "1024", source, "--out", master], { stdio: "ignore" });
  for (const [name, size] of [
    ["icon_16x16.png", 16], ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024],
  ]) {
    execFileSync("/usr/bin/sips", ["-z", String(size), String(size), master, "--out", join(iconset, name)], {
      stdio: "ignore",
    });
  }
  execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", out]);
} finally {
  rmSync(iconset, { recursive: true, force: true });
}
