/**
 * E2 — Open Russian Knowledge Layer (advisory metadata only).
 *
 * Loads curated facts from open Russian basin bulletins / inventories.
 * Does NOT accept/reject routes, change snap/hydro/STEM thresholds, or
 * replace BRouter / Phase A–D. ENC/S-57 is out of scope.
 */

import { haversineKm, type LngLat } from './geo';
import knowledgePack from './data/open-russian-knowledge.json';

export const WATER_KNOWLEDGE_VERSION = 'e2-open-ru-0.1.0' as const;

/** Match / filter thresholds (km / degrees). */
export const WK_BBOX_PAD_DEG = 0.15;
export const WK_ROUTE_DIST_KM = 25;
export const WK_CORRIDOR_HIT_PAD_DEG = 0.05;

export type KnowledgeSignalClass = 'informational' | 'advisory';
export type KnowledgeSeverity = 'low' | 'medium' | 'high';

export type WaterKnowledgeProvenance = {
  sourceId: string;
  sourceUrl?: string | null;
  retrievedAt?: string | null;
  documentDate?: string | null;
  originalText?: string | null;
  confidence: number;
};

/** Production-facing fact (reuses normalized open-RU fields + match helpers). */
export type WaterKnowledgeFact = {
  id: string;
  source: string;
  sourceUrl?: string | null;
  sourceDate?: string | null;
  extractionDate?: string | null;
  type: string;
  signalClass: KnowledgeSignalClass;
  severity: KnowledgeSeverity;
  eventType?: string | null;
  river?: string | null;
  waterBody?: string | null;
  basin?: string | null;
  segment?: string | null;
  kmFrom?: number | null;
  kmTo?: number | null;
  value?: number | null;
  unit?: string | null;
  widthM?: number | null;
  heightM?: number | null;
  lock?: string | null;
  barrier?: string | null;
  restriction?: string | null;
  navigationStatus?: string | null;
  confidence: number;
  validFrom?: string | null;
  validTo?: string | null;
  corridors: string[];
  rivers: string[];
  bbox?: [number, number, number, number] | null;
  geometry?: { type: 'Point'; coordinates: [number, number] } | null;
  originalFactId: string;
  provenance: WaterKnowledgeProvenance;
};

export type KnowledgeAdvisory = {
  type: string;
  severity: KnowledgeSeverity;
  affectsRoute: boolean;
  source: string;
  factId: string;
};

/** Diagnostic-only disagreement — never implies "official is right". */
export type KnowledgeDisagreement = {
  signalType: 'official_osm_disagreement';
  source: string;
  factId: string;
  distanceKm?: number;
};

export type WaterKnowledgeRequest = {
  a: LngLat;
  b: LngLat;
  route?: LngLat[] | null;
  /** Optional ISO date for seasonal validity (defaults to "now"). */
  asOf?: string | null;
  /** Optional waterway / river hints from the caller. */
  riverHints?: string[] | null;
};

export type WaterKnowledgeResult = {
  factsMatched: number;
  factIds: string[];
  sources: string[];
  facts: WaterKnowledgeFact[];
  advisories: KnowledgeAdvisory[];
  advisoryCount: number;
  highSeverityCount: number;
  /** Soft diagnostic score — NOT fed into Phase D ranking. */
  advisoryScore: number;
  disagreements: KnowledgeDisagreement[];
  knowledge: {
    factIds: string[];
    sources: string[];
    advisoryCount: number;
    highSeverityCount: number;
  };
};

export type RouteTraceKnowledge = {
  factsMatched: number;
  factIds: string[];
  sources: string[];
  advisories: KnowledgeAdvisory[];
  disagreements?: KnowledgeDisagreement[];
  advisoryScore?: number;
};

type Pack = {
  facts: WaterKnowledgeFact[];
  events: WaterKnowledgeFact[];
  corridors: Record<string, { bbox: [number, number, number, number]; rivers: string[] }>;
};

let packOverride: Pack | null = null;

function activePack(): Pack {
  if (packOverride) return packOverride;
  const p = knowledgePack as unknown as Pack;
  return {
    facts: (p.facts ?? []) as WaterKnowledgeFact[],
    events: (p.events ?? []) as WaterKnowledgeFact[],
    corridors: p.corridors ?? {},
  };
}

