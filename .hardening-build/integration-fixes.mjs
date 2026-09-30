export default function ({ replace, read, put }) {
  // The pre-cleanup verifier needs the model's outcome, not a prematurely
  // published terminal record. Pass that outcome explicitly through its hook.
  replace('src/agent-manager.ts', '  onBeforeWorktreeCleanup?: (worktreePath: string) => Promise<void>;', '  onBeforeWorktreeCleanup?: (worktreePath: string, outcome: AgentRecord["status"]) => Promise<void>;');
  replace('src/agent-manager.ts', '   * Fires only on the normal settle path, and only when a worktree was created.', '   * Receives the model outcome while the record remains pending finalization.\n   * Fires only on the normal settle path, and only when a worktree was created.');
  replace('src/agent-manager.ts', 'try { await options.onBeforeWorktreeCleanup(record.worktree.path); }', 'try { await options.onBeforeWorktreeCleanup(record.worktree.path, record.status === "stopped" ? "stopped" : outcome); }');
  replace('src/workflow/host.ts', ': async (worktreePath: string): Promise<void> => {', ': async (worktreePath: string, outcome: AgentRecord["status"]): Promise<void> => {');
  replace('src/workflow/host.ts', 'if (spawnedId === undefined || !succeeded(manager.getRecord(spawnedId))) return;', 'if (spawnedId === undefined || (outcome !== "completed" && outcome !== "steered")) return;');
  // A user's stop wins over a late resolved provider failure, as before.
  replace('src/agent-manager.ts', '        if (failure) record.error = failure;\n        record.result = responseText;', '        record.result = responseText;');
  replace('src/agent-manager.ts', '        if (record.status !== "stopped") record.status = outcome;', '        if (record.status !== "stopped") {\n          record.status = outcome;\n          if (failure) record.error = failure;\n        }');
  replace('src/agent-manager.ts', '      if (failure) record.error = failure;\n      record.result = text;', '      if (record.status !== "stopped" && failure) record.error = failure;\n      record.result = text;');
  replace('src/index.ts', 'Wait for its result before resuming it.`);', 'Use get_subagent_result with wait: true before resuming, or steer_subagent while it is actively running.`);');
  // Stopped is not the same as finalized: a stop can still be unwinding or
  // saving its worktree. Do not evict that execution, even if consumed elsewhere.
  replace('src/agent-manager.ts', '      if (record.status === "running" || record.status === "queued") continue;', '      if (this.isRunPending(record)) continue;', 2);
  replace('src/agent-manager.ts', '      r => r.status === "running" || r.status === "queued",', '      r => this.isRunPending(r),');
  replace('src/agent-manager.ts', '        if (record.status !== "running" && record.status !== "queued") continue;', '        if (!this.isRunPending(record)) continue;');

  // This old test accidentally reused the manager disposed by the prior test.
  replace('test/agent-manager.test.ts', '  it("gives a workflow\'s child no handle, so nothing can address it", () => {', '  it("gives a workflow\'s child no handle, so nothing can address it", () => {\n    manager = new AgentManager();');
  replace('test/agent-manager.test.ts', '  it("foreground resume is unchanged: awaits inline and does not fire onComplete", async () => {', '  it("foreground resume awaits inline and finalizes with its result consumed", async () => {');
  replace('test/agent-manager.test.ts', '    // Foreground resume returns its result inline and never notified before.\n    expect(onComplete).not.toHaveBeenCalled();', '    // Lifecycle/history now sees every final outcome; consumption suppresses\n    // a redundant background notification for the result returned inline.\n    expect(onComplete).toHaveBeenCalledOnce();\n    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ resultConsumed: true, runSettled: true, result: "inline result" }));');
  put('test/execution-lifecycle.test.ts', read('test/execution-lifecycle.test.ts') + `

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
`);
}
