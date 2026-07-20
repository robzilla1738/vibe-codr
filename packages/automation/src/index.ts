import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, stat, unlink, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import {
  AutomationSpecV1Schema,
  automationCanMutate,
  type AutomationSpecV1,
  type AutomationTriggerV1,
} from "@vibe/protocol";

export interface AutomationRecordV1 extends AutomationSpecV1 {
  createdAt: number;
  updatedAt: number;
  nextRunAt: number;
}

export type AutomationRunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted" | "skipped";

export interface AutomationRunV1 {
  id: string;
  automationId: string;
  idempotencyKey: string;
  scheduledAt: number;
  startedAt: number;
  finishedAt?: number;
  status: AutomationRunStatus;
  reason?: string;
  costUSD?: number;
}

export interface AutomationClaimV1 {
  run: AutomationRunV1;
  spec: AutomationRecordV1;
  leaseExpiresAt: number;
}

interface AutomationLeaseV1 {
  automationId: string;
  runId: string;
  ownerId: string;
  expiresAt: number;
}

interface AutomationStateV1 {
  schemaVersion: 1;
  specs: AutomationRecordV1[];
  runs: AutomationRunV1[];
  leases: AutomationLeaseV1[];
}

export interface SaveAutomationOptions {
  confirmUnattendedMutation?: boolean;
}

export interface AutomationStoreOptions {
  ownerId?: string;
  now?: () => number;
  leaseMs?: number;
  lockTimeoutMs?: number;
}

const MAX_HISTORY = 2_000;
const LOCK_STALE_MS = 30_000;

/** Machine-local durable scheduler state. It claims work but intentionally does
 * not open a runtime; callers execute claims and report completion. */
export class AutomationStore {
  readonly root: string;
  readonly ownerId: string;
  #now: () => number;
  #leaseMs: number;
  #lockTimeoutMs: number;

  constructor(root: string, options: AutomationStoreOptions = {}) {
    this.root = root;
    this.ownerId = options.ownerId ?? `automation-${process.pid}-${randomUUID()}`;
    this.#now = options.now ?? Date.now;
    this.#leaseMs = options.leaseMs ?? 5 * 60_000;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
  }

