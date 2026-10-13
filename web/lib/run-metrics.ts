export type RunMetrics = {
  modelTurns: number;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  activeDurationMs: number;
  tokensPerSecond: number | null;
  cacheHitRate: number | null;
};

export type UsageSnapshot = {
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokensDetails?: Array<Record<string, number>> | Record<string, number>;
  outputTokensDetails?: Array<Record<string, number>> | Record<string, number>;
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function detailTotal(
  details: UsageSnapshot["inputTokensDetails"] | UsageSnapshot["outputTokensDetails"],
  keys: string[],
): number | null {
  const entries = Array.isArray(details) ? details : details ? [details] : [];
  let reported = false;
  let total = 0;
  for (const entry of entries) {
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
      const value = finiteNumber(entry[key]);
      if (typeof value === "number") {
        reported = true;
        total += value;
      }
      break;
    }
  }
  return reported ? total : null;
}

export function createRunMetrics(usage: UsageSnapshot, actionSteps: number, activeDurationMs: number): RunMetrics {
  const modelTurns = finiteNumber(usage.requests) ?? 0;
  const inputTokens = finiteNumber(usage.inputTokens) ?? 0;
  const outputTokens = finiteNumber(usage.outputTokens) ?? 0;
  const totalTokens = finiteNumber(usage.totalTokens) ?? inputTokens + outputTokens;
  const cachedInputTokens = detailTotal(usage.inputTokensDetails, [
    "cached_tokens",
    "cachedTokens",
    "cache_read_input_tokens",
    "cacheReadInputTokens",
  ]);
  const reasoningTokens = detailTotal(usage.outputTokensDetails, ["reasoning_tokens", "reasoningTokens"]);
  const duration = Math.max(0, Math.round(activeDurationMs));

  return {
    modelTurns,
    steps: modelTurns + Math.max(0, actionSteps),
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    reasoningTokens,
    activeDurationMs: duration,
    tokensPerSecond: outputTokens > 0 && duration > 0 ? outputTokens / (duration / 1_000) : null,
    cacheHitRate: cachedInputTokens !== null && inputTokens > 0 ? cachedInputTokens / inputTokens : null,
  };
}
