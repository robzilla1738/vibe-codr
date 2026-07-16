import type { GoalContract, Task } from "@vibe/shared";

const HEADING = /^#{1,6}\s+(.+?)\s*$/;
const ITEM = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+?)\s*$/;

function key(text: string): keyof Pick<
  GoalContract,
  "acceptanceCriteria" | "verificationPlan" | "nonGoals" | "assumedScope" | "implementationPlan" | "risks"
> | undefined {
  const h = text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (/success|acceptance|done|completion/.test(h)) return "acceptanceCriteria";
  if (/verif|test|check|validation/.test(h)) return "verificationPlan";
  if (/non goal|out of scope|won t do|will not/.test(h)) return "nonGoals";
  if (/scope|assumption/.test(h)) return "assumedScope";
  if (/risk|pitfall|hazard/.test(h)) return "risks";
  if (/plan|implementation|approach|checklist|steps/.test(h)) return "implementationPlan";
  return undefined;
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 2_000);
}

function unique(values: string[], max = 50): string[] {
  return [...new Set(values.map(clean).filter(Boolean))].slice(0, max);
}

/** Build the immutable execution contract from the grounded plan and seeded task spine. */
export function freezeGoalContract(goal: string, plan: string, tasks: readonly Task[]): GoalContract {
  const buckets: Omit<GoalContract, "goal" | "frozenAt"> = {
    acceptanceCriteria: [],
    verificationPlan: [],
    nonGoals: [],
    assumedScope: [],
    implementationPlan: [],
    risks: [],
  };
  let section: keyof typeof buckets | undefined;
  for (const line of plan.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      section = key(heading[1] ?? "");
      continue;
    }
    const item = ITEM.exec(line);
    if (!item) continue;
    const text = clean(item[1] ?? "");
    if (section) buckets[section].push(text);
    else buckets.implementationPlan.push(text);
  }
  const taskTitles = tasks.map((task) => task.title);
  if (!buckets.implementationPlan.length) buckets.implementationPlan.push(...taskTitles);
  if (!buckets.acceptanceCriteria.length) buckets.acceptanceCriteria.push(...taskTitles);
  if (!buckets.verificationPlan.length) {
    buckets.verificationPlan.push("Run the project's relevant checks and inspect the resulting behavior.");
  }
  return {
    goal: clean(goal),
    acceptanceCriteria: unique(buckets.acceptanceCriteria),
    verificationPlan: unique(buckets.verificationPlan),
    nonGoals: unique(buckets.nonGoals),
    assumedScope: unique(buckets.assumedScope),
    implementationPlan: unique(buckets.implementationPlan),
    risks: unique(buckets.risks),
    frozenAt: Date.now(),
  };
}

export function formatGoalContract(contract: GoalContract): string {
  const block = (title: string, items: readonly string[]) =>
    items.length ? `\n${title}:\n${items.map((item) => `- ${item}`).join("\n")}` : "";
  return (
    `\nFROZEN GOAL CONTRACT (do not weaken or silently reinterpret):\nGoal: ${contract.goal}` +
    block("Acceptance criteria", contract.acceptanceCriteria) +
    block("Verification plan", contract.verificationPlan) +
    block("Non-goals", contract.nonGoals) +
    block("Assumed scope", contract.assumedScope) +
    block("Implementation plan", contract.implementationPlan) +
    block("Risks", contract.risks)
  );
}

/** Stable semantic-ish fingerprint for repeated-gap detection. */
export function gapFingerprint(gaps: readonly string[]): string {
  return unique(
    gaps.map((gap) =>
      gap
        .toLowerCase()
        .replace(/`[^`]+`/g, " code ")
        .replace(/\b\d+\b/g, "#")
        .replace(/[^a-z# ]/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    ),
  )
    .sort()
    .join("|");
}
