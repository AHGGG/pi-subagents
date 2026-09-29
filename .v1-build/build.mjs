import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

// Temporary integration tooling: only source/docs/tests are pushed to the feature
// branch. No workflow or repository permission changes are made by this runner.
const BASE = '94a2c86ee8152961428da796595317609a4b193e';
const BRANCH = 'fix/automatic-completion-continuation';
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
const read = path => readFileSync(path, 'utf8');
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
function replace(path, before, after, expected = 1) {
  const source = read(path);
  const count = source.split(before).length - 1;
  if (count === 0 && source.includes(after)) return;
  if (count !== expected) throw new Error(path + ': expected ' + expected + ' matches; got ' + count + ' for ' + before);
  put(path, source.split(before).join(after));
}
function move(before, after) {
  if (existsSync(before)) {
    if (existsSync(after)) throw new Error('Both paths exist: ' + before + ' and ' + after);
    renameSync(before, after);
  }
}
run('git', ['fetch', 'origin', 'master']);
if (git('rev-parse', 'FETCH_HEAD') !== BASE) throw new Error('Master changed; rebase and review before continuing.');
const remote = git('ls-remote', '--heads', 'origin', BRANCH);
if (remote) {
  run('git', ['fetch', 'origin', BRANCH]);
  run('git', ['checkout', '-B', BRANCH, 'FETCH_HEAD']);
} else {
  run('git', ['checkout', '-b', BRANCH, BASE]);
}
run('git', ['config', 'user.name', 'github-actions[bot]']);
run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);

put('src/completion-delivery.ts', `/**
 * Completion delivery is shared by individual, grouped and workflow-tool notices.
 *
 * On Pi 0.87.1, steering is drained AFTER the complete tool batch, before the
 * next model request. It does not abort tools or skip sequential batch members.
 * It also requests continuation after a text-only answer; followUp would delay
 * a notice until the active tool loop finishes. triggerTurn wakes an idle parent.
 *
 * This is not a cancellation policy: interrupting the parent alone does not
 * cancel detached children or permanently disable their later notifications.
 */
export const COMPLETION_DELIVERY_OPTIONS = Object.freeze({
  deliverAs: "steer",
  triggerTurn: true,
} as const);
`);
replace('src/index.ts', 'import { inChildSessionContext } from "./child-context.js";', 'import { inChildSessionContext } from "./child-context.js";\nimport { COMPLETION_DELIVERY_OPTIONS } from "./completion-delivery.js";');
replace('src/index.ts', '}, { triggerTurn: false });', '}, COMPLETION_DELIVERY_OPTIONS);', 3);
replace('src/index.ts', '   * agent uses — held briefly by `scheduleNudge`, appended as passive context\n   * without starting a turn, rendered by the existing notification renderer.', '   * agent uses — held briefly by `scheduleNudge`, queued at the next model\n   * boundary (or waking an idle parent), using the existing notification renderer.');
const oldGuidance = 'Background completion notices are passive context: they do not start or force a parent turn. Read a notice on your next natural model request and retrieve relevant results with get_subagent_result. If the final answer depends on a child, explicitly wait for that child with get_subagent_result(wait: true), or use run_in_background: false; do not assume a completion notice will wake an idle or exiting parent.';
const newGuidance = 'Background completion notices reach your next model request after the current tool batch. If you are idle or finishing a text-only answer, a completion can automatically continue the conversation while Pi remains open. Retrieve relevant full results with get_subagent_result; a notification does not consume the result. If your final answer must include a child result, explicitly wait with get_subagent_result(wait: true) or use run_in_background: false, especially in one-shot/headless mode. Never treat a missing notice as proof that a child is still running.';
replace('src/index.ts', oldGuidance, newGuidance);
replace('examples/agent-tool-description.md', oldGuidance, newGuidance);

