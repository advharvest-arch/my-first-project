/**
 * E2.2.1 — Fallback latency timeline diagnostics (dev/observability only).
 * Does NOT change routing, timeouts, or Overpass/BRouter behaviour.
 */

import { nowPerfMs } from './route-perf-context';

export type FallbackEventType =
  | 'request_start'
  | 'phase_a'
  | 'phase_b'
  | 'phase_c'
  | 'phase_c_trial'
  | 'snap_empty'
  | 'brouter'
  | 'overpass'
  | 'overpass_batch'
  | 'overpass_fetch_network'
  | 'final_reject'
  | 'final_ok'
  | 'marker';

export type FallbackTimelineEvent = {
  type: FallbackEventType;
  id: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  parent: string | null;
  parallelGroup: string | null;
  result: string;
  /** Extra diagnostic fields (cell, cache, dedup, etc.). */
  meta?: Record<string, unknown>;
};

export type FallbackSummary = {
  wallMs: number;
  overpassWallMs: number;
  overpassAggregateMs: number;
  brouterWallMs: number;
  phaseCWallMs: number;
  parallelGroups: number;
  overpassCallCount: number;
  brouterCallCount: number;
  phaseCTrialCount: number;
  longestOperationMs: number;
  longestOperationType: string;
  longestOperationId: string;
  snapEmptyAtMs: number | null;
  finalRejectAtMs: number | null;
  /** Explicit: aggregate Overpass can exceed wall due to parallelism. */
  overpassAggregateExceedsWall: boolean;
};

export type RouteTraceFallbackDiag = {
  events: FallbackTimelineEvent[];
  summary: FallbackSummary;
};

type OpenEvent = {
  type: FallbackEventType;
  id: string;
  startAbs: number;
  parent: string | null;
  parallelGroup: string | null;
  meta?: Record<string, unknown>;
};

type FallbackTimelineSession = {
  originAbs: number;
  seq: number;
  open: Map<string, OpenEvent>;
  events: FallbackTimelineEvent[];
  parallelGroupSeq: number;
};

let session: FallbackTimelineSession | null = null;

function rel(abs: number): number {
  if (!session) return 0;
  return Math.max(0, abs - session.originAbs);
}

export function beginFallbackTimeline(): void {
  session = {
    originAbs: nowPerfMs(),
    seq: 0,
    open: new Map(),
    events: [],
    parallelGroupSeq: 0,
  };
  markFallbackEvent('request_start', 'request', 'start');
}

export function endFallbackTimeline(): void {
  session = null;
}

export function hasFallbackTimeline(): boolean {
  return session != null;
}

export function nextFallbackParallelGroup(label: string): string {
  if (!session) return label;
  session.parallelGroupSeq += 1;
  return `${label}:${session.parallelGroupSeq}`;
}

export function beginFallbackEvent(
  type: FallbackEventType,
  idHint: string,
  opts?: {
    parent?: string | null;
    parallelGroup?: string | null;
    meta?: Record<string, unknown>;
  },
): string {
  if (!session) return idHint;
  session.seq += 1;
  const id = `${idHint}#${session.seq}`;
  session.open.set(id, {
    type,
    id,
    startAbs: nowPerfMs(),
    parent: opts?.parent ?? null,
    parallelGroup: opts?.parallelGroup ?? null,
    meta: opts?.meta,
  });
  return id;
}

export function endFallbackEvent(
  id: string,
  result: string,
  extraMeta?: Record<string, unknown>,
): void {
  if (!session) return;
  const open = session.open.get(id);
  if (!open) return;
  session.open.delete(id);
  const endAbs = nowPerfMs();
  const startMs = rel(open.startAbs);
  const endMs = rel(endAbs);
  session.events.push({
    type: open.type,
    id: open.id,
    startMs: Math.round(startMs),
    endMs: Math.round(endMs),
    durationMs: Math.round(Math.max(0, endMs - startMs)),
    parent: open.parent,
    parallelGroup: open.parallelGroup,
    result,
    meta: { ...(open.meta ?? {}), ...(extraMeta ?? {}) },
  });
}

