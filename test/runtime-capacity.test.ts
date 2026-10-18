import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { type RunResult, runAgent } from "../src/agent-runner.js";
import { cleanupWorktree, createWorktree } from "../src/worktree.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: () => true,
}));

const pi = {} as ExtensionAPI;
const ctx = { cwd: "/tmp" } as ExtensionContext;
const session = { dispose: vi.fn() } as unknown as AgentSession;
type Options = Parameters<AgentManager["spawn"]>[4];

describe("runtime capacity snapshot", () => {
  let manager: AgentManager;
  let resolveRuns: Map<string, () => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new AgentManager(undefined, 1);
    resolveRuns = new Map();
    vi.mocked(runAgent).mockImplementation((_ctx, _type, prompt) => new Promise<RunResult>(resolve => {
      resolveRuns.set(prompt, () => resolve({ responseText: prompt, session, aborted: false, steered: false }));
    }));
  });

  afterEach(async () => { await manager.dispose(); });

  function spawn(prompt: string, options: Partial<Options> = {}) {
    return manager.spawn(pi, ctx, "general-purpose", prompt, { description: prompt, isBackground: true, ...options });
  }

  it("reports empty bounded and unlimited pools separately", () => {
    expect(manager.getCapacitySnapshot()).toEqual({
      background: { limit: 1, occupied: 0, active: 0, available: 1, queued: 0 },
      foreground: { limit: null, occupied: 0, active: 0, available: null, queued: 0 },
      agents: [],
    });
  });

  it("uses one-based FIFO positions per pool and removes cancelled queue entries", () => {
    manager.setMaxConcurrentForeground(1);
    spawn("bg-running");
    spawn("fg-running", { isBackground: false, blocking: true });
    const bg1 = spawn("bg-1");
    const fg1 = spawn("fg-1", { isBackground: false, blocking: true });
    const bg2 = spawn("bg-2");
    const snapshot = manager.getCapacitySnapshot();
    expect(snapshot.background).toEqual({ limit: 1, occupied: 1, active: 1, available: 0, queued: 2 });
    expect(snapshot.foreground).toEqual({ limit: 1, occupied: 1, active: 1, available: 0, queued: 1 });
    expect(snapshot.agents.find(a => a.id === bg1)).toMatchObject({ pool: "background", queuePosition: 1, occupiesSlot: false, pending: true });
    expect(snapshot.agents.find(a => a.id === fg1)).toMatchObject({ pool: "foreground", queuePosition: 1 });
    expect(snapshot.agents.find(a => a.id === bg2)).toMatchObject({ pool: "background", queuePosition: 2 });
    expect(manager.abort(bg1)).toBe(true);
    const after = manager.getCapacitySnapshot();
    expect(after.background.queued).toBe(1);
    expect(after.agents.find(a => a.id === bg1)).toMatchObject({ status: "stopped", queuePosition: undefined, pending: false });
    expect(after.agents.find(a => a.id === bg2)?.queuePosition).toBe(1);
    expect(snapshot.background.queued).toBe(2); // snapshots are detached values
  });

  it("keeps stopped runs charged until settlement, then starts only the next queued run", async () => {
    const running = spawn("running");
    const next = spawn("next");
    spawn("last");
    manager.abort(running);
    const stopped = manager.getCapacitySnapshot();
    expect(stopped.background).toEqual({ limit: 1, occupied: 1, active: 1, available: 0, queued: 2 });
    expect(stopped.agents.find(a => a.id === running)).toMatchObject({ status: "stopped", occupiesSlot: true, pending: true });
    resolveRuns.get("running")!();
    await manager.getRecord(running)!.promise;
    const settled = manager.getCapacitySnapshot();
    expect(settled.background).toEqual({ limit: 1, occupied: 1, active: 1, available: 0, queued: 1 });
    expect(settled.agents.find(a => a.id === running)).toMatchObject({ occupiesSlot: false, pending: false });
    expect(settled.agents.find(a => a.id === next)).toMatchObject({ status: "running", occupiesSlot: true, queuePosition: undefined });
  });

  it("excludes owned children and distinguishes detached from unlimited foreground activity", () => {
    const parent = spawn("parent");
    spawn("nested", { parentAgentId: parent });
    spawn("workflow", { workflowId: "workflow-1" });
    const foreground = spawn("foreground", { isBackground: false, blocking: true });
    const detached = spawn("detached", { isBackground: false });
    const snapshot = manager.getCapacitySnapshot();
    expect(snapshot.agents.map(a => a.id).sort()).toEqual([parent, foreground, detached].sort());
    expect(snapshot.background).toEqual({ limit: 1, occupied: 1, active: 1, available: 0, queued: 0 });
    expect(snapshot.foreground).toEqual({ limit: null, occupied: 0, active: 1, available: null, queued: 0 });
    expect(snapshot.agents.find(a => a.id === foreground)).toMatchObject({ pool: "foreground", occupiesSlot: false });
    expect(snapshot.agents.find(a => a.id === detached)).toMatchObject({ pool: undefined, occupiesSlot: false, pending: true });
  });

  it("preserves actual charges through limit changes and clamps over-capacity availability", async () => {
    spawn("unlimited", { isBackground: false, blocking: true });
    manager.setMaxConcurrentForeground(1);
    const charged = spawn("charged", { isBackground: false, blocking: true });
    expect(manager.getCapacitySnapshot().foreground).toEqual({ limit: 1, occupied: 1, active: 2, available: 0, queued: 0 });
    manager.setMaxConcurrentForeground(0);
    expect(manager.getCapacitySnapshot().foreground).toEqual({ limit: null, occupied: 1, active: 2, available: null, queued: 0 });
    resolveRuns.get("charged")!();
    await manager.getRecord(charged)!.promise;
    expect(manager.getCapacitySnapshot().foreground.occupied).toBe(0);
    spawn("bg");
    spawn("bypass", { bypassQueue: true });
    expect(manager.getCapacitySnapshot().background).toEqual({ limit: 1, occupied: 2, active: 2, available: 0, queued: 0 });
  });

  it("moves attribution on foreground handoff without losing its charge", () => {
    manager.setMaxConcurrentForeground(1);
    spawn("background");
    const foreground = spawn("foreground", { isBackground: false, blocking: true });
    expect(manager.sendToBackground(foreground)).toBe(true);
    const snapshot = manager.getCapacitySnapshot();
    expect(snapshot.background).toEqual({ limit: 1, occupied: 2, active: 2, available: 0, queued: 0 });
    expect(snapshot.foreground).toEqual({ limit: 1, occupied: 0, active: 0, available: 1, queued: 0 });
    expect(snapshot.agents.find(a => a.id === foreground)).toMatchObject({ pool: "background", occupiesSlot: true });
  });

  it("counts startup and finalization as occupied until preservation finishes", async () => {
    let finishCopy!: (value: Awaited<ReturnType<typeof createWorktree>>) => void;
    let finishCleanup!: (value: Awaited<ReturnType<typeof cleanupWorktree>>) => void;
    vi.mocked(createWorktree).mockImplementation(() => new Promise(resolve => { finishCopy = resolve; }));
    vi.mocked(cleanupWorktree).mockImplementation(() => new Promise(resolve => { finishCleanup = resolve; }));
    const id = spawn("isolated", { isolation: "worktree" });
    expect(manager.getCapacitySnapshot().background.occupied).toBe(1);
    expect(runAgent).not.toHaveBeenCalled();
    finishCopy({ path: "/tmp/copy", workPath: "/tmp/copy", branch: "branch", baseSha: "abc123" });
    await manager.awaitStartup(id);
    resolveRuns.get("isolated")!();
    await Promise.resolve();
    expect(cleanupWorktree).toHaveBeenCalled();
    expect(manager.getCapacitySnapshot().background).toEqual({ limit: 1, occupied: 1, active: 1, available: 0, queued: 0 });
    finishCleanup({ hasChanges: false });
    await manager.getRecord(id)!.promise;
    expect(manager.getCapacitySnapshot().background).toEqual({ limit: 1, occupied: 0, active: 0, available: 1, queued: 0 });
  });
});
