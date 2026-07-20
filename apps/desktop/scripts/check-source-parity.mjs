#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";

const electronRoot = resolve(import.meta.dirname, "..");
const vibeRoot = process.env.VIBE_CODR_ROOT || [
  resolve(electronRoot, "..", ".."),
  resolve(electronRoot, "..", "cli"),
  resolve(electronRoot, "..", "vibe-codr"),
  join(homedir(), "Code", "vibe-codr"),
  join(homedir(), "code", "vibe-codr"),
].find((candidate) => existsSync(join(candidate, ".git"))) || join(homedir(), "Code", "vibe-codr");
const engineCommit = readFileSync(join(electronRoot, "ENGINE_COMMIT"), "utf8").trim();
if (!/^[0-9a-f]{40}$/i.test(engineCommit)) {
  console.error("CLI source parity check failed: ENGINE_COMMIT must contain a 40-character git commit");
  process.exit(1);
}

function lockedEngineSource(relativePath) {
  try {
    return execFileSync(
      "git",
      ["-C", vibeRoot, "show", `${engineCommit}:${relativePath}`],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
  } catch {
    throw new Error(
      `Could not read ${relativePath} at locked engine ${engineCommit}; fetch ENGINE_COMMIT in ${vibeRoot}`,
    );
  }
}

// Files where the Electron app intentionally diverges from the upstream TUI.
// `extras` allows declarations not in upstream; `drift` allows modified
// versions of upstream declarations. Both are documented in PARITY.md.
const ALLOW_EXTRAS = new Set([
  "modes",       // selectModeAction for the mode dropdown
  "reducer",     // isMarkdown flag on tool blocks for spawn_subagent/spawn_tasks
  "density",     // isMarkdown check in toolCollapsed for verbose expansion
  "tool-icons",  // permissionKind/permissionDetail/permissionPreview for the GUI card
  "themes",      // Electron-specific palette values (Graphite default differs)
  "trail",       // Electron hard-caps newline-free reasoning streams for renderer safety
  "file-fuzzy",  // formatAtPath + quoted/space-safe applyAtMention for Electron @ pick / paste
]);

// Forward-compatible additions already present in the active TUI worktree but
// not necessarily published to vibe-codr/main yet. Keep these declaration-
// scoped so unrelated drift in the same source files still fails the gate.
const ALLOW_DECLARATION_EXTRAS = new Map([
  ["spinner", new Set(["FunctionDeclaration:compactElapsed"])],
  [
    "editor-compose",
    new Set([
      "FirstStatement:EDITOR_DRAFT_MAX_BYTES",
      "FunctionDeclaration:readEditorDraft",
    ]),
  ],
]);
const ALLOW_DECLARATION_DRIFT = new Map([
  // Electron writes external-editor drafts with 0600 permissions; upstream's
  // behavior is otherwise identical but still uses the default file mode.
  ["editor-compose", new Set(["FunctionDeclaration:composeInEditor"])],
  ["glyphs", new Set(["FirstStatement:GLYPH"])],
]);

const pairs = [
  ["packages/shared/src/cloud-runtime.ts", "src/main/cloud/cloud-runtime.ts", {}],
  ["packages/providers/src/runtime-metadata.ts", "src/shared/provider-runtime-metadata.ts", {}],
  ["packages/providers/src/provider-manifest.ts", "src/shared/provider-manifest.ts", {}],
  ...[
    "slash",
    "reducer",
    "modes",
    "density",
    "file-fuzzy",
    "markdown-blocks",
    "rich-blocks",
    "tool-icons",
    "chrome-seed",
    "spinner",
    "trail",
    "editor-compose",
    "themes",
    "glyphs",
    "wordmark",
  ].map((name) => [
    `packages/tui/src/${name}.ts`,
    `src/shared/${name}.ts`,
    {
      extras: ALLOW_EXTRAS.has(name),
      drift: ALLOW_EXTRAS.has(name),
      extraDeclarations: ALLOW_DECLARATION_EXTRAS.get(name),
      driftDeclarations: ALLOW_DECLARATION_DRIFT.get(name),
    },
  ]),
];

function declarationName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations
      .map((declaration) => ts.isIdentifier(declaration.name) ? declaration.name.text : "")
      .filter(Boolean)
      .join(",");
  }
  return null;
}

function declarations(path, contents = readFileSync(path, "utf8")) {
  const source = ts.createSourceFile(
    path,
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const out = new Map();
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) continue;
    const name = declarationName(node);
    if (!name) continue;
    // SourceFile is supplied explicitly so printing is stable across the two paths.
    out.set(`${ts.SyntaxKind[node.kind]}:${name}`, printer.printNode(ts.EmitHint.Unspecified, node, source));
  }
  return out;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return null;
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function objectMapKeys(path, variableName, contents = readFileSync(path, "utf8")) {
  const source = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== variableName || !declaration.initializer) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (!ts.isObjectLiteralExpression(initializer)) {
        throw new Error(`${path}: ${variableName} must be an object literal`);
      }
      return new Set(initializer.properties.map((property) => propertyName(property.name)).filter(Boolean));
    }
  }
  throw new Error(`${path}: missing ${variableName}`);
}

function requireEqualDiscriminators(label, expected, actual, failures) {
  const missing = [...expected].filter((type) => !actual.has(type));
  const unexpected = [...actual].filter((type) => !expected.has(type));
  if (missing.length) failures.push(`${label}: missing discriminators ${missing.join(", ")}`);
  if (unexpected.length) failures.push(`${label}: unexpected discriminators ${unexpected.join(", ")}`);
}

