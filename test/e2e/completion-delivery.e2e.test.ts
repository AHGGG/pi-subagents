import { mkdtempSync, rmSync } from "node:fs";
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
