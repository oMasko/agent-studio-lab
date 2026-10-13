import type { CompactionRecord, CompactionSettings } from "@/lib/compaction-types";
export type ContextIdentity = { provider: string; model: string; baseURL: string; apiMode: string };
export type ContextLimits = { contextWindow: number | null; outputReserve: number; source?: "manual" | "official" | "unknown"; sourceURL?: string; verifiedAt?: string; approximate?: boolean };
export type ContextEstimate = { instructions: number; messages: number; tools: number; total: number; partial: boolean };
export type ContextSnapshot = {
  requestId: string; startedAt: number; updatedAt: number; agentId: string; agentName: string;
  model: string; provider: string; status: "requesting" | "completed" | "interrupted";
  source: "provider" | "estimate"; inputTokens: number; outputTokens: number | null;
  estimate: ContextEstimate;
  effectiveItems?: number;
};
export type ContextAgentUsage = { agentId: string; agentName: string; identity: ContextIdentity; limits: ContextLimits; snapshot: ContextSnapshot | null; compaction?: CompactionRecord | null };
export type ContextUsageView = {
  sessionId: string; agents: ContextAgentUsage[];
  compactionSettings?: CompactionSettings;
  history: { storedItems: number; effectiveItems: number; estimatedTokens: number; autoCompact: boolean; compacted: boolean; recentItemLimit: number; summaryIncluded: boolean };
};

export function contextBudget(input: number, output: number | null, limits: ContextLimits) {
  const used = input + (output ?? 0);
  const window = limits.contextWindow;
  return { used, percent: window === null ? null : used / window * 100,
    remaining: window === null ? null : Math.max(0, window - used),
    inputBudget: window === null ? null : Math.max(0, window - limits.outputReserve),
  };
}

// A deliberately labelled heuristic, not a model-specific tokenizer.
export function estimateContextTokens(value: unknown): number {
  if (Array.isArray(value) && value.length === 0) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  let ascii = 0; let other = 0;
  for (const character of text) character.codePointAt(0)! < 128 ? ascii++ : other++;
  return Math.ceil(ascii / 4 + other);
}
