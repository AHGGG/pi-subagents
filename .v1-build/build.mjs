import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
const BASE = 'e955e29c51b7a6cce37e1108cd2d6c57a77e151c';
const UPSTREAM = 'https://github.com/tintinweb/pi-subagents.git';
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const read = path => readFileSync(path, 'utf8');
const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
function replace(path, from, to, expected = 1) {
  const text = read(path);
  const count = text.split(from).length - 1;
  if (count !== expected) throw new Error(path + ': expected ' + expected + ' matches, got ' + count + ' for ' + from);
  put(path, text.split(from).join(to));
}
function commit(message) {
  git('add', '-A');
  if (git('diff', '--cached', '--name-only').trim()) run('git', ['commit', '-m', message]);
}
git('config', 'user.name', 'ChatGPT');
git('config', 'user.email', 'noreply@openai.com');
run('git', ['fetch', 'origin', 'master']);
const fresh = !git('ls-remote', '--heads', 'origin', 'refs/heads/v1').trim();
if (fresh) {
  if (git('rev-parse', 'origin/master').trim() !== BASE) throw new Error('master changed; refusing unreviewed base');
  run('git', ['switch', '-c', 'v1', 'origin/master']);
} else {
  run('git', ['fetch', 'origin', 'v1']);
  run('git', ['switch', '-c', 'v1', 'FETCH_HEAD']);
}
if (fresh) {
  for (const [number, sha, title, paths] of [
    [311, '8d56733ed2b87b3d93d129e67d14c1bc4469609b', 'expose foreground resumable agent IDs', ['.', ':(exclude)CHANGELOG.md']],
    [316, '75e0db9920c46f29a5dcea8ee9d16f80834c9526', 'dispose activation-owned timers on shutdown', ['.', ':(exclude)CHANGELOG.md']],
    [348, '1ecd1e52997ba29ec6baa4c2df5b3e7705f2dcab', 'retain unread results and fix Pi 0.87 mention cloning', ['.', ':(exclude)CHANGELOG.md']],
    [321, 'c89d72aa5f2c92d1db8ae2b6126373faf1e7b9f3', 'stop idle widget rendering and use a 250ms tick', ['src/ui/agent-widget.ts', 'test/agent-widget.test.ts']],
  ]) {
    run('git', ['fetch', '--no-tags', UPSTREAM, 'refs/pull/' + number + '/head']);
    if (git('rev-parse', 'FETCH_HEAD').trim() !== sha) throw new Error('PR #' + number + ' changed after review');
    const patch = git('diff', BASE, sha, '--', ...paths);
    execFileSync('git', ['apply', '--index', '-'], { input: patch, stdio: ['pipe', 'inherit', 'inherit'] });
    const author = git('show', '-s', '--format=%an <%ae>', sha).trim();
    run('git', ['commit', '--author', author, '-m', 'fix: ' + title + ' (upstream #' + number + ')', '-m', 'Ported from https://github.com/tintinweb/pi-subagents/pull/' + number + '\nReviewed head: ' + sha + (number === 321 ? '\nOnly the widget and its tests; unrelated changes excluded.' : '\nUpstream CHANGELOG omitted; fork notes document the backport.')]);
  }
  const index = 'src/index.ts';
  replace(index, '  const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();', '  let shuttingDown = false;\n  const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();');
  replace(index, '  function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {\n    cancelNudge(key);', '  function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {\n    if (shuttingDown) return;\n    cancelNudge(key);');
  replace(index, '  // ---- Individual nudge helper (async join mode) ----', `  // Retained completions are snapshots, not mutable records for resumed runs.
  // Promise identity distinguishes executions even when timestamps coincide.
  function isUnreadCompletion(completion: AgentRecord): boolean {
    if (shuttingDown) return false;
    const live = manager.getRecord(completion.id);
    return !!live && !live.resultConsumed
      && live.status !== "running" && live.status !== "queued"
      && live.promise === completion.promise
      && live.completedAt === completion.completedAt;
  }

  // ---- Individual nudge helper (async join mode) ----`);
  replace(index, '    if (record.resultConsumed) return;  // re-check at send time', '    if (!isUnreadCompletion(record)) return; // Re-check consumption and execution.');
  replace(index, '      content: notification + footer,', '      content: notification + footer + "\\nResult ready. Retrieve full output with get_subagent_result({ agent_id: " + JSON.stringify(record.id) + ", wait: false }). This notice does not mean the result has been consumed.",');
  replace(index, '    scheduleNudge(record.id, () => emitIndividualNudge(record));', '    const completion = { ...record };\n    scheduleNudge(record.id, () => emitIndividualNudge(completion));');
  replace(index, '        const unconsumed = records.filter(r => !r.resultConsumed);', '        const unconsumed = records.filter(isUnreadCompletion);');
  replace(index, '  const manager = new AgentManager((record) => {', '  const manager = new AgentManager((record) => {\n    if (shuttingDown) return;');
  replace(index, '  pi.on("session_shutdown", async () => {', '  pi.on("session_shutdown", async () => {\n    shuttingDown = true;');
  replace(index, "  let defaultJoinMode: JoinMode = 'smart';", "  let defaultJoinMode: JoinMode = 'async';");
  replace(index, '    }, { deliverAs: "followUp", triggerTurn: true });', '    }, { triggerTurn: false });', 3);
  replace(index, '  function notifyWorkflowFinished(task: WorkflowTask) {', '  function notifyWorkflowFinished(task: WorkflowTask) {\n    if (shuttingDown || !workflowTasks.has(task.id)) return;');
  replace(index, '   * agent uses — held briefly by `scheduleNudge`, delivered as a follow-up that\n   * triggers a turn, rendered by the existing `subagent-notification` renderer.', '   * agent uses — held briefly by `scheduleNudge`, appended as passive context\n   * without starting a turn, rendered by the existing notification renderer.');
  replace('src/group-join.ts', '    group.completedRecords.set(record.id, record);', '    // A resume mutates the live record. Keep the execution that actually finished.\n    group.completedRecords.set(record.id, { ...record });');
  const passiveNote = '\n\nBackground completion notices are passive context: they do not start or force a parent turn. Read a notice on your next natural model request and retrieve relevant results with get_subagent_result. If the final answer depends on a child, explicitly wait for that child with get_subagent_result(wait: true), or use run_in_background: false; do not assume a completion notice will wake an idle or exiting parent.\n';
  replace(index, 'Terse command-style prompts produce shallow, generic work.', 'Terse command-style prompts produce shallow, generic work.' + passiveNote);
  replace('examples/agent-tool-description.md', 'Terse command-style prompts produce shallow, generic work.', 'Terse command-style prompts produce shallow, generic work.' + passiveNote);
  const pkg = JSON.parse(read('package.json'));
  pkg.name = '@ahggg/pi-subagents';
  pkg.version = '0.19.0-ahggg.1';
  pkg.private = true;
  pkg.description = 'Personal V1 fork: reliable subagents with passive completion notifications for Pi';
  pkg.repository.url = 'https://github.com/AHGGG/pi-subagents.git';
  pkg.homepage = 'https://github.com/AHGGG/pi-subagents#readme';
  pkg.bugs.url = 'https://github.com/AHGGG/pi-subagents/issues';
  for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']) {
    pkg.peerDependencies[name] = '>=0.87.1';
    pkg.devDependencies[name] = '0.87.1';
  }
  put('package.json', JSON.stringify(pkg, null, 2) + '\n');
  // No workflow files are changed by this source-only runner.
  put('docs/FORK_V1.md', `# AHGGG personal fork — V1

Based on upstream master e955e29c51b7a6cce37e1108cd2d6c57a77e151c.
Requires Pi 0.87.1 or newer; development dependencies are pinned to 0.87.1.
This is a Git-installed personal fork, not a published npm package.

## Install

Remove the upstream extension first so two copies do not register the same tools:

    pi remove npm:@tintinweb/pi-subagents
    pi install git:github.com/AHGGG/pi-subagents

Then restart Pi (or use /reload after running agents finish). If upstream was
installed by a different Git/local source, remove that exact source instead.
The fork loads src/index.ts; Git installation does not depend on an untracked dist.
Update with pi update --extensions. Do not install the fork's unpublished npm name.

## Completion contract

Background completions use sendMessage with triggerTurn explicitly false and no
steer/followUp/nextTurn delivery mode. On Pi 0.87.1, an active tool batch finishes
before the custom message is appended. A naturally following model request sees
it. An idle parent is not prompted; its next user interaction includes the notice.
No user message is rewritten and no synthetic user prompt is created.
A completion arriving during the final assistant answer does NOT force another
request. Required joins must use a foreground Agent or get_subagent_result with
wait: true, particularly in one-shot print/JSON mode. A hung explicit wait remains
unbounded in V1; this fork does not include the broader timeout/supervisor rewrite.

The default joinMode is async, notifying each finished agent independently.
Existing explicit smart/group configuration is respected and may delay a group
notice. Change /agents -> Settings -> Join mode to async for incremental results.
Workflow-tool completions also append passively; flag-launched workflows retain
their existing next-user-turn behavior and headless lifecycle limitations.
Nested children remain owner-scoped rather than notifying the root directly.

A notice does not consume a result. get_subagent_result still performs retrieval.
The 200ms hold rechecks consumption and execution identity. Group records are
snapshotted so a resume cannot rewrite an earlier completion. Once handed to Pi,
a notice cannot be retracted: a later retrieval may leave a harmless stale notice.
There is no exactly-once/crash-recovery guarantee for pending notifications.

Unread terminal results are retained in memory until consumed or explicitly
cleared, or the session ends. There is no automatic size/TTL bound for unread
results. Consumed results retain upstream's completion-age cleanup policy.

## Imported fixes

- #311 (8d56733): foreground/nested inline result IDs; original tests included.
- #316 (75e0db9): dispose widget, group and debounce timers on shutdown.
- #348 (1ecd1e5): unread retention, Pi 0.87 mention cloning, compatibility tests.
- #321 (c89d72a): ONLY widget cadence/idle-stop and its tests; unrelated changes omitted.

Upstream PRs: https://github.com/tintinweb/pi-subagents/pulls
Pi implementation: https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/agent-session.ts
Original MIT license and author attribution are preserved.

## Validation

Run npm ci, npm run check, npm run build, and npm run test:e2e.
Tests use scripted providers and do not require paid model calls.
Manual Windows/macOS terminal and live-provider behavior are not certified by CI.
Passive-completion tests cover idle delivery, tool-batch ordering, no forced
final-answer continuation, consumption, grouping, resume and shutdown.
`);
  put('README.md', `# AHGGG pi-subagents — personal V1 fork

**Install this fork from Git, not the upstream npm package. Requires Pi >= 0.87.1.**

    pi install git:github.com/AHGGG/pi-subagents

Remove any installed upstream copy first. See [fork installation and behavior](docs/FORK_V1.md).

V1 adds passive completion notices, async join by default, unread result retention,
resumable foreground IDs, shutdown cleanup and an idle-safe 250ms widget tick.
Notices reach the next natural model request without interrupting tools or waking
an idle parent. Tasks that require a child result must still join it explicitly.

The upstream documentation below is retained for reference; the V1 contract above
supersedes its automatic-wakeup and smart-default descriptions.

---

` + read('README.md'));

  put('test/passive-completion-wiring.test.ts', String.raw`import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagents from "../src/index.js";
import { ctx, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

describe("V1 passive completion wiring", () => {
  let env: ReturnType<typeof hermeticDir>;
  let boot: ReturnType<typeof makePi>;
  let context: ReturnType<typeof ctx>;
  const releases: Array<() => void> = [];
  const completed = () => ({ responseText: "CHILD-RESULT", session: { dispose: vi.fn(), messages: [] }, aborted: false, steered: false });
  const manager = () => (globalThis as any)[Symbol.for("pi-subagents:manager")];
  beforeEach(() => {
    vi.useFakeTimers();
    env = hermeticDir({ settings: { schedulingEnabled: false, rememberAgents: false, outputTranscript: false } });
    vi.mocked(runAgent).mockResolvedValue(completed() as any);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "RESUMED-RESULT" } as any);
  });
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    await vi.advanceTimersByTimeAsync(0);
    await boot?.lifecycle.get("session_shutdown")?.({}, context);
    vi.useRealTimers();
    env.restore();
    vi.restoreAllMocks();
  });
  async function start(joinMode?: string) {
    if (joinMode) {
      const { writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      writeFileSync(join(env.dir, ".pi", "subagents.json"), JSON.stringify({ joinMode, schedulingEnabled: false, rememberAgents: false, outputTranscript: false }));
    }
    boot = makePi();
    context = ctx({ isIdle: () => true });
    subagents(boot.pi);
    await boot.lifecycle.get("session_start")({}, context);
  }
  async function spawn(description = "child") {
    const result = await boot.tools.get("Agent").execute("call-" + description, {
      subagent_type: "general-purpose", prompt: "do work", description, run_in_background: true,
    }, undefined, undefined, context);
    const id = textOf(result).match(/Agent ID: (\S+)/)?.[1];
    expect(id).toBeTruthy();
    return id!;
  }
  async function consume(id: string) {
    return boot.tools.get("get_subagent_result").execute("get", { agent_id: id, wait: false }, undefined, undefined, context);
  }
  it("appends an individual completion passively without consuming its result", async () => {
    await start();
    const id = await spawn();
    await vi.advanceTimersByTimeAsync(400);
    expect(boot.pi.sendMessage).toHaveBeenCalledOnce();
    expect(boot.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      customType: "subagent-notification", display: true, content: expect.stringContaining(id),
    }), { triggerTurn: false });
    expect(manager().getRecord(id).resultConsumed).toBeFalsy();
    expect(textOf(await consume(id))).toContain("CHILD-RESULT");
  });
  it("defaults to async: a fast child does not wait for a slow sibling", async () => {
    await start();
    vi.mocked(runAgent).mockResolvedValueOnce(completed() as any).mockImplementationOnce(() => new Promise(resolve => {
      releases.push(() => resolve(completed() as any));
    }));
    const first = await spawn("fast");
    await spawn("slow");
    await vi.advanceTimersByTimeAsync(400);
    expect(boot.pi.sendMessage).toHaveBeenCalledOnce();
    expect(boot.pi.sendMessage.mock.calls[0][0].content).toContain(first);
  });
  it("suppresses a result retrieved inside the hold", async () => {
    await start();
    const id = await spawn();
    await vi.advanceTimersByTimeAsync(0);
    await consume(id);
    await vi.advanceTimersByTimeAsync(400);
    expect(boot.pi.sendMessage).not.toHaveBeenCalled();
  });
  it("retains explicit smart grouping and removes consumed members", async () => {
    await start("smart");
    const first = await spawn("first");
    const second = await spawn("second");
    await vi.advanceTimersByTimeAsync(150);
    await consume(first);
    await vi.advanceTimersByTimeAsync(250);
    expect(boot.pi.sendMessage).toHaveBeenCalledOnce();
    const [message, options] = boot.pi.sendMessage.mock.calls[0];
    expect(options).toEqual({ triggerTurn: false });
    expect(message.content).toContain("1 agent(s) finished");
    expect(message.content).toContain(second);
    expect(message.content).not.toContain(first);
  });
  it("does not deliver the previous completion while the same agent is resumed", async () => {
    await start();
    const id = await spawn();
    await vi.advanceTimersByTimeAsync(120);
    vi.mocked(resumeAgent).mockImplementationOnce(() => new Promise(resolve => {
      releases.push(() => resolve({ text: "RESUMED-RESULT" } as any));
    }));
    await boot.tools.get("Agent").execute("resume", {
      subagent_type: "general-purpose", description: "resume", prompt: "continue", resume: id, run_in_background: true,
    }, undefined, undefined, context);
    await vi.advanceTimersByTimeAsync(400);
    expect(boot.pi.sendMessage).not.toHaveBeenCalled();
  });
  it("drops undelivered completions on shutdown", async () => {
    await start();
    await spawn();
    await boot.lifecycle.get("session_shutdown")({}, context);
    await vi.advanceTimersByTimeAsync(400);
    expect(boot.pi.sendMessage).not.toHaveBeenCalled();
  });
});
`);
  put('test/e2e/passive-completion.e2e.test.ts', String.raw`import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";
vi.setConfig({ testTimeout: 30_000 });
const MARKER = "SUBAGENT-READY-PASSIVE";
const notice = { customType: "subagent-notification", content: MARKER, display: true };
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
describe("passive completions against real Pi", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const releases: Array<() => void> = [];
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "passive-e2e-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    await session?.abort();
    session?.dispose();
    session = undefined;
    faux.unregister();
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  });
  async function create(customTools: any[] = []) {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, noExtensions: true, noSkills: true, noPromptTemplates: true });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd, model, modelRegistry: backend.modelRegistry, modelRuntime: backend.modelRuntime,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoader: loader, tools: customTools.map(t => t.name), customTools,
    } as any));
    return session!;
  }
  it("does not wake an idle parent; its next user request includes the notice", async () => {
    const requests: any[] = [];
    faux.setResponses([context => {
      requests.push(context);
      return fauxAssistantMessage([fauxText("done")]);
    }]);
    const s = await create();
    await s.sendCustomMessage(notice, { triggerTurn: false });
    expect(requests).toHaveLength(0);
    expect(JSON.stringify(s.messages)).toContain(MARKER);
    await s.prompt("Continue normally");
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0].messages)).toContain(MARKER);
  });
  it("finishes the entire tool batch and exposes the notice on the next natural request", async () => {
    const entered = gate();
    const release = gate();
    releases.push(release.resolve);
    const requests: any[] = [];
    let signalAtEnd: AbortSignal | undefined;
    const tool = {
      name: "blocked_probe", label: "Blocked probe", description: "Controlled test tool", parameters: Type.Object({}),
      async execute(_id: string, _args: unknown, signal?: AbortSignal) {
        entered.resolve();
        await release.promise;
        signalAtEnd = signal;
        return { content: [fauxText("TOOL-BATCH-FINISHED")], details: {} };
      },
    };
    faux.setResponses([
      context => { requests.push(context); return fauxAssistantMessage([fauxToolCall("blocked_probe", {})]); },
      context => { requests.push(context); return fauxAssistantMessage([fauxText("done")]); },
    ]);
    const s = await create([tool]);
    const running = s.prompt("Use the probe, then answer");
    await entered.promise;
    await s.sendCustomMessage(notice, { triggerTurn: false });
    expect(JSON.stringify(s.messages)).not.toContain(MARKER);
    expect(requests).toHaveLength(1);
    release.resolve();
    await running;
    expect(signalAtEnd?.aborted).not.toBe(true);
    expect(requests).toHaveLength(2);
    const messages = requests[1].messages;
    const toolIndex = messages.findIndex((m: any) => m.role === "toolResult" && JSON.stringify(m).includes("TOOL-BATCH-FINISHED"));
    const noticeIndex = messages.findIndex((m: any) => JSON.stringify(m).includes(MARKER));
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(noticeIndex).toBeGreaterThan(toolIndex);
  });
  it("does not force another request when completion arrives during a final answer", async () => {
    const entered = gate();
    const release = gate();
    releases.push(release.resolve);
    let calls = 0;
    faux.setResponses([async () => {
      calls++;
      entered.resolve();
      await release.promise;
      return fauxAssistantMessage([fauxText("FINAL-ANSWER")]);
    }, () => { calls++; return fauxAssistantMessage([fauxText("UNEXPECTED-CONTINUATION")]); }]);
    const s = await create();
    const running = s.prompt("Answer once");
    await entered.promise;
    await s.sendCustomMessage(notice, { triggerTurn: false });
    release.resolve();
    await running;
    expect(calls).toBe(1);
    expect(JSON.stringify(s.messages)).toContain(MARKER);
    expect(JSON.stringify(s.messages)).not.toContain("UNEXPECTED-CONTINUATION");
  });
});
`);
  function walk(path) {
    return readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(path, e.name)) : [join(path, e.name)]);
  }
  for (const path of walk('test').filter(p => p.endsWith('.ts'))) {
    const old = read(path);
    const changed = old.replaceAll('{ deliverAs: "followUp", triggerTurn: true }', '{ triggerTurn: false }');
    if (old !== changed) put(path, changed);
  }
  run('npm', ['install', '--package-lock-only', '--ignore-scripts']);
  run('npm', ['ci']);
  run('npx', ['biome', 'check', '--write', 'src/index.ts', 'src/group-join.ts', 'test/passive-completion-wiring.test.ts', 'test/e2e/passive-completion.e2e.test.ts']);
  commit('feat: add passive completion delivery and package personal V1 for Pi 0.87.1');
  run('git', ['push', 'origin', 'HEAD:refs/heads/v1']);
} else {
  run('npm', ['ci']);
}
if (existsSync(new URL('./fix.mjs', import.meta.url))) await import('./fix.mjs');
delete process.env.PI_E2E_LIVE;
run('npm', ['run', 'check']);
run('npm', ['run', 'build']);
run('npm', ['run', 'test:e2e']);
run('npm', ['pack', '--dry-run']);
console.log('V1_VALIDATED_SHA=' + git('rev-parse', 'HEAD').trim());
