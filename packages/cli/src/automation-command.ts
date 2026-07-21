import { readFile } from "node:fs/promises";
import { AutomationStore, machineAutomationRoot } from "@vibe/automation";

export async function runAutomationCommand(options: {
  args: string[];
  confirmMutation?: boolean;
  root?: string;
}): Promise<{ exitCode: 0 | 1; stdout: string; stderr: string }> {
  const store = new AutomationStore(options.root ?? machineAutomationRoot());
  const action = options.args[0] ?? "list";
  try {
    let value: unknown;
    if (action === "list") value = await store.list();
    else if (action === "history") value = await store.history(options.args[1]);
    else if (action === "save") {
      if (!options.args[1]) throw new Error("save requires a versioned automation JSON file");
      value = await store.save(JSON.parse(await readFile(options.args[1], "utf8")), { confirmUnattendedMutation: options.confirmMutation });
    } else if (action === "enable" || action === "disable") {
      if (!options.args[1]) throw new Error(`${action} requires an automation id`);
      value = await store.setEnabled(options.args[1], action === "enable");
    } else if (action === "claim") {
      value = await store.claimDue(options.args[1] === undefined ? 16 : Number(options.args[1]));
    } else if (action === "complete") {
      if (!options.args[1]) throw new Error("complete requires a run id");
      value = await store.complete(options.args[1], { ok: options.args[2] !== "failed", ...(options.args[3] ? { reason: options.args.slice(3).join(" ") } : {}) });
    } else if (action === "cancel") {
      if (!options.args[1]) throw new Error("cancel requires a run id");
      value = await store.cancel(options.args[1], options.args.slice(2).join(" ") || undefined);
    } else throw new Error("expected list, history, save, enable, disable, claim, complete, or cancel");
    return { exitCode: 0, stdout: `${JSON.stringify(value, null, 2)}\n`, stderr: "" };
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `vibecodr automation: ${error instanceof Error ? error.message : String(error)}\n` };
  }
}