/** Test helper — inject a pack; pass null to restore default JSON. */
export function setWaterKnowledgePackForTests(pack: Pack | null): void {
  packOverride = pack;
}

export function getWaterKnowledgeCorpus(): WaterKnowledgeFact[] {
  const p = activePack();
  return [...p.facts, ...p.events];
}

type BBox = [number, number, number, number];

function routeBBox(points: LngLat[], padDeg: number): BBox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const p of points) {
    if (p.lon < w) w = p.lon;
    if (p.lon > e) e = p.lon;
    if (p.lat < s) s = p.lat;
    if (p.lat > n) n = p.lat;
  }
  return [w - padDeg, s - padDeg, e + padDeg, n + padDeg];
}

function bboxesIntersect(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function pointInBBox(p: LngLat, b: BBox): boolean {
  return p.lon >= b[0] && p.lon <= b[2] && p.lat >= b[1] && p.lat <= b[3];
}

function minDistToRouteKm(point: LngLat, route: LngLat[]): number {
  if (!route.length) return Infinity;
  let best = Infinity;
  for (const p of route) {
    const d = haversineKm(point, p);
    if (d < best) best = d;
  }
  // Sample mid-segments coarsely for longer routes
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const mid = { lon: (a.lon + b.lon) / 2, lat: (a.lat + b.lat) / 2 };
    const d = haversineKm(point, mid);
    if (d < best) best = d;
  }
  return best;
}

function bboxCenter(b: BBox): LngLat {
  return { lon: (b[0] + b[2]) / 2, lat: (b[1] + b[3]) / 2 };
}

function isValidOnDate(fact: WaterKnowledgeFact, asOfIso: string): boolean {
  const day = asOfIso.slice(0, 10);
  if (fact.validFrom && day < fact.validFrom.slice(0, 10)) return false;
  if (fact.validTo && day > fact.validTo.slice(0, 10)) return false;
  return true;
}

function corridorsHitByRequest(reqBBox: BBox, riverHints: string[]): Set<string> {
  const p = activePack();
  const hit = new Set<string>();
  for (const [id, c] of Object.entries(p.corridors)) {
    const padded: BBox = [
      c.bbox[0] - WK_CORRIDOR_HIT_PAD_DEG,
      c.bbox[1] - WK_CORRIDOR_HIT_PAD_DEG,
      c.bbox[2] + WK_CORRIDOR_HIT_PAD_DEG,
      c.bbox[3] + WK_CORRIDOR_HIT_PAD_DEG,
    ];
    if (bboxesIntersect(reqBBox, padded)) hit.add(id);
    for (const r of riverHints) {
      if (c.rivers.includes(r) || id === r) hit.add(id);
    }
  }
  return hit;
}

function riversFromHintsAndCorridors(hints: string[], corridorIds: Set<string>): Set<string> {
  const p = activePack();
  const out = new Set(hints.map((h) => h.toLowerCase()));
  for (const id of corridorIds) {
    const c = p.corridors[id];
    if (!c) continue;
    out.add(id);
    for (const r of c.rivers) out.add(r.toLowerCase());
  }
  return out;
}

function factMatches(
  fact: WaterKnowledgeFact,
  ctx: {
    reqBBox: BBox;
    route: LngLat[];
    corridorIds: Set<string>;
    rivers: Set<string>;
    asOf: string;
  },
): { ok: boolean; distKm?: number } {
  if (!isValidOnDate(fact, ctx.asOf)) return { ok: false };

  // Corridor overlap
  const corridorHit = fact.corridors.some((c) => ctx.corridorIds.has(c));

  // River / waterbody name match (for facts without geometry)
  const riverHit =
    (fact.river && ctx.rivers.has(fact.river.toLowerCase())) ||
    fact.rivers.some((r) => ctx.rivers.has(r.toLowerCase())) ||
    (fact.waterBody && ctx.rivers.has(String(fact.waterBody).toLowerCase()));

  // BBox intersection
  let bboxHit = false;
  if (fact.bbox) {
    bboxHit = bboxesIntersect(ctx.reqBBox, fact.bbox as BBox);
  }

  // Geometry distance
  let distKm: number | undefined;
  if (fact.geometry?.type === 'Point') {
    const pt = { lon: fact.geometry.coordinates[0], lat: fact.geometry.coordinates[1] };
    distKm = minDistToRouteKm(pt, ctx.route);
    if (distKm <= WK_ROUTE_DIST_KM) return { ok: true, distKm };
  } else if (fact.bbox && corridorHit) {
    distKm = minDistToRouteKm(bboxCenter(fact.bbox as BBox), ctx.route);
  }

  // MVP: corridor overlap, or river metadata for geometry-less facts.
  // Do NOT match on bbox alone (avoids giant false positives).
  if (corridorHit) return { ok: true, distKm };
  if (riverHit && !fact.geometry) return { ok: true, distKm };
  if (bboxHit && riverHit) return { ok: true, distKm };
  return { ok: false };
}

