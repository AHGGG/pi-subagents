import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunResult, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

vi.mock("../src/agent-runner.js", async () => ({
  ...await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js"),
  runAgent: vi.fn(),
}));

const text = (result: { content: { type: string; text?: string }[] }) => result.content.map(c => c.text ?? "").join("\n");
const session = { dispose: vi.fn(), subscribe: () => () => {}, messages: [] } as unknown as AgentSession;
let hermetic: Hermetic;
let booted: ReturnType<typeof makePi>;
let resolves: Map<string, () => void>;

beforeEach(() => {
  hermetic = hermeticDir({ settings: { maxConcurrent: 1, outputTranscript: false, schedulingEnabled: false } });
  resolves = new Map();
  vi.mocked(runAgent).mockReset().mockImplementation((_ctx, _type, prompt, options) => new Promise<RunResult>(resolve => {
    options.onSessionCreated?.(session);
    resolves.set(prompt, () => resolve({ responseText: `${prompt} done`, session, aborted: false, steered: false }));
  }));
  booted = makePi();
  subagentsExtension(booted.pi);
});

afterEach(async () => {
  for (const resolve of resolves.values()) resolve();
  await flush();
  await booted.lifecycle.get("session_shutdown")?.();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
  hermetic.restore();
});

function spawn(prompt: string, context = ctx()) {
  return booted.tools.get("Agent").execute(`tc-${prompt}`, {
    prompt, description: prompt, subagent_type: "general-purpose", run_in_background: true,
  }, undefined, undefined, context);
}