  async save(input: unknown, options: SaveAutomationOptions = {}): Promise<AutomationRecordV1> {
    const spec = AutomationSpecV1Schema.parse(input);
    validateTrigger(spec.trigger);
    if (automationCanMutate(spec) && !options.confirmUnattendedMutation) {
      throw new Error("Saving unattended mutating automation requires explicit confirmation");
    }
    return this.#locked(async (state) => {
      const now = this.#now();
      const previous = state.specs.find((item) => item.id === spec.id);
      const record: AutomationRecordV1 = {
        ...spec,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        nextRunAt: nextTriggerAt(spec.trigger, now),
      };
      state.specs = previous
        ? state.specs.map((item) => item.id === record.id ? record : item)
        : [...state.specs, record];
      return freezeClone(record);
    });
  }

  async list(): Promise<readonly AutomationRecordV1[]> {
    return this.#locked((state) => freezeClone(state.specs));
  }

  async history(automationId?: string): Promise<readonly AutomationRunV1[]> {
    return this.#locked((state) => freezeClone(
      state.runs.filter((run) => !automationId || run.automationId === automationId),
    ));
  }

  async setEnabled(id: string, enabled: boolean): Promise<AutomationRecordV1> {
    return this.#locked((state) => {
      const current = state.specs.find((spec) => spec.id === id);
      if (!current) throw new Error(`Unknown automation: ${id}`);
      const now = this.#now();
      const next = {
        ...current,
        enabled,
        updatedAt: now,
        ...(enabled ? { nextRunAt: nextTriggerAt(current.trigger, now) } : {}),
      };
      state.specs = state.specs.map((spec) => spec.id === id ? next : spec);
      return freezeClone(next);
    });
  }

  async claimDue(limit = 16): Promise<readonly AutomationClaimV1[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("claim limit must be 1..100");
    return this.#locked((state) => {
      const now = this.#now();
      recoverExpired(state, now);
      const claims: AutomationClaimV1[] = [];
      const due = state.specs.filter((spec) => spec.enabled && spec.nextRunAt <= now)
        .sort((a, b) => a.nextRunAt - b.nextRunAt || a.id.localeCompare(b.id));
      for (const spec of due) {
        if (claims.length >= limit) break;
        const scheduledAt = spec.nextRunAt;
        const key = runKey(spec.id, scheduledAt);
        const active = state.leases.find((lease) => lease.automationId === spec.id && lease.expiresAt > now);
        const duplicate = state.runs.some((run) => run.idempotencyKey === key);
        spec.nextRunAt = nextTriggerAt(spec.trigger, now); // missed-run policy: skip backlog
        spec.updatedAt = now;
        if (duplicate) continue;
        if (active) {
          state.runs.push({
            id: randomUUID(), automationId: spec.id, idempotencyKey: key,
            scheduledAt, startedAt: now, finishedAt: now, status: "skipped",
            reason: "overlap policy skipped a run while the prior lease was active",
          });
          continue;
        }
        const run: AutomationRunV1 = {
          id: randomUUID(), automationId: spec.id, idempotencyKey: key,
          scheduledAt, startedAt: now, status: "running",
        };
        const lease: AutomationLeaseV1 = {
          automationId: spec.id, runId: run.id, ownerId: this.ownerId,
          expiresAt: now + Math.min(this.#leaseMs, spec.timeoutMs + 60_000),
        };
        state.runs.push(run);
        state.leases.push(lease);
        claims.push(freezeClone({ run, spec, leaseExpiresAt: lease.expiresAt }));
      }
      trimHistory(state);
      return freezeClone(claims);
    });
  }

  async heartbeat(runId: string): Promise<number> {
    return this.#locked((state) => {
      const lease = state.leases.find((item) => item.runId === runId && item.ownerId === this.ownerId);
      if (!lease) throw new Error("Automation lease is not owned by this scheduler");
      const spec = state.specs.find((item) => item.id === lease.automationId);
      if (!spec) throw new Error("Automation lease references an unknown spec");
      lease.expiresAt = this.#now() + Math.min(this.#leaseMs, spec.timeoutMs + 60_000);
      return lease.expiresAt;
    });
  }

  async complete(runId: string, result: { ok: boolean; reason?: string; costUSD?: number }): Promise<AutomationRunV1> {
    return this.#finish(runId, result.ok ? "completed" : "failed", result);
  }

  async cancel(runId: string, reason = "cancelled by user"): Promise<AutomationRunV1> {
    return this.#finish(runId, "cancelled", { reason });
  }

  async #finish(
    runId: string,
    status: "completed" | "failed" | "cancelled",
    result: { reason?: string; costUSD?: number },
  ): Promise<AutomationRunV1> {
    return this.#locked((state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run) throw new Error(`Unknown automation run: ${runId}`);
      if (run.status !== "running") return freezeClone(run);
      const lease = state.leases.find((item) => item.runId === runId);
      if (status !== "cancelled" && lease?.ownerId !== this.ownerId)
        throw new Error("Automation lease is not owned by this scheduler");
      run.status = status;
      run.finishedAt = this.#now();
      if (result.reason) run.reason = boundedReason(result.reason);
      if (result.costUSD !== undefined) {
        if (!Number.isFinite(result.costUSD) || result.costUSD < 0) throw new Error("Invalid automation cost");
        run.costUSD = result.costUSD;
      }
      state.leases = state.leases.filter((item) => item.runId !== runId);
      return freezeClone(run);
    });
  }

  async #locked<T>(operation: (state: AutomationStateV1) => T | Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700).catch(() => undefined);
    const release = await acquireFileLock(join(this.root, ".automations.lock"), this.ownerId, this.#now, this.#lockTimeoutMs);
    try {
      const state = await readState(join(this.root, "automations.json"));
      const result = await operation(state);
      await writeState(this.root, state);
      return result;
    } finally {
      await release();
    }
  }
}

export function nextTriggerAt(trigger: AutomationTriggerV1, after: number): number {
  validateTrigger(trigger);
  if (trigger.kind === "interval") return after + trigger.everyMs;
  const cron = parseCron(trigger.expression);
  let candidate = Math.floor(after / 60_000) * 60_000 + 60_000;
  const limit = candidate + 366 * 24 * 60 * 60_000;
  for (; candidate <= limit; candidate += 60_000) {
    const date = new Date(candidate);
    const dayOfMonth = cron.dayOfMonth.has(date.getUTCDate());
    const dayOfWeek = cron.dayOfWeek.has(date.getUTCDay());
    const dayMatches = cron.domWildcard
      ? dayOfWeek
      : cron.dowWildcard
        ? dayOfMonth
        : dayOfMonth || dayOfWeek;
    if (cron.minute.has(date.getUTCMinutes()) && cron.hour.has(date.getUTCHours())
      && cron.month.has(date.getUTCMonth() + 1) && dayMatches) return candidate;
  }
  throw new Error("Cron expression has no occurrence within one year");
}

