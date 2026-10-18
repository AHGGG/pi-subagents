import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { formatCapacityStatus, RuntimeStatus, type RuntimeStatusContextMessage, type RuntimeStatusNotice, type RuntimeStatusSnapshot } from "../src/runtime-status.js";

function snapshot(): RuntimeStatusSnapshot {
  return {
    background: { limit: 10, occupied: 2, active: 2, available: 8, queued: 0 },
    foreground: { limit: null, occupied: 0, active: 3, available: null, queued: 0 },
    agents: [], backgroundByDefault: true, defaultJoinMode: "async",
    defaultMaxTurns: undefined, graceTurns: 5, maxSubagentDepth: 2,
  };
}

function persisted(notice: RuntimeStatusNotice): RuntimeStatusContextMessage {
  return { ...notice, role: "custom" };
}

describe("append-only runtime status", () => {
  it("prepares a hidden initial message without suppressing an unpersisted retry", () => {
    const status = new RuntimeStatus("current");
    const notice = status.prepareNotice([], snapshot());
    expect(notice).toMatchObject({ customType: "subagents:runtime-status", display: false, details: { runtimeId: "current" } });
    expect(notice?.content).toContain("maxTurns=unlimited");
    expect(notice?.content).toContain("do not resubmit a queued agent");
    expect(notice?.content).toContain("Historical agent IDs from another runtime");
    expect(status.prepareNotice([], snapshot())).toEqual(notice);
  });

  it("does not reappend on ordinary requests or occupancy-only changes", () => {
    const status = new RuntimeStatus("current");
    const entries = [persisted(status.prepareNotice([], snapshot())!)];
    const changed = snapshot();
    changed.background = { limit: 10, occupied: 10, active: 9, available: 0, queued: 4 };
    expect(status.prepareNotice(entries, snapshot())).toBeUndefined();
    expect(status.prepareNotice(entries, changed)).toBeUndefined();
  });

  it("refreshes when compaction or a branch removes the marker, but not when retained", () => {
    const status = new RuntimeStatus("current");
    const notice = status.prepareNotice([], snapshot())!;
    status.confirmPersisted(notice);
    expect(status.prepareNotice([persisted(notice)], snapshot())).toBeUndefined();
    expect(status.prepareNotice([], snapshot())).toEqual(notice);
  });

  it("ignores markers from a previous manager runtime and non-message entries", () => {
    const old = new RuntimeStatus("old").prepareNotice([], snapshot())!;
    const entries: RuntimeStatusContextMessage[] = [persisted(old), {
      role: "user", customType: "subagents:runtime-status", details: { ...old.details, runtimeId: "new" },
    }];
    expect(new RuntimeStatus("new").prepareNotice(entries, snapshot())?.details.runtimeId).toBe("new");
    expect(new RuntimeStatus().prepareNotice([], snapshot())?.details.runtimeId).not.toBe(new RuntimeStatus().prepareNotice([], snapshot())?.details.runtimeId);
  });

  it("coalesces to latest effective settings and uses the last persisted revision", () => {
    const status = new RuntimeStatus("current");
    const entries = [persisted(status.prepareNotice([], snapshot())!)];
    const changed = snapshot();
    changed.background.limit = 4;
    status.prepareNotice(entries, changed); // prepared but never persisted
    changed.background.limit = 7;
    changed.defaultJoinMode = "group";
    const notice = status.prepareNotice(entries, changed)!;
    expect(notice.content).toContain("settings changed");
    expect(notice.content).toContain("Background: limit=7");
    expect(notice.content).toContain("join=group");
    entries.push(persisted(notice));
    expect(status.prepareNotice(entries, changed)).toBeUndefined();
    expect(status.prepareNotice(entries, snapshot())).toBeDefined();
  });

  it.each(["backgroundByDefault", "defaultJoinMode", "defaultMaxTurns", "graceTurns", "maxSubagentDepth", "foreground"] as const)("notices changes to %s", key => {
    const status = new RuntimeStatus("current");
    const entries = [persisted(status.prepareNotice([], snapshot())!)];
    const changed = { ...snapshot(), backgroundByDefault: false, defaultJoinMode: "smart" as const, defaultMaxTurns: 20, graceTurns: 3, maxSubagentDepth: 1, foreground: { limit: 2, occupied: 0, active: 0, available: 2, queued: 0 } };
    expect(status.prepareNotice(entries, { ...snapshot(), [key]: changed[key] })).toBeDefined();
  });

  it("supports explicit persistence acknowledgment only when projection is unavailable", () => {
    const status = new RuntimeStatus("current");
    const notice = status.prepareNotice(undefined, snapshot())!;
    expect(status.prepareNotice(undefined, snapshot())).toEqual(notice);
    status.confirmPersisted(new RuntimeStatus("other").prepareNotice([], snapshot())!);
    expect(status.prepareNotice(undefined, snapshot())).toBeDefined();
    status.confirmPersisted(notice);
    expect(status.prepareNotice(undefined, snapshot())).toBeUndefined();
    expect(status.prepareNotice([], snapshot())).toBeDefined();
  });

  it("ignores malformed persistence metadata", () => {
    const status = new RuntimeStatus("current");
    for (const details of [null, "current", {}, { runtimeId: "current" }, { runtimeId: "current", configuration: 3 }]) {
      status.observePersisted(details);
      expect(status.prepareNotice(undefined, snapshot())).toBeDefined();
    }
  });

  it("formats independent limits and occupied versus active counts without inventing a total cap", () => {
    expect(formatCapacityStatus(snapshot())).toBe([
      "Background: limit=10, occupied=2, active=2, available=8, queued=0",
      "Foreground: limit=unlimited, occupied=0, active=3, available=unlimited, queued=0",
    ].join("\n"));
  });

  it("uses real host context projection across compaction and branch changes", () => {
    const session = SessionManager.inMemory();
    const status = new RuntimeStatus("current");
    const notice = status.prepareNotice(session.buildSessionProjection().messages, snapshot())!;
    const marker = session.appendCustomMessageEntry(notice.customType, notice.content, notice.display, notice.details);
    expect(status.prepareNotice(session.buildSessionProjection().messages, snapshot())).toBeUndefined();
    session.appendCompaction("summary", marker, 100);
    expect(status.prepareNotice(session.buildSessionProjection().messages, snapshot())).toBeUndefined();
    const next = session.appendMessage({ role: "user", content: "next", timestamp: 1 });
    session.appendCompaction("summary", next, 100);
    expect(session.getEntries().some(entry => entry.id === marker)).toBe(true);
    expect(status.prepareNotice(session.buildSessionProjection().messages, snapshot())).toEqual(notice);
    session.branch(marker);
    expect(status.prepareNotice(session.buildSessionProjection().messages, snapshot())).toBeUndefined();
    session.appendContextEdit(marker, null);
    expect(status.prepareNotice(session.buildSessionProjection().messages, snapshot())).toEqual(notice);
  });
});
