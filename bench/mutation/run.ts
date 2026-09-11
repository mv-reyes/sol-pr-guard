// Mutation testing: each planted bug-class must be caught (fire on mutant),
// and the clean version must be silent. Release gate: 100% recall on Tier-1
// mutation classes. Runs offline.
import { runScan, ScanInput } from '../../src/engine';
import { MUTANTS, Mutant } from './mutants';

function inputAllChanged(text: string, rule: string): ScanInput {
  const n = text.split('\n').length;
  const changed = new Set<number>();
  for (let i = 1; i <= n; i++) changed.add(i);
  return {
    files: [
      {
        diff: {
          newPath: 'mutant.rs',
          oldPath: 'mutant.rs',
          status: 'modified',
          changedLines: changed,
          removedLines: new Set(),
          hunks: [],
          binary: false,
        },
        headText: text,
        baseText: null,
      },
    ],
    context: { source: 'patch' },
  };
}

async function fires(text: string, rule: string): Promise<boolean> {
  const r = await runScan(inputAllChanged(text, rule), {
    ruleFilter: [rule],
    includeTests: true,
  });
  return r.findings.some((f) => f.ruleId === rule);
}

async function main() {
  let t1total = 0;
  let t1caught = 0;
  let cleanFp = 0;
  const rows: string[] = [];
  console.log(`${'mutant'.padEnd(38)} caught  clean-silent`);
  console.log('-'.repeat(64));
  for (const m of MUTANTS) {
    const caught = await fires(m.mutant, m.rule);
    const cleanSilent = !(await fires(m.clean, m.rule));
    if (m.tier === 1) {
      t1total++;
      if (caught) t1caught++;
    }
    if (!cleanSilent) cleanFp++;
    console.log(
      `${m.name.padEnd(38)} ${(caught ? 'YES' : 'NO ').padEnd(6)}  ${cleanSilent ? 'YES' : 'NO (FP!)'}`
    );
    rows.push(`| \`${m.name}\` | \`${m.rule}\` | T${m.tier} | ${caught ? '✅' : '❌'} | ${cleanSilent ? '✅' : '❌'} |`);
  }
  const recallT1 = t1total ? (100 * t1caught) / t1total : 100;
  console.log(`\nTier-1 recall: ${t1caught}/${t1total} = ${recallT1.toFixed(0)}%`);
  console.log(`clean false-positives: ${cleanFp}`);

  const fail = recallT1 < 100 || cleanFp > 0;
  if (fail) {
    console.error('MUTATION GATE FAILED');
    process.exit(1);
  } else {
    console.log('MUTATION GATE PASSED');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