/** Instant marker (zero-duration) at current time. */
export function markFallbackEvent(
  type: FallbackEventType,
  idHint: string,
  result: string,
  opts?: {
    parent?: string | null;
    parallelGroup?: string | null;
    meta?: Record<string, unknown>;
  },
): string {
  if (!session) return idHint;
  session.seq += 1;
  const id = `${idHint}#${session.seq}`;
  const t = Math.round(rel(nowPerfMs()));
  session.events.push({
    type,
    id,
    startMs: t,
    endMs: t,
    durationMs: 0,
    parent: opts?.parent ?? null,
    parallelGroup: opts?.parallelGroup ?? null,
    result,
    meta: opts?.meta,
  });
  return id;
}

function spanWall(events: FallbackTimelineEvent[]): number {
  if (!events.length) return 0;
  const start = Math.min(...events.map((e) => e.startMs));
  const end = Math.max(...events.map((e) => e.endMs));
  return Math.max(0, end - start);
}

export function buildFallbackSummary(
  events: FallbackTimelineEvent[],
  wallMs: number,
): FallbackSummary {
  const overpass = events.filter((e) => e.type === 'overpass');
  const brouter = events.filter((e) => e.type === 'brouter');
  const trials = events.filter((e) => e.type === 'phase_c_trial');
  const phaseC = events.filter((e) => e.type === 'phase_c' || e.type === 'phase_c_trial');
  const groups = new Set(
    events.map((e) => e.parallelGroup).filter((g): g is string => !!g),
  );
  const overpassAggregateMs = overpass.reduce((s, e) => s + e.durationMs, 0);
  const overpassWallMs = spanWall(overpass);
  const brouterWallMs = spanWall(brouter);
  const phaseCWallMs = spanWall(phaseC);

  let longest: FallbackTimelineEvent | null = null;
  for (const e of events) {
    if (e.durationMs <= 0) continue;
    if (!longest || e.durationMs > longest.durationMs) longest = e;
  }

  const snap = events.find((e) => e.type === 'snap_empty');
  const fin =
    events.find((e) => e.type === 'final_reject') ??
    events.find((e) => e.type === 'final_ok');

  return {
    wallMs: Math.round(wallMs),
    overpassWallMs: Math.round(overpassWallMs),
    overpassAggregateMs: Math.round(overpassAggregateMs),
    brouterWallMs: Math.round(brouterWallMs),
    phaseCWallMs: Math.round(phaseCWallMs),
    parallelGroups: groups.size,
    overpassCallCount: overpass.length,
    brouterCallCount: brouter.length,
    phaseCTrialCount: trials.length,
    longestOperationMs: longest?.durationMs ?? 0,
    longestOperationType: longest?.type ?? 'none',
    longestOperationId: longest?.id ?? '',
    snapEmptyAtMs: snap ? snap.startMs : null,
    finalRejectAtMs: fin && fin.type === 'final_reject' ? fin.startMs : null,
    overpassAggregateExceedsWall: overpassAggregateMs > wallMs + 1,
  };
}

export function snapshotFallbackDiag(wallMs: number): RouteTraceFallbackDiag | null {
  if (!session) return null;
  // Close any still-open events as abandoned (mirrors may still run in background).
  for (const [id, open] of [...session.open.entries()]) {
    endFallbackEvent(id, 'abandoned_open_at_snapshot', {
      note: 'event still open when trace finished',
    });
    void open;
  }
  const events = session.events
    .slice()
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return {
    events,
    summary: buildFallbackSummary(events, wallMs),
  };
}

export function formatFallbackTimelineTable(
  events: FallbackTimelineEvent[],
): string {
  const header =
    '| start | end | duration | operation | parallel group | result |';
  const sep = '|---:|---:|---:|---|---|---|';
  const rows = events.map((e) => {
    const op = e.meta?.queryType
      ? `${e.type}:${e.meta.queryType}`
      : e.meta?.cell
        ? `${e.type}:${e.meta.cell}`
        : e.type;
    return `| ${e.startMs} | ${e.endMs} | ${e.durationMs} | ${op} (${e.id}) | ${e.parallelGroup ?? '—'} | ${e.result} |`;
  });
  return [header, sep, ...rows].join('\n');
}
