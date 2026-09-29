import { mkdtempSync, rmSync } from "node:fs";
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
