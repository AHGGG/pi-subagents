import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/index.ts';
const source = readFileSync(file, 'utf8');
const before = '        if (!record) continue;\n        record.groupId = groupId;';
const after = `        if (!record) continue;
        // Fast runs can settle during awaitStartup, before batch registration.
        // The group now owns delivery: retract the individual hold first.
        cancelNudge(id);
        record.groupId = groupId;`;

if (!source.includes(after)) {
  if (source.split(before).length !== 2) throw new Error('Expected one group-assignment boundary');
  writeFileSync(file, source.replace(before, after));
  execFileSync('npx', ['biome', 'check', file], { stdio: 'inherit' });
  execFileSync('npx', ['vitest', 'run', 'test/passive-completion-wiring.test.ts', 'test/group-join.test.ts', 'test/e2e/passive-completion.e2e.test.ts'], { stdio: 'inherit' });
  execFileSync('git', ['add', file], { stdio: 'inherit' });
  execFileSync('git', ['commit', '-m', 'fix: cancel early individual notices when a group takes ownership'], { stdio: 'inherit' });
  execFileSync('git', ['push', 'origin', 'HEAD:refs/heads/v1'], { stdio: 'inherit' });
}
