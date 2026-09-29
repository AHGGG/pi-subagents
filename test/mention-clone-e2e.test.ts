import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { type ExtensionContext, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { expect, it, vi } from "vitest";
import { runMentionClone } from "../src/mention-clone.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { modelContext, registerFauxProvider } from "./helpers/pi-ai.js";

it("the real clone receives the live prompt and restored history, with only its Agent tool", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "mention-clone-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
  const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  try {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const parent = SessionManager.inMemory(cwd);
    const kept = parent.appendMessage({ role: "user", content: "HISTORY-MARKER", timestamp: 1 });
    parent.appendCompaction("SUMMARY-MARKER", kept, 1000);
    const entriesBefore = parent.getEntries().slice();
    const execute = vi.fn(async () => ({ content: [fauxText("started")], details: {} }));
    const tool: ToolDefinition = {
      name: "Agent", label: "Agent", description: "Start an agent",
      parameters: Type.Object({ prompt: Type.String() }), execute,
    };
    const requests: ReturnType<typeof modelContext>[] = [];
    faux.setResponses([
      context => {
        requests.push(modelContext(context));
        return fauxAssistantMessage([fauxToolCall("Agent", { prompt: "do work" })]);
      },
      fauxAssistantMessage([fauxText("done")]),
    ]);
    const ctx = {
      cwd, model, thinkingLevel: "off", sessionManager: parent,
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
      getSystemPrompt: () => "LIVE-PROMPT-MARKER",
    } as unknown as ExtensionContext;
    const result = await runMentionClone({ ctx, type: "general-purpose", message: "MENTION-MARKER", agentTool: tool });
    expect(requests).toHaveLength(1);
    expect(requests[0].systemPrompt).toBe("LIVE-PROMPT-MARKER");
    expect(requests[0].tools?.map(t => t.name)).toEqual(["Agent"]);
    const text = JSON.stringify(requests[0].messages);
    expect(text).toContain("HISTORY-MARKER");
    expect(text).toContain("SUMMARY-MARKER");
    expect(text).toContain("MENTION-MARKER");
    expect(result).toEqual({ spawned: true });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(undefined, expect.objectContaining({ run_in_background: true }), expect.anything(), expect.anything(), ctx);
    expect(parent.getEntries()).toEqual(entriesBefore);
  } finally {
    faux.unregister();
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);