// Keep the existing consumption, grouping, resume and shutdown regressions;
// only update their delivery contract and give the tests accurate names.
move('test/passive-completion-wiring.test.ts', 'test/completion-delivery-wiring.test.ts');
replace('test/completion-delivery-wiring.test.ts', 'V1 passive completion wiring', 'automatic completion delivery wiring');
replace('test/completion-delivery-wiring.test.ts', 'appends an individual completion passively without consuming its result', 'requests an individual completion turn without consuming its result');
replace('test/completion-delivery-wiring.test.ts', '{ triggerTurn: false }', '{ deliverAs: "steer", triggerTurn: true }', 3);
replace('test/completion-delivery-wiring.test.ts', 'it("retains explicit smart grouping and removes consumed members", async () => {\n    await start("smart");', 'it.each(["smart", "group"])("retains explicit %s grouping and removes consumed members", async (joinMode) => {\n    await start(joinMode);');
replace('test/agent-mention-wiring.test.ts', '{ triggerTurn: false }', '{ deliverAs: "steer", triggerTurn: true }');
replace('test/mention-start-notification.test.ts', '{ triggerTurn: false }', '{ deliverAs: "steer", triggerTurn: true }', 2);
replace('test/workflow-tool.test.ts', '{ triggerTurn: false }', '{ deliverAs: "steer", triggerTurn: true }');
move('test/e2e/passive-completion.e2e.test.ts', 'test/e2e/completion-delivery.e2e.test.ts');
put('test/e2e/completion-delivery.e2e.test.ts', String.raw`import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPLETION_DELIVERY_OPTIONS } from "../../src/completion-delivery.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });
const MARKER = "SUBAGENT-READY-AUTOMATIC";
const notice = { customType: "subagent-notification", content: MARKER, display: true };
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
const snapshot = (context: any): any[] => structuredClone(context.messages);
const countNotices = (messages: any[]) => messages.filter(m => m.role === "custom" && m.customType === notice.customType).length;

describe("automatic completions against real Pi", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const releases: Array<() => void> = [];
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "completion-e2e-"));
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

  it("wakes an idle parent in the same session and lets it retrieve the result without a new user prompt", async () => {
    const requests: any[][] = [];
    const retrieve = vi.fn(async () => ({ content: [fauxText("CHILD-FULL-RESULT")], details: {} }));
    const tool = {
      name: "get_subagent_result", label: "Get result", description: "Read the completed child result",
      parameters: Type.Object({ agent_id: Type.String(), wait: Type.Boolean() }), execute: retrieve,
    };
    faux.setResponses([
      context => { requests.push(snapshot(context)); return fauxAssistantMessage([fauxText("The helper is working.")]); },
      context => { requests.push(snapshot(context)); return fauxAssistantMessage([fauxToolCall("get_subagent_result", { agent_id: "child-1", wait: false })]); },
      context => { requests.push(snapshot(context)); return fauxAssistantMessage([fauxText("I retrieved the helper's result.")]); },
    ]);
    const s = await create([tool]);
    await s.prompt("Delegate work, then tell me when the result is ready.");
    const sessionId = s.sessionId;
    expect(s.isIdle).toBe(true);
    expect(requests).toHaveLength(1);
    await s.sendCustomMessage(notice, COMPLETION_DELIVERY_OPTIONS);
    expect(s.sessionId).toBe(sessionId);
    expect(s.isIdle).toBe(true);
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[1])).toContain(MARKER);
    expect(JSON.stringify(requests[2])).toContain("CHILD-FULL-RESULT");
    expect(retrieve).toHaveBeenCalledOnce();
    expect(countNotices(s.messages)).toBe(1);
    expect(s.messages.filter(m => m.role === "user")).toHaveLength(1);
  });

  it.each(["parallel", "sequential"])("finishes every %s batch member before delivering on the next request, not at the end of the tool loop", async (mode) => {
    const firstEntered = gate();
    const secondEntered = gate();
    const firstRelease = gate();
    const secondRelease = gate();
    releases.push(firstRelease.resolve, secondRelease.resolve);
    const requests: any[][] = [];
    const finished: string[] = [];
    const aborted: boolean[] = [];
    const probe = (name: string, entered: ReturnType<typeof gate>, release: ReturnType<typeof gate>) => ({
      name, label: name, description: "Controlled test tool", parameters: Type.Object({}),
      executionMode: mode,
      async execute(_id: string, _args: unknown, signal?: AbortSignal) {
        entered.resolve();
        await release.promise;
        aborted.push(signal?.aborted ?? false);
        finished.push(name);
        return { content: [fauxText(name + "-FINISHED")], details: {} };
      },
    });
    const afterProbe = {
      name: "after_probe", label: "After probe", description: "Continue useful work", parameters: Type.Object({}),
      async execute() { return { content: [fauxText("FOLLOW-ON-WORK")], details: {} }; },
    };
    faux.setResponses([
      context => { requests.push(snapshot(context)); return fauxAssistantMessage([fauxToolCall("first_probe", {}), fauxToolCall("second_probe", {})]); },
      context => { requests.push(snapshot(context)); return fauxAssistantMessage([fauxToolCall("after_probe", {})]); },
      context => { requests.push(snapshot(context)); return fauxAssistantMessage([fauxText("DONE")]); },
    ]);
    const s = await create([probe("first_probe", firstEntered, firstRelease), probe("second_probe", secondEntered, secondRelease), afterProbe]);
    const running = s.prompt("Use both probes, do follow-on work, then answer.");
    await firstEntered.promise;
    if (mode === "parallel") await secondEntered.promise;
    await s.sendCustomMessage(notice, COMPLETION_DELIVERY_OPTIONS);
    expect(requests).toHaveLength(1);
    expect(countNotices(s.messages)).toBe(0);
    firstRelease.resolve();
    await secondEntered.promise;
    expect(requests).toHaveLength(1);
    expect(countNotices(s.messages)).toBe(0);
    secondRelease.resolve();
    await running;
    expect(finished.sort()).toEqual(["first_probe", "second_probe"]);
    expect(aborted).toEqual([false, false]);
    expect(requests).toHaveLength(3);
    const messages = requests[1];
    const noticeIndex = messages.findIndex(m => JSON.stringify(m).includes(MARKER));
    for (const name of ["first_probe", "second_probe"]) {
      const resultIndex = messages.findIndex(m => m.role === "toolResult" && JSON.stringify(m).includes(name + "-FINISHED"));
      expect(resultIndex).toBeGreaterThanOrEqual(0);
      expect(noticeIndex).toBeGreaterThan(resultIndex);
    }
    expect(countNotices(s.messages)).toBe(1);
  });

  it("automatically continues when a completion arrives during a text-only final answer", async () => {
    const entered = gate();
    const release = gate();
    releases.push(release.resolve);
    const requests: any[][] = [];
    faux.setResponses([
      async context => { requests.push(snapshot(context)); entered.resolve(); await release.promise; return fauxAssistantMessage([fauxText("FIRST-ANSWER")]); },
      context => { requests.push(snapshot(context)); return fauxAssistantMessage([fauxText("RESULT-HANDLED")]); },
    ]);
    const s = await create();
    const running = s.prompt("Answer about the delegated work.");
    await entered.promise;
    await s.sendCustomMessage(notice, COMPLETION_DELIVERY_OPTIONS);
    expect(requests).toHaveLength(1);
    release.resolve();
    await running;
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain(MARKER);
    expect(JSON.stringify(s.messages)).toContain("FIRST-ANSWER");
    expect(JSON.stringify(s.messages)).toContain("RESULT-HANDLED");
    expect(countNotices(s.messages)).toBe(1);
    expect(s.messages.filter(m => m.role === "user")).toHaveLength(1);
  });

  it("does not lose a completion arriving at agent_end before the parent becomes idle", async () => {
    const requests: any[][] = [];
    faux.setResponses([
      context => { requests.push(snapshot(context)); return fauxAssistantMessage([fauxText("FIRST-ANSWER")]); },
      context => { requests.push(snapshot(context)); return fauxAssistantMessage([fauxText("RESULT-HANDLED")]); },
    ]);
    const s = await create();
    let injected = false;
    let delivery: Promise<void> | undefined;
    const unsubscribe = s.subscribe(event => {
      if (event.type === "agent_end" && !injected) {
        injected = true;
        delivery = s.sendCustomMessage(notice, COMPLETION_DELIVERY_OPTIONS);
      }
    });
    try {
      await s.prompt("Answer, then become idle.");
      await delivery;
      expect(injected).toBe(true);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1])).toContain(MARKER);
      expect(countNotices(s.messages)).toBe(1);
      expect(s.isIdle).toBe(true);
    } finally {
      unsubscribe();
    }
  });
});
`);

