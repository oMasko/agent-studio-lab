export type CompactionSettings = {
  triggerPercent: number; targetPercent: number; summaryTokens: number; fallbackTokenBudget: number;
};
export const defaultCompactionSettings: CompactionSettings = {
  triggerPercent: 75, targetPercent: 50, summaryTokens: 2048, fallbackTokenBudget: 32000,
};
export type CompactionRecord = {
  operationId: string; status: "running" | "completed" | "failed" | "cancelled" | "skipped";
  summary: string; prefixLength: number; prefixHash: string;
  count: number; beforeTokens: number; afterTokens: number | null;
  summaryInputTokens: number; summaryOutputTokens: number;
  updatedAt: number; message: string;
};
