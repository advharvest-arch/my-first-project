/**
 * E2.9 — Historical ingest forensics script.
 * Usage: cd sea-map && npx tsx scripts/e29-historical-ingest-forensics.ts [--verify-git]
 */
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildE29Report,
  formatE29Markdown,
} from '../src/e29-historical-ingest-forensics';
import { getRouteFeatureFlags } from '../src/route-feature-flags';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

function verifyGit(commits: string[]): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const c of commits) {
    if (!/^[0-9a-f]{7,40}$/i.test(c)) continue;
    const r = spawnSync('git', ['cat-file', '-t', c], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (r.status !== 0 || String(r.stdout).trim() !== 'commit') missing.push(c);
  }
  return { ok: missing.length === 0, missing };
}

async function main() {
  if (getRouteFeatureFlags().USE_WATER_GRAPH) {
    throw new Error('USE_WATER_GRAPH must stay false');
  }
  const report = buildE29Report();
  process.stdout.write(formatE29Markdown(report));

  if (process.argv.includes('--verify-git')) {
    const shas = report.timeline.map((t) => t.commit);
    const v = verifyGit(shas);
    process.stderr.write(
      v.ok ? 'git verify: ok\n' : `git verify missing: ${v.missing.join(', ')}\n`,
    );
    if (!v.ok) process.exitCode = 2;
  }

  writeFileSync('/tmp/e29-historical-ingest-forensics.json', JSON.stringify(report, null, 2));
  process.stderr.write('wrote /tmp/e29-historical-ingest-forensics.json\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
