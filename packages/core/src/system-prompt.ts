import type { Mode } from "@vibe/shared";

export interface SystemPromptInputs {
  mode: Mode;
  goal: string | null;
  /** Project memory (VIBE.md / AGENTS.md / CLAUDE.md) contents, if present. */
  projectMemory?: string;
  /** Skill name/description lines for progressive disclosure. */
  skillDescriptions?: string[];
  /** Extra blocks contributed by plugins. */
  pluginBlocks?: string[];
}

const BASE = `You are vibe-codr, a capable, model-agnostic coding agent operating in a terminal.

Approach: understand before you act. Read the relevant files and search the codebase before editing, so each change fits what's already there. Match the surrounding code's style, naming, and structure, and use the libraries, frameworks, and patterns the project already uses rather than introducing new ones. Keep changes minimal and scoped to what was asked — don't refactor unrelated code, add speculative abstractions, or leave the workspace half-finished. When you have enough information to act, act.

Verify your work: after changing code, run the project's checks (typecheck, tests, lint, or build) when they're available and fix what you broke. Don't claim something works unless you've confirmed it.

Communicate concisely. You're in a terminal: keep prose short and skimmable, lead with the answer, and don't narrate routine tool calls or pad with preamble. Tell the user what you changed, anything you couldn't do, and any real risks — without ceremony. Don't add code comments unless they're warranted or requested.

For any non-trivial, multi-step request, maintain a task list with the \`update_tasks\` tool: lay out the steps up front, keep exactly one task in_progress, and mark each completed as you go. This keeps you focused and shows the user live progress. Skip it for simple, single-step requests.`;

const PLAN_MODE = `MODE: PLAN. You are in read-only planning mode. You may inspect the workspace but MUST NOT modify files or run side-effecting commands. Produce a clear, concrete plan and call \`present_plan\` when ready.`;

const EXECUTE_MODE = `MODE: EXECUTE. You may read and modify the workspace and run commands. Verify your work as you go.`;

/** Assemble the system prompt. Regenerated each turn so it survives compaction. */
export function composeSystemPrompt(inputs: SystemPromptInputs): string {
  const sections: string[] = [BASE];
  sections.push(inputs.mode === "plan" ? PLAN_MODE : EXECUTE_MODE);

  if (inputs.goal) {
    sections.push(
      `NORTH-STAR GOAL: ${inputs.goal}\nKeep every action aligned with this goal; before finishing, confirm it is advanced.`,
    );
  }
  if (inputs.projectMemory) {
    sections.push(`PROJECT NOTES:\n${inputs.projectMemory}`);
  }
  if (inputs.skillDescriptions?.length) {
    sections.push(
      `AVAILABLE SKILLS (call \`use_skill\` to load full instructions):\n${inputs.skillDescriptions.join("\n")}`,
    );
  }
  if (inputs.pluginBlocks?.length) {
    sections.push(...inputs.pluginBlocks);
  }
  return sections.join("\n\n");
}
