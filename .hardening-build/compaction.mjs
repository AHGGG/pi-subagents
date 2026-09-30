export default function ({ put, replace }) {
  replace('test/result-history.test.ts', '    sm.branch(null);', '    sm.resetLeaf();');
  put('test/e2e/result-compaction.e2e.test.ts', `import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import subagents from "../../src/index.js";
import { hermeticDir } from "../helpers/boot-extension.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { modelContext, registerFauxProvider } from "../helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const FULL_A = "A-PREVIEW-" + "x".repeat(900) + "-A-SECRET-BEYOND-PREVIEW";

describe("actual extension results across parent auto-compaction", () => {
  let env: ReturnType<typeof hermeticDir>;
  let faux: ReturnType<typeof registerFauxProvider>;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const releases: Array<() => void> = [];
  beforeEach(() => {
    env = hermeticDir({ settings: { schedulingEnabled: false, rememberAgents: false, outputTranscript: false, toolDescriptionMode: "compact", worktreeIsolation: false, defaultJoinMode: "async" } });
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 50_000 }] });
  });
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    await session?.abort();
    await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose(); session = undefined;
    faux.unregister(); env.restore();
  });

  it.each(["during-compaction", "after-compaction-tool"])("retrieves A when it finishes %s, while B keeps running", async timing => {
    const aEntered = gate(), bEntered = gate(), aRelease = gate(), bRelease = gate();
    const compactEntered = gate(), compactRelease = gate(), toolEntered = gate(), toolRelease = gate();
    releases.push(aRelease.resolve, bRelease.resolve, compactRelease.resolve, toolRelease.resolve);
    let parentPhase = 0, compactCount = 0;
    let aId = "", bId = "";
    const requests: any[][] = [];
    const registry = () => (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const sm = SessionManager.inMemory(env.dir);
    const settings = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 512 }, retry: { enabled: false } });
    const driver = (pi: any) => {
      pi.registerTool({ name: "grow_context", label: "Grow context", description: "Produce a large test tool result", parameters: Type.Object({}),
        async execute() { session!.setAutoCompactionEnabled(true); return { content: [fauxText("padding ".repeat(40_000))], details: {} }; } });
      pi.registerTool({ name: "after_compact_probe", label: "After compact", description: "Controlled implementation step", parameters: Type.Object({}),
        async execute(_id: string, _args: unknown, signal?: AbortSignal) {
          toolEntered.resolve(); await toolRelease.promise;
          expect(signal?.aborted).not.toBe(true);
          return { content: [fauxText("IMPLEMENTATION-TOOL-FINISHED")], details: {} };
        } });
      // Public compaction customization makes the summary deterministic. Pi's
      // threshold detection, in-flight compaction, context replacement and
      // queued-message delivery remain real, as do both child sessions.
      pi.on("session_before_compact", async (event: any) => {
        expect(event.reason).toBe("threshold"); compactCount++;
        const keep = sm.appendCustomEntry("test:summary-boundary", {});
        compactEntered.resolve(); await compactRelease.promise;
        return { compaction: { summary: "Continue implementation. Two delegated jobs exist; use completion notices to retrieve results.", firstKeptEntryId: keep, tokensBefore: event.preparation.tokensBefore } };
      });
    };
    const respond = async (raw: any) => {
      const context = modelContext(raw);
      const parent = context.tools?.some((t: any) => t.name === "Agent");
      if (!parent) {
        const text = JSON.stringify(context.messages);
        if (text.includes("CHILD_A")) { aEntered.resolve(); await aRelease.promise; return fauxAssistantMessage([fauxText(FULL_A)]); }
        if (text.includes("CHILD_B")) { bEntered.resolve(); await bRelease.promise; return fauxAssistantMessage([fauxText("B-RESULT")]); }
        throw new Error("Unexpected child request");
      }
      requests.push(structuredClone(context.messages));
      const phase = parentPhase++;
      if (phase === 0) return fauxAssistantMessage([
        fauxToolCall("Agent", { subagent_type: "general-purpose", description: "CHILD_A", prompt: "CHILD_A: return the requested report", isolated: true, run_in_background: true }),
        fauxToolCall("Agent", { subagent_type: "general-purpose", description: "CHILD_B", prompt: "CHILD_B: return the requested report", isolated: true, run_in_background: true }),
      ]);
      if (phase === 1) {
        await Promise.all([aEntered.promise, bEntered.promise]);
        for (const e of sm.getBranch() as any[]) {
          if (e.type === "custom" && e.customType === "subagents:run-start") {
            if (e.data.description === "CHILD_A") aId = e.data.id;
            if (e.data.description === "CHILD_B") bId = e.data.id;
          }
        }
        expect(aId).toBeTruthy(); expect(bId).toBeTruthy();
        return fauxAssistantMessage([fauxToolCall("grow_context", {})]);
      }
      if (phase === 2) return fauxAssistantMessage([fauxToolCall("after_compact_probe", {})]);
      if (phase === 3) {
        const text = JSON.stringify(context.messages);
        expect(text).toContain(aId); expect(text).toContain("A-PREVIEW-");
        expect(text).not.toContain("A-SECRET-BEYOND-PREVIEW");
        return fauxAssistantMessage([fauxToolCall("get_subagent_result", { agent_id: aId, wait: false })]);
      }
      if (phase === 4) expect(JSON.stringify(context.messages)).toContain("A-SECRET-BEYOND-PREVIEW");
      return fauxAssistantMessage([fauxText("IMPLEMENTATION-CONTINUES-WITH-RESULT")]);
    };
    faux.setResponses(Array.from({ length: 30 }, () => respond));
    const backend = fauxModelBackend(faux.getModel());
    const loader = new DefaultResourceLoader({ cwd: env.dir, agentDir: env.dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [subagents, driver] });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: env.dir, model: faux.getModel(), ...backend, sessionManager: sm, settingsManager: settings, resourceLoader: loader } as any));
    await session.bindExtensions({ mode: "print" });
    const running = session.prompt("Delegate both jobs, implement, and retrieve A when it finishes.");
    // Observe the promise immediately so a failure cannot become unhandled while a gate waits.
    running.catch(() => {});
    await compactEntered.promise;
    expect(registry().getRecord(aId)?.status).toBe("running");
    expect(registry().getRecord(bId)?.status).toBe("running");
    if (timing === "during-compaction") {
      aRelease.resolve();
      await vi.waitFor(() => expect(JSON.stringify(session!.agent.peekQueuedMessages())).toContain("A-PREVIEW-"), { timeout: 5000, interval: 10 });
      compactRelease.resolve(); await toolEntered.promise;
    } else {
      compactRelease.resolve(); await toolEntered.promise;
      expect(compactCount).toBe(1);
      aRelease.resolve();
      await vi.waitFor(() => expect(JSON.stringify(session!.agent.peekQueuedMessages())).toContain("A-PREVIEW-"), { timeout: 5000, interval: 10 });
    }
    expect(registry().getRecord(bId)?.status).toBe("running");
    toolRelease.resolve(); await running;
    expect(compactCount).toBe(1);
    expect(sm.getBranch().some(e => e.type === "compaction")).toBe(true);
    expect(registry().getRecord(aId)?.resultConsumed).toBe(true);
    expect(registry().getRecord(bId)?.status).toBe("running");
    expect(JSON.stringify(requests.at(-1))).toContain("A-SECRET-BEYOND-PREVIEW");
    expect(session.messages.filter(m => m.role === "user")).toHaveLength(0); // original user prompt was compacted, no synthetic user prompt was added
  });
});
`);
}
