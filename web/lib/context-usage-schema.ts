import { z } from "zod";
export const contextIdentitySchema = z.object({
  provider: z.enum(["openai", "deepseek", "glm", "custom"]),
  model: z.string().trim().min(1).max(256), baseURL: z.string().max(2048).default(""),
  apiMode: z.enum(["responses", "chat_completions"]),
});
export const contextLimitsSchema = z.object({
  identity: contextIdentitySchema,
  limits: z.object({ contextWindow: z.number().int().min(1).max(100_000_000).nullable(), outputReserve: z.number().int().min(0).max(100_000_000) }),
});
