# AHGGG personal fork — installation and behavior

Current version: **0.22.0-ahggg.1**.

Synced through upstream master `ca93a52`, including changes after upstream 0.22.0.
See [merge decisions](UPSTREAM_SYNC.md) for the imported changes and
[hardening behavior](HARDENING.md) for retained saved-result recovery and lifecycle guarantees.
Requires Pi **1.1.0 or newer**; development dependencies and the required CI baseline
are pinned to 1.1.0. Host-provided runtime packages use `"*"` peers for Pi's loader
contract, so the peer range does not enforce that minimum.
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

## Completion contract

Introduced in `0.19.0-ahggg.2` and retained in the current fork. Upstream #388
adds an outbox that combines available notices at each parent turn boundary;
the fork keeps one shared delivery option constant and stale-run filtering.

Individual, grouped and workflow-tool completions use the shared delivery options:

    { deliverAs: "steer", triggerTurn: true }

On the supported Pi 1.1 runtime:

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

This replaced `0.19.0-ahggg.1`'s passive-only policy; all other V1 reliability fixes remain.
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
before finishing. Explicit waits remain unbounded.

## Existing controls and reliability

The defaultJoinMode setting defaults to async: results never wait for siblings,
but available notices share one message at the parent's next boundary or after
a 200 ms idle hold. Explicit smart/group settings retain sibling waits; groups
now use the full parent turn rather than a 100 ms spawn window. A lone spawn or
a spawn outside a parent turn notifies individually.
Change /agents -> Settings -> Join mode to async for incremental processing.
Flag-launched workflows retain their existing next-user-turn delivery and headless
lifecycle limitations. Nested children remain owner-scoped, not root broadcasts.

A notice does not consume a result. Sending rechecks consumption and execution
identity. Accepting a resume cancels any pending notice for the previous run.
Group snapshots cannot be rewritten by a resumed execution; group ownership
cancels any earlier individual hold. These checks apply before
handoff to Pi, not to messages already queued there. A later retrieval can leave
a stale queued notice and an unnecessary continuation; exactly-once delivery and
crash recovery are not promised.

Unread terminal results stay in memory until consumed, explicitly cleared or the
session ends, without an automatic size/TTL bound. Consumed results keep the
upstream completion-age cleanup policy.

## Imported fixes retained

- #311 (8d56733): foreground/nested inline result IDs and tests.
- #316 (75e0db9, now upstream 83be963): dispose widget, groups and pending notices
  on shutdown. Turn-boundary batching replaces the old debounce timer.
- #348 (1ecd1e5): unread retention. Its Pi 0.87-specific clone implementation is
  superseded by upstream's Pi 1.1 session-entry clone; the history, branch and
  exact-prompt regression scenarios remain covered.
- #321 (c89d72a): only widget cadence/idle stop and tests; unrelated changes omitted.

Original MIT license and author attribution are preserved.
Upstream: https://github.com/tintinweb/pi-subagents
Pi notification implementation: https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/agent-session.ts
Pi tool-batch/steering order: https://github.com/earendil-works/pi/blob/v1.1.0/packages/agent/src/agent-loop.ts

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
