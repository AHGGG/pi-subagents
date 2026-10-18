import { randomUUID } from "node:crypto";
import type { CapacitySnapshot, PoolCapacitySnapshot } from "./agent-manager.js";
import type { JoinMode } from "./types.js";

export interface RuntimeStatusSnapshot extends CapacitySnapshot {
  backgroundByDefault: boolean;
  defaultJoinMode: JoinMode;
  defaultMaxTurns: number | undefined;
  graceTurns: number;
  maxSubagentDepth: number;
}

export interface RuntimeStatusNotice {
  customType: "subagents:runtime-status";
  content: string;
  display: false;
  details: { runtimeId: string; configuration: string };
}

export interface RuntimeStatusContextMessage {
  role: string;
  customType?: string;
  details?: unknown;
}

function formatPool(name: string, pool: PoolCapacitySnapshot): string {
  return `${name}: limit=${pool.limit ?? "unlimited"}, occupied=${pool.occupied}, active=${pool.active}, available=${pool.available ?? "unlimited"}, queued=${pool.queued}`;
}

/** A point-in-time view, not a promise that a later spawn will get a slot. */
export function formatCapacityStatus(snapshot: CapacitySnapshot): string {
  return [formatPool("Background", snapshot.background), formatPool("Foreground", snapshot.foreground)].join("\n");
}

/**
 * One append-only notice per effective configuration in the current context.
 * The runtime id prevents a resumed transcript from standing in for a new
 * manager. Inspect projected context, not the entire log: a compacted-away
 * notice must be refreshed, while one retained by compaction must not.
 */
export class RuntimeStatus {
  private confirmedConfiguration: string | undefined;

  constructor(private readonly runtimeId: string = randomUUID()) {}

  prepareNotice(
    contextMessages: readonly RuntimeStatusContextMessage[] | undefined,
    snapshot: RuntimeStatusSnapshot,
  ): RuntimeStatusNotice | undefined {
    const configuration = JSON.stringify([
      snapshot.background.limit, snapshot.foreground.limit,
      snapshot.backgroundByDefault, snapshot.defaultJoinMode,
      snapshot.defaultMaxTurns ?? 0, snapshot.graceTurns, snapshot.maxSubagentDepth,
    ]);
    let previous = contextMessages === undefined ? this.confirmedConfiguration : undefined;
    // Last matching entry wins, including when settings were changed back.
    for (const message of contextMessages ?? []) {
      if (message.role !== "custom" || message.customType !== "subagents:runtime-status") continue;
      const details = message.details;
      if (!details || typeof details !== "object" || !("runtimeId" in details) || !("configuration" in details)) continue;
      if (details.runtimeId === this.runtimeId && typeof details.configuration === "string") previous = details.configuration;
    }
    if (previous === configuration) return undefined;
    return {
      customType: "subagents:runtime-status",
      display: false,
      details: { runtimeId: this.runtimeId, configuration },
      content: [
        `Subagent runtime status${previous === undefined ? "" : " (settings changed)"}:`,
        formatCapacityStatus(snapshot),
        `Defaults: background=${snapshot.backgroundByDefault}, join=${snapshot.defaultJoinMode}, maxTurns=${snapshot.defaultMaxTurns || "unlimited"}, graceTurns=${snapshot.graceTurns}, maxSubagentDepth=${snapshot.maxSubagentDepth}.`,
        "The pools are independent. Occupied counts scheduler slots, including stopping/finalizing runs; active counts started, unsettled runs. Unlimited foreground runs need no slot.",
        "Excess work queues automatically and starts when its pool has capacity; do not resubmit a queued agent. Nested and workflow-owned agents are outside these pools; detached foreground spawns are not bounded by the foreground limit.",
        "This is a point-in-time snapshot. Use list_subagents for current capacity, queue positions, and agent states. Historical agent IDs from another runtime are not evidence of currently running work.",
      ].join("\n"),
    };
  }

  /** Only for hosts without projected context; call after actual persistence. */
  confirmPersisted(notice: RuntimeStatusNotice): void {
    this.observePersisted(notice.details);
  }

  /** Accept metadata from a persisted host message without trusting its shape. */
  observePersisted(details: unknown): void {
    if (!details || typeof details !== "object" || !("runtimeId" in details) || !("configuration" in details)) return;
    if (details.runtimeId === this.runtimeId && typeof details.configuration === "string") this.confirmedConfiguration = details.configuration;
  }
}
