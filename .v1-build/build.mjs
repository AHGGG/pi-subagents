import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Temporary runner only. Source/docs/tests land on the feature branch after all
// checks pass. Master, workflows, repository settings and permissions are untouched.
const BASE = '825cab42e85948d971bc1ac441bb207ff6349101';
const BRANCH = 'fix/robust-result-recovery';
const payload = join(process.env.RUNNER_TEMP, 'hardening-payload');
cpSync('.hardening-build', payload, { recursive: true });
const run = (command, args) => {
  console.log('\nRUN', command, ...args);
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  console.log(output.split('\n').slice(result.status === 0 ? -45 : -250).join('\n'));
  if (result.error || result.status !== 0) throw result.error ?? new Error(command + ' failed with exit ' + result.status);
};
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
const read = path => readFileSync(path, 'utf8');
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
function replace(path, before, after, expected = 1) {
  const source = read(path);
  const count = source.split(before).length - 1;
  if (count !== expected) throw new Error(path + ': expected ' + expected + ' matches; got ' + count + ' for ' + JSON.stringify(before));
  put(path, source.split(before).join(after));
}
function section(path, start, end, replacement) {
  const source = read(path);
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(path + ': missing section boundary ' + JSON.stringify({ start, end }));
  put(path, source.slice(0, a) + replacement + source.slice(b));
}
async function apply(name, overrides = {}) {
  const module = await import(pathToFileURL(join(payload, name + '.mjs')).href);
  module.default({ read, put, replace, section, ...overrides });
}
function commit(message) {
  const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  const paths = status.split('\n').map(l => l.slice(3)).filter(p => /^(src|test)\/.+\.ts$/.test(p));
  if (paths.length) run('npx', ['biome', 'check', '--write', ...paths]);
  run('git', ['add', 'src', 'test', 'docs', 'README.md', 'CHANGELOG.md', 'package.json', 'package-lock.json', 'examples']);
  run('git', ['commit', '-m', message]);
}
run('git', ['fetch', 'origin', 'master']);
if (git('rev-parse', 'FETCH_HEAD') !== BASE) throw new Error('Master changed; review/rebase before proceeding.');
if (git('ls-remote', '--heads', 'origin', BRANCH)) throw new Error('Feature branch already exists; do not overwrite validated history.');
run('git', ['checkout', '-b', BRANCH, BASE]);
run('git', ['config', 'user.name', 'github-actions[bot]']);
run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
run('npm', ['ci']);
const audit = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8' });
try { const report = JSON.parse(audit.stdout); console.log('DEPENDENCY_AUDIT', JSON.stringify({ metadata: report.metadata, vulnerabilities: report.vulnerabilities })); } catch { console.log('DEPENDENCY_AUDIT_UNAVAILABLE'); }

await apply('worktree', { replace: (path, ...args) => path === 'src/agent-manager.ts' ? undefined : replace(path, ...args) });
replace('src/types.ts', 'import type { LifetimeUsage } from "./usage.js";', 'import type { LifetimeUsage } from "./usage.js";\nimport type { WorktreeCleanupResult } from "./worktree.js";');
replace('src/types.ts', '  worktreeResult?: { hasChanges: boolean; branch?: string };', '  worktreeResult?: WorktreeCleanupResult;');
await apply('contract-tests');
replace('test/worktree.test.ts', '      const result = await cleanupWorktree(pi, repoDir, wt, "already gone");\n      expect(result.hasChanges).toBe(false);', '      const result = await cleanupWorktree(pi, repoDir, wt, "already gone");\n      expect(result).toMatchObject({ hasChanges: true, error: expect.stringContaining("missing") });');
commit('fix: preserve worktree changes when Git preservation or removal fails');
await apply('lifecycle');
replace('src/index.ts', 'import { abortable } from "./abortable.js";\n', '');
replace('src/agent-manager.ts', '    signal.addEventListener("abort", () => this.abort(id), { once: true });', '    const runId = this.agents.get(id)?.runId;\n    signal.addEventListener("abort", () => {\n      if (this.agents.get(id)?.runId === runId) this.abort(id);\n    }, { once: true });');
replace('src/agent-manager.ts', '            record.result += "\\n\\nChanges saved to branch " + wt.branch + repoNote + ". Merge with: git merge " + wt.branch;', '            record.result += "\\n\\n---\\nChanges saved to branch `" + wt.branch + "`" + repoNote + ". Merge with: `git merge " + wt.branch + "`" +\n              (customCwd !== undefined ? " (run in `" + baseCwd + "`)" : "");');
replace('test/agent-manager.test.ts', '// Foreground resume returns its result inline and never notified (historical).', '// Foreground resume returns its result inline and never notified before.');
await apply('integration-fixes');
commit('fix: unify execution finalization, resume guards and result waiting');
await apply('history');
await apply('compaction');
await apply('followup');
await apply('docs');
commit('feat: recover saved results across compaction and runtime cleanup (0.19.0-ahggg.3)');

run('npx', ['vitest', 'run', 'test/worktree-preservation.test.ts', 'test/worktree.test.ts', 'test/execution-lifecycle.test.ts', 'test/agent-manager.test.ts', 'test/workflow-gate-worktree.test.ts', 'test/background-resume-wiring.test.ts', 'test/result-history.test.ts', 'test/result-recovery-wiring.test.ts', 'test/e2e/result-compaction.e2e.test.ts']);
run('npm', ['run', 'check']);
run('npm', ['run', 'build']);
run('npm', ['run', 'test:e2e']);
run('git', ['diff', '--check']);
if (git('status', '--porcelain')) throw new Error('Validation changed tracked or untracked source; review before pushing.');
const packs = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
for (const pack of packs) console.log('PACK_VALIDATED', pack.id, pack.entryCount, 'files');
const sha = git('rev-parse', 'HEAD');
run('git', ['push', 'origin', 'HEAD:' + BRANCH]);
console.log('HARDENING_VALIDATED_SHA=' + sha);
