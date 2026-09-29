# AHGGG personal fork — V1

Based on upstream master e955e29c51b7a6cce37e1108cd2d6c57a77e151c.
Requires Pi 0.87.1 or newer; development dependencies are pinned to 0.87.1.
This is a Git-installed personal fork, not a published npm package.

## Install

Remove the upstream extension first so two copies do not register the same tools:

    pi remove npm:@tintinweb/pi-subagents
    pi install git:github.com/AHGGG/pi-subagents

Then restart Pi (or use /reload after running agents finish). If upstream was
installed by a different Git/local source, remove that exact source instead.
The fork loads src/index.ts; Git installation does not depend on an untracked dist.
Update with pi update --extensions. Do not install the fork's unpublished npm name.

## Completion contract

Background completions use sendMessage with triggerTurn explicitly false and no
steer/followUp/nextTurn delivery mode. On Pi 0.87.1, an active tool batch finishes
before the custom message is appended. A naturally following model request sees
it. An idle parent is not prompted; its next user interaction includes the notice.
No user message is rewritten and no synthetic user prompt is created.
A completion arriving during the final assistant answer does NOT force another
request. Required joins must use a foreground Agent or get_subagent_result with
wait: true, particularly in one-shot print/JSON mode. A hung explicit wait remains
unbounded in V1; this fork does not include the broader timeout/supervisor rewrite.

The default joinMode is async, notifying each finished agent independently.
Existing explicit smart/group configuration is respected and may delay a group
notice. Change /agents -> Settings -> Join mode to async for incremental results.
Workflow-tool completions also append passively; flag-launched workflows retain
their existing next-user-turn behavior and headless lifecycle limitations.
Nested children remain owner-scoped rather than notifying the root directly.

A notice does not consume a result. get_subagent_result still performs retrieval.
The 200ms hold rechecks consumption and execution identity. Group records are
snapshotted so a resume cannot rewrite an earlier completion. Once handed to Pi,
a notice cannot be retracted: a later retrieval may leave a harmless stale notice.
There is no exactly-once/crash-recovery guarantee for pending notifications.

Unread terminal results are retained in memory until consumed or explicitly
cleared, or the session ends. There is no automatic size/TTL bound for unread
results. Consumed results retain upstream's completion-age cleanup policy.

## Imported fixes

- #311 (8d56733): foreground/nested inline result IDs; original tests included.
- #316 (75e0db9): dispose widget, group and debounce timers on shutdown.
- #348 (1ecd1e5): unread retention, Pi 0.87 mention cloning, compatibility tests.
- #321 (c89d72a): ONLY widget cadence/idle-stop and its tests; unrelated changes omitted.

Upstream PRs: https://github.com/tintinweb/pi-subagents/pulls
Pi implementation: https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/agent-session.ts
Original MIT license and author attribution are preserved.

## Validation

Run npm ci, npm run check, npm run build, and npm run test:e2e.
Tests use scripted providers and do not require paid model calls.
Manual Windows/macOS terminal and live-provider behavior are not certified by CI.
Passive-completion tests cover idle delivery, tool-batch ordering, no forced
final-answer continuation, consumption, grouping, resume and shutdown.
