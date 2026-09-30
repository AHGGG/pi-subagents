export default function ({ read, put, section }) {
  section('src/result-history.ts', 'export function findSavedResult(', '\nexport function formatSavedResult(', `export function findSavedResult(entries: readonly unknown[], id: string, sessionId: string): HistoryLookup {
  let latest: HistoryLookup = { kind: "missing" };
  let currentRunId: string | undefined;
  // Replay only state entries for this exact ID. A late outcome from an older
  // run must not override a newer accepted execution, even when appended later.
  for (const entry of entries) {
    if (!object(entry) || entry.type !== "custom" || (entry.customType !== RESULT_ENTRY && entry.customType !== RUN_START_ENTRY)) continue;
    const data = entry.data;
    if (!object(data) || data.id !== id) continue;
    if (data.parentAgentId !== undefined || data.workflowId !== undefined ||
      (data.rootSessionId !== undefined && data.rootSessionId !== sessionId)) return { kind: "invalid" };
    if (entry.customType === RUN_START_ENTRY) {
      if (data.version !== 1 || typeof data.runId !== "string" || !data.runId || data.rootSessionId !== sessionId) return { kind: "invalid" };
      currentRunId = data.runId;
      latest = { kind: "unfinished", runId: currentRunId };
      continue;
    }
    if (currentRunId !== undefined && data.runId !== currentRunId) continue;
    const legacy = data.version === undefined;
    if ((!legacy && (data.version !== 1 || typeof data.runId !== "string" || !data.runId || data.rootSessionId !== sessionId)) ||
      typeof data.type !== "string" || typeof data.description !== "string" || typeof data.status !== "string" || !terminal.has(data.status) ||
      typeof data.completedAt !== "number" || !Number.isFinite(data.completedAt) || data.completedAt < 0 || data.completedAt > 8.64e15 ||
      (data.result !== undefined && typeof data.result !== "string") || (data.error !== undefined && typeof data.error !== "string")) return { kind: "invalid" };
    latest = { kind: "found", result: {
      id, runId: typeof data.runId === "string" ? data.runId : undefined,
      type: data.type, description: data.description, status: data.status,
      completedAt: data.completedAt, result: data.result as string | undefined, error: data.error as string | undefined, legacy,
    } };
  }
  return latest;
}
`);
  put('test/result-history.test.ts', read('test/result-history.test.ts') + `

describe("late execution outcomes", () => {
  it("ignores an old completion appended after a newer run started", () => {
    const entries = [entry(data(), "subagents:run-start"), entry(), entry(data({ runId: "r2", status: "queued" }), "subagents:run-start"), entry()];
    expect(findSavedResult(entries, "a", "s")).toEqual({ kind: "unfinished", runId: "r2" });
  });
  it("keeps the newer result when a stale completion arrives last", () => {
    const entries = [entry(data({ runId: "r2" }), "subagents:run-start"), entry(data({ runId: "r2", result: "NEW" })), entry(data({ runId: "r1", result: "STALE" }))];
    const found = findSavedResult(entries, "a", "s"); expect(found.kind).toBe("found");
    if (found.kind === "found") expect(found.result.result).toBe("NEW");
  });
});
`);
  put('test/execution-lifecycle.test.ts', read('test/execution-lifecycle.test.ts') + `

describe("run-scoped cancellation", () => {
  it("aborting an old caller signal cannot stop a later resume", async () => {
    const manager = new AgentManager();
    vi.mocked(runAgent).mockResolvedValue(result());
    vi.mocked(resumeAgent).mockResolvedValue({ text: "FIRST-RESUME" });
    const id = manager.spawn({} as any, { cwd: process.cwd() } as any, "general-purpose", "work", { description: "work", isBackground: true });
    await manager.waitForResult(id);
    const old = new AbortController(); await manager.resume(id, "first", old.signal);
    const hold = gate<any>(); vi.mocked(resumeAgent).mockReturnValueOnce(hold.promise);
    const next = manager.resume(id, "second"); await flush();
    try {
      old.abort();
      expect(manager.getRecord(id)!.abortController!.signal.aborted).toBe(false);
      expect(manager.getRecord(id)!.status).toBe("running");
    } finally { hold.resolve({ text: "SECOND-RESUME" }); await next; await manager.dispose(); }
  });
});
`);
}
