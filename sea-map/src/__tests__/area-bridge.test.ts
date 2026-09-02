/**
 * Area-Bridge regression tests.
 *
 * 1. Kovzha → Belozersky via Beloye lake — PASS
 * 2. Strelka Malaya/Bolshaya Neva across land — NO PATH
 * 3. Belomor E9 unchanged
 * 4. Ordinary E1 route unchanged (with/without areas)
 * 5. Two water areas separated by land — NO PATH
 */
import { describe, expect, it } from 'vitest';
import {
  areasShareBoundary,
  routeE1Only,
  routeWithAreaBridge,
  type AreaBridgeSnapshot,
} from '../area-bridge';
import {
  getPostgisWgSnapshot,
  postgisWgNavigableEdgeCount,
  routePostgisWaterGraph,
} from '../postgis-watergraph-provider';
import { BELOMOR_A, BELOMOR_B } from '../relation-aware-ingest';
import beloye from '../__fixtures__/area-bridge/beloye-lake.json';
import strelka from '../__fixtures__/area-bridge/strelka-land-barrier.json';
import landSep from '../__fixtures__/area-bridge/land-separated-areas.json';

const beloyeSnap = beloye as AreaBridgeSnapshot;
const strelkaSnap = strelka as AreaBridgeSnapshot;
const landSepSnap = landSep as AreaBridgeSnapshot;

/** Kovzha inland terminal (node 3435). */
const KOVZHA_A = { lon: 37.1038076, lat: 60.7815069 };
/** Belozersky canal terminal (node 12377). */
const BELOZERSKY_B = { lon: 37.6951354, lat: 60.0328436 };
/** Kovzha mid-chain points for E1-only regression. */
const KOVZHA_MID_A = { lon: 37.1038076, lat: 60.7815069 }; // 3435
const KOVZHA_MID_B = { lon: 37.1582034, lat: 60.3357963 }; // 12244