const pkg = JSON.parse(read('package.json'));
if (!['0.19.0-ahggg.1', '0.19.0-ahggg.2'].includes(pkg.version)) throw new Error('Unexpected package version.');
pkg.version = '0.19.0-ahggg.2';
pkg.description = 'Personal fork: reliable subagents with timely completion notices and automatic continuation for Pi';
put('package.json', JSON.stringify(pkg, null, 2) + '\n');
const lock = JSON.parse(read('package-lock.json'));
lock.version = pkg.version;
lock.packages[''].version = pkg.version;
put('package-lock.json', JSON.stringify(lock, null, 2) + '\n');

replace('README.md', '# AHGGG pi-subagents — personal V1 fork', '# AHGGG pi-subagents — personal fork');
replace('README.md', 'V1 adds passive completion notices, async join by default, unread result retention,\nresumable foreground IDs, shutdown cleanup and an idle-safe 250ms widget tick.\nNotices reach the next natural model request without interrupting tools or waking\nan idle parent. Tasks that require a child result must still join it explicitly.\n\nThe upstream documentation below is retained for reference; the V1 contract above\nsupersedes its automatic-wakeup and smart-default descriptions.', '**Current version: 0.19.0-ahggg.2. Automatic wake-up is restored.**\nCompletion notices are queued after the current tool batch for the next model\nrequest. An idle main agent wakes automatically; a completion arriving during\na text-only final answer also requests continuation while Pi remains open.\nV1 reliability fixes remain: async join by default, unread-result retention,\nresumable IDs, shutdown cleanup, stale-run filtering and the idle-safe widget.\n\nAlready installed? Run `pi update --extensions`, then restart Pi after any\nrunning agents finish. Do not load the upstream package alongside this fork.\n\nStopping the parent alone does not cancel detached children or prevent their\nlater notices from waking it. Stop unwanted children through `/agents`. One-shot\nheadless commands must still explicitly join required results before exiting.\n\nThe upstream documentation below is retained for reference. The fork contract\nin `docs/FORK_V1.md` takes precedence, notably async default and earlier delivery.');
put('docs/FORK_V1.md', `# AHGGG personal fork — V1 and automatic-continuation update

Current version: **0.19.0-ahggg.2**.
Based on upstream master e955e29c51b7a6cce37e1108cd2d6c57a77e151c.
Requires Pi 0.87.1 or newer; development dependencies are pinned to 0.87.1.
This is a Git-installed personal fork, not a published npm package.

## Install or update

For an existing Git installation:

    pi update --extensions

For a new installation, remove any upstream copy first, then install:

    pi remove npm:@tintinweb/pi-subagents
    pi install git:github.com/AHGGG/pi-subagents

If upstream was installed by another Git/local source, remove that exact source
instead. Restart Pi after running agents finish, or use /reload when none remain.
The fork loads src/index.ts directly; no separate clone/build or npm publication
is needed. Do not install the unpublished @ahggg/pi-subagents npm name.

## Completion contract (updated in .2)

Individual, grouped and workflow-tool completions use the shared delivery options:

    { deliverAs: "steer", triggerTurn: true }

On the tested Pi 0.87.1 runtime:

- While the parent is working, the current model response and complete tool batch
  finish first. The completion is included before the next model request, not
  held until the entire tool loop ends as followUp would do. Running tools are
  not aborted, and remaining sequential batch tools are not skipped.
- When the parent is idle, the notice starts another turn in the same session.
  The user does not have to type "continue".
- A completion arriving during a text-only final answer requests a continuation
  after that answer. It does not cancel or rewrite the answer in progress.
- The notice is a custom session message. It neither rewrites the user's prompt
  nor creates a new user-authored message. The main model decides how to act on
  the notice; retrieval is not guaranteed solely by the delivery mechanism.

This replaces .1's passive-only policy; all other V1 reliability fixes remain.
Automatic turns use the configured main model and can incur normal model costs.
There is no busy/idle polling timer or agent-loop monkey-patch in this update.

## Cancellation and one-shot commands

Interrupting the main agent alone is NOT a global stop: detached children may
keep running, and a later completion can wake the parent again. This update does
not implement a new "manual stop disables wake-ups" policy. Stop unwanted children
through /agents. Session shutdown suppresses pending notices and aborts children.
A notice already handed to Pi cannot be retracted by the extension.

Wake-up requires a live Pi session. It does not keep a one-shot print/JSON process
alive until every child finishes. If the final answer must contain a child's
result, use a foreground Agent or get_subagent_result({ agent_id, wait: true })
before finishing. Explicit waits remain unbounded in V1.

## Existing controls and reliability

The defaultJoinMode setting defaults to async, notifying each child independently.
Existing explicit smart/group settings are respected and may delay group notices.
Change /agents -> Settings -> Join mode to async for incremental processing.
Flag-launched workflows retain their existing next-user-turn delivery and headless
lifecycle limitations. Nested children remain owner-scoped, not root broadcasts.

A notice does not consume a result. The 200ms hold rechecks consumption and
execution identity. Group snapshots cannot be rewritten by a resumed execution;
group ownership cancels any earlier individual hold. These checks apply before
handoff to Pi, not to messages already queued there. A later retrieval can leave
a stale queued notice and an unnecessary continuation; exactly-once delivery and
crash recovery are not promised.

Unread terminal results stay in memory until consumed, explicitly cleared or the
session ends, without an automatic size/TTL bound. Consumed results keep the
upstream completion-age cleanup policy.

## Imported fixes retained

- #311 (8d56733): foreground/nested inline result IDs and tests.
- #316 (75e0db9): dispose widget, group and debounce timers on shutdown.
- #348 (1ecd1e5): unread retention and Pi 0.87 mention-clone compatibility.
- #321 (c89d72a): only widget cadence/idle stop and tests; unrelated changes omitted.

Original MIT license and author attribution are preserved.
Upstream: https://github.com/tintinweb/pi-subagents
Pi notification implementation: https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/agent-session.ts
Pi tool-batch/steering order: https://github.com/earendil-works/pi/blob/v0.87.1/packages/agent/src/agent-loop.ts

## Validation

Run npm ci, npm run check, npm run build and npm run test:e2e.
The automatic-completion tests cover idle wake-up and result retrieval without a
new user prompt, parallel/sequential tool-batch ordering, delivery during a final
answer, and delivery at the agent_end boundary. Wiring tests retain consumption,
grouping, resumed-run filtering, failure and shutdown checks.
Tests use scripted providers with real Pi sessions, not paid/live model calls.
Manual Windows/macOS terminal and live-provider behavior are not certified by CI.

## Simple smoke test

Ask Pi to launch a general-purpose background agent that replies with
SUBAGENT_TEST_OK, then have the parent end its current response without waiting.
Once the child finishes and its hold expires, the parent should continue on its
own and be able to retrieve the result. If the child finishes before the parent
ends, its completion may instead be handled within the same ongoing run.
`);
const changelogEntry = `## 0.19.0-ahggg.2 — 2026-09-29

- Restore automatic parent continuation on background completion. Use explicit
  steering delivery at the next model boundary instead of passive-only context.
- Cover idle wake-up, completion during a final answer, late agent_end delivery,
  and uninterrupted parallel/sequential tool batches against real Pi 0.87.1.
- Keep V1 result retention, resumable IDs, async default, shutdown cleanup,
  execution-identity checks and duplicate/group safeguards.
- Document that parent-only interruption does not cancel detached children or
  permanently suppress their later wake-ups; one-shot commands still need joins.

`;
if (!read('CHANGELOG.md').includes('## 0.19.0-ahggg.2')) {
  const source = read('CHANGELOG.md');
  const firstBreak = source.indexOf('\n');
  put('CHANGELOG.md', source.slice(0, firstBreak + 1) + '\n' + changelogEntry + source.slice(firstBreak + 1).replace(/^\n+/, ''));
}

