/**
 * E2.4 — Connection model diagnostic script.
 * Usage: cd sea-map && npx tsx scripts/e24-watergraph-connection.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  geojsonToCenterlineFeatures,
  ingestCenterlineFeaturesSync,
} from '../src/water-graph-ingest';
import { buildWaterGraph } from '../src/water-graph';
import { diagnoseWaterGraphTopology } from '../src/water-graph-topology';
import { buildConnectionEvidence } from '../src/water-graph-connection';
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

function preset(id: string) {
  const p = USER_TEST_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(id);
  return { a: p.a, b: p.b };
}

function densify(a: LngLat, b: LngLat, stepKm = 15): LngLat[] {
  const n = Math.max(3, Math.ceil(Math.max(haversineKm(a, b), 1) / stepKm));
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

async function runOne(c: Case) {
  process.stderr.write(`connection ${c.id}…\n`);
  let centerlines: CenterlineSource[] = [];
  if (c.fixture) {
    const fc = JSON.parse(readFileSync(fixturePath(c.fixture), 'utf8'));
    centerlines = ingestCenterlineFeaturesSync(
      c.a,
      c.b,
      geojsonToCenterlineFeatures(fc),
    ).centerlines;
  }
  if (c.warmLake) {
    try {
      await routeAcrossOpenLake([c.a, c.b]);
    } catch {
      /* ignore */
    }
  }
  const shared = findSharedOpenLake([c.a, c.b]);
  const lake = shared ? cachedLakeMaskAlongPath(densify(c.a, c.b)) : null;
  const g = buildWaterGraph({
    a: c.a,
    b: c.b,
    centerlines,
    lake,
    lakeComplete: lake ? isLakeMaskComplete(lake) : false,
  });
  const topology = diagnoseWaterGraphTopology(g, { a: c.a, b: c.b, lake });
  const report = buildConnectionEvidence({
    a: c.a,
    b: c.b,
    topology,
    graph: g,
    centerlines,
    lake,
  });
  return {
    routeId: c.id,
    confirmedCount: report.confirmedCount,
    candidateCount: report.candidateCount,
    rejectedCount: report.rejectedCount,
    policy: report.policy,
    connections: report.connections.map((x) => ({
      from: x.fromComponent,
      to: x.toComponent,
      relationType: x.relationType,
      status: x.connectionStatus,
      level: x.evidenceLevel,
      physical: x.physicalConnectionEvidence,
      navigable: x.navigableConnectionEvidence,
      km: x.distanceKm,
      waterIds: x.waterIds,
      insufficient: x.insufficientSignals,
      reject: x.rejectionReasons.slice(0, 4),
      provenance: x.evidenceSources.slice(0, 4),
    })),
  };
}

async function main() {
  if (getRouteFeatureFlags().USE_WATER_GRAPH) {
    throw new Error('USE_WATER_GRAPH must stay false');
  }
  const rows = [];
  for (const c of CASES) rows.push(await runOne(c));

  const table = [
    '| route | confirmed | candidate | rejected | primary relation | status | phys | nav |',
    '|---|---:|---:|---:|---|---|---|---|',
  ];
  for (const r of rows) {
    const p = r.connections[0];
    table.push(
      `| ${r.routeId} | ${r.confirmedCount} | ${r.candidateCount} | ${r.rejectedCount} | ${p?.relationType ?? '—'} | ${p?.status ?? '—'} | ${p?.physical ?? '—'} | ${p?.navigable ?? '—'} |`,
    );
  }
  process.stdout.write(table.join('\n') + '\n\n');
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
