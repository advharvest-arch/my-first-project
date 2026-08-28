/**
 * E2.3 — Water corridor evidence diagnostic.
 * Usage: cd sea-map && npx tsx scripts/e23-water-corridor-evidence.ts
 *
 * Does NOT create seams, does NOT enable USE_WATER_GRAPH, does NOT change routing.
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
import { buildWaterCorridorEvidence } from '../src/water-corridor-evidence';
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

type Case = {
  id: string;
  a: LngLat;
  b: LngLat;
  fixture?: string;
  warmLake?: boolean;
};

function preset(id: string): { a: LngLat; b: LngLat } {
  const p = USER_TEST_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`missing ${id}`);
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

function densifyCorridor(a: LngLat, b: LngLat, stepKm = 15): LngLat[] {
  const d = haversineKm(a, b);
  const n = Math.max(3, Math.ceil(Math.max(d, 1) / stepKm));
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

async function runOne(c: Case) {
  process.stderr.write(`evidence ${c.id}…\n`);
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
      /* best-effort */
    }
  }
  const shared = findSharedOpenLake([c.a, c.b]);
  const lake = shared ? cachedLakeMaskAlongPath(densifyCorridor(c.a, c.b)) : null;
  const g = buildWaterGraph({
    a: c.a,
    b: c.b,
    centerlines,
    lake,
    lakeComplete: lake ? isLakeMaskComplete(lake) : false,
  });
  const topology = diagnoseWaterGraphTopology(g, { a: c.a, b: c.b, lake });
  const report = buildWaterCorridorEvidence({
    a: c.a,
    b: c.b,
    topology,
    graph: g,
    centerlines,
    lake,
  });

  return {
    routeId: c.id,
    lakeName: lake?.name ?? null,
    centerlineNames: centerlines.map((x) => x.name),
    componentCount: topology.componentCount,
    reportSummary: {
      candidateCount: report.candidateCount,
      strong: report.strongEvidenceCount,
      weak: report.weakEvidenceCount,
      none: report.noEvidenceCount,
    },
    gaps: report.candidates.map((ev) => ({
      from: ev.fromComponent,
      to: ev.toComponent,
      distanceKm: ev.distanceKm,
      waterIds: ev.waterIds,
      names: ev.names,
      evidenceTypes: ev.evidenceTypes,
      evidenceSources: ev.evidenceSources,
      barriers: ev.barriers,
      locksRelevant: ev.locks
        .filter((l) => l.relevance === 'related_to_gap')
        .map((l) => l.source),
      locksDistant: ev.locks
        .filter((l) => l.relevance === 'distant_unrelated')
        .map((l) => `${l.source}@${l.distanceToGapKm}km`)
        .slice(0, 2),
      maskEvidence: ev.maskEvidence,
      fairwayEvidence: ev.fairwayEvidence,
      physical: ev.physicalConnection,
      navigable: ev.navigableConnection,
      final: ev.finalDiagnosticClassification,
      confidence: ev.confidence,
      safetyFlags: ev.safetyFlags,
    })),
  };
}

async function main() {
  const flags = getRouteFeatureFlags();
  process.stderr.write(
    `E2.3 corridor evidence — USE_WATER_GRAPH=${flags.USE_WATER_GRAPH}\n`,
  );
  if (flags.USE_WATER_GRAPH) {
    throw new Error('USE_WATER_GRAPH must remain false');
  }

  const rows = [];
  for (const c of CASES) rows.push(await runOne(c));

  const table = [
    '| route | gap | from→to | km | waterIds | evidenceTypes | final | conf |',
    '|---|---|---|---:|---|---|---|---:|',
  ];
  for (const r of rows) {
    if (!r.gaps.length) {
      table.push(
        `| ${r.routeId} | — | — | — | — | — | NO_PAIR | — |`,
      );
      continue;
    }
    for (const g of r.gaps) {
      table.push(
        `| ${r.routeId} | ${g.from}→${g.to ?? 'mask'} | ${g.names.join('/') || '—'} | ${g.distanceKm} | ${g.waterIds.join(',')} | ${g.evidenceTypes.join('+')} | **${g.final}** | ${g.confidence} |`,
      );
    }
  }
  process.stdout.write(table.join('\n') + '\n\n');
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
