import { z } from "zod";

export const chatPayload = z.object({
  requestId: z.string().uuid().optional(),
  sessionId: z.string(),
  message: z.string().trim().min(1, "消息不能为空。").max(12_000, "消息不能超过 12000 个字符。"),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().max(12_000),
  })).max(100).default([]),
  config: z.object({
    provider: z.enum(["openai", "deepseek", "glm", "custom"]),
    model: z.string().trim().min(1).max(200),
    subagentModel: z.string().trim().max(200),
    baseURL: z.string().trim().max(500),
    apiMode: z.enum(["responses", "chat_completions"]),
    apiKey: z.string().trim().max(500).optional(),
    webSearchEnabled: z.boolean().default(true),
    mainMaxTurns: z.number().int().min(1).max(500).nullable(),
    subagentMaxTurns: z.number().int().min(1).max(500).nullable(),
  }),
});
