export type ProviderName = "openai" | "deepseek" | "glm" | "custom";
export type ApiMode = "responses" | "chat_completions";
export type AgentScope = "main" | "subagent" | "both";

export const DEFAULT_MAIN_INSTRUCTIONS =
  "你是一个通用 AI 助手。准确理解用户目标，提供清晰、直接、诚实的帮助。" +
  "信息不足时询问必要问题；不确定时明确说明，不编造事实。" +
  "简单任务直接回答。对于复杂、可独立分析或适合拆分的任务，可以调用 delegate_task 委派给 Subagent。" +
  "委派时提供完整目标、必要上下文、约束和期望输出。收到 Subagent 结果后自行检查、整合并给出最终答案。" +
  "默认使用与用户相同的语言回答。";

export const DEFAULT_SUBAGENT_INSTRUCTIONS =
  "你是主 Agent 的通用任务 Subagent。专注完成主 Agent 委派的任务，分析关键事实、约束和可能遗漏。" +
  "只返回可供主 Agent 使用的清晰结果；不要假装与最终用户直接对话。不确定时明确说明，不编造事实。";

export type EditableConfig = {
  provider: ProviderName;
  model: string;
  subagentModel: string;
  baseURL: string;
  apiMode: ApiMode;
  apiKey: string;
  webSearchEnabled: boolean;
  mainMaxTurns: number | null;
  subagentMaxTurns: number | null;
};

export type ProviderInfo = {
  label: string;
  defaultModel: string;
  defaultBaseURL: string;
  defaultApiMode: ApiMode;
  hasServerApiKey: boolean;
};

export type ConfigResponse = {
  config: Omit<EditableConfig, "apiKey"> & { hasServerApiKey: boolean; subagent: string };
  providers: Record<ProviderName, ProviderInfo>;
};
