#!/usr/bin/env node
// sol-pr-guard command-line interface. Zero-dep hand-rolled arg parsing.
import * as fs from 'fs';
import * as path from 'path';
import { runScan, findingsAtGate, ScanInput, ScanResult } from './engine';
import { loadConfig } from './config';
import { readBaseline, writeBaseline } from './baseline';
import { render, OutputFormat } from './emit';
import {
  parsePrSpec,
  parseRepoSpec,
  fromPr,
  fromRange,
  fromLocal,
  fromWholeRepo,
} from './fetch';
import { toPosix } from './util';

function version(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
    );
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
  multi: Record<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const multi: Record<string, string[]> = { rule: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        const k = a.slice(2, eq);
        const v = a.slice(eq + 1);
        if (k === 'rule') multi.rule.push(v);
        else flags[k] = v;
      } else {
        const k = a.slice(2);
        const next = argv[i + 1];
        const takesValue = [
          'repo', 'base', 'head', 'baseline', 'write-baseline', 'config',
          'token', 'format', 'fail-on', 'rule', 'interval', 'post', 'state',
        ].includes(k);
        if (takesValue && next !== undefined && !next.startsWith('--')) {
          if (k === 'rule') multi.rule.push(next);
          else flags[k] = next;
          i++;
        } else {
          flags[k] = true;
        }
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags, multi };
}

const HELP = `sol-pr-guard ${version()} — diff-scoped security review for Solana (Rust/Anchor) PRs

USAGE
  sol-pr-guard scan <owner/repo#PR>            review a pull request (open/merged/closed, incl. forks)
  sol-pr-guard scan --repo o/r --base A --head B   review a commit range
  sol-pr-guard scan <path> [--base <ref>]      review a local repo vs a base ref
  sol-pr-guard scan <path> --staged            review staged changes (pre-push)
  sol-pr-guard scan <path> --whole-repo        scan every .rs file (no diff scoping)
  sol-pr-guard watch <owner/repo>              review open PRs that changed since last run
  sol-pr-guard init                            write a SHA-pinned GitHub Action into ./.github/workflows

OUTPUT
  --json | --sarif | --format=efm             machine formats (default: human terminal)
  --no-color                                  disable ANSI colors
  --quiet                                     only print findings + summary

GATING
  --fail-on T1|T2|T3|none                     exit 1 when findings at/above this tier (default T2)
  --rule <id>                                 restrict to rule id(s) (repeatable)
  --include-tests                             do not skip tests/benches/cfg(test)

BASELINE / CONFIG
  --baseline <file>                           suppress findings listed in a baseline file
  --write-baseline <file>                     write current findings as a baseline and exit 0
  --config <file>                             path to sol-pr-guard.toml (else discovered upward)

AI (optional, off by default; never gates a merge)
  --ai                                        Phase A: LLM explanation + suggested fix per finding
  --ai=experimental                           + Phase B: Tier-3 semantic hypotheses (repo-context)
                                              backend: ANTHROPIC_API_KEY | OPENAI_API_KEY | SPG_AI_PROVIDER=ollama

LIVE
  --post [review|check]                       post findings to the PR (needs --token / GITHUB_TOKEN)
  --token <t>                                 GitHub token (or env GITHUB_TOKEN / GH_TOKEN)
  --interval <sec>                            watch poll interval (default 60)
  --state <file>                              watch/dismiss state file

  --help | --version

EXIT CODES  0 = clean (below gate) · 1 = findings at/above gate · 2 = tool error
Network: GitHub only (github.com / raw.githubusercontent.com / api.github.com). No telemetry.
`;

function token(flags: Record<string, string | boolean>): string | undefined {
  return (
    (typeof flags.token === 'string' ? flags.token : undefined) ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    undefined
  );
}

function outputFormat(flags: Record<string, string | boolean>): OutputFormat {
  if (flags.json) return 'json';
  if (flags.sarif) return 'sarif';
  if (flags.format === 'efm') return 'efm';
  if (typeof flags.format === 'string' && ['json', 'sarif', 'efm', 'terminal'].includes(flags.format))
    return flags.format as OutputFormat;
  return 'terminal';
}

async function acquire(args: Args): Promise<ScanInput> {
  const target = args._[1];
  const flags = args.flags;
  const tok = token(flags);

  if (typeof flags.repo === 'string' && flags.base && flags.head) {
    const r = parseRepoSpec(flags.repo);
    if (!r) throw new Error(`bad --repo '${flags.repo}' (expected owner/repo)`);
    return fromRange(r.owner, r.repo, String(flags.base), String(flags.head), tok);
  }
  if (target) {
    const pr = parsePrSpec(target);
    if (pr) return fromPr(pr, tok);
    // local path?
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      if (flags['whole-repo']) return fromWholeRepo(target);
      return fromLocal(target, {
        base: typeof flags.base === 'string' ? flags.base : undefined,
        staged: !!flags.staged,
      });
    }
    // repo with base/head?
    const repo = parseRepoSpec(target);
    if (repo && flags.base && flags.head) {
      return fromRange(repo.owner, repo.repo, String(flags.base), String(flags.head), tok);
    }
    throw new Error(
      `could not interpret target '${target}'. Use owner/repo#PR, a local path, or --repo/--base/--head.`
    );
  }
  // no target: default to CWD local against --base
  if (flags['whole-repo']) return fromWholeRepo('.');
  return fromLocal('.', {
    base: typeof flags.base === 'string' ? flags.base : undefined,
    staged: !!flags.staged,
  });
}

