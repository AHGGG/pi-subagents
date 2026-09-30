# AHGGG personal fork — V1 and automatic-continuation update

Current version: **0.19.0-ahggg.3**.

The automatic-continuation contract below remains in effect. See
[hardening behavior](HARDENING.md) for .3 saved-result recovery and lifecycle changes.
Based on upstream master e955e29c51b7a6cce37e1108cd2d6c57a77e151c.
Requires Pi 0.87.1 or newer; development dependencies are pinned to 0.87.1.
This is a Git-installed personal fork, not a published npm package.

## Install or update

For an existing Git installation:

    pi update git:github.com/AHGGG/pi-subagents

For a new installation, remove any upstream copy first, then install:

    pi remove npm:@tintinweb/pi-subagents
    pi install git:github.com/AHGGG/pi-subagents

If upstream was installed by another Git/local source, remove that exact source
instead. Restart Pi after running agents finish, or use /reload when none remain.
The fork loads src/index.ts directly; no separate clone/build or npm publication
is needed. Do not install the unpublished @ahggg/pi-subagents npm name.

## Completion contract (updated in .2)

Individual, grouped and workflow-tool completions use the shared delivery options:

    { deliverAs: "steer", triggerTurn: true }

On the tested Pi 0.87.1 runtime:

- While the parent is working, the current model response and complete tool batch
  finish first. The completion is included before the next model request, not
  held until the entire tool loop ends as followUp would do. Running tools are
  not aborted, and remaining sequential batch tools are not skipped.
- When the parent is idle, the notice starts another turn in the same session.
  The user does not have to type "continue".
- A completion arriving during a text-only final answer requests a continuation
  after that answer. It does not cancel or rewrite the answer in progress.
- The notice is a custom session message. It neither rewrites the user's prompt
  nor creates a new user-authored message. The main model decides how to act on
  the notice; retrieval is not guaranteed solely by the delivery mechanism.

This replaces .1's passive-only policy; all other V1 reliability fixes remain.
Automatic turns use the configured main model and can incur normal model costs.
There is no busy/idle polling timer or agent-loop monkey-patch in this update.

## Cancellation and one-shot commands

Interrupting the main agent alone is NOT a global stop: detached children may
keep running, and a later completion can wake the parent again. This update does
not implement a new "manual stop disables wake-ups" policy. Stop unwanted children
through /agents. Session shutdown suppresses pending notices and aborts children.
A notice already handed to Pi cannot be retracted by the extension.

Wake-up requires a live Pi session. It does not keep a one-shot print/JSON process
alive until every child finishes. If the final answer must contain a child's
result, use a foreground Agent or get_subagent_result({ agent_id, wait: true })
before finishing. Explicit waits remain unbounded in V1.

## Existing controls and reliability

The defaultJoinMode setting defaults to async, notifying each child independently.
Existing explicit smart/group settings are respected and may delay group notices.
Change /agents -> Settings -> Join mode to async for incremental processing.
Flag-launched workflows retain their existing next-user-turn delivery and headless
lifecycle limitations. Nested children remain owner-scoped, not root broadcasts.

A notice does not consume a result. The 200ms hold rechecks consumption and
execution identity. Group snapshots cannot be rewritten by a resumed execution;
group ownership cancels any earlier individual hold. These checks apply before
handoff to Pi, not to messages already queued there. A later retrieval can leave
a stale queued notice and an unnecessary continuation; exactly-once delivery and
crash recovery are not promised.

Unread terminal results stay in memory until consumed, explicitly cleared or the
session ends, without an automatic size/TTL bound. Consumed results keep the
upstream completion-age cleanup policy.

## Imported fixes retained

- #311 (8d56733): foreground/nested inline result IDs and tests.
- #316 (75e0db9): dispose widget, group and debounce timers on shutdown.
- #348 (1ecd1e5): unread retention and Pi 0.87 mention-clone compatibility.
- #321 (c89d72a): only widget cadence/idle stop and tests; unrelated changes omitted.

Original MIT license and author attribution are preserved.
Upstream: https://github.com/tintinweb/pi-subagents
Pi notification implementation: https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/agent-session.ts
Pi tool-batch/steering order: https://github.com/earendil-works/pi/blob/v0.87.1/packages/agent/src/agent-loop.ts

## Validation

Run npm ci, npm run check, npm run build and npm run test:e2e.
The automatic-completion tests cover idle wake-up and result retrieval without a
new user prompt, parallel/sequential tool-batch ordering, delivery during a final
answer, and delivery at the agent_end boundary. Wiring tests retain consumption,
grouping, resumed-run filtering, failure and shutdown checks.
Tests use scripted providers with real Pi sessions, not paid/live model calls.
Manual Windows/macOS terminal and live-provider behavior are not certified by CI.

## Simple smoke test

Ask Pi to launch a general-purpose background agent that replies with
SUBAGENT_TEST_OK, then have the parent end its current response without waiting.
Once the child finishes and its hold expires, the parent should continue on its
own and be able to retrieve the result. If the child finishes before the parent
ends, its completion may instead be handled within the same ongoing run.
