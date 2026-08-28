/**
 * E2.5 — Belomor geometry recovery research script.
 * Usage: cd sea-map && npx tsx scripts/e25-belomor-geometry-recovery.ts
 *
 * Research only. Does not import geometry into production or create seams.
 */
import { writeFileSync } from 'node:fs';
import { researchBelomorGeometryRecovery } from '../src/belomor-geometry-recovery';
import { getRouteFeatureFlags } from '../src/route-feature-flags';

async function main() {
  if (getRouteFeatureFlags().USE_WATER_GRAPH) {
    throw new Error('USE_WATER_GRAPH must stay false');
  }
  const live = process.argv.includes('--live');
  const report = researchBelomorGeometryRecovery({ liveOsmApi: live });

  process.stdout.write(
    [
      '# E2.5 Belomor geometry recovery',
      '',
      `classification: **${report.classification}**`,
      `geometryConfidence: ${report.geometryConfidence}`,
      `canRecoverWithoutSyntheticSeam: ${report.canRecoverRealGeometryWithoutSyntheticSeam}`,
      '',
      '## Gap',
      `- start: ${report.gap.gapStart.lon}, ${report.gap.gapStart.lat}`,
      `- end: ${report.gap.gapEnd.lon}, ${report.gap.gapEnd.lat}`,
      `- lengthKm: ${report.gap.lengthKm}`,
      `- bbox: ${report.gap.bbox.join(', ')}`,
      `- waterId: ${report.gap.waterId}`,
      '',
      '## OSM relation',
      `- found: ${report.osmRelation.found} id=${report.osmRelation.relationId}`,
      `- members: ${report.osmRelation.memberWayCount}`,
      `- covering gap latitudes: ${report.osmRelation.membersCoveringGapLatitudes.join(', ')}`,
      '',
      '## Sources',
      ...report.sourcesChecked.map(
        (s) =>
          `- ${s.sourceType}/${s.sourceId}: geom=${s.geometryAvailable} covKm=${s.geometryCoverageKm} conf=${s.confidence}`,
      ),
      '',
      '## Import candidates (diagnosticOnly)',
      ...report.importCandidates.map(
        (c) =>
          `- ${c.sourceId}: ${c.coverageKm}km latCover=${c.gapLatitudeCoveragePercent}% chordProx=${c.fixtureChordProximityPercent}%`,
      ),
      '',
      report.summary,
      '',
    ].join('\n'),
  );

  writeFileSync(
    '/tmp/e25-belomor-recovery-report.json',
    JSON.stringify(report, null, 2),
  );
  process.stderr.write('wrote /tmp/e25-belomor-recovery-report.json\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
