# Upstream sync — 0.20.0-ahggg.1

Sync target: [`tintinweb/pi-subagents@7d83085`](https://github.com/tintinweb/pi-subagents/commit/7d83085).
Fork starting point: [`AHGGG/pi-subagents@c3e8d6c`](https://github.com/AHGGG/pi-subagents/commit/c3e8d6c).
Shared base: `e955e29c51b7a6cce37e1108cd2d6c57a77e151c`.

Merge all 12 upstream commits since the shared base and retain the fork's current
behavior where it remains useful. The target includes upstream 0.20.0 plus later
master commits. This is a Git-installed personal version, not an npm publication.

## What was merged

| Upstream commit | Change | Integration decision |
|---|---|---|
| [`25eb4fa`](https://github.com/tintinweb/pi-subagents/commit/25eb4fa) | Pi 1.1 compatibility, session-entry mention clones, transcript handling, TypeBox imports | Adopt Pi 1.1 APIs; keep current-provider resolution and exact live-prompt behavior |
| [`13106ab`](https://github.com/tintinweb/pi-subagents/commit/13106ab) | Upstream 0.20.0 release metadata | Preserve upstream release history; identify the fork as `0.20.0-ahggg.1` |
| [`3ff1a8b`](https://github.com/tintinweb/pi-subagents/commit/3ff1a8b) | Spacer below FleetView | Adopt |
| [`7da6bef`](https://github.com/tintinweb/pi-subagents/commit/7da6bef) | FleetView works with custom prompt editors | Adopt the editor-interface focus check |
| [`d57e351`](https://github.com/tintinweb/pi-subagents/commit/d57e351) | Queued foreground startup-failure coverage | Retain regression coverage |
| [`fd8d816`](https://github.com/tintinweb/pi-subagents/commit/fd8d816) | Workflow children honor `isolated` | Adopt |
| [`fc1ddb3`](https://github.com/tintinweb/pi-subagents/commit/fc1ddb3) | Agent-file `isolated` applies to every spawn path | Adopt frontmatter precedence |
| [`bb7d208`](https://github.com/tintinweb/pi-subagents/commit/bb7d208) | Agent-file `isolation` applies to mention/RPC spawns | Adopt; workflow scripts still control their own worktree option |
| [`c30ff31`](https://github.com/tintinweb/pi-subagents/commit/c30ff31) | Built-in MCP, codemode, tool search, tool scoping and inherited project trust | Adopt together so new tools retain their trust and scope boundaries |
| [`7bec8b9`](https://github.com/tintinweb/pi-subagents/commit/7bec8b9) | Fullscreen conversation observer and mouse support | Adopt; regular TUI mode keeps the floating viewer |
| [`83fdf77`](https://github.com/tintinweb/pi-subagents/commit/83fdf77) | `ctrl+b` / viewer `b` handoff to background | Integrate with the fork's run identity, abort-listener cleanup and finalization |
| [`7d83085`](https://github.com/tintinweb/pi-subagents/commit/7d83085) | Deliver completions to a busy parent through steering | Same policy as the fork since `.2`; retain the shared delivery constant and both regression suites |

## What stays in the fork

| Behavior | Why it stays |
|---|---|
| Bare model IDs/names resolve only on the parent's provider | Prevents an implicit provider switch. `provider/modelId` is still an explicit choice |
| `defaultJoinMode: async` | Each completed child becomes available independently. Explicit `smart` and `group` settings still work |
| Automatic completion continuation | The parent can process results without another user message. Upstream now shares this policy |
| Saved results in the parent session | Exact-ID retrieval survives live-record cleanup and parent compaction without rerunning the child |
| Fresh identity per execution and finalization before result publication | Old callbacks/results cannot impersonate a resumed run; consumers wait for required preservation |
| Worktree preservation on Git failures | A failed status/stage/commit/branch/remove operation retains recoverable work and reports the error |
| Unread-result retention, inline resumable IDs, shutdown cleanup and idle-safe widget | These fixes still address behavior not replaced by the upstream sync |
| Host runtime peers declared as `"*"` | Follows Pi's extension-loader contract and prevents duplicate host modules |

The scheduled-model path also closes fallback gaps: an unavailable bare
override now falls back to the concrete parent model. Leaving the override unset
at that point could have selected the agent file's explicit model on another
provider. An unavailable qualified `provider/modelId` reports a job error without
spawning an agent. Schedules with no override still honor agent defaults.

The foreground handoff keeps the same session, worktree, promise and run ID. It
removes the original caller's abort listener and moves the charged concurrency
slot to the background pool. Finalization releases that slot once, writes the
saved result, and then permits the normal completion notice. A full background
pool can temporarily run over its limit after a handoff; queued work waits until
capacity returns. No restart, polling service or second execution system is added.

## What was replaced or removed

- The Pi 0.87-specific mention-clone conversion path is replaced with Pi 1.1's
  session-entry seeding. History, compaction, selected-branch and exact-prompt
  checks remain useful and stay covered.
- The old Pi 0.87 compatibility baseline is replaced with Pi 1.1.0. The version
  requirement is explicit even though host package peer ranges are `"*"`.
- Source imports use `typebox`. The unused `@sinclair/typebox` runtime peer is
  removed; its development dependency remains for test fixtures that import it.
- Stale current-version and default-behavior documentation is updated. Historical
  fork releases and upstream release entries are preserved.

No upstream feature is intentionally dropped. The fork's small shared completion
constant is retained because it expresses the same upstream delivery option in
one place; there is no need for a second notifier or a new compatibility layer.

## Compatibility and operational changes

**Upgrade Pi to 1.1.0 or newer before updating this fork.** Development dependencies
and the required CI baseline target 1.1.0. An older Pi version is no longer a
supported runtime, even if installation succeeds because the peer ranges are `"*"`.

With `extensions: true`, each child now loads Pi's built-in extensions and can
start its own `mcp.json` servers. Those resources remain until the child session
is disposed. In this fork unread results retain their sessions, so the ordinary
ten-minute cleanup only applies once a result is consumed. For agents that do
not need MCP, use the existing `exclude_extensions: builtin:mcp`; `isolated: true`
disables all extensions and skills. The parent project's trust decision and each
agent's tool scope apply to these built-ins, including nested `ctx.executeTool()`
calls from codemode.

An existing agent file with `isolation: worktree` now applies that choice to
mentions and RPC spawns too. It fails to start outside a usable Git repository
when worktree isolation is enabled. Workflow `agent()` calls keep the script's
choice; the global `worktreeIsolation: false` setting still disables worktrees.

Completion delivery still waits until the current tool batch finishes. It can
wake an idle parent; it cannot keep a one-shot process alive after exit. Stop
unwanted detached children explicitly, and join required results before ending a
headless command. See [the completion contract](FORK_V1.md#completion-contract).

## Validation

Required commands for the merged tree:

```bash
npm ci
npm run check
npm run test:e2e
npm run build
```

Executed locally on Node 24.19.0 with Pi 1.1.0:

| Check | Result |
|---|---|
| `npm ci --ignore-scripts --no-audit --no-fund` | Passed; 219 packages installed |
| `npm run check` | Lint and typecheck passed; 121 test files passed, 2,302 tests passed and 7 skipped |
| `npm run test:e2e` | 19 files passed; 94 tests passed and 7 skipped |
| `npm run build` | Passed |
| `git diff --cached --check` | Passed |

The end-to-end command selects tests already included in the full suite; its
count is not additional coverage. Skipped tests are the opt-in live-provider
cases. No paid provider calls or manual Windows/macOS TUI checks were run.

Focused mutation checks also confirmed the new regressions fail if the live
pool release is replaced with the foreground pool, idle wake-up is disabled,
the stale no-wake prompt instruction returns, the exact clone-prompt hook is
removed, or scheduled provider scoping/fallback/error guards are broken. Each
temporary mutation was restored before the passing final suite. Independent
review found no remaining merge blocker in the lifecycle and notification paths.

Relevant regression coverage includes provider selection on every spawn path;
Pi 1.1 mention cloning and transcript output; trusted/untrusted project extensions
and MCP; nested tool-scope vetoes; isolated workflow/mention/RPC spawns; fullscreen
scrolling and focus; foreground handoff, abort and concurrency accounting;
saved-result recovery during/after parent compaction; and real-Git preservation
failures. Scripted providers exercise real Pi sessions without paid model calls.
Manual Windows/macOS TUI and live-provider behavior require a separate smoke test.

## Update

```bash
pi update git:github.com/AHGGG/pi-subagents
```

Restart Pi after running children finish. For a new installation or an upstream
installation, follow [the fork installation guide](FORK_V1.md#install-or-update).
