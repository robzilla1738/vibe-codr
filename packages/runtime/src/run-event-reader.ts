import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  RUN_EVENT_V1_LIMITS,
  RunEventV1Schema,
  TraceListResultV1Schema,
  TracePageV1Schema,
  TraceRunIdV1Schema,
  TraceSummaryV1Schema,
  contentFreeRunEventV1,
  type RunEventV1,
  type TraceCorruptionV1,
  type TraceListResultV1,
  type TracePageV1,
  type TraceSummaryV1,
} from "@vibe/protocol";
import { recoverRunEventLedger } from "./run-event-recorder.ts";

const SEGMENT_RE = /^(.*)-([0-9]{6})\.jsonl$/;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_PAGE_LIMIT = 200;
const TRACE_EXPORT_MAX_EVENTS = 5_000;

interface Segment {
  name: string;
  path: string;
  number: number;
}

function inspectionLimit(value: number | undefined, fallback: number, max: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new Error(`limit must be an integer from 1 to ${max}`);
  }
  return limit;
}

function safeRunId(runId: string): string {
  return TraceRunIdV1Schema.parse(runId);
}

async function groupedSegments(directory: string): Promise<Map<string, Segment[]>> {
  const groups = new Map<string, Segment[]>();
  const names = await readdir(directory).catch(() => [] as string[]);
  for (const name of names) {
    const match = SEGMENT_RE.exec(name);
    if (!match) continue;
    const runId = TraceRunIdV1Schema.safeParse(match[1]);
    if (!runId.success || basename(name) !== name) continue;
    const number = Number(match[2]);
    if (!Number.isSafeInteger(number) || number < 1) continue;
    const segments = groups.get(runId.data) ?? [];
    segments.push({ name, path: join(directory, name), number });
    groups.set(runId.data, segments);
  }
  for (const segments of groups.values()) {
    segments.sort((left, right) => left.number - right.number || left.name.localeCompare(right.name));
  }
  return groups;
}

interface ScannedRun {
  events: RunEventV1[];
  corruptions: TraceCorruptionV1[];
  segmentCount: number;
  hasRedactedContent: boolean;
}

async function scanRun(directory: string, runId: string): Promise<ScannedRun> {
  const groups = await groupedSegments(directory);
  const segments = groups.get(safeRunId(runId));
  if (!segments?.length) throw new Error(`trace not found: ${runId}`);

  const events: RunEventV1[] = [];
  const corruptions: TraceCorruptionV1[] = [];
  let previousSeq = 0;
  let hasRedactedContent = false;
  let stop = false;
  for (const segment of segments) {
    if (stop) break;
    const source = await readFile(segment.path, "utf8");
    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line) continue;
      let event: RunEventV1;
      try {
        event = RunEventV1Schema.parse(JSON.parse(line));
        if (event.runId !== runId) throw new Error("row runId does not match segment name");
      } catch (error) {
        corruptions.push({
          segment: segment.name,
          line: index + 1,
          reason: "invalid-row",
          detail: error instanceof Error ? error.message.slice(0, 1_024) : "invalid row",
        });
        stop = true;
        break;
      }
      if (previousSeq > 0 && event.seq <= previousSeq) {
        corruptions.push({
          segment: segment.name,
          line: index + 1,
          reason: "non-monotonic-sequence",
          detail: `sequence ${event.seq} follows ${previousSeq}`,
        });
        stop = true;
        break;
      }
      if (previousSeq > 0 && event.seq !== previousSeq + 1) {
        corruptions.push({
          segment: segment.name,
          line: index + 1,
          reason: "sequence-gap",
          detail: `sequence ${event.seq} follows ${previousSeq}`,
        });
      }
      previousSeq = event.seq;
      hasRedactedContent ||= event.content !== undefined;
      events.push(event);
    }
  }
  return { events, corruptions, segmentCount: segments.length, hasRedactedContent };
}

function summaryFor(runId: string, scanned: ScannedRun): TraceSummaryV1 | null {
  const first = scanned.events[0];
  const last = scanned.events.at(-1);
  if (!first || !last) return null;
  return TraceSummaryV1Schema.parse({
    schemaVersion: 1,
    runId,
    startedAt: first.at,
    updatedAt: last.at,
    firstSeq: first.seq,
    lastSeq: last.seq,
    eventCount: scanned.events.length,
    segmentCount: scanned.segmentCount,
    hasRedactedContent: scanned.hasRedactedContent,
    corruptionCount: scanned.corruptions.length,
  });
}

