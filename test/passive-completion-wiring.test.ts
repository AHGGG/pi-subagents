import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      writeFileSync(join(env.dir, ".pi", "subagents.json"), JSON.stringify({ defaultJoinMode: joinMode, schedulingEnabled: false, rememberAgents: false, outputTranscript: false }));
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

});