describe('Area-Bridge overlay', () => {
  it('1. Kovzha → Belozersky through Beloye lake — PASS', () => {
    const e1 = routeE1Only(KOVZHA_A, BELOZERSKY_B, beloyeSnap);
    expect(e1.ok).toBe(false);
    if (!e1.ok) expect(e1.reason).toBe('no_path');

    const r = routeWithAreaBridge(KOVZHA_A, BELOZERSKY_B, beloyeSnap);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.usedAreaBridge).toBe(true);
    expect(r.areaOsmIds).toContain(1603199);
    expect(r.lengthKm).toBeGreaterThan(40);
    expect(r.lengthKm).toBeLessThan(200);
    expect(r.points.length).toBeGreaterThanOrEqual(2);
    expect(r.note).toMatch(/area-bridge/i);
  });

  it('2. Strelka: river_area polygons do not touch across land', () => {
    expect(strelkaSnap.areas.length).toBe(2);
    expect(areasShareBoundary(strelkaSnap.areas[0]!, strelkaSnap.areas[1]!)).toBe(
      false,
    );

    // Mouths are ~6 km apart; E1 still connects via fork 3452 (~11 km).
    // Area-bridge must NOT invent a short land/gulf seam.
    const a = strelkaSnap.nodes.find((n) => n.node_id === 160400)!;
    const b = strelkaSnap.nodes.find((n) => n.node_id === 98322)!;
    const r = routeWithAreaBridge(
      { lon: a.lon, lat: a.lat },
      { lon: b.lon, lat: b.lat },
      strelkaSnap,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Geodesic mouths ~6.2 km; land seam would be ~that. E1 detour is ~11 km.
    expect(r.lengthKm).toBeGreaterThan(9);
    // Path must still use the fork edge pair (E1), not only area chords.
    expect(r.edgeIds.some((id) => id === 2240 || id === 2241)).toBe(true);
  });

  it('2b. Mouths without fork E1 edges — NO PATH (no land bridge)', () => {
    // Drop edges incident to fork node 3452 so Malaya/Bolshaya E1 components split.
    const FORK = 3452;
    const malayaOnly = strelkaSnap.edges.filter(
      (e) =>
        e.name === 'Малая Нева' &&
        e.from_node_id !== FORK &&
        e.to_node_id !== FORK,
    );
    const bolshayaOnly = strelkaSnap.edges.filter(
      (e) =>
        e.name === 'Большая Нева' &&
        e.from_node_id !== FORK &&
        e.to_node_id !== FORK,
    );
    const snap: AreaBridgeSnapshot = {
      ...strelkaSnap,
      edges: [...malayaOnly, ...bolshayaOnly],
    };
    const a = strelkaSnap.nodes.find((n) => n.node_id === 160400)!;
    const b = strelkaSnap.nodes.find((n) => n.node_id === 98322)!;
    const r = routeWithAreaBridge(
      { lon: a.lon, lat: a.lat },
      { lon: b.lon, lat: b.lat },
      snap,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('no_path');
      expect(r.note).toMatch(/NO WATER CONNECTION/i);
    }
  });

  it('3. Belomor E9 result unchanged', () => {
    expect(postgisWgNavigableEdgeCount()).toBe(29);
    const r = routePostgisWaterGraph(BELOMOR_A, BELOMOR_B);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.edgeIds.length).toBe(29);
    expect(r.lengthKm).toBeGreaterThan(200);
    expect(r.lengthKm).toBeLessThan(240);
    // Snapshot object identity / edge count untouched by area-bridge module.
    expect(getPostgisWgSnapshot().edges.length).toBe(29);
  });

  it('4. Ordinary E1 route identical with/without area overlay', () => {
    const withAreas = routeWithAreaBridge(KOVZHA_MID_A, KOVZHA_MID_B, beloyeSnap);
    const e1Only = routeE1Only(KOVZHA_MID_A, KOVZHA_MID_B, beloyeSnap);
    expect(e1Only.ok).toBe(true);
    expect(withAreas.ok).toBe(true);
    if (!e1Only.ok || !withAreas.ok) return;
    expect(withAreas.usedAreaBridge).toBe(false);
    expect(withAreas.edgeIds).toEqual(e1Only.edgeIds);
    expect(Math.abs(withAreas.lengthKm - e1Only.lengthKm)).toBeLessThan(0.05);
  });

  it('5. Two water areas separated by land — NO PATH', () => {
    const pond = landSepSnap.areas.find((a) => a.water_type === 'pond');
    const river = landSepSnap.areas.find((a) => a.water_type === 'river_area');
    expect(pond).toBeTruthy();
    expect(river).toBeTruthy();
    // Pond is not an eligible bridge class; areas must not share boundary.
    if (pond && river) {
      expect(areasShareBoundary(pond, river)).toBe(false);
    }
    // Only Malaya Nevka E1 edges present — cannot reach pond via area-bridge.
    const a = landSepSnap.nodes[0];
    const b = landSepSnap.nodes[landSepSnap.nodes.length - 1];
    expect(a && b).toBeTruthy();
    if (!a || !b) return;
    // Fabricate a terminal "on" the pond centroid — still must not bridge.
    const pondGeom = pond!.geometry.coordinates as number[][][][];
    const ring = pondGeom[0]![0]!;
    let sx = 0;
    let sy = 0;
    for (const c of ring) {
      sx += c[0]!;
      sy += c[1]!;
    }
    const pondPt = { lon: sx / ring.length, lat: sy / ring.length };
    const r = routeWithAreaBridge(
      { lon: a.lon, lat: a.lat },
      pondPt,
      landSepSnap,
      { maxSnapKm: 5 },
    );
    // Pond terminal will not bind to E1 (or no area bridge to pond class).
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(['no_path', 'terminal_unbound']).toContain(r.reason);
    }
  });

  it('hybrid attempt routes Beloye via area-bridge provider', async () => {
    const { attemptWaterGraphRoute } = await import('../watergraph-hybrid-router');
    const { AREA_BRIDGE_PROVIDER } = await import('../area-bridge');
    const ok = await attemptWaterGraphRoute(KOVZHA_A, BELOZERSKY_B);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.diag.centerlineSource).toBe(AREA_BRIDGE_PROVIDER);
      expect(ok.path.lengthKm).toBeGreaterThan(40);
    }
  });
});