/** List newest traces after repairing old torn ledger tails. */
export async function listRunTraces(
  directory: string,
  options: { limit?: number } = {},
): Promise<TraceListResultV1> {
  const limit = inspectionLimit(
    options.limit,
    DEFAULT_LIST_LIMIT,
    RUN_EVENT_V1_LIMITS.traceListItems,
  );
  await recoverRunEventLedger(directory);
  const groups = await groupedSegments(directory);
  const summaries: TraceSummaryV1[] = [];
  for (const runId of groups.keys()) {
    const summary = summaryFor(runId, await scanRun(directory, runId));
    if (summary) summaries.push(summary);
  }
  summaries.sort((left, right) => right.updatedAt - left.updatedAt || left.runId.localeCompare(right.runId));
  return TraceListResultV1Schema.parse({
    schemaVersion: 1,
    traces: summaries.slice(0, limit),
    truncated: summaries.length > limit,
  });
}

/** Read a bounded, cursor-addressed trace page without ever reordering source rows. */
export async function readRunTrace(
  directory: string,
  runId: string,
  options: { afterSeq?: number; limit?: number; includeRedacted?: boolean } = {},
): Promise<TracePageV1> {
  const id = safeRunId(runId);
  const afterSeq = options.afterSeq ?? 0;
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    throw new Error("afterSeq must be a non-negative safe integer");
  }
  const limit = inspectionLimit(
    options.limit,
    DEFAULT_PAGE_LIMIT,
    RUN_EVENT_V1_LIMITS.tracePageEvents,
  );
  await recoverRunEventLedger(directory);
  const scanned = await scanRun(directory, id);
  const after = scanned.events.filter((event) => event.seq > afterSeq);
  const selected = after.slice(0, limit).map((event) =>
    options.includeRedacted ? event : contentFreeRunEventV1(event),
  );
  const more = after.length > selected.length;
  const cursor = selected.at(-1)?.seq ?? null;
  return TracePageV1Schema.parse({
    schemaVersion: 1,
    runId: id,
    events: selected,
    corruptions: scanned.corruptions.slice(0, RUN_EVENT_V1_LIMITS.traceCorruptions),
    lastSeq: scanned.events.at(-1)?.seq ?? 0,
    nextAfterSeq: more ? cursor : null,
    truncated: more || scanned.corruptions.length > RUN_EVENT_V1_LIMITS.traceCorruptions,
    hasRedactedContent: scanned.hasRedactedContent,
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Build a self-contained static document. It contains no script or remote resource. */
export async function renderRunTraceHtml(
  directory: string,
  runId: string,
  options: { includeRedacted?: boolean; maxEvents?: number } = {},
): Promise<string> {
  const maxEvents = inspectionLimit(
    options.maxEvents,
    TRACE_EXPORT_MAX_EVENTS,
    TRACE_EXPORT_MAX_EVENTS,
  );
  const rows: RunEventV1[] = [];
  let cursor = 0;
  let page: TracePageV1;
  do {
    page = await readRunTrace(directory, runId, {
      afterSeq: cursor,
      limit: Math.min(RUN_EVENT_V1_LIMITS.tracePageEvents, maxEvents - rows.length),
      includeRedacted: options.includeRedacted,
    });
    rows.push(...page.events);
    cursor = page.events.at(-1)?.seq ?? cursor;
  } while (page.nextAfterSeq !== null && rows.length < maxEvents);
  const clipped = page.nextAfterSeq !== null;
  const eventRows = rows.map((event) => {
    const json = escapeHtml(JSON.stringify(event, null, 2));
    return `<tr><td>${event.seq}</td><td>${escapeHtml(new Date(event.at).toISOString())}</td><td>${escapeHtml(event.type)}</td><td><pre>${json}</pre></td></tr>`;
  }).join("\n");
  const corruptionRows = page.corruptions.map((item) =>
    `<li>${escapeHtml(`${item.segment}${item.line ? `:${item.line}` : ""} — ${item.reason}${item.detail ? `: ${item.detail}` : ""}`)}</li>`,
  ).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vibe Codr trace ${escapeHtml(runId)}</title>
<style>body{font:14px system-ui,sans-serif;margin:32px;color:#171717;background:#fff}h1{font-size:22px}p{color:#555}table{width:100%;border-collapse:collapse}th,td{border-top:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:12px ui-monospace,monospace}.warn{color:#8a4b00}</style></head>
<body><h1>Run trace ${escapeHtml(runId)}</h1><p>Local export · ${options.includeRedacted ? "explicitly included redacted content" : "content-free by default"} · ${rows.length} events</p>
${clipped ? `<p class="warn">Export bounded at ${maxEvents} events.</p>` : ""}
${corruptionRows ? `<h2>Corruption report</h2><ul>${corruptionRows}</ul>` : ""}
<table><thead><tr><th>Seq</th><th>Time</th><th>Event</th><th>Evidence</th></tr></thead><tbody>${eventRows}</tbody></table></body></html>\n`;
}
