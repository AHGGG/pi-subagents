import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({ createWorktree: vi.fn(), cleanupWorktree: vi.fn(), pruneWorktrees: vi.fn(), isWorktreeIsolationEnabled: () => true }));

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { cleanupWorktree, createWorktree } from "../src/worktree.js";

const gate = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; };
const result = () => ({ responseText: "CHILD", session: { messages: [], dispose: vi.fn() }, aborted: false, steered: false }) as any;
const flush = async () => { await new Promise(r => setImmediate(r)); };
describe("execution finalization", () => {
  let manager: AgentManager;
  beforeEach(() => { vi.mocked(runAgent).mockResolvedValue(result()); vi.mocked(resumeAgent).mockResolvedValue({ text: "RESUMED" }); });
  afterEach(async () => { await manager?.dispose(); vi.restoreAllMocks(); });
  async function finished() { const id = manager.spawn({} as any, { cwd: process.cwd() } as any, "general-purpose", "work", { description: "work", isBackground: true }); await manager.getRecord(id)!.promise; return id; }
  it("foreground resume installs a new promise/controller and rejects overlap in both modes", async () => {
    manager = new AgentManager(); const id = await finished(); const record = manager.getRecord(id)!;
    const oldPromise = record.promise; const oldController = record.abortController; const oldRun = record.runId;
    const hold = gate<any>(); vi.mocked(resumeAgent).mockReturnValueOnce(hold.promise);
    const foreground = manager.resume(id, "resume"); await flush();
    expect(record.promise).not.toBe(oldPromise); expect(record.abortController).not.toBe(oldController); expect(record.runId).not.toBe(oldRun);
    const currentPromise = record.promise;
    expect(await manager.resume(id, "overlap")).toBeUndefined();
    expect(await manager.resume(id, "overlap", undefined, { isBackground: true })).toBeUndefined();
    expect(record.promise).toBe(currentPromise); expect(record.status).toBe("running");
    let read = false; const waiter = manager.waitForResult(id).then(() => { read = true; }); await flush(); expect(read).toBe(false);
    manager.abort(id); expect(record.abortController!.signal.aborted).toBe(true);
    expect(await manager.resume(id, "too early")).toBeUndefined();
    hold.resolve({ text: "PARTIAL-AFTER-STOP" }); await foreground; await waiter;
    expect(record.status).toBe("stopped"); expect(record.result).toBe("PARTIAL-AFTER-STOP"); expect(record.runSettled).toBe(true);
  });
  it("keeps completion and waiters pending through worktree preservation", async () => {
    const cleanup = gate<any>(); vi.mocked(createWorktree).mockResolvedValue({ path: "/tmp/work", workPath: "/tmp/work", baseSha: "base", branch: "saved" });
    vi.mocked(cleanupWorktree).mockReturnValue(cleanup.promise);
    const onComplete = vi.fn(); manager = new AgentManager(onComplete);
    const id = manager.spawn({} as any, { cwd: process.cwd() } as any, "general-purpose", "work", { description: "work", isBackground: true, isolation: "worktree" });
    await manager.awaitStartup(id); await flush(); const record = manager.getRecord(id)!;
    expect(manager.isRunPending(record)).toBe(true); expect(onComplete).not.toHaveBeenCalled();
    let ready = false; const waiter = manager.waitForResult(id).then(() => { ready = true; }); await flush(); expect(ready).toBe(false);
    cleanup.resolve({ hasChanges: true, branch: "saved", path: "/tmp/work", error: "removal failed" }); await waiter;
    expect(record.result).toContain("saved"); expect(record.result).toContain("retained at: /tmp/work");
    expect(record.runSettled).toBe(true); expect(onComplete).toHaveBeenCalledOnce();
  });
  it("a throwing error-completion callback cannot strand the next queued child", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = gate<any>(); vi.mocked(runAgent).mockReturnValueOnce(first.promise);
    manager = new AgentManager(() => { throw new Error("observer failed"); }, 1);
    manager.setRunObserver(() => { throw new Error("persistence failed"); });
    const a = manager.spawn({} as any, { cwd: process.cwd() } as any, "general-purpose", "a", { description: "a", isBackground: true });
    const b = manager.spawn({} as any, { cwd: process.cwd() } as any, "general-purpose", "b", { description: "b", isBackground: true });
    expect(manager.getRecord(b)!.status).toBe("queued");
    first.resolve({ ...result(), failure: "provider failed" }); await manager.waitForResult(a); await manager.waitForResult(b);
    expect(manager.getRecord(a)!.status).toBe("error"); expect(manager.getRecord(b)!.status).toBe("completed");
    expect((manager as any).runningBackground).toBe(0);
  });
  it("rejecting execution plus throwing completion callback still drains the queue", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let reject!: (error: Error) => void;
    vi.mocked(runAgent).mockReturnValueOnce(new Promise((_resolve, r) => { reject = r; }));
    manager = new AgentManager(() => { throw new Error("notify failed"); }, 1);
    const a = manager.spawn({} as any, { cwd: process.cwd() } as any, "general-purpose", "a", { description: "a", isBackground: true });
    const b = manager.spawn({} as any, { cwd: process.cwd() } as any, "general-purpose", "b", { description: "b", isBackground: true });
    reject(new Error("failure")); await manager.waitForResult(a); await manager.waitForResult(b);
    expect(manager.getRecord(b)!.runSettled).toBe(true); expect((manager as any).runningBackground).toBe(0);
  });
  it("foreground resume emits finalized history without a background notification", async () => {
    const completions: boolean[] = []; manager = new AgentManager(r => { completions.push(!!r.resultConsumed); });
    const states: any[] = []; manager.setRunObserver(r => states.push({ ...r }));
    const id = await finished(); await manager.resume(id, "more");
    expect(states.filter(r => r.runSettled === true)).toHaveLength(2);
    expect(states.at(-1).result).toBe("RESUMED"); expect(completions).toEqual([false, true]);
  });
});


describe("pending stop protection", () => {
  it("cannot evict a stopped run before its pending finalization resolves", async () => {
    const hold = gate<any>(); vi.mocked(runAgent).mockReturnValueOnce(hold.promise);
    const manager = new AgentManager();
    const id = manager.spawn({} as any, { cwd: process.cwd() } as any, "general-purpose", "work", { description: "work", isBackground: true });
    const record = manager.getRecord(id)!;
    try {
      manager.abort(id); record.resultConsumed = true;
      record.completedAt = Date.now() - 20 * 60_000;
      (manager as any).cleanup(); manager.clearCompleted();
      expect(manager.getRecord(id)).toBe(record); expect(manager.hasRunning()).toBe(true);
      hold.resolve(result()); await manager.waitForResult(id);
      expect(manager.hasRunning()).toBe(false);
    } finally { hold.resolve(result()); await manager.dispose(); }
  });
  it("refuses new work after manager disposal", async () => {
    const manager = new AgentManager(); await manager.dispose();
    expect(() => manager.spawn({} as any, { cwd: process.cwd() } as any, "general-purpose", "late", { description: "late" })).toThrow("disposed");
  });
});