function advisoryFromFact(fact: WaterKnowledgeFact, affectsRoute: boolean): KnowledgeAdvisory | null {
  if (fact.signalClass !== 'advisory') return null;
  const type =
    fact.eventType === 'closure'
      ? 'navigation_closure'
      : fact.eventType === 'restriction'
        ? 'navigation_restriction'
        : fact.type === 'dimension'
          ? 'published_depth'
          : 'operational_advisory';
  return {
    type,
    severity: fact.severity,
    affectsRoute,
    source: fact.source,
    factId: fact.id,
  };
}

/**
 * Match open-RU facts to a route request. Advisory only — never mutates routing.
 */
export function getWaterKnowledgeForRoute(request: WaterKnowledgeRequest): WaterKnowledgeResult {
  const route =
    request.route && request.route.length >= 2
      ? request.route
      : [request.a, request.b];
  const reqBBox = routeBBox(route, WK_BBOX_PAD_DEG);
  const riverHints = (request.riverHints ?? []).map((r) => r.toLowerCase());
  const corridorIds = corridorsHitByRequest(reqBBox, riverHints);
  const rivers = riversFromHintsAndCorridors(riverHints, corridorIds);
  const asOf = (request.asOf ?? new Date().toISOString()).slice(0, 10);

  const matched: WaterKnowledgeFact[] = [];
  const advisories: KnowledgeAdvisory[] = [];
  const disagreements: KnowledgeDisagreement[] = [];

  for (const fact of getWaterKnowledgeCorpus()) {
    const hit = factMatches(fact, { reqBBox, route, corridorIds, rivers, asOf });
    if (!hit.ok) continue;
    matched.push(fact);
    const affects =
      Boolean(hit.distKm != null && hit.distKm <= WK_ROUTE_DIST_KM) ||
      fact.corridors.some((c) => corridorIds.has(c)) ||
      pointInBBox(request.a, reqBBox);
    const adv = advisoryFromFact(fact, affects);
    if (adv) advisories.push(adv);
    // Closure / high advisory overlapping an otherwise-routable corridor → disagreement signal only
    if (adv && adv.severity === 'high' && affects) {
      disagreements.push({
        signalType: 'official_osm_disagreement',
        source: fact.source,
        factId: fact.id,
        distanceKm: hit.distKm,
      });
    }
  }

  const factIds = matched.map((f) => f.id);
  const sources = [...new Set(matched.map((f) => f.source))];
  const highSeverityCount = advisories.filter((a) => a.severity === 'high').length;
  // Diagnostic soft score — intentionally unused by Phase D / validators.
  const advisoryScore =
    advisories.reduce((s, a) => s + (a.severity === 'high' ? 3 : a.severity === 'medium' ? 1.5 : 0.5), 0) /
    Math.max(1, matched.length);

  return {
    factsMatched: matched.length,
    factIds,
    sources,
    facts: matched,
    advisories,
    advisoryCount: advisories.length,
    highSeverityCount,
    advisoryScore,
    disagreements,
    knowledge: {
      factIds,
      sources,
      advisoryCount: advisories.length,
      highSeverityCount,
    },
  };
}

export function toRouteTraceKnowledge(result: WaterKnowledgeResult): RouteTraceKnowledge {
  return {
    factsMatched: result.factsMatched,
    factIds: result.factIds.slice(),
    sources: result.sources.slice(),
    advisories: result.advisories.map((a) => ({ ...a })),
    disagreements: result.disagreements.map((d) => ({ ...d })),
    advisoryScore: result.advisoryScore,
  };
}

/** Dev/debug one-liner — optional UI hint, not a ranking input. */
export function formatKnowledgeDebug(result: WaterKnowledgeResult): string {
  return `RU knowledge: ${result.factsMatched} facts / ${result.advisoryCount} advisory`;
}