const codeFiles = ['src/completion-delivery.ts', 'src/index.ts', 'test/completion-delivery-wiring.test.ts', 'test/e2e/completion-delivery.e2e.test.ts', 'test/agent-mention-wiring.test.ts', 'test/mention-start-notification.test.ts', 'test/workflow-tool.test.ts'];
run('npm', ['ci']);
run('npx', ['biome', 'check', '--write', ...codeFiles]);
run('npx', ['vitest', 'run', 'test/completion-delivery-wiring.test.ts', 'test/e2e/completion-delivery.e2e.test.ts', 'test/agent-mention-wiring.test.ts', 'test/mention-start-notification.test.ts', 'test/workflow-tool.test.ts']);
run('npm', ['run', 'check']);
run('npm', ['run', 'build']);
run('npm', ['run', 'test:e2e']);
run('npm', ['pack', '--dry-run', '--json']);
run('git', ['diff', '--check']);
const changed = git('diff', '--name-only');
if (changed.split('\n').some(path => path.startsWith('.github/'))) throw new Error('Workflow changes are not permitted in the source branch.');
const paths = ['src/completion-delivery.ts', 'src/index.ts', 'test', 'examples/agent-tool-description.md', 'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'docs/FORK_V1.md'];
run('git', ['add', '--', ...paths]);
if (git('diff', '--cached', '--name-only')) run('git', ['commit', '-m', 'fix: restore automatic subagent completion continuation (0.19.0-ahggg.2)']);
run('git', ['diff', '--stat', BASE, 'HEAD']);
run('git', ['push', 'origin', 'HEAD:refs/heads/' + BRANCH]);
console.log('AUTOMATIC_COMPLETION_VALIDATED_SHA=' + git('rev-parse', 'HEAD'));
