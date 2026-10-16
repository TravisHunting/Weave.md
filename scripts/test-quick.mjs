// Quick development checks: the unit tests that finish in seconds, without the
// Git workflows, the Rust test host or the PowerShell validator. Not a release
// gate; npm test, cargo test and the browser suites remain the full checks.
import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const testDir = join(root, 'app/weave/tests');

// Whole files that drive real Git repositories, the native test host or PowerShell.
const slowFiles = new Set([
  'git.test.mjs',
  'knowledge-validation.test.mjs',
  'monitoring.test.mjs',
  'native-backend.test.mjs',
]);

// Individual tests in otherwise quick files that take seconds or need the test host.
const slowTests = [
  'Rust indexes the same Kanban model',
  'standalone build is executable',
  'a mid-rename write failure rolls back',
];

const files = readdirSync(testDir)
  .filter(name => name.endsWith('.test.mjs') && !slowFiles.has(name))
  .map(name => relative(root, join(testDir, name)).replaceAll('\\', '/'));
files.push('app/tests/chat-markdown.test.mjs');

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const args = ['--test', ...slowTests.map(name => `--test-skip-pattern=${escape(name)}`), ...files];

const started = performance.now();
const result = spawnSync(process.execPath, args, {cwd: root, stdio: 'inherit'});
const seconds = ((performance.now() - started) / 1000).toFixed(1);
console.log(`\nQuick checks ${result.status === 0 ? 'passed' : 'failed'} in ${seconds} s (skipped ${slowFiles.size} files and ${slowTests.length} slow tests; run npm test for everything).`);
process.exit(result.status ?? 1);
