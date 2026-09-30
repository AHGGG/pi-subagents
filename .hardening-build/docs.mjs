export default function ({ replace, put, read }) {
  const pkg = JSON.parse(read('package.json'));
  pkg.version = '0.19.0-ahggg.3';
  pkg.description = 'Personal fork: recoverable subagent results, safe finalization, and automatic continuation for Pi';
  put('package.json', JSON.stringify(pkg, null, 2) + '\n');
  const lock = JSON.parse(read('package-lock.json'));
  lock.version = pkg.version; lock.packages[''].version = pkg.version;
  put('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
  replace('README.md', '**Current version: 0.19.0-ahggg.2. Automatic wake-up is restored.**', '**Current version: 0.19.0-ahggg.3. Automatic wake-up remains enabled.**');
  replace('README.md', 'Already installed? Run `pi update --extensions`', 'The .3 update adds exact-ID recovery of saved final results in the current session\nbranch, consistent execution finalization, and safe worktree preservation on errors.\nIt does not automatically restart an agent merely to read an old answer.\nSee [hardening behavior and limits](docs/HARDENING.md).\n\nAlready installed? Run `pi update git:github.com/AHGGG/pi-subagents`');
  replace('docs/FORK_V1.md', 'Current version: **0.19.0-ahggg.2**.', 'Current version: **0.19.0-ahggg.3**.\n\nThe automatic-continuation contract below remains in effect. See\n[hardening behavior](HARDENING.md) for .3 saved-result recovery and lifecycle changes.');
  replace('docs/FORK_V1.md', '    pi update --extensions', '    pi update git:github.com/AHGGG/pi-subagents');
  replace('CHANGELOG.md', '# Changelog\n', `# Changelog

## 0.19.0-ahggg.3 — 2026-09-30

- Preserve worktrees and report recovery paths when Git status, staging, commit,
  branch creation or removal fails. Never force-delete work after preservation fails.
- Finalize spawn/resume executions before exposing or consuming final results;
  use fresh run identities, promises and controllers; reject overlapping resumes.
- Record accepted and finalized top-level executions in the existing parent session.
  Recover exact-ID final results from the current branch after in-memory cleanup
  or extension reload, without rerunning a child or accessing unrelated sessions.
- Make completion-observer failures non-fatal to concurrency slots and queue progress.
- Add real-Git fault tests, lifecycle/recovery regressions, and real-Pi tests with
  two managed children completing during/after parent auto-compaction.
- Keep automatic wake-up, async join default and earlier V1 reliability fixes.
`);
  put('docs/HARDENING.md', `# Personal fork hardening — 0.19.0-ahggg.3

Install/update from Git:

    pi update git:github.com/AHGGG/pi-subagents

Restart Pi after active children finish. No npm publication or new setting is needed.
Requires Pi >= 0.87.1; deterministic tests target the pinned 0.87.1 runtime.

## Result retrieval

The real get_subagent_result tool first checks an accessible live record. If no
record is present, it searches raw custom entries in the current parent-session
branch for the exact agent ID. Compaction changes model context, not these raw
entries. Recovery returns the saved outcome with completion time and execution ID;
it does not rerun the task, reopen a child runtime, or search other sessions.

Accepted runs and queued resumes record a new run ID. An unfinished newer run
blocks fallback to an earlier answer. Invalid/scope-mismatched records fail closed.
Nested and workflow-owned live records still cannot be read via the top-level tool.
Saved final text is not the same thing as a full child transcript; verbose recovery
says when that transcript is unavailable. Handles still resolve live records;
history recovery initially requires the exact ID from the launch/completion notice.

Legacy .1/.2 completion entries can also be read and are explicitly labelled.
Older versions did not persist every foreground resume, so those legacy entries
are the last recorded outcome, not proof that no later unrecorded execution existed.
Unknown IDs, missing entries, and newer runs without a final snapshot get distinct
messages. Recovery cannot reconstruct a result that was never successfully recorded.

Consumed runtime records still use the existing completion-age cleanup policy;
unread results are retained in memory without a new size/TTL cap. Reading a saved
result does not restore a resumable runtime. Restarting/resuming agents from disk
(PR #286's broader behavior) is not included. Session files can grow with saved
result text; this patch does not introduce a database, retention service or index.

## Execution lifecycle

Spawn and both resume modes keep a fresh current run identity/controller/promise.
A stopped execution remains pending until it unwinds; another resume is refused
while it is running, queued or finalizing. Required worktree preservation completes
before a result becomes finalized. Waiting can be cancelled without consuming the
result; a detached child keeps its separate cancellation policy.

Foreground and background finalizations both record the outcome. Foreground
results are marked consumed for notification purposes, but remain recoverable.
Slots are released once, and a reporting or persistence callback failure cannot
prevent the queue from progressing. Failures are warned about, not represented
as successful persistence.

## Worktree safety

A clean unchanged worktree can be removed. Changed work is removed only after
it is preserved to a branch. Preservation failures retain the worktree and report
its path and the Git error. If only removal fails, both saved branch and retained
path are reported. A missing worktree is not reported as verified clean.
The extension does not disable Git signing or overwrite existing branches.

## Unchanged behavior

Automatic completion delivery remains steer + triggerTurn: true. Current tools
finish before the notice is handled; an idle main agent can wake automatically.
Stopping the parent alone does not cancel all detached children or permanently
suppress their future notices. One-shot commands still need explicit joins before
exit. Already-queued notices cannot be retracted, and notification exactly-once
or crash-proof execution guarantees are not added.

## Tests and limits

The new tests include real Git preservation failures, generation-safe resume and
wait behavior, queue progress after callback failures, exact-ID/scope validation,
recovery after cleanup and new extension activation, and two real Pi child sessions
completing during/after parent auto-compaction. The compaction integration uses
Pi's public custom-summary hook for deterministic text; threshold detection,
context replacement, completion queueing and get_subagent_result are real.
No paid/live-model test or manual Windows/macOS terminal certification is implied.
See the release pull request for the actually executed results and exact SHA.
`);
}
