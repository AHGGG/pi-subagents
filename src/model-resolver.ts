/**
 * Model resolution: exact match ("provider/modelId") with fuzzy fallback.
 */

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

export interface ModelRegistry {
  find(provider: string, modelId: string): any;
  getAll(): any[];
  getAvailable?(): any[];
}

/**
 * Both display forms of a model. The short one goes on tight rows (the widget,
 * the Agent tool result), the canonical one where there is room to disambiguate
 * two providers serving a similarly-named model (the conversation viewer).
 *
 * One function, because `index.ts` labels the model it resolved before the run
 * and `agent-manager.ts` relabels it from the live session afterwards — the two
 * must agree or the label would visibly change the moment the session starts.
 */
export function describeModel(
  model: { provider: string; id: string; name?: string },
): { modelName: string; modelId: string } {
  return {
    modelName: (model.name ?? model.id).replace(/^Claude\s+/i, "").toLowerCase(),
    modelId: `${model.provider}/${model.id}`,
  };
}

/**
 * Resolve a model string to a Model instance.
 * Tries exact match first ("provider/modelId"), then fuzzy match against all available models.
 * Returns the Model on success, or an error message string on failure.
 */
export function resolveModel(
  input: string,
  registry: ModelRegistry,
  preferredProvider?: string,
): any | string {
  // Available models (those with auth configured)
  const available = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];

  // A provider/model input is an explicit provider choice. A bare model stays
  // on the caller's provider when one is supplied. This prevents an innocent
  // model override from silently moving work (and billing) to another provider.
  const slashIdx = input.indexOf("/");
  const explicitProvider = slashIdx !== -1 ? input.slice(0, slashIdx) : undefined;
  const providerScope = explicitProvider ?? preferredProvider;
  const all = providerScope
    ? available.filter(m => m.provider.toLowerCase() === providerScope.toLowerCase())
    : available;

  // 1. Exact canonical match for explicit provider/model inputs.
  if (slashIdx !== -1) {
    const modelId = input.slice(slashIdx + 1);
    const exact = all.find(
      m => m.provider.toLowerCase() === explicitProvider!.toLowerCase()
        && m.id.toLowerCase() === modelId.toLowerCase(),
    );
    if (exact) {
      const found = registry.find(exact.provider, exact.id);
      if (found) return found;
    }
  }

  // 2. Fuzzy match, but only inside the provider scope established above.
  // Normalize separators so cosmetic punctuation differences still match —
  // e.g. "claude-haiku-4.5" and "claude-haiku-4-5".
  const normalize = (s: string) => s.toLowerCase().replace(/\./g, "-");
  const query = normalize(input);

  // Score each model: prefer exact id match > id contains > name contains > provider+id contains
  let bestMatch: ModelEntry | undefined;
  let bestScore = 0;

  for (const m of all) {
    const id = normalize(m.id);
    const name = normalize(m.name);
    const full = normalize(`${m.provider}/${m.id}`);

    let score = 0;
    if (id === query || full === query) {
      score = 100; // exact
    } else if (id.includes(query) || full.includes(query)) {
      score = 60 + (query.length / id.length) * 30; // substring, prefer tighter matches
    } else if (name.includes(query)) {
      score = 40 + (query.length / name.length) * 20;
    } else if (
      // A trailing date-stamp token (e.g. "20251001") is optional, so a
      // date-pinned config like "claude-haiku-4-5-20251001" still matches an
      // undated registry id like "claude-haiku-4-5".
      query
        .split(/[\s\-/]+/)
        .every(part => /^\d{8}$/.test(part) || id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))
    ) {
      score = 20; // all parts present somewhere
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = m;
    }
  }

  if (bestMatch && bestScore >= 20) {
    const found = registry.find(bestMatch.provider, bestMatch.id);
    if (found) return found;
  }

  // 3. No match. Do not cross providers: callers that supplied a parent
  // provider will fall back to the parent model; explicit provider/model inputs
  // fail against that provider rather than being silently rerouted.
  const modelList = all
    .map(m => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  const scope = providerScope ? ` in provider "${providerScope}"` : "";
  return `Model not found: "${input}"${scope}.\n\nAvailable models:\n${modelList || "  (none)"}`;
}
