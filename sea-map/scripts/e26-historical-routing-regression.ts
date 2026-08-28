/**
 * E2.6 — Historical routing regression archaeology script.
 * Usage: cd sea-map && npx tsx scripts/e26-historical-routing-regression.ts
 *
 * Forensic only. Does not checkout commits onto the project branch,
 * mutate history, or change production routing.
 *
 * Optional: --verify-git runs read-only `git cat-file` / `git log` checks
 * for embedded SHAs (never checks out).
 */
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildE26Report,
  formatE26Markdown,
  pipelineChangesSafeToRestore,
} from '../src/e26-historical-routing-regression';
import { getRouteFeatureFlags } from '../src/route-feature-flags';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');

function verifyGitShas(commits: string[]): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const c of commits) {
    if (!/^[0-9a-f]{7,40}$/i.test(c)) continue; // skip labels like "E1" / "pre-Phase"
    const r = spawnSync('git', ['cat-file', '-t', c], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (r.status !== 0 || String(r.stdout).trim() !== 'commit') {
      missing.push(c);
    }
  }
  return { ok: missing.length === 0, missing };
}

async function main() {
  if (getRouteFeatureFlags().USE_WATER_GRAPH) {
    throw new Error('USE_WATER_GRAPH must stay false');
  }

  const report = buildE26Report();
  const md = formatE26Markdown(report);
  process.stdout.write(md);

  const verify = process.argv.includes('--verify-git');
  if (verify) {
    const shas = report.pipelineChanges.map((c) => c.commit);
    const v = verifyGitShas(shas);
    process.stderr.write(
      v.ok
        ? 'git verify: all hex SHAs resolve\n'
        : `git verify: missing ${v.missing.join(', ')}\n`,
    );
    if (!v.ok) process.exitCode = 2;
  }

  const safe = pipelineChangesSafeToRestore();
  process.stderr.write(
    `restore-safe candidates (coverage only): ${safe.map((c) => c.commit).join(', ') || 'none'}\n`,
  );

  writeFileSync('/tmp/e26-historical-routing-regression.json', JSON.stringify(report, null, 2));
  process.stderr.write('wrote /tmp/e26-historical-routing-regression.json\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
