/**
 * E2 — Open Russian Knowledge Layer unit tests.
 * Advisory matching only — must not change route accept/reject semantics.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginRouteTrace,
  clearRouteTraces,
  getLastRouteTrace,
  setRouteTraceSink,
} from '../route-trace';
import {
  formatKnowledgeDebug,
  getWaterKnowledgeForRoute,
  setWaterKnowledgePackForTests,
  toRouteTraceKnowledge,
  type WaterKnowledgeFact,
} from '../water-knowledge';
import knowledgePack from '../data/open-russian-knowledge.json';

const p = (lon: number, lat: number) => ({ lon, lat });

afterEach(() => {
  setWaterKnowledgePackForTests(null);
  clearRouteTraces();
  setRouteTraceSink(null);
});

describe('Open Russian Knowledge Layer (E2)', () => {
  it('1. Kim closure matches Moscow canal corridor', () => {
    // Near КиМ locks 7–8 (approx.)
    const res = getWaterKnowledgeForRoute({
      a: p(37.48, 55.86),
      b: p(37.52, 55.84),
      route: [p(37.48, 55.86), p(37.5, 55.85), p(37.52, 55.84)],
      asOf: '2024-05-17',
    });
    expect(res.factIds).toContain('nev-closure-2415bc8a');
    expect(res.advisories.some((a) => a.type === 'navigation_closure' && a.severity === 'high')).toBe(
      true,
    );
    expect(res.sources).toContain('kim-bulletins');
  });

  it('2. Kim closure outside corridor does not match (Don bbox)', () => {
    const res = getWaterKnowledgeForRoute({
      a: p(40.0, 47.5),
      b: p(40.5, 47.8),
      route: [p(40.0, 47.5), p(40.5, 47.8)],
      asOf: '2024-05-17',
    });
    expect(res.factIds).not.toContain('nev-closure-2415bc8a');
    expect(res.advisories.some((a) => a.factId === 'nev-closure-2415bc8a')).toBe(false);
  });

  it('3. Seasonal fact respects validFrom/validTo', () => {
    const inside = getWaterKnowledgeForRoute({
      a: p(37.48, 55.86),
      b: p(37.52, 55.84),
      asOf: '2024-05-17',
    });
    expect(inside.factIds).toContain('nev-closure-kim-seasonal-demo');

    const outside = getWaterKnowledgeForRoute({
      a: p(37.48, 55.86),
      b: p(37.52, 55.84),
      asOf: '2024-06-01',
    });
    expect(outside.factIds).not.toContain('nev-closure-kim-seasonal-demo');
  });

  it('4. Kama segment facts match Kama corridor', () => {
    const res = getWaterKnowledgeForRoute({
      a: p(56.2, 58.0),
      b: p(55.0, 57.5),
      route: [p(56.2, 58.0), p(55.5, 57.8), p(55.0, 57.5)],
      riverHints: ['kama'],
    });
    expect(res.factsMatched).toBeGreaterThan(0);
    expect(res.facts.some((f) => f.basin === 'kama' || f.corridors.includes('kama'))).toBe(true);
    expect(res.sources).toContain('kama-dimensions');
  });

  it('5. Don corridor does not pick Volga/Kim advisories', () => {
    const res = getWaterKnowledgeForRoute({
      a: p(39.7, 47.2),
      b: p(40.1, 47.5),
      asOf: '2024-05-17',
    });
    expect(res.factIds.some((id) => id.startsWith('nev-'))).toBe(false);
    expect(res.facts.every((f) => !f.corridors.includes('moscow_canal'))).toBe(true);
  });

  it('6. Fact without geometry can match via river/corridor metadata', () => {
    const bridgeLike: WaterKnowledgeFact = {
      id: 'wf-test-kama-bridge',
      source: 'kama-dimensions',
      sourceUrl: 'https://example.test/bridge.pdf',
      sourceDate: '2021-04-01',
      extractionDate: '2026-08-27T12:00:00Z',
      type: 'bridge',
      signalClass: 'informational',
      severity: 'low',
      river: 'kama',
      waterBody: 'kama',
      basin: 'kama',
      segment: 'test bridge clearance',
      kmFrom: null,
      kmTo: null,
      value: 14.5,
      unit: 'm',
      heightM: 14.5,
      confidence: 0.8,
      validFrom: null,
      validTo: null,
      corridors: ['kama'],
      rivers: ['kama'],
      bbox: null,
      geometry: null,
      originalFactId: 'wf-test-kama-bridge',
      provenance: {
        sourceId: 'kama-dimensions',
        sourceUrl: 'https://example.test/bridge.pdf',
        retrievedAt: '2026-08-27T12:00:00Z',
        documentDate: '2021-04-01',
        originalText: 'bridge VERCLR 14.5',
        confidence: 0.8,
      },
    };
    setWaterKnowledgePackForTests({
      facts: [bridgeLike],
      events: [],
      corridors: (knowledgePack as { corridors: Record<string, { bbox: [number, number, number, number]; rivers: string[] }> })
        .corridors,
    });
    const res = getWaterKnowledgeForRoute({
      a: p(56.0, 58.0),
      b: p(55.5, 57.8),
      riverHints: ['kama'],
    });
    expect(res.factIds).toContain('wf-test-kama-bridge');
    expect(res.facts[0]!.geometry).toBeNull();
  });

  it('7. Provenance fields are preserved on matched facts', () => {
    const res = getWaterKnowledgeForRoute({
      a: p(37.48, 55.86),
      b: p(37.52, 55.84),
      asOf: '2024-05-17',
    });
    const closure = res.facts.find((f) => f.id === 'nev-closure-2415bc8a');
    expect(closure).toBeTruthy();
    expect(closure!.source).toBe('kim-bulletins');
    expect(closure!.sourceUrl).toMatch(/kim-online\.ru/);
    expect(closure!.provenance.sourceId).toBe('kim-bulletins');
    expect(closure!.provenance.originalText).toBeTruthy();
    expect(closure!.confidence).toBeGreaterThan(0);
    expect(closure!.originalFactId).toBe('nev-closure-2415bc8a');
  });

  it('8. RouteTrace receives knowledge via builder', () => {
    const wk = getWaterKnowledgeForRoute({
      a: p(37.48, 55.86),
      b: p(37.52, 55.84),
      asOf: '2024-05-17',
    });
    const builder = beginRouteTrace([p(37.48, 55.86), p(37.52, 55.84)], 5);
    builder.knowledge = toRouteTraceKnowledge(wk);
    const trace = builder.finish({
      ok: true,
      method: 'waterway',
      lengthKm: 5,
      rejectReason: null,
      waterName: 'Канал имени Москвы',
    });
    expect(trace.knowledge).toBeTruthy();
    expect(trace.knowledge!.factsMatched).toBeGreaterThan(0);
    expect(trace.knowledge!.factIds).toContain('nev-closure-2415bc8a');
    expect(trace.knowledge!.advisories.length).toBeGreaterThan(0);
    expect(getLastRouteTrace()?.knowledge?.sources).toContain('kim-bulletins');
    expect(formatKnowledgeDebug(wk)).toMatch(/RU knowledge:/);
  });

  it('9. Knowledge layer does not change finish ok/reject fields by itself', () => {
    const builder = beginRouteTrace([p(37.48, 55.86), p(37.52, 55.84)], 5);
    builder.knowledge = toRouteTraceKnowledge(
      getWaterKnowledgeForRoute({
        a: p(37.48, 55.86),
        b: p(37.52, 55.84),
        asOf: '2024-05-17',
      }),
    );
    // High-severity closure present, but final remains caller-controlled.
    const okTrace = builder.finish({
      ok: true,
      method: 'waterway',
      lengthKm: 5,
      rejectReason: null,
      waterName: 'Канал имени Москвы',
    });
    expect(okTrace.final.ok).toBe(true);
    expect(okTrace.knowledge!.advisories.some((a) => a.severity === 'high')).toBe(true);
  });

  it('10. Corpus loaded from open-russian-knowledge pack has provenance on every fact', () => {
    const pack = knowledgePack as {
      facts: WaterKnowledgeFact[];
      events: WaterKnowledgeFact[];
    };
    const all = [...pack.facts, ...pack.events];
    expect(all.length).toBeGreaterThan(20);
    for (const f of all) {
      expect(f.source).toBeTruthy();
      expect(f.provenance?.sourceId).toBeTruthy();
      expect(f.originalFactId).toBeTruthy();
    }
  });
});
