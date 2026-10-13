import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import ts from "typescript";
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = mkdtempSync(join(tmpdir(), "agent-compaction-test-"));
mkdirSync(join(fixture, "web")); process.chdir(join(fixture, "web"));
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
const { compactModelRequest, safeCompactionCuts } = await import("@/lib/context-compaction");
const { observeContextModel } = await import("@/lib/context-model");
const { saveContextLimits } = await import("@/lib/context-usage-store");
const { getCompaction, clearCompactions, saveCompactionSettings } = await import("@/lib/compaction-store");
const { saveSessionContext } = await import("@/lib/memory-store");
const { SqliteAgentSession } = await import("@/lib/persistent-session");
const { agentDatabase } = await import("@/lib/database");
const { Agent, Runner, RunState, Usage, tool } = await import("@openai/agents");
const { z } = await import("zod");
const identity = { provider: "custom", model: "fixture", baseURL: "http://localhost:1", apiMode: "responses" };
saveContextLimits(identity, { contextWindow: 8000, outputReserve: 800 });
const user = (content) => ({ type: "message", role: "user", content });
const assistant = (text) => ({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
const history = Array.from({ length: 36 }, (_, i) => i % 2 ? assistant(`result${i} ${"x".repeat(950)}`) : user(`task${i} ${"y".repeat(950)}`));
history.push(user("CURRENT_GOAL: finish analysis, do not write files"));
const request = { input: history, systemInstructions: "SYSTEM_RULE: Never bypass approval.", tools: [], handoffs: [], outputType: "text", modelSettings: {}, tracing: { includeData: false } };
const responses = (text) => ({ output: [assistant(text)], usage: new Usage({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }) });
let summaryCalls = [];
const events = [];
const model = {
  async getResponse(r) {
    summaryCalls.push(r);
    assert.deepEqual(r.tools, []); assert.deepEqual(r.handoffs, []);
    assert.equal(r.outputType, "text"); assert.equal(r.previousResponseId, undefined);
    return responses(`CHECKPOINT_${summaryCalls.length}: goal, constraints, evidence, remaining tasks.`);
  },
};
const run = (r = request, id = "A", m = model, agentId = "main") => compactModelRequest(m, r, id, agentId, "Main", identity, (event) => events.push(event));
const before = JSON.stringify(request);
const compacted = await run();
assert.equal(JSON.stringify(request), before, "no mutation of SDK input / RunState");
assert.ok(compacted.input.length < history.length);
assert.ok(compacted.input.some((item) => item.content === history.at(-1).content), "latest user goal remains verbatim");
assert.equal(compacted.systemInstructions, request.systemInstructions);
assert.equal(getCompaction("A", "main", identity).count, 1);
assert.equal(getCompaction("A", "main", identity).status, "completed");
const calls = summaryCalls.length;
await run();
assert.equal(summaryCalls.length, calls, "identical input reuses durable checkpoint");
assert.equal(getCompaction("B", "main", identity), null);
assert.equal(getCompaction("A", "expert", identity), null);
assert.equal(getCompaction("A", "main", { ...identity, model: "other" }), null);
// Growing the same run requires merging the old summary with newly evicted items.
const grown = { ...request, input: [...history, ...Array.from({ length: 28 }, (_, i) => assistant(`NEW_${i} ${"z".repeat(1000)}`))] };
await run(grown);
assert.equal(getCompaction("A", "main", identity).count, 2);
assert.ok(summaryCalls[calls].input[0].content.includes("CHECKPOINT_"), "rolling summary consumes previous summary");
assert.ok(summaryCalls.slice(calls).some((r) => r.input[0].content.includes("NEW_")));
assert.ok(events.some((e) => e.phase === "start") && events.some((e) => e.phase === "end"));
// A divergent delegation input must not inherit another task's summary.
const divergent = { ...request, input: history.map((item) => JSON.parse(JSON.stringify(item).replaceAll("task", "different"))) };
const start = summaryCalls.length; await run(divergent);
assert.equal(JSON.parse(summaryCalls[start].input[0].content).previousSummary, "");

const call = (id) => ({ type: "function_call", name: "read", callId: id, arguments: "{}" });
const result = (id) => ({ type: "function_call_result", name: "read", callId: id, output: "data" });
assert.deepEqual(safeCompactionCuts([user("hi"), call("1"), call("2"), result("2"), result("1"), assistant("done")]), [1, 5, 6]);
assert.deepEqual(safeCompactionCuts([call("1"), result("orphan")]), []);
assert.deepEqual(safeCompactionCuts([user("hi"), call("pending")]), [1]);
assert.deepEqual(safeCompactionCuts([{ type: "opaque" }, user("hi")]), []);

saveSessionContext("off", { autoCompact: false });
assert.equal(await run(request, "off"), request);
assert.equal(await run({ ...request, previousResponseId: "server-state" }, "remote").then((r) => r.previousResponseId), "server-state");
const failure = { async getResponse() { throw new Error("upstream unavailable"); } };
await assert.rejects(run(request, "fail", failure), /压缩失败/);
assert.equal(getCompaction("fail", "main", identity).prefixLength, 0);
assert.equal(getCompaction("fail", "main", identity).status, "failed");
const controller = new AbortController();
await assert.rejects(run({ ...request, signal: controller.signal }, "cancel", { async getResponse() { controller.abort(new Error("user cancelled")); return responses("unused"); } }), /user cancelled/);
assert.equal(getCompaction("cancel", "main", identity).status, "cancelled");
assert.equal(getCompaction("cancel", "main", identity).prefixLength, 0);
await assert.rejects(run(request, "cleared", { async getResponse() { clearCompactions("cleared"); return responses("short"); } }), /会话已清空/);
assert.equal(getCompaction("cleared", "main", identity), null);
// Oversized current user messages are never truncated to fake a fit.
await assert.rejects(run({ ...request, input: [user("q".repeat(40000))] }, "huge"), /无法安全压缩/);
assert.equal(getCompaction("huge", "main", identity).status, "skipped");
await assert.rejects(run({ ...request, input: history }, "empty", { async getResponse() { return responses(""); } }), /压缩失败/);
assert.throws(() => saveCompactionSettings("A", { triggerPercent: 60, targetPercent: 59 }));

// Real SDK run: a tool result grows context mid-turn; the next model call is compacted.
let mainCalls = 0; let receivedFinal;
const fake = {
  async getResponse(r) {
    if (r.systemInstructions?.startsWith("你是历史压缩器")) return model.getResponse(r);
    mainCalls++;
    if (mainCalls === 1) return { ...responses(""), output: [{ type: "function_call", name: "large_read", callId: "fixture_call", arguments: "{}" }] };
    receivedFinal = r;
    return responses("finished");
  },
};
const wrapped = observeContextModel(fake, "sdk", "main", "Main", identity);
const agent = new Agent({ name: "Main", model: wrapped, tools: [tool({ name: "large_read", description: "fixture", parameters: z.object({}), execute: () => "EVIDENCE ".repeat(4000) })] });
const runner = new Runner({ tracingDisabled: true });
// Keep a small assistant message after the large tool result via a preceding history:
// if the final complete tool group itself cannot fit, safely fail (never orphan it).
await assert.rejects(runner.run(agent, "read fixture", { maxTurns: 3 }), /无法安全压缩/);
assert.equal(mainCalls, 1, "must not send an oversized or broken tool group to provider");
let loopCalls = 0;
const loopModel = {
  async getResponse(r) {
    if (r.systemInstructions?.startsWith("你是历史压缩器")) return model.getResponse(r);
    loopCalls++;
    if (loopCalls < 6) return { ...responses(""), output: [{ type: "function_call", name: "bounded_read", callId: `bounded_${loopCalls}`, arguments: "{}" }] };
    assert.ok(r.input.some((item) => typeof item.content === "string" && item.content.includes("CHECKPOINT_")));
    assert.ok(r.input.some((item) => typeof item.content === "string" && item.content === "CURRENT_LOOP_GOAL"));
    return responses("loop finished");
  },
};
const loopAgent = new Agent({ name: "Main", model: observeContextModel(loopModel, "loop", "main", "Main", identity),
  tools: [tool({ name: "bounded_read", description: "fixture", parameters: z.object({}), execute: () => "e".repeat(7000) })] });
assert.equal((await runner.run(loopAgent, "CURRENT_LOOP_GOAL", { maxTurns: 8 })).finalOutput, "loop finished");
assert.ok(getCompaction("loop", "main", identity).count >= 1, "compaction runs inside a single SDK tool loop");
let streamedInput;
const streamWrapper = observeContextModel({ ...model, async *getStreamedResponse(r) { streamedInput = r.input; yield { type: "response_done", response: responses("stream complete") }; } }, "stream", "main", "Main", identity);
for await (const event of streamWrapper.getStreamedResponse(request)) assert.equal(event.type, "response_done");
assert.ok(streamedInput.length < history.length);
const session = new SqliteAgentSession("sdk2");
await session.addItems(history.slice(0, -1));
const simple = new Agent({ name: "Main", model: observeContextModel({ async getResponse(r) { if (r.systemInstructions?.startsWith("你是历史压缩器")) return model.getResponse(r); receivedFinal = r; return responses("finished"); } }, "sdk2", "main", "Main", identity) });
const completed = await runner.run(simple, "continue", { session });
assert.equal(completed.finalOutput, "finished");
assert.ok(receivedFinal.input.length < history.length);
assert.ok((await session.getItems()).length >= history.length);
await RunState.fromString(simple, completed.state.toString());
assert.equal(getCompaction("sdk2", "main", identity).status, "completed");
await session.clearSession();
assert.equal(getCompaction("sdk2", "main", identity), null);
agentDatabase().close();
console.log("PASS: token trigger, rolling checkpoint, raw history, reuse/isolation, tool pairs, disabled/remote, failure/cancel/clear, oversized latest input, real SDK loop and RunState.");
console.log(`Isolated fixtures: ${fixture}`);