describe("append-only runtime visibility", () => {
  it("returns a hidden first-run message without sending or mutating prompt/tools; disk edits do not apply", async () => {
    const context = ctx();
    const entries: unknown[] = [];
    context.sessionManager.buildSessionProjection = () => ({ messages: entries });
    const definitions = [...booted.tools.values()].map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
    const event = { systemPrompt: "unchanged system", systemPromptOptions: { selectedTools: ["Agent"] } };
    const startHook = booted.lifecycle.get("before_agent_start");
    const first = await startHook(event, context);
    expect(first.message.display).toBe(false);
    expect(first.message.content).toContain("Background: limit=1");
    expect(first.systemPrompt).toBeUndefined();
    expect(booted.pi.sendMessage).not.toHaveBeenCalled();
    entries.push({ role: "custom", ...first.message });
    const old = JSON.stringify(entries);
    writeFileSync(join(hermetic.dir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 9 }));
    expect(await startHook(event, context)).toBeUndefined();
    expect(JSON.stringify(entries)).toBe(old);
    expect(event).toEqual({ systemPrompt: "unchanged system", systemPromptOptions: { selectedTools: ["Agent"] } });
    expect([...booted.tools.values()].map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))).toEqual(definitions);
    expect(text(await booted.tools.get("list_subagents").execute())).toContain("Background: limit=1");
    entries.length = 0; // compaction omitted the notice
    expect((await startHook(event, context)).message.content).toContain("Background: limit=1");
  });

  it("honors main-session active-tool selection", async () => {
    booted.pi.setActiveTools(["read"]);
    expect(await booted.lifecycle.get("before_agent_start")({}, ctx())).toBeUndefined();
    expect(booted.pi.setActiveTools).toHaveBeenCalledTimes(1); // extension never re-enables tools
  });

  it("reports dispatch counts and queue position; stop removes queued work without launching it", async () => {
    const first = await spawn("first");
    const second = await spawn("second");
    expect(text(first)).toContain("Agent started in background");
    expect(text(first)).toContain("occupied=1, active=1, available=0, queued=0");
    expect(text(second)).toContain("Agent queued in background");
    expect(text(second)).toContain("queued=1");
    expect(text(second)).toContain("Queue position: 1 in background pool");
    const stopped = await booted.tools.get("stop_subagent").execute("stop", { agent_id: second.details.agentId });
    expect(text(stopped)).toContain("removed from the queue without starting");
    expect(text(stopped)).toContain("queued=0");
    resolves.get("first")!();
    await flush();
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(text(await booted.tools.get("list_subagents").execute())).toContain("stopped");
  });

  it("retains a running stop's slot until settlement and reports repeated stops truthfully", async () => {
    const first = await spawn("first");
    await spawn("second");
    const stop = () => booted.tools.get("stop_subagent").execute("stop", { agent_id: first.details.agentId });
    expect(text(await stop())).toContain("Stop requested; finalization is still pending");
    expect(text(await stop())).toContain("Already stopping or finalizing");
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(text(await booted.tools.get("list_subagents").execute())).toContain("occupied=1, active=1, available=0, queued=1");
    resolves.get("first")!();
    await flush();
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(text(await stop())).toContain("Already finished");
  });

  it("handles a queue-to-running cancellation race and refuses another agent's owned child", async () => {
    const first = await spawn("first");
    const second = await spawn("second");
    const manager = vi.mocked(runAgent).mock.calls[0][3].nestedRuntime!.manager;
    const childId = manager.spawn(booted.pi, ctx(), "general-purpose", "owned-child", {
      description: "owned-child", isBackground: true, parentAgentId: first.details.agentId,
      depth: 2, maxSubagentDepth: 2,
    });
    expect(text(await booted.tools.get("list_subagents").execute())).not.toContain(childId);
    expect(text(await booted.tools.get("stop_subagent").execute("stop", { agent_id: childId }))).toContain("not accessible");
    expect(manager.getRecord(childId)?.status).toBe("running");
    resolves.get("first")!();
    await flush();
    expect(manager.getRecord(second.details.agentId)?.status).toBe("running");
    expect(text(await booted.tools.get("stop_subagent").execute("stop", { agent_id: second.details.agentId }))).toContain("Stop requested");
    expect(text(await booted.tools.get("stop_subagent").execute("stop", { agent_id: "unknown" }))).toContain("not found");
  });

  it("appends completion capacity after queue drain and does not re-notify at another boundary", async () => {
    const context = ctx({ signal: new AbortController().signal });
    await booted.lifecycle.get("session_start")({}, context);
    await spawn("first", context);
    const second = await spawn("second", context);
    resolves.get("first")!();
    await flush();
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(booted.pi.sendMessage).not.toHaveBeenCalled();
    await booted.lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "toolUse" } }, context);
    expect(booted.pi.sendMessage).toHaveBeenCalledTimes(1);
    const [notice, options] = booted.pi.sendMessage.mock.calls[0];
    expect(notice.content).toContain("occupied=1, active=1, available=0, queued=0");
    expect(notice.content).toContain(`${second.details.agentId}`);
    expect(notice.content).toContain(": running");
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
    await booted.lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "stop" } }, context);
    expect(booted.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("coalesces simultaneous completions into one fresh fleet snapshot", async () => {
    // Change via the real settings menu, which applies the manager setter.
    const context = ctx({ signal: new AbortController().signal });
    context.ui.select = vi.fn().mockResolvedValueOnce("Settings").mockResolvedValue(undefined);
    context.ui.custom = vi.fn().mockResolvedValueOnce("maxConcurrent").mockResolvedValue(undefined);
    context.ui.input = vi.fn().mockResolvedValue("2");
    await booted.commands.get("agents").handler("", context);
    await booted.lifecycle.get("session_start")({}, context);
    // Treat the initial snapshot as persisted so setting dirtiness creates no extra notice.
    const first = await booted.lifecycle.get("before_agent_start")({}, context);
    context.sessionManager.buildSessionProjection = () => ({ messages: [{ role: "custom", ...first.message }] });
    await spawn("one", context);
    await spawn("two", context);
    resolves.get("one")!();
    resolves.get("two")!();
    await flush();
    await booted.lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "toolUse" } }, context);
    expect(booted.pi.sendMessage).toHaveBeenCalledTimes(1);
    const content = booted.pi.sendMessage.mock.calls[0][0].content;
    expect(content).toContain("2 background tasks finished");
    expect(content.match(/Background: limit=/g)).toHaveLength(1);
    expect(content).toContain("occupied=0, active=0, available=2, queued=0");
  });

  it("appends applied setting changes at a normal boundary without triggering a turn", async () => {
    const context = ctx({ signal: new AbortController().signal });
    await booted.lifecycle.get("session_start")({}, context);
    const first = await booted.lifecycle.get("before_agent_start")({}, context);
    const messages = [{ role: "custom", ...first.message }];
    context.sessionManager.buildSessionProjection = () => ({ messages });
    context.ui.select = vi.fn().mockResolvedValueOnce("Settings").mockResolvedValue(undefined);
    context.ui.custom = vi.fn().mockResolvedValueOnce("maxConcurrent").mockResolvedValue(undefined);
    context.ui.input = vi.fn().mockResolvedValue("3");
    await booted.commands.get("agents").handler("", context);
    context.ui.select = vi.fn().mockResolvedValueOnce("Settings").mockResolvedValue(undefined);
    context.ui.custom = vi.fn().mockResolvedValueOnce("maxConcurrent").mockResolvedValue(undefined);
    context.ui.input = vi.fn().mockResolvedValue("4");
    await booted.commands.get("agents").handler("", context);
    expect(booted.pi.sendMessage).not.toHaveBeenCalled();
    await booted.lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "toolUse" } }, context);
    expect(booted.pi.sendMessage).toHaveBeenCalledTimes(1);
    const [notice, options] = booted.pi.sendMessage.mock.calls[0];
    expect(notice.content).toContain("settings changed");
    expect(notice.content).toContain("Background: limit=4");
    expect(options).toEqual({ triggerTurn: false });
    messages.push({ role: "custom", ...notice });
    expect(await booted.lifecycle.get("before_agent_start")({}, context)).toBeUndefined();
    expect(first.message.content).toContain("Background: limit=1");
  });
});
