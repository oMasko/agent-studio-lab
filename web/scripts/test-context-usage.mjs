import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import ts from "typescript";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = mkdtempSync(join(tmpdir(), "agent-context-test-"));
mkdirSync(join(fixture, "web"));
process.chdir(join(fixture, "web"));
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/server") return next("next/server.js", context);
    if (specifier.startsWith("@/")) return { url: pathToFileURL(resolve(sourceRoot, `${specifier.slice(2)}.ts`)).href, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(pathToFileURL(sourceRoot).href) && url.endsWith(".ts")) return { format: "module", source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, shortCircuit: true };
    return next(url, context);
  },
});
const store = await import("@/lib/context-usage-store");
const { observeContextModel } = await import("@/lib/context-model");
const { contextBudget, estimateContextTokens } = await import("@/lib/context-usage-types");
const { SqliteAgentSession, previewSessionContext } = await import("@/lib/persistent-session");
const { saveSessionContext, getSessionContext } = await import("@/lib/memory-store");
const { agentDatabase } = await import("@/lib/database");
const { Agent, Runner, RunState, Usage } = await import("@openai/agents");
const identity = { provider: "custom", model: "fixture", baseURL: "http://localhost:1", apiMode: "responses" };
const request = { systemInstructions: "You are helpful.", input: [{ role: "user", content: "hello" }], tools: [], handoffs: [], outputType: { type: "text" }, modelSettings: {} };
let inputTokens = 1000;
let omitUsage = false;
const response = () => ({ usage: new Usage({ requests: 1, inputTokens: omitUsage ? 0 : inputTokens, outputTokens: omitUsage ? 0 : 100, totalTokens: omitUsage ? 0 : inputTokens + 100 }), output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "fixture answer" }] }] });
const model = {
  async getResponse(r) { assert.equal(r.modelSettings.preserveRawUsage, true); return response(); },
  async *getStreamedResponse() { yield { type: "output_text_delta", delta: "fixture answer" }; yield { type: "response_done", response: response() }; },
};
const wrapped = observeContextModel(model, "A", "main", "Main", identity);
await wrapped.getResponse(request);
assert.equal(store.getContextSnapshot("A", "main", identity).inputTokens, 1000);
inputTokens = 600;
for await (const ignored of wrapped.getStreamedResponse(request)) { void ignored; }
const measured = store.getContextSnapshot("A", "main", identity);
assert.equal(measured.inputTokens, 600, "latest request, not cumulative usage");
assert.equal(contextBudget(measured.inputTokens, measured.outputTokens, { contextWindow: 1000, outputReserve: 100 }).percent, 70);
assert.equal(contextBudget(10, null, { contextWindow: null, outputReserve: 0 }).percent, null);
assert.equal(estimateContextTokens([]), 0);
assert.equal(store.getContextSnapshot("B", "main", identity), null);
assert.equal(store.getContextSnapshot("A", "expert", identity), null);
assert.equal(store.getContextSnapshot("A", "main", { ...identity, model: "other" }), null);
assert.equal(store.getContextSnapshot("A", "main", { ...identity, baseURL: "http://localhost:2" }), null);
assert.equal(store.getContextSnapshot("A", "main", { ...identity, apiMode: "chat_completions" }), null);
omitUsage = true;
await wrapped.getResponse(request);
assert.equal(store.getContextSnapshot("A", "main", identity).source, "estimate");
omitUsage = false;
const partial = wrapped.getStreamedResponse(request);
await partial.next(); await partial.return();
assert.equal(store.getContextSnapshot("A", "main", identity).status, "interrupted");
const rawModel = observeContextModel({ ...model, async getResponse() { return { ...response(), rawUsage: { prompt_tokens: 2000, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 200 }, prompt_cache_hit_tokens: 1900 } }; } }, "A", "main", "Main", identity);
await rawModel.getResponse(request);
const raw = store.getContextSnapshot("A", "main", identity);
assert.equal(contextBudget(raw.inputTokens, raw.outputTokens, { contextWindow: 10000, outputReserve: 0 }).used, 2300, "do not subtract cache hits or count reasoning twice");
store.startContextSnapshot("A", identity, { ...raw, requestId: "new" });
store.finishContextSnapshot("A", identity, { ...raw, inputTokens: 9999 });
assert.equal(store.getContextSnapshot("A", "main", identity).requestId, "new");
store.saveContextLimits(identity, { contextWindow: 8000, outputReserve: 1000 });
assert.equal(store.getContextLimits(identity).contextWindow, 8000);
assert.throws(() => store.saveContextLimits(identity, { contextWindow: 100, outputReserve: 100 }));
assert.equal(store.getContextLimits({ provider: "openai", model: "gpt-5.6-luna", baseURL: "", apiMode: "responses" }).contextWindow, 1050000);
assert.equal(store.getContextLimits({ provider: "deepseek", model: "deepseek-flash", baseURL: "https://api.deepseek.com", apiMode: "responses" }).contextWindow, 1000000);
assert.equal(store.getContextLimits({ provider: "glm", model: "glm-4.7", baseURL: "https://open.bigmodel.cn/api/paas/v4/", apiMode: "chat_completions" }).contextWindow, 200000);
assert.equal(store.getContextLimits({ ...identity, provider: "openai", model: "gpt-5.6-luna" }).contextWindow, null, "do not assume proxy limits");
assert.equal(store.getContextLimits({ ...identity, model: "unknown" }).source, "unknown");
store.saveContextLimits(identity, { contextWindow: null, outputReserve: 0 });
assert.equal(store.getContextLimits(identity).contextWindow, null);

