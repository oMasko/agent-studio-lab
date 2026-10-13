import type { ContextIdentity, ContextLimits } from "@/lib/context-usage-types";

// Verified documentation snapshots, not a live model-discovery API. Exact IDs only:
// unknown aliases and proxy endpoints must not inherit an unrelated model's limit.
export function knownContextLimits(identity: ContextIdentity): ContextLimits {
  const endpoint = identity.baseURL.trim().replace(/\/+$/, "");
  const model = identity.model.trim();
  const result = (contextWindow: number, sourceURL: string, approximate = false): ContextLimits =>
    ({ contextWindow, outputReserve: 0, source: "official", sourceURL, verifiedAt: "2026-09-22", approximate });
  if (identity.provider === "openai" && ["", "https://api.openai.com/v1"].includes(endpoint)) {
    if (model === "gpt-5.6-luna") return result(1_050_000, "https://developers.openai.com/api/docs/models/gpt-5.6-luna");
    if (["gpt-4.1", "gpt-4.1-2025-04-14"].includes(model)) return result(1_047_576, "https://developers.openai.com/api/docs/models/gpt-4.1");
  }
  if (identity.provider === "deepseek" && ["", "https://api.deepseek.com", "https://api.deepseek.com/v1"].includes(endpoint)
    && ["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(model)) {
    // Docs publish rounded "1M"; use a labelled, conservative decimal budget.
    return result(1_000_000, "https://api-docs.deepseek.com/quick_start/pricing/", true);
  }
  if (identity.provider === "glm" && ["", "https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/coding/paas/v4", "https://api.z.ai/api/paas/v4", "https://api.z.ai/api/coding/paas/v4"].includes(endpoint)
    && ["glm-4.7", "glm-4.7-flash", "glm-4.7-flashx"].includes(model)) {
    return result(200_000, "https://docs.z.ai/guides/llm/glm-4.7", true);
  }
  return { contextWindow: null, outputReserve: 0, source: "unknown" };
}
