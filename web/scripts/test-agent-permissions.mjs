import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import ts from "typescript";

// Use a fresh project/state directory: never read or modify real Agent settings.
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = mkdtempSync(join(tmpdir(), "agent-permissions-test-"));
mkdirSync(join(fixture, "web"));
process.chdir(join(fixture, "web"));
process.env.ALLOW_STDIO_MCP = "true";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) return { url: pathToFileURL(resolve(sourceRoot, `${specifier.slice(2)}.ts`)).href, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(pathToFileURL(sourceRoot).href) && url.endsWith(".ts")) {
      return { format: "module", source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, shortCircuit: true };
    }
    return next(url, context);
  },
});

const { emptyPermissions, permitsMcp, agentPermissionsSchema } = await import("@/lib/agent-permissions");
const store = await import("@/lib/agent-definition-store");
const { agentDatabase } = await import("@/lib/database");
const { createRuntime, inspectManagedMcpServer } = await import("@/lib/agent");
const { createMcpServer } = await import("@/lib/mcp-store");
const { getSafetySettings, saveSafetySettings } = await import("@/lib/safety-store");
const { RunContext } = await import("@openai/agents");

assert.equal(agentPermissionsSchema.safeParse({ tools: ["arbitrary_shell"], skills: [], mcp: [] }).success, false);
assert.equal(agentPermissionsSchema.safeParse({ tools: [], skills: [], mcp: [{ serverId: "x", tools: "*" }] }).success, false);
const base = { name: "isolated", description: "test", instructions: "test", model: "", collaboration: "both", coreTools: true, webTools: true, workspaceAccess: "write", skillsEnabled: true, mcpEnabled: true, maxTurns: 5, enabled: true, sortOrder: 0 };
const denied = store.createAgentDefinition(base);
assert.deepEqual(denied.permissions, emptyPermissions(), "missing permissions must not fall back to legacy flags");

// A real local stdio MCP protocol fixture, with no network or real write operation.
const serverScript = join(fixture, "mcp-fixture.mjs");
writeFileSync(serverScript, `import { createInterface } from 'node:readline';
const lines = createInterface({input:process.stdin});
lines.on('line', line => {
 const m=JSON.parse(line); if(m.id===undefined)return;
 let result={};
 if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
 if(m.method==='tools/list')result={tools:['read_value','write_value','future_tool'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{},required:[],additionalProperties:false}}))};
 if(m.method==='tools/call')result={content:[{type:'text',text:'fixture-result'}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`);
const server = await createMcpServer({ title: "fixture", displayName: "fixture", description: "", preset: "custom", enabled: true, scope: "subagent", trusted: true, config: { type: "stdio", command: process.execPath, args: [serverScript] } });
const discovered = await inspectManagedMcpServer(server, true);
await createMcpServer({ title: "unused", displayName: "unused", description: "", preset: "custom", enabled: true, scope: "subagent", trusted: true, config: { type: "stdio", command: join(fixture, "does-not-exist") } });
assert.equal(discovered.length, 3);
const readTool = discovered.find((item) => item.name.includes("read_value")).name;
const grant = { tools: ["calculate", "workspace_read_file"], skills: ["allowed-skill"], mcp: [{ serverId: server.id, tools: [readTool] }] };
assert.equal(permitsMcp(grant, "another-server", readTool), false);
assert.equal(permitsMcp(grant, server.id, "future_tool"), false);
store.updateAgentDefinition(denied.id, { ...denied, permissions: grant });
assert.deepEqual(store.getAgentDefinition(denied.id).permissions, grant);

for (const name of ["allowed-skill", "hidden-skill"]) {
  const dir = join(fixture, ".agents", "skills", name); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture skill\n---\n${name} content`);
}
writeFileSync(join(fixture, ".agent-studio", "skills-state.json"), JSON.stringify({ "allowed-skill": { enabled: true, scope: "both" }, "hidden-skill": { enabled: true, scope: "both" } }));
const config = { provider: "custom", model: "test", subagentModel: "test", apiKey: "local-test-only", baseURL: "http://127.0.0.1:1", apiMode: "chat_completions", webSearchEnabled: false, mainMaxTurns: 5, subagentMaxTurns: 5 };
let runtime = await createRuntime(config);
try {
  const expert = runtime.subagents.find((item) => item.name === "isolated");
  assert.deepEqual(expert.tools.map((item) => item.name).sort(), ["calculate", "workspace_read_file", "load_skill", "read_skill_file", readTool].sort());
  assert.equal(runtime.mainAgent.handoffs[0], expert, "Handoff and Tool delegation must share the constrained expert");
  assert.ok(runtime.mainAgent.tools.some((item) => item.name.startsWith("delegate_")));
  assert.ok(expert.instructions.includes("allowed-skill"));
  assert.ok(!expert.instructions.includes("hidden-skill"));
  const load = expert.tools.find((item) => item.name === "load_skill");
  assert.match(await load.invoke(new RunContext(), JSON.stringify({ name: "hidden-skill" })), /未授权/);
  assert.match(await load.invoke(new RunContext(), JSON.stringify({ name: "allowed-skill" })), /allowed-skill content/);
  assert.match(JSON.stringify(await expert.tools.find((item) => item.name === readTool).invoke(new RunContext(), "{}")), /fixture-result/);
} finally { await runtime.close(); }

// Host settings remain an upper bound, even when an expert selects a tool.
const safety = await getSafetySettings();
await saveSafetySettings({ ...safety, workspace: { ...safety.workspace, readEnabled: false } });
runtime = await createRuntime(config);
try { assert.ok(!runtime.subagents[0].tools.some((item) => item.name === "workspace_read_file")); }
finally { await runtime.close(); }

store.updateAgentDefinition(denied.id, { ...denied, permissions: emptyPermissions() });
runtime = await createRuntime(config);
try { assert.equal(runtime.subagents[0].tools.length, 0); }
finally { await runtime.close(); }

// Legacy migration is a one-time snapshot; later assets never expand it.
agentDatabase().prepare("UPDATE agent_definitions SET permissions_json=NULL, core_tools=1, skills_enabled=1, mcp_enabled=1 WHERE id=?").run(denied.id);
store.migrateAgentPermissions(["allowed-skill"], [{ id: server.id, tools: [readTool] }]);
const snapshot = store.getAgentDefinition(denied.id).permissions;
store.migrateAgentPermissions(["allowed-skill", "new-skill"], [{ id: server.id, tools: discovered.map((item) => item.name) }]);
assert.deepEqual(store.getAgentDefinition(denied.id).permissions, snapshot);
agentDatabase().close();
console.log("PASS: default deny, validation, storage, MCP server/tool isolation, Skill argument enforcement, actual runtime assembly, Handoff, global gates, empty grants, migration snapshot.");
console.log(`Isolated test artifacts: ${fixture}`);
