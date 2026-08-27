/**
 * E1.6 — classify rejectReason into AI-ready failure categories.
 * Diagnostic only — never feeds back into routing.
 */

export type RouteFailureCategory =
  | 'data_gap'
  | 'routing_failure'
  | 'snap_failure'
  | 'external_provider_failure'
  | 'validator_reject'
  | 'hydro_reject'
  | 'performance_timeout'
  | 'none';

export type RouteFailureStage =
  | 'candidate_generation'
  | 'phase_a'
  | 'phase_b'
  | 'phase_c'
  | 'overpass'
  | 'validation'
  | 'hydro'
  | 'bind'
  | 'unknown';

export type RouteFailureSignal = {
  category: RouteFailureCategory;
  code: string;
  stage: RouteFailureStage;
};

export function classifyRouteFailure(
  rejectReason: string | null | undefined,
  opts?: { longSpanOverpassSkip?: boolean; ok?: boolean },
): RouteFailureSignal | null {
  if (opts?.ok) return null;
  const reason = (rejectReason ?? '').trim();
  if (!reason) {
    return { category: 'routing_failure', code: 'unknown', stage: 'unknown' };
  }

  if (reason === 'span_gt_120' || opts?.longSpanOverpassSkip) {
    return {
      category: 'data_gap',
      code: 'span_gt_120_overpass_skip',
      stage: 'overpass',
    };
  }
  if (reason === 'snap_empty' || reason.startsWith('endpoints_far')) {
    return { category: 'snap_failure', code: reason.split(' ')[0]!, stage: 'bind' };
  }
  if (reason === 'open_lake_fail' || reason === 'no_shared_lake') {
    return { category: 'routing_failure', code: reason, stage: 'phase_a' };
  }
  if (reason === 'dam_straddle' || reason.includes('illegal_barrier')) {
    return { category: 'validator_reject', code: reason, stage: 'validation' };
  }
  if (reason.includes('hydro') || reason === 'hydro_reject') {
    return { category: 'hydro_reject', code: reason, stage: 'hydro' };
  }
  if (
    reason.includes('excessive_detour') ||
    reason.includes('stem') ||
    reason === 'stem_miss_early' ||
    reason.includes('vetl')
  ) {
    return { category: 'validator_reject', code: reason, stage: 'validation' };
  }
  if (reason === 'brouter_detour_cut' || reason.includes('brouter')) {
    return {
      category: 'external_provider_failure',
      code: reason,
      stage: 'phase_b',
    };
  }
  if (reason === 'phase_c_all_fail' || reason === 'no_pairs') {
    return { category: 'routing_failure', code: reason, stage: 'phase_c' };
  }
  if (reason.includes('timeout') || reason.includes('abort')) {
    return { category: 'performance_timeout', code: reason, stage: 'unknown' };
  }
  if (reason === 'route_not_found' || reason === 'too_few_waypoints') {
    return { category: 'routing_failure', code: reason, stage: 'unknown' };
  }
  // Validator issue lists joined by comma
  if (reason.includes(',') || reason.includes('_')) {
    return { category: 'validator_reject', code: reason.split(',')[0]!, stage: 'validation' };
  }
  return { category: 'routing_failure', code: reason, stage: 'unknown' };
}