function validateTrigger(trigger: AutomationTriggerV1): void {
  if (trigger.kind === "cron") parseCron(trigger.expression);
}

function parseCron(expression: string): {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  domWildcard: boolean;
  dowWildcard: boolean;
} {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron trigger requires five UTC fields");
  const dayOfWeek = cronField(fields[4]!, 0, 7);
  if (dayOfWeek.delete(7)) dayOfWeek.add(0);
  return {
    minute: cronField(fields[0]!, 0, 59),
    hour: cronField(fields[1]!, 0, 23),
    dayOfMonth: cronField(fields[2]!, 1, 31),
    month: cronField(fields[3]!, 1, 12),
    dayOfWeek,
    domWildcard: fields[2] === "*",
    dowWildcard: fields[4] === "*",
  };
}

function cronField(input: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const segment of input.split(",")) {
    const [rangeText, stepText] = segment.split("/");
    if (segment.split("/").length > 2) throw new Error("Invalid cron field");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1 || step > max - min + 1) throw new Error("Invalid cron step");
    let start: number;
    let end: number;
    if (rangeText === "*") [start, end] = [min, max];
    else if (rangeText?.includes("-")) {
      const parts = rangeText.split("-");
      if (parts.length !== 2) throw new Error("Invalid cron range");
      [start, end] = parts.map(Number) as [number, number];
    } else start = end = Number(rangeText);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end)
      throw new Error("Cron value is out of range");
    for (let value = start; value <= end; value += step) result.add(value);
  }
  if (!result.size) throw new Error("Cron field is empty");
  return result;
}

function recoverExpired(state: AutomationStateV1, now: number): void {
  const expired = state.leases.filter((lease) => lease.expiresAt <= now);
  for (const lease of expired) {
    const run = state.runs.find((item) => item.id === lease.runId && item.status === "running");
    if (run) {
      run.status = "interrupted";
      run.finishedAt = now;
      run.reason = "scheduler lease expired during restart recovery";
    }
  }
  state.leases = state.leases.filter((lease) => lease.expiresAt > now);
}

function trimHistory(state: AutomationStateV1): void {
  if (state.runs.length > MAX_HISTORY) state.runs = state.runs.slice(-MAX_HISTORY);
}

function runKey(id: string, scheduledAt: number): string {
  return createHash("sha256").update(`${id}\0${scheduledAt}`).digest("hex");
}

async function readState(path: string): Promise<AutomationStateV1> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as AutomationStateV1;
    if (value?.schemaVersion !== 1 || !Array.isArray(value.specs) || !Array.isArray(value.runs) || !Array.isArray(value.leases))
      throw new Error("Automation state is invalid");
    value.specs = value.specs.map((record) => {
      const { createdAt, updatedAt, nextRunAt, ...spec } = record;
      if (![createdAt, updatedAt, nextRunAt].every(Number.isFinite)) throw new Error("Automation record timestamps are invalid");
      return { ...AutomationSpecV1Schema.parse(spec), createdAt, updatedAt, nextRunAt };
    });
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, specs: [], runs: [], leases: [] };
    throw error;
  }
}

async function writeState(root: string, state: AutomationStateV1): Promise<void> {
  const destination = join(root, "automations.json");
  const temp = join(root, `.automations.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temp, destination);
  await chmod(destination, 0o600);
}

async function acquireFileLock(
  path: string,
  ownerId: string,
  now: () => number,
  timeoutMs: number,
): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${ownerId}\n${now()}\n`);
      return async () => { await handle.close(); await unlink(path).catch(() => undefined); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = now() - (await stat(path).then((item) => item.mtimeMs).catch(() => now()));
      if (age > LOCK_STALE_MS) { await unlink(path).catch(() => undefined); continue; }
      if (Date.now() >= deadline) throw new Error("Automation state is locked by another process");
      await Bun.sleep(10);
    }
  }
}

function boundedReason(reason: string): string { return reason.replace(/\0/g, "").slice(0, 2_000); }

function freezeClone<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return;
    Object.freeze(item);
    for (const child of Object.values(item)) freeze(child);
  };
  freeze(clone);
  return clone;
}
