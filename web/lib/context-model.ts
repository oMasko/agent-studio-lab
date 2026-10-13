import { randomUUID } from "node:crypto";
import type { Model, ModelRequest } from "@openai/agents";
import { type ContextIdentity, type ContextSnapshot } from "@/lib/context-usage-types";
import { startContextSnapshot, finishContextSnapshot } from "@/lib/context-usage-store";
import { estimateModelRequest } from "@/lib/context-estimate";
import { compactModelRequest, type CompactionObserver } from "@/lib/context-compaction";
export { estimateModelRequest } from "@/lib/context-estimate";

export function observeContextModel(model: Model, sessionId: string, agentId: string, agentName: string, identity: ContextIdentity, onCompaction?: CompactionObserver): Model {
  function begin(request: ModelRequest): ContextSnapshot {
    const estimate = estimateModelRequest(request);
    const snapshot: ContextSnapshot = { requestId: randomUUID(), startedAt: Date.now(), updatedAt: Date.now(),
      agentId, agentName, model: identity.model, provider: identity.provider,
      status: "requesting", source: "estimate", inputTokens: estimate.total, outputTokens: null, estimate };
    snapshot.effectiveItems = Array.isArray(request.input) ? request.input.length : 1;
    startContextSnapshot(sessionId, identity, snapshot);
    return snapshot;
  }
  function complete(snapshot: ContextSnapshot, response?: { usage?: { inputTokens?: number; outputTokens?: number }; rawUsage?: Record<string, unknown> }) {
    const raw = response?.rawUsage;
    const input = raw?.input_tokens ?? raw?.prompt_tokens ?? response?.usage?.inputTokens;
    const output = raw?.output_tokens ?? raw?.completion_tokens ?? response?.usage?.outputTokens;
    // SDKs may normalize missing usage to 0; that is not a measured empty context.
    const measured = typeof input === "number" && Number.isFinite(input) && input > 0;
    finishContextSnapshot(sessionId, identity, { ...snapshot, updatedAt: Date.now(), status: response ? "completed" : "interrupted",
      source: measured ? "provider" : "estimate", inputTokens: measured ? input : snapshot.inputTokens,
      outputTokens: measured && typeof output === "number" && Number.isFinite(output) && output >= 0 ? output : null });
  }
  const prepare = (request: ModelRequest): ModelRequest => ({ ...request, modelSettings: { ...request.modelSettings, preserveRawUsage: true } });
  return {
    supportsPromptModelSelection: model.supportsPromptModelSelection,
    getRetryAdvice: model.getRetryAdvice?.bind(model),
    async getResponse(request) {
      request = await compactModelRequest(model, request, sessionId, agentId, agentName, identity, onCompaction);
      const snapshot = begin(request);
      try { const response = await model.getResponse(prepare(request)); complete(snapshot, response); return response; }
      catch (error) { complete(snapshot); throw error; }
    },
    async *getStreamedResponse(request) {
      request = await compactModelRequest(model, request, sessionId, agentId, agentName, identity, onCompaction);
      const snapshot = begin(request); let done = false;
      try {
        for await (const event of model.getStreamedResponse(prepare(request))) {
          if (event.type === "response_done") { complete(snapshot, event.response); done = true; }
          yield event;
        }
      } finally { if (!done) complete(snapshot); }
    },
  };
}
