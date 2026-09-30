export default function ({ replace, put, section }) {
  replace('src/worktree.ts', '  /** Whether changes were found in the worktree. */\n  hasChanges: boolean;', '  /** Changes were found, or could not safely be ruled out after a failure. */\n  hasChanges: boolean;');
  replace('src/worktree.ts', '  /** Worktree path if it was kept. */\n  path?: string;', '  /** Worktree path if it was kept. */\n  path?: string;\n  /** Preservation or removal failed; never interpret this as a clean tree. */\n  error?: string;');
  replace('src/worktree.ts', '  if (!existsSync(worktree.path)) {\n    return { hasChanges: false };\n  }\n\n  try {', '  if (!existsSync(worktree.path)) {\n    return { hasChanges: true, error: "Worktree is missing; its changes could not be verified." };\n  }\n\n  let preservedBranch: string | undefined;\n  try {');
  replace('src/worktree.ts', '    worktree.branch = branchName;', '    worktree.branch = branchName;\n    preservedBranch = branchName;');
  replace('src/worktree.ts', '      branch: worktree.branch,\n      path: worktree.path,', '      branch: worktree.branch,');
  replace('src/worktree.ts', '  } catch {\n    // Best effort cleanup on error\n    try { await removeWorktree(pi, cwd, worktree.path); } catch { /* ignore */ }\n    return { hasChanges: false };\n  }', '  } catch (err) {\n    // A failed status/stage/commit/branch operation may leave the only copy of\n    // the work here. Never remove it on the failure path. If only removal\n    // failed, preserve the already-created branch information as well.\n    return {\n      hasChanges: true,\n      ...(preservedBranch ? { branch: preservedBranch } : {}),\n      ...(existsSync(worktree.path) ? { path: worktree.path } : {}),\n      error: err instanceof Error ? err.message : String(err),\n    };\n  }');
  section('src/worktree.ts', 'async function removeWorktree(', '\n/**\n * Prune any orphaned worktrees', `async function removeWorktree(pi: ExtensionAPI, cwd: string, worktreePath: string): Promise<void> {
  // Pruning registrations is not a substitute for removing a directory. Let
  // cleanupWorktree report a failed removal rather than claim success.
  await git(pi, cwd, ["worktree", "remove", "--force", worktreePath], 10000);
}
`);
  replace('src/agent-manager.ts', '          record.worktreeResult = wtResult;', '          record.worktreeResult = wtResult;\n          if (wtResult.error) {\n            record.result = (record.result ?? "") + `\\n\\nWorktree preservation/cleanup needs attention: ${wtResult.error}` +\n              (wtResult.path ? `\\nWorktree retained at: ${wtResult.path}` : "");\n          }', 1);
  replace('src/agent-manager.ts', '            record.worktreeResult = wtResult;', '            record.worktreeResult = wtResult;\n            if (wtResult.error) {\n              record.result = (record.result ?? "") + `\\n\\nWorktree preservation/cleanup needs attention: ${wtResult.error}` +\n                (wtResult.path ? `\\nWorktree retained at: ${wtResult.path}` : "");\n            }', 1);
  put('test/worktree-preservation.test.ts', `import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupWorktree, createWorktree } from "../src/worktree.js";

// Real Git, no model calls. Fault injection preserves pi.exec's resolved-error contract.
describe("worktree preservation failures", () => {
  let cwd: string;
  const paths: string[] = [];
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  const pi = (fail?: string, killed = false) => ({
    async exec(command: string, args: string[], options: any) {
      if (args[0] === fail || (fail === "remove" && args[0] === "worktree" && args[1] === "remove")) {
        return { stdout: "", stderr: "CONTROLLED-" + fail, code: killed ? 0 : 128, killed };
      }
      try {
        return { stdout: execFileSync(command, args, { ...options, encoding: "utf8", stdio: "pipe" }), stderr: "", code: 0, killed: false };
      } catch (error: any) {
        return { stdout: error.stdout ?? "", stderr: error.stderr ?? String(error), code: error.status ?? 1, killed: false };
      }
    },
  }) as any;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-safe-wt-"));
    git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(cwd, "README.md"), "base"); git("add", "-A"); git("commit", "-m", "base");
  });
  afterEach(() => {
    for (const path of paths.splice(0)) {
      try { git("worktree", "remove", "--force", path); } catch { rmSync(path, { recursive: true, force: true }); }
    }
    rmSync(cwd, { recursive: true, force: true });
  });
  async function dirty() {
    const wt = (await createWorktree(pi(), cwd, "preserve"))!;
    paths.push(wt.path);
    writeFileSync(join(wt.path, "valuable.txt"), "ONLY-COPY-OF-WORK");
    return wt;
  }
  it.each(["status", "add", "commit", "branch"])("retains all work when %s fails", async fail => {
    const wt = await dirty();
    const result = await cleanupWorktree(pi(fail), cwd, wt, "preserve work");
    expect(result).toMatchObject({ hasChanges: true, path: wt.path, error: "CONTROLLED-" + fail });
    expect(result.branch).toBeUndefined();
    expect(readFileSync(join(wt.path, "valuable.txt"), "utf8")).toBe("ONLY-COPY-OF-WORK");
  });
  it("retains work on a timed-out commit even if its exit code is zero", async () => {
    const wt = await dirty();
    expect(await cleanupWorktree(pi("commit", true), cwd, wt, "timeout")).toMatchObject({ path: wt.path, error: "CONTROLLED-commit" });
    expect(existsSync(join(wt.path, "valuable.txt"))).toBe(true);
  });
  it("retains work on a real Git signing failure", async () => {
    const wt = await dirty();
    git("config", "commit.gpgsign", "true");
    git("config", "gpg.program", join(cwd, "nonexistent-signer"));
    const result = await cleanupWorktree(pi(), cwd, wt, "signing fails");
    expect(result.error).toBeTruthy();
    expect(result.path).toBe(wt.path);
    expect(result.branch).toBeUndefined();
    expect(readFileSync(join(wt.path, "valuable.txt"), "utf8")).toBe("ONLY-COPY-OF-WORK");
  });
  it("reports the saved branch AND retained path when removal fails", async () => {
    const wt = await dirty();
    const result = await cleanupWorktree(pi("remove"), cwd, wt, "saved but not removed");
    expect(result).toMatchObject({ hasChanges: true, branch: wt.branch, path: wt.path, error: "CONTROLLED-remove" });
    expect(git("show", result.branch + ":valuable.txt")).toBe("ONLY-COPY-OF-WORK");
    expect(existsSync(wt.path)).toBe(true);
  });
  it("reports a missing worktree instead of declaring it clean", async () => {
    expect(await cleanupWorktree(pi(), cwd, { path: join(cwd, "missing"), branch: "b", baseSha: "x", workPath: "x" }, "missing")).toMatchObject({ hasChanges: true, error: expect.any(String) });
  });
});
`);
}
