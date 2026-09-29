/**
 * pi-ai.ts — single import point for the two test helpers that pi-ai ≥0.80
 * exports only from the `/compat` subpath (all lived on the package root in
 * ≤0.75.x). Upstream deletes `/compat` with its coding-agent ModelManager
 * migration; the replacement then is `fauxProvider()` + `createModels()`.
 */

import type { Context } from "@earendil-works/pi-ai";
import * as ai from "@earendil-works/pi-ai";

export { getModel, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";

// Pi 0.87 carries prompt/tool declarations in system messages rather than on Context.
// Use Pi's replay helpers so tool removals and prompt sections keep their semantics.
export function modelContext(context: Context): Context {
  const transcript = ai as typeof ai & {
    getCurrentTools?: (messages: Context["messages"]) => Context["tools"];
    getCurrentSystemPrompt?: (messages: Context["messages"]) => string;
  };
  return {
    ...context,
    tools: context.tools ?? transcript.getCurrentTools?.(context.messages),
    systemPrompt: context.systemPrompt ?? transcript.getCurrentSystemPrompt?.(context.messages),
  };
}