async function cmdScan(args: Args): Promise<number> {
  const flags = args.flags;
  const startDir = process.cwd();
  const config = loadConfig(typeof flags.config === 'string' ? flags.config : undefined, startDir);
  if (typeof flags['fail-on'] === 'string') {
    const v = String(flags['fail-on']).toUpperCase();
    if (['T1', 'T2', 'T3', 'NONE'].includes(v))
      config.failOn = v === 'NONE' ? 'none' : (v as 'T1' | 'T2' | 'T3');
  }

  const t0 = Date.now();
  const input = await acquire(args);
  const baseline =
    typeof flags.baseline === 'string' ? readBaseline(flags.baseline) : undefined;

  const aiMode: 'off' | 'on' | 'experimental' =
    flags.ai === 'experimental' ? 'experimental' : flags.ai ? 'on' : 'off';

  const result: ScanResult = await runScan(input, {
    config,
    ruleFilter: args.multi.rule.length ? args.multi.rule : undefined,
    baselineFingerprints: baseline,
    includeTests: !!flags['include-tests'],
    wholeRepo: !!flags['whole-repo'],
    collectAiContext: aiMode === 'experimental',
  });

  if (typeof flags['write-baseline'] === 'string') {
    writeBaseline(flags['write-baseline'], result.findings);
    process.stderr.write(`wrote baseline (${result.findings.length} findings) to ${flags['write-baseline']}\n`);
    return 0;
  }

  const color =
    !flags['no-color'] && !process.env.NO_COLOR && !!process.stdout.isTTY && !flags.json && !flags.sarif;
  const out = render(result, {
    format: outputFormat(flags),
    color,
    showSuppressed: !flags.quiet,
    timingMs: Date.now() - t0,
    toolVersion: version(),
  });
  process.stdout.write(out + '\n');

  // Optional AI layer (off by default; never affects the exit code / gate).
  if (aiMode !== 'off') {
    const { runAi } = await import('./ai');
    const ai = await runAi(result, { mode: aiMode });
    const { renderAi } = await import('./emit/ai');
    process.stdout.write(renderAi(result, ai, { color, format: outputFormat(flags) }) + '\n');
  }

  // Optional posting.
  if (flags.post) {
    const { postToPr } = await import('./post');
    await postToPr(input, result, {
      token: token(flags),
      mode: typeof flags.post === 'string' && flags.post === 'check' ? 'check' : 'review',
      toolVersion: version(),
      stateFile: typeof flags.state === 'string' ? flags.state : undefined,
    });
  }

  const gated = findingsAtGate(result.findings, config.failOn);
  return gated.length > 0 ? 1 : 0;
}

async function cmdWatch(args: Args): Promise<number> {
  const { runWatch } = await import('./watch');
  return runWatch(args._[1], {
    token: token(args.flags),
    intervalSec: args.flags.interval ? parseInt(String(args.flags.interval), 10) : 60,
    stateFile: typeof args.flags.state === 'string' ? args.flags.state : undefined,
    post: !!args.flags.post,
    once: !!args.flags.once,
  });
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.help || args.flags.h || (args._.length === 0 && Object.keys(args.flags).length === 0)) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.flags.version || args.flags.v) {
    process.stdout.write(version() + '\n');
    return 0;
  }
  const cmd = args._[0] ?? 'scan';
  try {
    if (cmd === 'scan') return await cmdScan(args);
    if (cmd === 'watch') return await cmdWatch(args);
    if (cmd === 'init') return cmdInit(args);
    process.stderr.write(`unknown command '${cmd}'. Try --help.\n`);
    return 2;
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return 2;
  }
}

/** `init` writes a GitHub workflow that runs sol-pr-guard on every PR. The tool
 *  is checked out at its exact current commit SHA — a registry artifact is
 *  mutable, a commit is not: review the tool once, then trust the hash. */
function cmdInit(args: Args): number {
  const cp = require('child_process');
  const toolRoot = path.join(__dirname, '..', '..', '..');
  let origin = 'mv-reyes/sol-pr-guard';
  let sha = '<PINNED-TOOL-SHA>';
  try {
    sha = cp
      .execSync('git rev-parse HEAD', { cwd: toolRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    /* tool not in a git checkout — leave the placeholder */
  }
  try {
    const url = cp
      .execSync('git config --get remote.origin.url', { cwd: toolRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    if (m) origin = m[1];
  } catch {
    /* keep default origin */
  }
  const wfDir = path.join(process.cwd(), '.github', 'workflows');
  const wfPath = path.join(wfDir, 'sol-pr-guard.yml');
  if (fs.existsSync(wfPath)) {
    process.stderr.write(`error: ${wfPath} already exists — refusing to overwrite.\n`);
    return 2;
  }
  const yaml = `# .github/workflows/sol-pr-guard.yml — generated by \`sol-pr-guard init\`
name: sol-pr-guard
on: pull_request
permissions:
  contents: read
  pull-requests: write
  checks: write
  security-events: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      # the tool, pinned to the exact commit you reviewed
      - uses: actions/checkout@v4
        with:
          repository: ${origin}
          ref: ${sha}
          path: .sol-pr-guard
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: cd .sol-pr-guard && npm ci && npm run build
      - run: node .sol-pr-guard/dist/src/cli.js scan --repo \${{ github.repository }} \\
               --base \${{ github.event.pull_request.base.sha }} \\
               --head \${{ github.event.pull_request.head.sha }} \\
               --sarif > results.sarif
      - uses: github/codeql-action/upload-sarif@v3
        with: { sarif_file: results.sarif }
`;
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(wfPath, yaml);
  process.stdout.write(
    `wrote ${wfPath}\n` +
      `  tool: ${origin} @ ${sha}\n` +
      `  review that commit, then commit this workflow. On fork PRs the default\n` +
      `  GITHUB_TOKEN is read-only — the SARIF/code-scanning path above works there.\n`
  );
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`fatal: ${e?.stack ?? e}\n`);
      process.exit(2);
    }
  );
}
