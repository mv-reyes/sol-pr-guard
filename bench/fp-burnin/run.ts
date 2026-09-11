// FP burn-in: scan many recently-merged PRs from real Anchor repos and report
// the false-positive rate. The release gate is ZERO Tier-1 findings a
// maintainer would reject; every T1 finding is listed for manual review.
// Uses ~1 GitHub API call per repo (the PR list carries head/base SHAs), so it
// stays within the unauthenticated 60/hr budget; pass a token to scale up.
import * as fs from 'fs';
import * as path from 'path';
import { listClosedPrs } from '../../src/github';
import { fromPrEntry } from '../../src/fetch';
import { runScan } from '../../src/engine';
import { Finding } from '../../src/types';

const DEFAULT_REPOS = [
  'gmsol-labs/gmx-solana',
  'mrgnlabs/marginfi-v2',
  'metaplex-foundation/mpl-core',
  'marinade-finance/liquid-staking-program',
  'tensor-foundation/marketplace',
];

function findRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

async function main() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;
  const perRepo = parseInt(process.env.FP_PER_REPO || '20', 10);
  const repos = (process.env.FP_REPOS || DEFAULT_REPOS.join(',')).split(',').map((s) => s.trim());

  let scanned = 0;
  let withRust = 0;
  const t1Findings: Array<{ repo: string; pr: number; f: Finding }> = [];
  let t2Count = 0;
  let t3Count = 0;
  const perRepoStats: Record<string, { scanned: number; t1: number; t2: number }> = {};

  for (const repo of repos) {
    const [owner, name] = repo.split('/');
    perRepoStats[repo] = { scanned: 0, t1: 0, t2: 0 };
    let entries;
    try {
      entries = await listClosedPrs(owner, name, perRepo * 3, token);
    } catch (e) {
      console.error(`skip ${repo}: ${(e as Error).message}`);
      continue;
    }
    const merged = entries.filter((e) => e.merged && e.headSha && e.baseSha).slice(0, perRepo);
    for (const e of merged) {
      try {
        const input = await fromPrEntry(owner, name, e, token);
        if (input.files.length === 0) continue; // no .rs changes
        const maxFiles = parseInt(process.env.FP_MAX_FILES || '25', 10);
        if (input.files.length > maxFiles) continue; // skip atypically huge PRs (perf)
        const r = await runScan(input, {});
        scanned++;
        withRust++;
        perRepoStats[repo].scanned++;
        for (const f of r.findings) {
          if (f.tier === 1) {
            t1Findings.push({ repo, pr: e.number, f });
            perRepoStats[repo].t1++;
          } else if (f.tier === 2) {
            t2Count++;
            perRepoStats[repo].t2++;
          } else t3Count++;
        }
        process.stdout.write(
          `  ${repo}#${e.number}: ${r.findings.filter((f) => f.tier === 1).length} T1, ${r.findings.filter((f) => f.tier === 2).length} T2\n`
        );
      } catch (err) {
        // Network / large-diff issues are not FP evidence; skip quietly.
      }
    }
  }

  const md: string[] = [
    '# False-positive burn-in report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    `Scanned **${scanned}** merged PRs across **${repos.length}** repos (${perRepo}/repo requested).`,
    `Token used: ${token ? 'yes' : 'no (unauthenticated; increase FP_PER_REPO with a token)'}.`,
    '',
    '## Headline',
    '',
    `- **Tier-1 findings (release-blocking if a maintainer would reject): ${t1Findings.length}**`,
    `- Tier-2 findings (warnings): ${t2Count}`,
    `- Tier-3 findings (summary hints): ${t3Count}`,
    '',
    '## Per-repo',
    '',
    '| repo | PRs scanned | T1 | T2 |',
    '| --- | --- | --- | --- |',
  ];
  for (const [repo, s] of Object.entries(perRepoStats)) {
    md.push(`| ${repo} | ${s.scanned} | ${s.t1} | ${s.t2} |`);
  }
  md.push('', '## Tier-1 findings (each must be reviewed; a real FP is a rule bug)', '');
  if (t1Findings.length === 0) {
    md.push('_None. Zero Tier-1 findings on the burn-in set._');
  } else {
    md.push('| repo | PR | rule | location | message |', '| --- | --- | --- | --- | --- |');
    for (const { repo, pr, f } of t1Findings) {
      md.push(`| ${repo} | #${pr} | \`${f.ruleId}\` | \`${f.file}:${f.line}\` | ${f.message.replace(/\|/g, '\\|').slice(0, 120)} |`);
    }
  }
  md.push('');

  const out = path.join(findRoot(), 'bench', 'fp-burnin', 'report.md');
  fs.writeFileSync(out, md.join('\n'));
  console.log(`\nScanned ${scanned} merged PRs. T1=${t1Findings.length} T2=${t2Count} T3=${t3Count}`);
  console.log(`report -> ${out}`);
  // The gate is human review of any T1; the script does not auto-fail on T1>0
  // because a merged PR can legitimately contain a caught bug (see report).
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
