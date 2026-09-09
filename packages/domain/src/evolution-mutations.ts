import type { AgentProfile, GovernanceTier } from "./index.js";
import { isL3ProtectedMutationPath } from "./index.js";

export interface EvolutionMutation {
  path: string;
  before: string;
  after: string;
  tier: GovernanceTier;
}

export function applyEvolutionMutations(
  snapshot: Omit<AgentProfile, "pinnedVersionId">,
  mutations: EvolutionMutation[],
): Omit<AgentProfile, "pinnedVersionId"> {
  const next = structuredClone(snapshot);
  for (const mutation of mutations) {
    if (isL3ProtectedMutationPath(mutation.path)) {
      throw new Error("evolution_l3_mutation_forbidden");
    }
    applyOneMutation(next, mutation);
  }
  return next;
}

function applyOneMutation(
  snapshot: Omit<AgentProfile, "pinnedVersionId">,
  mutation: EvolutionMutation,
): void {
  const { path, after } = mutation;

  if (path === "prompt/system") {
    snapshot.systemPrompt = after;
    return;
  }

  const mcpMatch = /^mcp\/([^/]+)\/description$/.exec(path);
  if (mcpMatch) {
    const serverName = mcpMatch[1]!;
    let binding = snapshot.mcpBindings.find((entry) => entry.serverName === serverName);
    if (!binding) {
      binding = { serverName, transport: "stdio" };
      snapshot.mcpBindings.push(binding);
    }
    binding.description = after;
    return;
  }

  const skillMatch = /^skills\/(.+)$/.exec(path);
  if (skillMatch) {
    const skillKey = skillMatch[1]!;
    snapshot.systemPrompt = `${snapshot.systemPrompt}\n\n[Evolved skill ${skillKey}]\n${after}`;
    return;
  }

  throw new Error(`evolution_unknown_mutation_path:${path}`);
}
