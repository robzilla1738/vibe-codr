import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const DEFAULT_RUNTIME_IMAGE = "node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059";
const runtimeRoot = resolve(root, "dist", "cloud-runtime");
const archive = readdirSync(runtimeRoot).find((name) => /^vibe-cloud-runtime-[0-9a-f]{12}\.tar\.gz$/.test(name));
if (!archive) throw new Error("Cloud runtime archive is missing");
const checksum = `${archive}.sha256`;
if (!existsSync(resolve(runtimeRoot, checksum))) throw new Error("Cloud runtime checksum is missing");
const expected = readFileSync(resolve(runtimeRoot, checksum), "utf8").trim().split(/\s+/)[0];
if (!expected) throw new Error("Cloud runtime checksum is empty");
const actual = createHash("sha256").update(readFileSync(resolve(runtimeRoot, archive))).digest("hex");
if (actual !== expected) throw new Error(`Cloud runtime archive checksum mismatch: expected ${expected}, received ${actual}`);

const image = process.env.VIBE_CLOUD_RUNTIME_IMAGE || DEFAULT_RUNTIME_IMAGE;
execFileSync("docker", [
  "run", "--rm", "--network", "none", "--platform", "linux/amd64",
  "-v", `${runtimeRoot}:/artifacts:ro`, image, "sh", "-lc",
  [
    "set -eu",
    "install -d -m 0700 /tmp/private-home",
    "mkdir -p /tmp/private-home/runtime",
    `tar -xzf '/artifacts/${archive}' -C /tmp/private-home/runtime`,
    "cd /tmp/private-home/runtime",
    "sh install-runtime.sh",
    "./bin/node <<'NODE'",
    "const { createHash } = require('node:crypto');",
    "const { readFileSync, writeFileSync } = require('node:fs');",
    "const hash = (value) => createHash('sha256').update(value).digest('hex');",
    "const revision = JSON.parse(readFileSync('runtime.json', 'utf8')).engineRevision;",
    "const workspace = Buffer.from('offline cloud runtime smoke\\n');",
    "const session = Buffer.from('{}\\n');",
    "const engineFiles = [{ path: 'session/smoke.json', bytes: session.length, sha256: hash(session), contentBase64: session.toString('base64') }];",
    "const engine = { schemaVersion: 1, sessionId: 'cloud-smoke', sourceRoot: '/tmp/source', sourceStateRoot: '/tmp/source-state', ownershipGeneration: 1, executionTarget: { kind: 'cloud', provider: 'e2b' }, engineRevision: revision, createdAt: Date.now(), files: engineFiles, pendingCapabilities: [], archiveSha256: hash(engineFiles.map((file) => `${file.path}\\0${file.bytes}\\0${file.sha256}\\n`).join('')) };",
    "const manifest = { schemaVersion: 1, engineRevision: revision, entries: [{ path: 'README.md', type: 'file', bytes: workspace.length, mode: 420, sha256: hash(workspace) }], git: { isRepository: false, head: null, deleted: [], submodules: [] } };",
    "const files = [{ path: 'workspace/README.md', contentBase64: workspace.toString('base64') }];",
    "const archiveSha256 = hash(JSON.stringify({ manifest, files: files.map((file) => [file.path, hash(Buffer.from(file.contentBase64, 'base64'))]), engine: engine.archiveSha256 }));",
    "writeFileSync('/tmp/handoff.json', JSON.stringify({ manifest: { ...manifest, archiveSha256 }, files, engine }));",
    "NODE",
    "REVISION=\"$(./bin/node -p \"require('./runtime.json').engineRevision\")\"",
    "./bin/node vibe-cloud-bootstrap.mjs /tmp/handoff.json /tmp/project \"$REVISION\"",
    "test \"$(cat /tmp/project/README.md)\" = 'offline cloud runtime smoke'",
    "export VIBE_CLOUD_ACCESS_TOKEN='offline-smoke-access-token-0000000000000000'",
    "export VIBE_CLOUD_PROVIDER=e2b",
    "export VIBE_WORKSPACE_ROOT=/tmp/project",
    "export VIBE_CLOUD_AGENT_PORT=8787",
    "export VIBE_STATE_DIR=/tmp/cloud-state",
    "sh start.sh >/tmp/cloud-agent.log 2>&1 &",
    "AGENT_PID=$!",
    "cleanup() { kill -TERM \"$AGENT_PID\" >/dev/null 2>&1 || true; wait \"$AGENT_PID\" >/dev/null 2>&1 || true; }",
    "trap cleanup EXIT INT TERM",
    "./bin/node --input-type=module <<'NODE'",
    "import { readFileSync } from 'node:fs';",
    "import WebSocket from 'ws';",
    "const token = 'offline-smoke-access-token-0000000000000000';",
    "let last;",
    "for (let attempt = 0; attempt < 80; attempt += 1) {",
    "  try { const response = await fetch('http://127.0.0.1:8787/health', { headers: { authorization: `Bearer ${token}` } }); if (response.ok) break; last = `HTTP ${response.status}`; } catch (error) { last = error.message; }",
    "  await new Promise((resolve) => setTimeout(resolve, 250));",
    "}",
    "const socket = new WebSocket('ws://127.0.0.1:8787', { headers: { authorization: `Bearer ${token}` }, perMessageDeflate: false });",
    "await new Promise((resolve, reject) => {",
    "  const timer = setTimeout(() => reject(new Error(`cloud engine handshake timed out: ${last}`)), 20_000);",
    "  socket.on('message', (raw) => {",
    "    const frame = JSON.parse(raw.toString());",
    "    if (frame.channel === 'agent' && frame.type === 'ready') socket.send(JSON.stringify({ channel: 'engine', payload: { op: 'bootstrap', cwd: '/tmp/project' } }));",
    "    if (frame.channel === 'engine' && frame.payload?.type === 'ready') { clearTimeout(timer); socket.close(); resolve(); }",
    "    if (frame.channel === 'fatal' || frame.channel === 'error') { clearTimeout(timer); reject(new Error(frame.message ?? frame.error)); }",
    "  });",
    "  socket.on('error', reject);",
    "  socket.on('close', (code) => { if (code !== 1000) reject(new Error(`cloud engine disconnected (${code})`)); });",
    "});",
    "process.stdout.write('cloud runtime offline smoke ok\\n');",
    "NODE",
    "kill -0 \"$AGENT_PID\"",
    "kill -TERM \"$AGENT_PID\"",
    "set +e",
    "wait \"$AGENT_PID\"",
    "AGENT_STATUS=$?",
    "set -e",
    "trap - EXIT INT TERM",
    "if [ \"$AGENT_STATUS\" -ne 0 ] && [ \"$AGENT_STATUS\" -ne 143 ]; then cat /tmp/cloud-agent.log >&2; echo \"cloud agent exited unexpectedly: $AGENT_STATUS\" >&2; exit 1; fi",
  ].join("\n"),
], { stdio: "inherit" });
