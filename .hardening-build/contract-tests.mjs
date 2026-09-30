export default function ({ read, put, section }) {
  section('test/worktree.test.ts', '    it("falls back to pruning when `git worktree remove` fails",', '\n  });\n\n  describe("pruneWorktrees"', `    it("reports a retained directory when git worktree remove fails", async () => {
      const wt = (await createWorktree(pi, repoDir, "remove-fails"))!;
      const failing = failingPi(
        args => args[0] === "worktree" && args[1] === "remove",
        { code: 1, killed: false },
      );
      try {
        const result = await cleanupWorktree(failing, repoDir, wt, "removal fails");
        expect(result).toMatchObject({ hasChanges: true, path: wt.path, error: "boom" });
        expect(existsSync(wt.path)).toBe(true);
        expect(vi.mocked(failing.exec).mock.calls.some(([, args]) => args[0] === "worktree" && args[1] === "prune")).toBe(false);
      } finally {
        try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { rmSync(wt.path, { recursive: true, force: true }); }
      }
    });
`);
  section('test/worktree.test.ts', '  it("short-circuits when the worktree directory is already gone",', '  it("creates the branch BEFORE removing the worktree', `  it("reports uncertainty when the worktree directory is already gone", async () => {
    const wt = (await createWorktree(pi, repoDir, "vanished"))!;
    rmSync(wt.path, { recursive: true, force: true });
    const result = await cleanupWorktree(pi, repoDir, wt, "agent that vanished");
    expect(result).toMatchObject({ hasChanges: true, error: expect.stringContaining("missing") });
    expect(result.branch).toBeUndefined();
  });

  it("keeps a corrupted worktree and reports where to recover it", async () => {
    const wt = (await createWorktree(pi, repoDir, "corrupt"))!;
    try {
      writeFileSync(join(wt.path, "work.txt"), "agent output");
      writeFileSync(join(wt.path, ".git"), "gitdir: /nonexistent/path/that/is/not/a/repo");
      const result = await cleanupWorktree(pi, repoDir, wt, "corrupted agent");
      expect(result).toMatchObject({ hasChanges: true, path: wt.path, error: expect.any(String) });
      expect(result.branch).toBeUndefined();
      expect(existsSync(join(wt.path, "work.txt"))).toBe(true);
    } finally { rmSync(wt.path, { recursive: true, force: true }); }
  });

  it("retains the only copy of changes when the preservation commit fails", async () => {
    const wt = (await createWorktree(pi, repoDir, "commit-fails"))!;
    try {
      writeFileSync(join(wt.path, "work.txt"), "agent output");
      const result = await cleanupWorktree(
        failingPi(args => args[0] === "commit", { code: 1, killed: false }), repoDir, wt, "commit fails",
      );
      expect(result).toMatchObject({ hasChanges: true, path: wt.path, error: "boom" });
      expect(result.branch).toBeUndefined();
      expect(existsSync(join(wt.path, "work.txt"))).toBe(true);
    } finally {
      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { rmSync(wt.path, { recursive: true, force: true }); }
    }
  });

`);
  put('test/worktree.test.ts', read('test/worktree.test.ts').replace(
    '// cleanupWorktree\'s outer catch is the only place in the repo where a caught\n// error can DESTROY user work while reporting success-shaped output: it removes\n// the worktree and returns `{ hasChanges: false }`, which the manager renders as\n// "the agent changed nothing". If the commit or branch step fails, the agent\'s\n// commits go with the worktree and nobody is told.',
    '// Preservation errors must retain work and report uncertainty, never masquerade\n// as a successful cleanup of an unchanged tree.'
  ));
}
