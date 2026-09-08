import { test } from 'node:test';
import * as assert from 'node:assert';
import { parseConfig, globMatch, defaultConfig } from '../src/config';

test('default config', () => {
  const c = defaultConfig();
  assert.strictEqual(c.failOn, 'T2');
  assert.strictEqual(c.includeTests, false);
});

test('parseConfig reads fail_on, rules, severity, exclude', () => {
  const toml = `
fail_on = "T1"
include_tests = true
exclude = ["vendor/**", "gen/*.rs"]

[rules]
unchecked-arithmetic = false
copy-paste-constraint = true

[severity]
copy-paste-constraint = "critical"
`;
  const c = parseConfig(toml);
  assert.strictEqual(c.failOn, 'T1');
  assert.strictEqual(c.includeTests, true);
  assert.deepStrictEqual(c.exclude, ['vendor/**', 'gen/*.rs']);
  assert.strictEqual(c.ruleEnabled['unchecked-arithmetic'], false);
  assert.strictEqual(c.ruleEnabled['copy-paste-constraint'], true);
  assert.strictEqual(c.severityOverride['copy-paste-constraint'], 'critical');
});

test('parseConfig never throws on garbage', () => {
  const c = parseConfig('=== not [ valid ] toml @@@\nfail_on');
  assert.ok(c);
});

test('globMatch supports * and **', () => {
  assert.ok(globMatch('vendor/**', 'vendor/a/b.rs'));
  assert.ok(globMatch('gen/*.rs', 'gen/x.rs'));
  assert.ok(!globMatch('gen/*.rs', 'gen/sub/x.rs'));
  assert.ok(globMatch('**/*.rs', 'a/b/c.rs'));
});
