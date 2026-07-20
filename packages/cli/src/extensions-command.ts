import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { ExtensionLifecycleStore, verifyCatalogIndex, type CatalogEntryKind } from "@vibe/plugins";

export interface ExtensionCommandOptions {
  args: string[];
  catalogKey?: string;
  keyId?: string;
  entry?: string;
  artifact?: string;
  confirmCapabilities?: boolean;
  root?: string;
}

export async function runExtensionsCommand(options: ExtensionCommandOptions): Promise<{ exitCode: 0 | 1; stdout: string; stderr: string }> {
  const store = new ExtensionLifecycleStore(options.root ?? join(homedir(), ".vibe", "extensions"));
  const action = options.args[0] ?? "list";
  try {
    if (action === "list") return ok(`${JSON.stringify(await store.list(), null, 2)}\n`);
    if (action === "install" || action === "update") {
      const catalogPath = options.args[1];
      if (!catalogPath || !options.catalogKey || !options.keyId || !options.entry || !options.artifact) {
        throw new Error("install requires <catalog.json> --catalog-key <public.pem> --key-id <id> --entry <kind:id@version> --artifact <file>");
      }
      const catalog = verifyCatalogIndex(await readFile(catalogPath), new Map([[options.keyId, await readFile(options.catalogKey, "utf8")]]));
      const identity = parseCatalogIdentity(options.entry);
      const entry = catalog.entries.find((item) => item.kind === identity.kind && item.id === identity.id && item.version === identity.version);
      if (!entry) throw new Error("The exact extension entry is not present in the verified catalog");
      if (entry.requiredCapabilities.length && !options.confirmCapabilities) {
        return { exitCode: 1, stdout: `${JSON.stringify({ entry: options.entry, requiredCapabilities: entry.requiredCapabilities }, null, 2)}\n`, stderr: "Review capabilities, then repeat with --confirm-capabilities\n" };
      }
      return ok(`${JSON.stringify(await store.install(entry, options.artifact), null, 2)}\n`);
    }
    const identity = parseInstalledIdentity(options.args[1]);
    if (action === "enable") return ok(`${JSON.stringify(await store.setEnabled(identity.kind, identity.id, true), null, 2)}\n`);
    if (action === "disable") return ok(`${JSON.stringify(await store.setEnabled(identity.kind, identity.id, false), null, 2)}\n`);
    if (action === "rollback") return ok(`${JSON.stringify(await store.rollback(identity.kind, identity.id), null, 2)}\n`);
    throw new Error("expected list, install, update, enable, disable, or rollback");
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `vibecodr extensions: ${error instanceof Error ? error.message : String(error)}\n` };
  }
}

function parseCatalogIdentity(value: string): { kind: CatalogEntryKind; id: string; version: string } {
  const installed = parseInstalledIdentity(value.slice(0, value.lastIndexOf("@")));
  const version = value.slice(value.lastIndexOf("@") + 1);
  if (!version || value.lastIndexOf("@") <= value.indexOf(":")) throw new Error("Entry must be kind:id@version");
  return { ...installed, version };
}

function parseInstalledIdentity(value?: string): { kind: CatalogEntryKind; id: string } {
  const split = value?.indexOf(":") ?? -1;
  const kind = value?.slice(0, split) as CatalogEntryKind;
  const id = value?.slice(split + 1) ?? "";
  if (!(["plugin", "skill", "mcp"] as string[]).includes(kind) || !id) throw new Error("Extension identity must be plugin:id, skill:id, or mcp:id");
  return { kind, id };
}

function ok(stdout: string): { exitCode: 0; stdout: string; stderr: string } { return { exitCode: 0, stdout, stderr: "" }; }
