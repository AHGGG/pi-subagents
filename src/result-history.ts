import type { AgentRecord } from "./types.js";

/** State-only entries: never automatically copied into model context. */
export const RUN_START_ENTRY = "subagents:run-start";
export const RESULT_ENTRY = "subagents:record";
const terminal = new Set(["completed", "steered", "error", "stopped", "aborted"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function snapshotRun(record: AgentRecord, sessionId: string) {
  return {
    version: 1,
    id: record.id, runId: record.runId, rootSessionId: sessionId,
    type: record.type, description: record.description, status: record.status,
    startedAt: record.startedAt, completedAt: record.completedAt,
    ...(record.runSettled ? { result: record.result, error: record.error } : {}),
  };
}

export interface SavedResult {
  id: string;
  runId?: string;
  type: string;
  description: string;
  status: string;
  completedAt: number;
  result?: string;
  error?: string;
  legacy: boolean;
}
export type HistoryLookup =
  | { kind: "found"; result: SavedResult }
  | { kind: "unfinished"; runId?: string }
  | { kind: "invalid" }
  | { kind: "missing" };

/** Search only the caller's current branch and an EXACT recorded agent ID. */
export function findSavedResult(entries: readonly unknown[], id: string, sessionId: string): HistoryLookup {
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

export function formatSavedResult(result: SavedResult, verbose: boolean): string {
  return "Agent: " + result.id + "\nType: " + result.type + " | Status: " + result.status +
    "\nRecovered saved result from the current session branch. Completed: " + new Date(result.completedAt).toISOString() +
    (result.runId ? "\nExecution: " + result.runId : "\nLegacy snapshot: this is the last recorded outcome; older versions did not record every resume.") +
    "\nDescription: " + result.description + "\n\n" +
    (result.error ? "Error: " + result.error + "\n" : "") + (result.result?.trim() || "No output was recorded.") +
    (verbose ? "\n\nFull child conversation is not attached. This is the saved final result, not a reconstructed transcript." : "");
}
