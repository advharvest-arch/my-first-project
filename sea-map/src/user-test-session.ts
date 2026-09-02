/**
 * USER_TEST_READY — in-memory session stats for manual testing (dev only).
 * Does not affect routing.
 */

import type { RouteTrace } from './route-trace';

export type UserTestSessionSummary = {
  routesTested: number;
  ok: number;
  fail: number;
  methods: Record<string, number>;
  knowledgeMatches: number;
  knowledgeAdvisories: number;
  hydroRejects: number;
  validatorRejects: number;
  lastPresetId: string | null;
};

function empty(): UserTestSessionSummary {
  return {
    routesTested: 0,
    ok: 0,
    fail: 0,
    methods: {},
    knowledgeMatches: 0,
    knowledgeAdvisories: 0,
    hydroRejects: 0,
    validatorRejects: 0,
    lastPresetId: null,
  };
}

let summary = empty();
let lastTrace: RouteTrace | null = null;

export function resetUserTestSession(): void {
  summary = empty();
  lastTrace = null;
}

export function getUserTestSessionSummary(): UserTestSessionSummary {
  return {
    ...summary,
    methods: { ...summary.methods },
  };
}

export function getLastUserTestTrace(): RouteTrace | null {
  return lastTrace;
}

export function recordUserTestTrace(trace: RouteTrace, presetId?: string | null): void {
  lastTrace = trace;
  summary.routesTested += 1;
  if (trace.final.ok) summary.ok += 1;
  else summary.fail += 1;

  const method = trace.final.method || 'unknown';
  summary.methods[method] = (summary.methods[method] ?? 0) + 1;

  if (trace.knowledge && trace.knowledge.factsMatched > 0) {
    summary.knowledgeMatches += 1;
    summary.knowledgeAdvisories += trace.knowledge.advisories.length;
  }
  if (trace.hydro?.reject) summary.hydroRejects += 1;
  if (trace.validator && !trace.validator.ok) summary.validatorRejects += 1;
  if (presetId) summary.lastPresetId = presetId;
}

export function formatUserTestSessionSummary(s: UserTestSessionSummary = summary): string {
  const methods = Object.entries(s.methods)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ') || '—';
  return [
    `Routes tested: ${s.routesTested}`,
    `OK: ${s.ok}`,
    `FAIL: ${s.fail}`,
    `Methods: ${methods}`,
    `Knowledge matches: ${s.knowledgeMatches}`,
    `Knowledge advisories: ${s.knowledgeAdvisories}`,
    `Hydro rejects: ${s.hydroRejects}`,
    `Validator rejects: ${s.validatorRejects}`,
  ].join('\n');
}
