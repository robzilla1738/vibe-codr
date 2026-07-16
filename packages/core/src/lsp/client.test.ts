import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient, defaultLspSpawn } from "./client.ts";

/**
 * A REAL mock language server, run over stdio via `bun -e`. It speaks the LSP
 * Content-Length JSON-RPC framing for real — no Bun.spawn mock — so these tests
 * exercise the actual transport (framing, handshake, version-matched
 * publishDiagnostics, and the diagnose deadline against a silent server).
 */
function mockServerScript(opts: { silent: boolean }): string {
  return `
    const SILENT = ${opts.silent};
    let buf = Buffer.alloc(0);
    function send(msg) {
      const body = Buffer.from(JSON.stringify(msg), "utf8");
      const header = Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "ascii");
      process.stdout.write(Buffer.concat([header, body]));
    }
    function handle(msg) {
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { textDocumentSync: 1 } } });
      } else if (msg.method === "textDocument/didOpen" || msg.method === "textDocument/didChange") {
        if (SILENT) return;
        const td = msg.params.textDocument;
        send({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: {
            uri: td.uri,
            version: td.version,
            diagnostics: [{
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              severity: 1,
              code: "E001",
              source: "mock",
              message: "mock type error",
            }],
          },
        });
      }
    }
    process.stdin.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const i = buf.indexOf("\\r\\n\\r\\n");
        if (i < 0) break;
        const header = buf.slice(0, i).toString("ascii");
        const m = /Content-Length:\\s*(\\d+)/i.exec(header);
        if (!m) { buf = buf.slice(i + 4); continue; }
        const len = parseInt(m[1], 10);
        if (buf.length < i + 4 + len) break;
        const body = buf.slice(i + 4, i + 4 + len).toString("utf8");
        buf = buf.slice(i + 4 + len);
        let msg; try { msg = JSON.parse(body); } catch { continue; }
        handle(msg);
      }
    });
  `;
}

function makeClient(silent: boolean, rootPath: string): LspClient {
  return new LspClient({
    command: "bun",
    args: ["-e", mockServerScript({ silent })],
    rootPath,
    languageId: "python",
    initializeTimeoutMs: 5_000,
    spawn: defaultLspSpawn,
  });
}

test("handshake + version-matched publishDiagnostics round-trip over real stdio", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-lsp-client-"));
  const file = join(dir, "broken.py");
  writeFileSync(file, "x: int = 'nope'\n");

  const client = makeClient(false, dir);
  try {
    // start() only resolves once the real initialize handshake completed.
    await client.start();
    const out = await client.diagnose(file, 3_000);
    expect(out).toBeString();
    expect(out).toContain("LSP diagnostics (python)");
    expect(out).toContain(":1:1");
    expect(out).toContain("E001");
    expect(out).toContain("mock type error");

    // A second diagnose bumps the document version (didChange) and still round-
    // trips — the client waits for the NEW version's publishDiagnostics.
    writeFileSync(file, "y: int = 'still nope'\n");
    const again = await client.diagnose(file, 3_000);
    expect(again).toContain("mock type error");
  } finally {
    client.dispose();
  }
});

test("a silent server hits the per-diagnose deadline → undefined (never a false clean)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-lsp-silent-"));
  const file = join(dir, "quiet.py");
  writeFileSync(file, "z = 1\n");

  const client = makeClient(true, dir);
  try {
    // The handshake still succeeds — only publishDiagnostics is withheld.
    await client.start();
    const started = Date.now();
    const out = await client.diagnose(file, 300);
    expect(out).toBeUndefined();
    // It returned promptly on the deadline, not after some unbounded wait.
    expect(Date.now() - started).toBeLessThan(2_000);
  } finally {
    client.dispose();
  }
});
