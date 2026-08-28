/**
 * E2.2.3 — WaterGraph topology diagnostic script.
 * Usage: cd sea-map && npx tsx scripts/e223-watergraph-topology.ts
 *
 * Builds shadow WaterGraph from fixtures / lake masks and prints topology.
 * Does NOT enable USE_WATER_GRAPH, does NOT add seams, does NOT change routing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  geojsonToCenterlineFeatures,
  ingestCenterlineFeaturesSync,
} from '../src/water-graph-ingest';
import { buildWaterGraph } from '../src/water-graph';
import {
  diagnoseWaterGraphTopology,
  type WaterGraphTopology,
} from '../src/water-graph-topology';
import {
  findSharedOpenLake,
  cachedLakeMaskAlongPath,
  isLakeMaskComplete,
  routeAcrossOpenLake,
} from '../src/open-lake';
import { getRouteFeatureFlags } from '../src/route-feature-flags';
import { USER_TEST_PRESETS } from '../src/user-test-presets';
import { haversineKm, type LngLat } from '../src/geo';
import type { CenterlineSource } from '../src/water-graph-types';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) =>
  join(here, '../src/__fixtures__/centerlines', name);

/** Densify A–B so cachedLakeMaskAlongPath (≥3 bbox hits) can resolve. */
function densifyCorridor(a: LngLat, b: LngLat, stepKm = 15): LngLat[] {
  const d = haversineKm(a, b);
  if (d <= stepKm) return [a, b, { lon: (a.lon + b.lon) / 2, lat: (a.lat + b.lat) / 2 }];
  const n = Math.max(3, Math.ceil(d / stepKm));
  const out: LngLat[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push({
      lon: a.lon + (b.lon - a.lon) * t,
      lat: a.lat + (b.lat - a.lat) * t,
    });
  }
  return out;
}

type Case = {
  id: string;
  a: LngLat;
  b: LngLat;
  fixture?: string;
  warmLake?: boolean;
};

function preset(id: string): { a: LngLat; b: LngLat } {
  const p = USER_TEST_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`missing preset ${id}`);
  return { a: p.a, b: p.b };
}

const CASES: Case[] = [
  {
    id: 'VG-mid',
    a: { lon: 45.9, lat: 47.75 },
    b: { lon: 46.95, lat: 47.0 },
    fixture: 'lower-volga-mid.geojson',
  },
  {
    id: 'BELOMOR',
    a: { lon: 34.82, lat: 62.86 },
    b: { lon: 34.77, lat: 64.52 },
    fixture: 'belomor.geojson',
  },
  { id: 'N06', ...preset('N06'), warmLake: true },
  { id: 'N08', ...preset('N08'), warmLake: true },
  { id: 'X3', ...preset('X3'), warmLake: true },
];

function loadFixtureCenterlines(
  a: LngLat,
  b: LngLat,
  file: string,
): CenterlineSource[] {
  const fc = JSON.parse(readFileSync(fixturePath(file), 'utf8'));
  const ingest = ingestCenterlineFeaturesSync(
    a,
    b,
    geojsonToCenterlineFeatures(fc),
  );
  return ingest.centerlines;
}

function summarize(topo: WaterGraphTopology) {
  const gaps = topo.gapSummary;
  const wwMask = topo.waterwayMaskCandidates.length;
  const wwWw = topo.candidateSeams.filter(
    (c) => c.candidateType === 'waterway_to_waterway',
  ).length;
  const smallestGap = gaps.length ? gaps[0]!.distanceKm : null;
  return {
    components: topo.componentCount,
    largestComponentKm: topo.largestComponentKm,
    gapCount: gaps.length,
    smallestGapKm: smallestGap,
    waterwayMaskCandidates: wwMask,
    waterwayWaterwayCandidates: wwWw,
    lockPortalCandidates: topo.lockPortalCandidates.length,
  };
}

async function runOne(c: Case) {
  process.stderr.write(`topology ${c.id}…\n`);
  let centerlines: CenterlineSource[] = [];
  if (c.fixture) {
    centerlines = loadFixtureCenterlines(c.a, c.b, c.fixture);
  }

  if (c.warmLake) {
    try {
      await routeAcrossOpenLake([c.a, c.b]);
    } catch {
      // lake warm is best-effort for diagnostics
    }
  }

  const corridor = densifyCorridor(c.a, c.b);
  const shared = findSharedOpenLake([c.a, c.b]);
  const lake = shared ? cachedLakeMaskAlongPath(corridor) : null;
  const g = buildWaterGraph({
    a: c.a,
    b: c.b,
    centerlines,
    lake,
    lakeComplete: lake ? isLakeMaskComplete(lake) : false,
  });
  const topo = diagnoseWaterGraphTopology(g, {
    a: c.a,
    b: c.b,
    lake,
  });
  const sum = summarize(topo);
  return {
    routeId: c.id,
    ...sum,
    nodeCount: topo.nodeCount,
    edgeCount: topo.edgeCount,
    minComponentKm: topo.minComponentKm,
    maxComponentKm: topo.maxComponentKm,
    layers: g.layers,
    lakeName: lake?.name ?? null,
    centerlineCount: centerlines.length,
    componentsDetail: topo.components.map((comp) => ({
      id: comp.id,
      lengthKm: comp.lengthKm,
      nodes: comp.nodeCount,
      edges: comp.edgeCount,
      waterIds: comp.waterIds,
      layers: comp.layers,
      portals: comp.portalCount,
      bbox: comp.bbox.map((x) => Math.round(x * 1000) / 1000),
    })),
    mainGaps: topo.gapSummary.slice(0, 6).map((gap) => ({
      from: gap.fromComponent,
      to: gap.toComponent,
      km: gap.distanceKm,
      class: gap.classification,
      contents: gap.gapContents,
      fromSide: gap.fromSide,
      toSide: gap.toSide,
      note: gap.note,
    })),
    wwMaskSample: topo.waterwayMaskCandidates.slice(0, 3),
    wwWwSample: topo.candidateSeams
      .filter((x) => x.candidateType === 'waterway_to_waterway')
      .slice(0, 3),
    lockSample: topo.lockPortalCandidates.slice(0, 5).map((l) => ({
      source: l.source,
      location: l.location,
      nearby: l.nearbyComponents,
      lock: l.lockPresent,
      barrier: l.barrierPresent,
    })),
  };
}

async function main() {
  const flags = getRouteFeatureFlags();
  process.stderr.write(
    `E2.2.3 topology — USE_WATER_GRAPH=${flags.USE_WATER_GRAPH} (must stay false)\n`,
  );
  if (flags.USE_WATER_GRAPH) {
    throw new Error('USE_WATER_GRAPH must remain false for this diagnostic');
  }

  const rows = [];
  for (const c of CASES) {
    rows.push(await runOne(c));
  }

  const table = [
    '| route | components | largestComponentKm | gapCount | smallest gap km | ww→mask | ww→ww | lock/portal |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((r) =>
      `| ${r.routeId} | ${r.components} | ${r.largestComponentKm} | ${r.gapCount} | ${r.smallestGapKm ?? '—'} | ${r.waterwayMaskCandidates} | ${r.waterwayWaterwayCandidates} | ${r.lockPortalCandidates} |`,
    ),
  ].join('\n');

  process.stdout.write(table + '\n\n');
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