const failures = [];
for (const [upstreamRel, electronRel, allowElectronExtras] of pairs) {
  const upstreamPath = join(vibeRoot, upstreamRel);
  const electronPath = join(electronRoot, electronRel);
  if (!existsSync(electronPath)) {
    failures.push(`${electronRel}: Electron port missing`);
    continue;
  }
  let upstream;
  try {
    upstream = declarations(upstreamPath, lockedEngineSource(upstreamRel));
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    continue;
  }
  const electron = declarations(electronPath);
  const allowExtras = typeof allowElectronExtras === "object" ? allowElectronExtras.extras : allowElectronExtras;
  const allowDrift = typeof allowElectronExtras === "object" ? allowElectronExtras.drift : false;
  const extraDeclarations = allowElectronExtras?.extraDeclarations ?? new Set();
  const driftDeclarations = allowElectronExtras?.driftDeclarations ?? new Set();
  // Normalize whitespace so formatting-only differences (line wrapping, spacing)
  // don't cause false drift. The TS printer preserves original newlines in
  // array/object literals, so a single-line vs multi-line array would drift
  // even when semantically identical. Collapsing whitespace before comparison
  // catches real code changes while ignoring pure formatting.
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  for (const [key, value] of upstream) {
    if (!electron.has(key)) failures.push(`${electronRel}: missing upstream declaration ${key}`);
    else if (!allowDrift && !driftDeclarations.has(key) && norm(electron.get(key)) !== norm(value)) failures.push(`${electronRel}: drifted declaration ${key}`);
  }
  if (!allowExtras) {
    for (const key of electron.keys()) {
      if (!upstream.has(key) && !extraDeclarations.has(key)) failures.push(`${electronRel}: unexpected declaration ${key}`);
    }
  }
}

// Protocol parity is schema-driven. Desktop compatibility files may re-export
// canonical APIs, but must never regain discriminator maps or copied unions.
// The golden fixture covers every host frame family so adding a transport frame
// without fixture evidence fails this release gate deterministically.
try {
  const canonicalDomainPath = join(vibeRoot, "packages/protocol/src/domain.ts");
  const canonicalHostPath = join(vibeRoot, "packages/protocol/src/host.ts");
  const desktopProtocolPath = join(electronRoot, "src/shared/protocol.ts");
  const desktopProtocol = readFileSync(desktopProtocolPath, "utf8");
  if (!desktopProtocol.includes('from "@vibe/protocol"')) {
    failures.push("src/shared/protocol.ts: canonical @vibe/protocol facade missing");
  }
  for (const copiedAuthority of ["ENGINE_COMMAND_TYPE_MAP", "UI_EVENT_TYPE_MAP", "const RPC_METHODS = new Set"]) {
    if (desktopProtocol.includes(copiedAuthority)) {
      failures.push(`src/shared/protocol.ts: copied protocol authority ${copiedAuthority}`);
    }
  }

  const hostOps = objectMapKeys(canonicalHostPath, "HOST_INBOUND_FRAME_SCHEMAS");
  const hostTypes = objectMapKeys(canonicalHostPath, "HOST_OUTBOUND_FRAME_SCHEMAS");
  const fixtureLines = readFileSync(
    join(vibeRoot, "packages/protocol/fixtures/host-protocol-v2.jsonl"),
    "utf8",
  ).trim().split("\n").map((line) => JSON.parse(line));
  const fixtureOps = new Set(fixtureLines.flatMap((frame) => typeof frame.op === "string" ? [frame.op] : []));
  const fixtureTypes = new Set(fixtureLines.flatMap((frame) => typeof frame.type === "string" ? [frame.type] : []));
  requireEqualDiscriminators("protocol golden inbound frames", hostOps, fixtureOps, failures);
  requireEqualDiscriminators("protocol golden outbound frames", hostTypes, fixtureTypes, failures);

  // Reading both registries makes malformed/missing canonical discriminator
  // maps fail the gate even though desktop no longer copies them.
  objectMapKeys(canonicalDomainPath, "ENGINE_COMMAND_SCHEMAS");
  objectMapKeys(canonicalDomainPath, "eventSchemas");
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

// The Electron palette intentionally groups and describes commands differently
// from the TUI, so declaration-level parity is too strict. Still require every
// canonical engine command to remain discoverable except the three documented
// duplicate aliases: /models (same picker as /model), /new, and /quit.
try {
  const upstreamCommands = new Set(
    [...lockedEngineSource("packages/core/src/commands.ts").matchAll(/name:\s*"([^"]+)"/g)]
      .map((match) => match[1]),
  );
  const electronCommands = new Set(
    [...readFileSync(join(electronRoot, "src/shared/commands-catalog.ts"), "utf8").matchAll(/name:\s*"([^"]+)"/g)]
      .map((match) => match[1]),
  );
  const hiddenAliases = new Set(["models", "new", "quit"]);
  for (const name of upstreamCommands) {
    if (!hiddenAliases.has(name) && !electronCommands.has(name)) {
      failures.push(`src/shared/commands-catalog.ts: missing engine slash command /${name}`);
    }
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

if (failures.length) {
  console.error("CLI source parity check failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`CLI source parity OK (${pairs.length} source pairs)`);
