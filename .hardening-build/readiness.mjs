export default function ({ replace, section }) {
  section('test/agent-manager.test.ts', '  it("stops both queued and running agents and returns the total count",', '  it("returns 0 when there are no running or queued agents",', `  it("stops both queued and running agents and waits for active finalization", async () => {
    manager = new AgentManager(undefined, 1);
    let finish!: () => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => {
      finish = () => resolve({ responseText: "stopped output", session: mockSession(), aborted: true, steered: false } as any);
    }));
    const running = manager.spawn(mockPi, mockCtx, "X", "r", { description: "r", isBackground: true });
    const queued = manager.spawn(mockPi, mockCtx, "Y", "q", { description: "q", isBackground: true });
    expect(manager.getRecord(running)?.status).toBe("running");
    expect(manager.getRecord(queued)?.status).toBe("queued");
    try {
      expect(manager.abortAll()).toBe(2);
      expect(manager.getRecord(running)?.status).toBe("stopped");
      expect(manager.getRecord(queued)?.status).toBe("stopped");
      expect(manager.getRecord(queued)?.runSettled).toBe(true);
      // Stop requests do not magically finish asynchronous cleanup. Keep the
      // running execution reachable until its result and preservation settle.
      expect(manager.hasRunning()).toBe(true);
      finish();
      await manager.waitForResult(running);
      expect(manager.hasRunning()).toBe(false);
      expect(manager.getRecord(running)?.runSettled).toBe(true);
      expect(manager.getRecord(running)?.result).toBe("stopped output");
    } finally { finish(); }
  });

`);
  replace('src/agent-manager.ts', '  /** Whether any agents are still running or queued. */', '  /** Whether any execution is running, queued, stopping, or finalizing. */');
  replace('src/index.ts', '            if (record.status === "running" || record.status === "queued") return false;', '            if (manager.isRunPending(record)) return false;');
  replace('src/nested-tools.ts', '  const idLine = position === "inline" ? `Agent ID: ${record.id}` : "";', '  const idLine = position === "inline" ? `Agent ID: ${record.id}` : "";\n  if (record.runSettled === false && record.status !== "running" && record.status !== "queued") {\n    return `Agent ${record.id} is stopping or finalizing. Use wait: true for its final result.`;\n  }');
  replace('src/nested-tools.ts', '      if (params.wait && (record.status === "queued" || record.status === "running")) {', '      if (params.wait && (record.runSettled === false || record.status === "queued" || record.status === "running")) {');
  replace('src/nested-tools.ts', '        if (record.promise) await abortable(record.promise, signal);', '        await abortable(context.manager.awaitStartup(record.id), signal);\n        if (record.promise) await abortable(record.promise, signal);');
  replace('src/workflow/host.ts', ' * turns into `ok`, read from the live record so the pre-cleanup hook can tell a\n * finished child from a failed one before the result exists.', ' * turns into `ok`. The pre-cleanup hook receives the model outcome separately\n * because the record remains pending until preservation has finished.');
}
