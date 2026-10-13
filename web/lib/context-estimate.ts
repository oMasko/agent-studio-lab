import type { ModelRequest } from "@openai/agents";
import { estimateContextTokens } from "@/lib/context-usage-types";
export function estimateModelRequest(request: ModelRequest) {
  const instructions = estimateContextTokens(request.systemInstructions ?? "");
  const messages = estimateContextTokens(request.input);
  const tools = estimateContextTokens({ tools: request.tools, handoffs: request.handoffs, outputType: request.outputType });
  return { instructions, messages, tools, total: instructions + messages + tools,
    partial: Boolean(request.previousResponseId || request.conversationId || request.prompt) };
}
