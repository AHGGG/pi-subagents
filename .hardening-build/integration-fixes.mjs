export default function ({ replace, read, put }) {
  // The pre-cleanup verifier needs the model's outcome, not a prematurely
  // published terminal record. Pass that outcome explicitly through its hook.
  replace('src/agent-manager.ts', '  onBeforeWorktreeCleanup?: (worktreePath: string) => Promise<void>;', '  onBeforeWorktreeCleanup?: (worktreePath: string, outcome: AgentRecord["status"]) => Promise<void>;');
  replace('src/agent-manager.ts', '    * Fires only on the normal settle path, and only when a worktree was created.', '    * Fires only on the normal settle path, and only when a worktree was created.', 0);
}