// Exercise the real SDK Runner and state serializer, without API calls.
const agent = new Agent({ name: "Main", instructions: "test", model: wrapped });
const runner = new Runner({ tracingDisabled: true });
const result = await runner.run(agent, "hello");
assert.equal(result.finalOutput, "fixture answer");
const restored = await RunState.fromString(agent, result.state.toString());
assert.ok(restored);
const session = new SqliteAgentSession("A");
await session.addItems(Array.from({ length: 15 }, (_, i) => ({ role: "user", content: `history ${i}` })));
saveSessionContext("A", { recentItemLimit: 10 });
const preview = previewSessionContext("A");
assert.equal(preview.storedItems, 15);
assert.equal(preview.compacted, false, "Session retains raw history; model boundary owns compaction");
assert.equal(preview.items.length, 15);
assert.equal(getSessionContext("A").summary, "", "preview must not persist a summary");
assert.deepEqual(await session.getItems(), preview.items);
await session.clearSession();
assert.equal(store.getContextSnapshot("A", "main", identity), null);
store.finishContextSnapshot("A", identity, raw);
assert.equal(store.getContextSnapshot("A", "main", identity), null, "late completion must not resurrect cleared state");
assert.equal(previewSessionContext("A").storedItems, 0);
const { POST } = await import("../app/api/context/[sessionId]/usage/route.ts");
const { PUT } = await import("../app/api/context/limits/route.ts");
let api = await POST(new Request("http://localhost/api/context/A/usage", { method: "POST", body: JSON.stringify(identity) }), { params: Promise.resolve({ sessionId: "A" }) });
assert.equal(api.status, 200);
let body = await api.json();
assert.equal(body.sessionId, "A");
assert.equal(body.history.estimatedTokens, 0);
assert.equal(body.agents[0].snapshot, null);
api = await PUT(new Request("http://localhost/api/context/limits", { method: "PUT", body: JSON.stringify({ identity, limits: { contextWindow: 8000, outputReserve: 100 } }) }));
assert.equal(api.status, 200);
api = await PUT(new Request("http://localhost/api/context/limits", { method: "PUT", body: JSON.stringify({ identity, limits: { contextWindow: -1, outputReserve: 100 } }) }));
assert.equal(api.status, 422);
agentDatabase().close();
console.log("PASS: per-request usage, streaming, cancellation, cache/reasoning accounting, isolation, stale results, model limits, SDK Runner/RunState, compaction and clear.");
console.log(`Isolated test artifacts: ${fixture}`);
