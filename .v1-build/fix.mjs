import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const changed = new Set();
function change(path, before, after, expected = 1) {
  const source = readFileSync(path, 'utf8');
  if (!source.includes(before) && source.includes(after)) return;
  const count = source.split(before).length - 1;
  if (count !== expected) throw new Error(path + ': unexpected replacement count ' + count);
  writeFileSync(path, source.split(before).join(after));
  changed.add(path);
}

change('test/agent-mention-wiring.test.ts', 'expect.objectContaining({ triggerTurn: true })', 'expect.objectContaining({ triggerTurn: false })');
change('test/mention-start-notification.test.ts', 'expect.objectContaining({ triggerTurn: true })', 'expect.objectContaining({ triggerTurn: false })', 2);
change('test/passive-completion-wiring.test.ts', 'JSON.stringify({ joinMode, schedulingEnabled: false, rememberAgents: false, outputTranscript: false })', 'JSON.stringify({ defaultJoinMode: joinMode, schedulingEnabled: false, rememberAgents: false, outputTranscript: false })');

change('src/index.ts',
  '      for (const r of records) { agentActivity.delete(r.id); widget.markFinished(r.id); fleet.onAgentFinished(r.id); }',
  `      for (const r of records) {
        // A previous grouped run must not erase the resumed run's live activity.
        if (!isUnreadCompletion(r)) continue;
        agentActivity.delete(r.id);
        widget.markFinished(r.id);
        fleet.onAgentFinished(r.id);
      }`);
change('src/index.ts',
  '- Parallel work: one message, multiple Agent calls — they run concurrently.',
  '- Parallel work: one message, multiple Agent calls — they run concurrently.\n- Completion notices are passive: they do not wake an idle parent. Join required results explicitly with get_subagent_result(wait: true) before your final answer.');
change('src/index.ts',
  '      "A workflow runs in the background and notifies you when it finishes — do not poll or sleep waiting for it.",',
  '      "A workflow runs in the background and appends a passive completion notice. It does not wake an idle parent; do not promise an automatic later response or poll/sleep waiting for it.",');
change('docs/FORK_V1.md', 'The default joinMode is async, notifying each finished agent independently.', 'The defaultJoinMode setting defaults to async, notifying each finished agent independently.');

change('test/workflow-tool.test.ts', 'import { join } from "node:path";', 'import { join } from "node:path";\nimport { Worker } from "node:worker_threads";');
change('test/workflow-tool.test.ts',
  '  it("kills a still-running workflow (and its worker thread) on session shutdown", async () => {',
  '  it("kills a still-running workflow (and its worker thread) on session shutdown", async () => {\n    const terminate = vi.spyOn(Worker.prototype, "terminate");');
change('test/workflow-tool.test.ts',
  '    const sent = await awaitNotification(startedTaskId(result));\n    expect(String(sent[0].content)).toContain("<status>Stopped</status>");',
  `    // Shutdown must terminate the real worker, not try to wake a stale host.
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
    await Promise.all(terminate.mock.results.filter(r => r.type === "return").map(r => r.value));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(booted.pi.sendMessage.mock.calls.some((c: any[]) => String(c[0]?.content).includes(startedTaskId(result)))).toBe(false);`);

const testPath = 'test/passive-completion-wiring.test.ts';
const testSource = readFileSync(testPath, 'utf8');
if (!testSource.includes('filters a stale grouped execution even after that agent completes again')) {
  const insertion = String.raw`
  it("filters a stale grouped execution even after that agent completes again", async () => {
    await start("smart");
    const first = await spawn("first-generation");
    const second = await spawn("sibling");
    await vi.advanceTimersByTimeAsync(150);
    // Simulate the same retained agent completing another execution before
    // the original group hold fires, including the same completion timestamp.
    const live = manager().getRecord(first);
    live.promise = Promise.resolve("NEW-GENERATION");
    live.result = "NEW-GENERATION";
    live.resultConsumed = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(boot.pi.sendMessage).toHaveBeenCalledOnce();
    const message = boot.pi.sendMessage.mock.calls[0][0];
    expect(message.content).toContain(second);
    expect(message.content).toContain("1 agent(s) finished");
    expect(message.content).not.toContain(first);
    expect(message.content).not.toContain("NEW-GENERATION");
  });

  it("reports failure truthfully and does not consume the failed result", async () => {
    await start();
    vi.mocked(runAgent).mockRejectedValueOnce(new Error("CONTROLLED-CHILD-FAILURE"));
    const id = await spawn("failing-child");
    await vi.advanceTimersByTimeAsync(400);
    expect(boot.pi.sendMessage).toHaveBeenCalledOnce();
    const [message, options] = boot.pi.sendMessage.mock.calls[0];
    expect(options).toEqual({ triggerTurn: false });
    expect(message.details.status).toBe("error");
    expect(message.content).toContain("CONTROLLED-CHILD-FAILURE");
    expect(manager().getRecord(id).resultConsumed).toBeFalsy();
  });
`;
  const end = testSource.lastIndexOf('\n});');
  if (end < 0) throw new Error('test insertion boundary missing');
  writeFileSync(testPath, testSource.slice(0, end) + insertion + testSource.slice(end));
  changed.add(testPath);
}

if (changed.size) {
  const ts = [...changed].filter(p => p.endsWith('.ts'));
  execFileSync('npx', ['biome', 'check', '--write', ...ts], { stdio: 'inherit' });
  execFileSync('git', ['add', ...changed], { stdio: 'inherit' });
  execFileSync('git', ['commit', '-m', 'fix: validate passive completion lifecycle and stale run filtering'], { stdio: 'inherit' });
  execFileSync('git', ['push', 'origin', 'HEAD:refs/heads/v1'], { stdio: 'inherit' });
}

// Report dependency diagnostics without applying an unrelated dependency rewrite.
const audit = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8' });
try {
  const report = JSON.parse(audit.stdout);
  console.log('DEPENDENCY_AUDIT=' + JSON.stringify({ metadata: report.metadata?.vulnerabilities, packages: Object.entries(report.vulnerabilities ?? {}).map(([name, v]) => ({ name, severity: v.severity, isDirect: v.isDirect, fixAvailable: v.fixAvailable, via: v.via.map(x => typeof x === 'string' ? x : { name: x.name, title: x.title, range: x.range }) })) }));
} catch { console.log('Dependency audit report unavailable; no automatic fixes applied.'); }
