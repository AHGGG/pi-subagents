import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => ({ ...await vi.importActual<any>("../src/agent-runner.js"), runAgent: vi.fn(), resumeAgent: vi.fn() }));

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagents from "../src/index.js";
import { ctx, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

describe("real result tool with recorded outcomes", () => {
  let env: ReturnType<typeof hermeticDir>; let boot: ReturnType<typeof makePi>; let context: any; let sm: SessionManager;
  const result = () => ({ responseText: "PRIVATE-FULL-RESULT-" + "x".repeat(800) + "-BEYOND-PREVIEW", session: { dispose: vi.fn(), messages: [] }, aborted: false, steered: false });
  const registry = () => (globalThis as any)[Symbol.for("pi-subagents:manager")];
  beforeEach(async () => {
    vi.useFakeTimers(); env = hermeticDir({ settings: { rememberAgents: false, outputTranscript: false, schedulingEnabled: false } });
    vi.mocked(runAgent).mockResolvedValue(result() as any); vi.mocked(resumeAgent).mockResolvedValue({ text: "FOREGROUND-RESUME-RESULT" });
    sm = SessionManager.inMemory(env.dir); boot = makePi();
    boot.pi.appendEntry.mockImplementation((type: string, data: any) => sm.appendCustomEntry(type, data));
    context = ctx({ sessionManager: sm }); subagents(boot.pi); await boot.lifecycle.get("session_start")({}, context);
  });
  afterEach(async () => { await boot.lifecycle.get("session_shutdown")({}, context); vi.useRealTimers(); env.restore(); vi.restoreAllMocks(); });
  async function spawn() {
    const out = await boot.tools.get("Agent").execute("spawn", { subagent_type: "general-purpose", description: "job", prompt: "work", run_in_background: true }, undefined, undefined, context);
    const id = textOf(out).match(/Agent ID: (\S+)/)![1]; await vi.advanceTimersByTimeAsync(0); return id;
  }
  const get = (id: string, verbose = false) => boot.tools.get("get_subagent_result").execute("get", { agent_id: id, verbose }, undefined, undefined, context);
  it("rereads consumed and evicted output after compaction, without running a new child", async () => {
    const id = await spawn(); expect(textOf(await get(id))).toContain("BEYOND-PREVIEW");
    await vi.advanceTimersByTimeAsync(11 * 60_000); expect(registry().getRecord(id)).toBeUndefined();
    const keep = sm.appendMessage({ role: "user", content: "recent", timestamp: Date.now() }); sm.appendCompaction("Compacted", keep, 20000);
    const recovered = await get(id, true);
    expect(recovered.details.source).toBe("session-history"); expect(textOf(recovered)).toContain("BEYOND-PREVIEW"); expect(runAgent).toHaveBeenCalledOnce();
  });
  it("records foreground-resume results too", async () => {
    const id = await spawn();
    await boot.tools.get("Agent").execute("resume", { resume: id, subagent_type: "general-purpose", description: "resume", prompt: "more", run_in_background: false }, undefined, undefined, context);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(textOf(await get(id))).toContain("FOREGROUND-RESUME-RESULT");
  });
  it("never uses history to bypass a live ownership check", async () => {
    const id = await spawn(); registry().getRecord(id).parentAgentId = "another-owner";
    const out = await get(id); expect(textOf(out)).toContain("not accessible"); expect(textOf(out)).not.toContain("PRIVATE-FULL-RESULT");
  });
  it("recovers after a new extension activation reading the same saved session", async () => {
    const id = await spawn(); await boot.lifecycle.get("session_shutdown")({}, context);
    boot = makePi(); boot.pi.appendEntry.mockImplementation((type: string, data: any) => sm.appendCustomEntry(type, data));
    subagents(boot.pi); await boot.lifecycle.get("session_start")({}, context);
    expect((await get(id)).details.source).toBe("session-history");
    expect(textOf(await get(id))).toContain("BEYOND-PREVIEW");
  });
});
