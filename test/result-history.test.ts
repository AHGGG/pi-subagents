import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { findSavedResult, formatSavedResult } from "../src/result-history.js";

const data = (overrides: Record<string, unknown> = {}) => ({ version: 1, id: "a", runId: "r1", rootSessionId: "s", type: "general-purpose", description: "job", status: "completed", completedAt: 1, result: "FULL-RESULT", ...overrides });
const entry = (value = data(), customType = "subagents:record") => ({ type: "custom", customType, data: value });
describe("exact-ID, branch-local result history", () => {
  it("recovers the latest saved result and labels it", () => {
    const found = findSavedResult([entry(), entry(data({ runId: "r2", result: "LATEST" }))], "a", "s");
    expect(found.kind).toBe("found"); if (found.kind !== "found") return;
    expect(formatSavedResult(found.result, true)).toContain("LATEST");
    expect(formatSavedResult(found.result, true)).toContain("Full child conversation is not attached");
  });
  it("never falls back to an older answer after a new run was accepted", () => {
    expect(findSavedResult([entry(), entry(data({ runId: "r2", status: "queued" }), "subagents:run-start")], "a", "s")).toEqual({ kind: "unfinished", runId: "r2" });
  });
  it.each([{ parentAgentId: "owner" }, { workflowId: "workflow" }, { rootSessionId: "other" }, { version: 99 }, { result: 123 }, { status: "running" }, { completedAt: Infinity }])("rejects invalid or out-of-scope data: %j", invalid => {
    expect(findSavedResult([entry(), entry(data(invalid))], "a", "s").kind).toBe("invalid");
  });
  it("does not guess an ID or interpret a handle as saved identity", () => {
    expect(findSavedResult([entry()], "general-purpose", "s").kind).toBe("missing");
    expect(findSavedResult([entry()], "a-typo", "s").kind).toBe("missing");
  });
  it("supports the existing .2 saved-record format with an explicit legacy label", () => {
    const found = findSavedResult([entry(data({ version: undefined, runId: undefined, rootSessionId: undefined }))], "a", "s");
    expect(found.kind).toBe("found"); if (found.kind === "found") expect(formatSavedResult(found.result, false)).toContain("Legacy snapshot");
  });
  it("uses raw branch entries that survive a real SessionManager compaction entry", () => {
    const sm = SessionManager.inMemory(process.cwd()); const id = sm.getSessionId();
    sm.appendCustomEntry("subagents:record", data({ rootSessionId: id }));
    const keep = sm.appendMessage({ role: "user", content: "recent", timestamp: Date.now() });
    sm.appendCompaction("Older work summarized", keep, 10000);
    expect(JSON.stringify(sm.buildSessionProjection().messages)).not.toContain("FULL-RESULT");
    expect(findSavedResult(sm.getBranch(), "a", id).kind).toBe("found");
    sm.resetLeaf();
    expect(findSavedResult(sm.getBranch(), "a", id).kind).toBe("missing");
  });
});


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
