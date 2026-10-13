import { resolve } from "node:path";

import {
  Agent,
  getAllMcpTools,
  MCPServerSSE,
  MCPServerStdio,
  MCPServerStreamableHttp,
  NoopTrace,
  OpenAIProvider,
  Runner,
  ToolGuardrailFunctionOutputFactory,
  webSearchTool,
  defineToolInputGuardrail,
  tool,
  withTrace,
  type AgentInputItem,
  type FunctionTool,
  type MCPServer,
  type RunItem,
  type Session,
  type Tool,
  type ToolInputGuardrailDefinition,
} from "@openai/agents";
import { config as loadDotenv } from "dotenv";
import OpenAI from "openai";
import { z } from "zod";

import { type ApiMode, type EditableConfig, type ProviderName } from "@/lib/config-types";
import { listAgentDefinitions, migrateAgentPermissions } from "@/lib/agent-definition-store";
import { permitsMcp, selectAllowedTools } from "@/lib/agent-permissions";
import { listBoundMcpTools } from "@/lib/mcp-tool-list";
import { createDefaultCapabilityRegistry, enabledCapabilityTools } from "@/lib/core-capabilities";
import { listMcpServers, type ManagedMcpServer } from "@/lib/mcp-store";
import { memoryInstructions } from "@/lib/memory-store";
import { getActivePrompt } from "@/lib/prompt-store";
import {
  evaluateToolPolicy,
  findBlockedTerm,
  getSafetySettings,
  type SafetySettings,
} from "@/lib/safety-store";
import { findSessionApproval, type SessionApprovalGrant } from "@/lib/session-approvals";
import { listInstalledSkills, loadSkillForAgent, readSkillFile, type InstalledSkill } from "@/lib/skills";
import { SqliteAgentSession } from "@/lib/persistent-session";
import { observeContextModel } from "@/lib/context-model";
import type { CompactionObserver } from "@/lib/context-compaction";
import type { ManagedTool, ToolSecurityProfile } from "@/lib/tool-capabilities";
import { createWorkspaceTools } from "@/lib/workspace-tools";

type ProviderPreset = {
  label: string;
  apiKeyEnv: string;
  defaultModel?: string;
  defaultBaseURL?: string;
  defaultApiMode: ApiMode;
  modelEnv: string;
  baseURLEnv: string;
};

export type ClientRuntimeConfig = EditableConfig;

export type PublicRuntimeConfig = Omit<ClientRuntimeConfig, "apiKey"> & {
  hasServerApiKey: boolean;
  subagent: string;
};

export type PublicConfigResponse = {
  config: PublicRuntimeConfig;
  providers: Record<ProviderName, {
    label: string;
    defaultModel: string;
    defaultBaseURL: string;
    defaultApiMode: ApiMode;
    hasServerApiKey: boolean;
  }>;
};

export type AgentRuntime = {
  provider: ProviderName;
  mainAgent: Agent;
  subagent?: Agent;
  subagents: Agent[];
  runner: Runner;
  toolProfiles: Record<string, ToolSecurityProfile>;
  close: () => Promise<void>;
};

type RuntimeApprovalContext = {
  sessionId: string;
  onCompaction?: CompactionObserver;
  onSessionApprovalUsed?: (grant: SessionApprovalGrant) => void;
};

export async function withSdkTraceContext<T>(provider: ProviderName, callback: () => Promise<T>): Promise<T> {
  if (provider === "openai") return callback();
  return withTrace(new NoopTrace(), async () => callback());
}

export class AgentConfigError extends Error {}

const presets: Record<ProviderName, ProviderPreset> = {
  openai: {
    label: "OpenAI",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-5.6-luna",
    defaultApiMode: "responses",
    modelEnv: "OPENAI_MODEL",
    baseURLEnv: "OPENAI_BASE_URL",
  },
  deepseek: {
    label: "DeepSeek",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-flash",
    defaultBaseURL: "https://api.deepseek.com",
    defaultApiMode: "responses",
    modelEnv: "DEEPSEEK_MODEL",
    baseURLEnv: "DEEPSEEK_BASE_URL",
  },
  glm: {
    label: "智谱 GLM",
    apiKeyEnv: "ZAI_API_KEY",
    defaultModel: "glm-4.7",
    defaultBaseURL: "https://open.bigmodel.cn/api/paas/v4/",
    defaultApiMode: "chat_completions",
    modelEnv: "GLM_MODEL",
    baseURLEnv: "GLM_BASE_URL",
  },
  custom: {
    label: "自定义兼容服务",
    apiKeyEnv: "MODEL_API_KEY",
    defaultApiMode: "chat_completions",
    modelEnv: "MODEL_NAME",
    baseURLEnv: "MODEL_BASE_URL",
  },
};

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function webSearchSources(response: unknown): Array<{ title: string; url: string }> {
  if (!response || typeof response !== "object") return [];
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) return [];
  const sources = new Map<string, string>();
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const annotations = (part as { annotations?: unknown }).annotations;
      if (!Array.isArray(annotations)) continue;
      for (const annotation of annotations) {
        if (!annotation || typeof annotation !== "object") continue;
        const value = annotation as { type?: unknown; url?: unknown; title?: unknown };
        if (value.type !== "url_citation" || typeof value.url !== "string") continue;
        sources.set(value.url, typeof value.title === "string" && value.title.trim() ? value.title : value.url);
      }
    }
  }
  return [...sources].slice(0, 12).map(([url, title]) => ({ title, url }));
}

function createWebSearchBridgeTool(apiKey: string, model: string): Tool {
  const client = new OpenAI({ apiKey });
  return tool({
    name: "web_search",
    description: "搜索实时公开网页信息。适用于最新动态、价格、排名、新闻、产品变化或需要来源链接的事实；不要用于本地文件。",
    parameters: z.object({
      query: z.string().trim().min(2).max(500).describe("清晰、具体的网页搜索查询"),
    }),
    async execute({ query }) {
      const response = await client.responses.create({
        model,
        tools: [{ type: "web_search", search_context_size: "medium" }],
        tool_choice: "required",
        input: `搜索以下问题并给出简洁、基于来源的结果。不要猜测；如果结果不足请明确说明。\n\n查询：${query}`,
      });
      return JSON.stringify({
        answer: response.output_text,
        sources: webSearchSources(response),
      });
    },
  });
}

function loadEnvironment(): void {
  loadDotenv({ path: resolve(process.cwd(), "..", ".env"), override: false, quiet: true });
  loadDotenv({ path: resolve(process.cwd(), ".env.local"), override: true, quiet: true });
}

function providerFromEnv(): ProviderName {
  const name = readEnv("MODEL_PROVIDER") ?? "openai";
  return name in presets ? name as ProviderName : "openai";
}

function resolvedProviderDefaults(provider: ProviderName) {
  const preset = presets[provider];
  return {
    label: preset.label,
    defaultModel: readEnv(preset.modelEnv) ?? preset.defaultModel ?? "",
    defaultBaseURL: readEnv(preset.baseURLEnv) ?? preset.defaultBaseURL ?? "",
    defaultApiMode: preset.defaultApiMode,
    hasServerApiKey: Boolean(readEnv(preset.apiKeyEnv)),
  };
}

export function getPublicConfig(): PublicConfigResponse {
  loadEnvironment();
  const provider = providerFromEnv();
  const defaults = resolvedProviderDefaults(provider);
  const configuredMode = readEnv("MODEL_API_MODE");
  const apiMode = configuredMode === "responses" || configuredMode === "chat_completions"
    ? configuredMode
    : defaults.defaultApiMode;
  const model = defaults.defaultModel;

  return {
    config: {
      provider,
      model,
      subagentModel: readEnv("SUBAGENT_MODEL") ?? model,
      baseURL: defaults.defaultBaseURL,
      apiMode,
      hasServerApiKey: defaults.hasServerApiKey,
      webSearchEnabled: readEnv("WEB_SEARCH_ENABLED") !== "false",
      mainMaxTurns: 30,
      subagentMaxTurns: 15,
      subagent: "通用任务执行器",
    },
    providers: {
      openai: resolvedProviderDefaults("openai"),
      deepseek: resolvedProviderDefaults("deepseek"),
      glm: resolvedProviderDefaults("glm"),
      custom: resolvedProviderDefaults("custom"),
    },
  };
}

function instructionsWithSkillCatalog(base: string, skills: InstalledSkill[]): string {
  const runtime = "# Workspace Runtime\n工作区工具会执行真实操作。读取前先定位文件；修改前先读取上下文；只做完成用户任务所需的最小修改。文件修改和命令执行会暂停等待用户审批，绝不能把未执行或被拒绝的操作描述为成功。Skill 只提供工作流，不会自动授予额外权限。";
  if (skills.length === 0) return `${base.trim()}\n\n${runtime}`;
  const catalog = skills.map((skill) => {
    const requirements = skill.requiredCapabilities.length ? ` [requires: ${skill.requiredCapabilities.join(", ")}]` : "";
    return `- ${skill.name}${requirements}: ${skill.description}`;
  }).join("\n");
  return `${base.trim()}\n\n${runtime}\n\n# Available Skills\n以下 Skills 已安装并启用。仅当任务与 description 匹配时调用 load_skill 加载完整 SKILL.md；不要猜测未加载的内容。Skill 声明的 requires 只是能力需求，不是授权。\n${catalog}`;
}

function createSkillTools(skills: InstalledSkill[]) {
  if (skills.length === 0) return [];
  const allowed = new Set(skills.map((skill) => skill.name));
  const loadSkillTool = tool({
    name: "load_skill",
    description: "加载一个已启用 Skill 的完整 SKILL.md、文件清单和渐进式使用说明。先根据 Available Skills 的描述选择，再调用此工具。",
    parameters: z.object({ name: z.string().describe("Available Skills 中的准确 Skill 名称") }),
    async execute({ name }) {
      if (!allowed.has(name)) return `Skill ${JSON.stringify(name)} 未授权给当前 Agent。`;
      return JSON.stringify(await loadSkillForAgent(name));
    },
  });
  const readSkillFileTool = tool({
    name: "read_skill_file",
    description: "按 SKILL.md 的路由读取 Skill 项目中的文本 reference、script 源码或文本 asset。不会执行脚本，也不能读取二进制资源。",
    parameters: z.object({
      name: z.string().describe("已加载的 Skill 名称"),
      path: z.string().describe("Skill 目录内的相对文件路径"),
    }),
    async execute({ name, path }) {
      if (!allowed.has(name)) return `Skill ${JSON.stringify(name)} 未授权给当前 Agent。`;
      return readSkillFile(name, path);
    },
  });
  return [loadSkillTool, readSkillFileTool];
}

function parseToolArguments(value: string | undefined): unknown {
  if (!value) return {};
  try { return JSON.parse(value); } catch { return value; }
}

function makeToolInputGuardrail(
  settings: SafetySettings,
  profile: ToolSecurityProfile,
  originalNeedsApproval: FunctionTool["needsApproval"],
): ToolInputGuardrailDefinition {
  return defineToolInputGuardrail({
    name: "agent_studio_tool_policy",
    async run({ context, toolCall }) {
      const selfRequiresApproval = await originalNeedsApproval(
        context,
        parseToolArguments(toolCall.arguments) as never,
        toolCall.callId,
      );
      const decision = evaluateToolPolicy(settings, {
        toolName: toolCall.name,
        source: profile.source,
        capabilities: profile.capabilities,
        selfRequiresApproval,
      });
      if (decision.action === "deny") {
        return ToolGuardrailFunctionOutputFactory.rejectContent(
          `统一工具策略拒绝了 ${JSON.stringify(toolCall.name)}：${decision.reason}。`,
          { policyAction: decision.action, profile, reason: decision.reason, ruleId: decision.rule?.id },
        );
      }
      const matched = findBlockedTerm(toolCall.arguments ?? "", settings.toolGuardrail.blockedTerms);
      if (!settings.toolGuardrail.enabled || !matched) {
        return ToolGuardrailFunctionOutputFactory.allow({
          checked: true,
          policyAction: decision.action,
          profile,
          reason: decision.reason,
          ruleId: decision.rule?.id,
        });
      }
      return ToolGuardrailFunctionOutputFactory.rejectContent(
        `安全策略拒绝了工具调用：参数命中拦截词 ${JSON.stringify(matched)}。`,
        { matchedTerm: matched, policyAction: decision.action, profile },
      );
    },
  });
}

function secureTool<T extends Tool>(
  toolDefinition: T,
  settings: SafetySettings,
  profile: ToolSecurityProfile,
  approvalContext?: RuntimeApprovalContext,
): T {
  if (toolDefinition.type !== "function") {
    const unsupported = toolDefinition as Tool & { name?: string };
    throw new AgentConfigError(`工具 ${JSON.stringify(unsupported.name ?? unsupported.type)} 无法接入统一审批策略，已按 fail-closed 拒绝加载。`);
  }
  const functionTool = toolDefinition as FunctionTool;
  const originalNeedsApproval = functionTool.needsApproval;
  const originalIsEnabled = functionTool.isEnabled;
  const policyGuardrail = makeToolInputGuardrail(settings, profile, originalNeedsApproval);
  const reportedGrantCalls = new Set<string>();

  functionTool.needsApproval = async (context, input, callId) => {
    const selfRequiresApproval = await originalNeedsApproval(context, input, callId);
    const decision = evaluateToolPolicy(settings, {
      toolName: functionTool.name,
      source: profile.source,
      capabilities: profile.capabilities,
      selfRequiresApproval,
    });
    if (decision.action !== "approval") return false;
    if (!approvalContext) return true;
    const grant = findSessionApproval({
      sessionId: approvalContext.sessionId,
      toolName: functionTool.name,
      arguments: input,
      profile,
    });
    if (!grant) return true;
    const useKey = `${grant.id}:${callId}`;
    if (!reportedGrantCalls.has(useKey)) {
      reportedGrantCalls.add(useKey);
      approvalContext.onSessionApprovalUsed?.(grant);
    }
    return false;
  };
  functionTool.isEnabled = async (context, agent) => {
    if (originalIsEnabled && !(await originalIsEnabled(context, agent))) return false;
    return evaluateToolPolicy(settings, {
      toolName: functionTool.name,
      source: profile.source,
      capabilities: profile.capabilities,
    }).action !== "deny";
  };
  functionTool.inputGuardrails = [
    policyGuardrail,
    ...(functionTool.inputGuardrails ?? []).filter((guardrail) => guardrail.name !== policyGuardrail.name),
  ];
  return toolDefinition;
}

function secureTools(
  tools: Tool[],
  settings: SafetySettings,
  profile: ToolSecurityProfile,
  registry: Record<string, ToolSecurityProfile>,
  approvalContext?: RuntimeApprovalContext,
): Tool[] {
  return tools.map((toolDefinition) => {
    registry[toolDefinition.name] = profile;
    return secureTool(toolDefinition, settings, profile, approvalContext);
  });
}

function createApprovalDemoTool(settings: SafetySettings) {
  if (!settings.approval.demoToolEnabled) return [];
  const parameters = z.object({
    action: z.enum(["send_message", "delete_record", "run_command"]).describe("要模拟的敏感操作类型"),
    target: z.string().describe("模拟操作的目标"),
    reason: z.string().describe("为什么需要执行该操作"),
  });
  const result = (action: string, target: string, reason: string, declaration: "declared" | "undeclared") => JSON.stringify({
    simulated: true,
    action,
    target,
    reason,
    approvalDeclaration: declaration,
    message: "这是安全模拟，没有修改任何真实外部系统。",
  });
  return [
    tool({
      name: "simulate_sensitive_action",
      description: "仅当用户明确要求测试审批，或明确要求模拟敏感操作时调用。它会模拟发送消息、删除记录或执行命令，但不会修改任何真实外部系统。",
      parameters,
      needsApproval: true,
      async execute({ action, target, reason }) {
        return result(action, target, reason, "declared");
      },
    }),
    tool({
      name: "simulate_undeclared_sensitive_action",
      description: "安全策略实验专用：模拟一个没有自行声明 needsApproval 的敏感工具。仅在用户明确要求使用 safety-policy-lab 测试时调用，不会修改真实系统。",
      parameters,
      async execute({ action, target, reason }) {
        return result(action, target, reason, "undeclared");
      },
    }),
  ];
}

function buildMcpServer(server: ManagedMcpServer): MCPServer {
  const shared = {
    name: server.title,
    cacheToolsList: true,
    timeout: 15_000,
  };
  const config = server.config;
  if (config.type === "stdio") {
    if (!server.trusted) throw new AgentConfigError(`MCP「${server.title}」是本地 stdio 配置，但尚未标记为信任。`);
    if (process.env.ALLOW_STDIO_MCP !== "true") {
      throw new AgentConfigError(`MCP「${server.title}」需要执行本地命令。请在 .env 设置 ALLOW_STDIO_MCP=true 后重启服务。`);
    }
    return new MCPServerStdio({ ...shared, command: config.command!, args: config.args, env: config.env, cwd: config.cwd });
  }
  const options = { ...shared, url: config.url!, requestInit: config.headers ? { headers: config.headers } : undefined };
  return config.type === "sse" ? new MCPServerSSE(options) : new MCPServerStreamableHttp(options);
}

export async function inspectManagedMcpServer(config: ManagedMcpServer, boundNames = false) {
  const server = buildMcpServer(config);
  try {
    await server.connect();
    const tools = boundNames ? await listBoundMcpTools(server) : await server.listTools();
    return tools.map((tool) => ({ name: tool.name, description: "description" in tool ? tool.description ?? "" : "" }));
  } finally {
    await server.close().catch(() => undefined);
  }
}

export async function createRuntime(requested: ClientRuntimeConfig, approvalContext?: RuntimeApprovalContext): Promise<AgentRuntime> {
  loadEnvironment();
  const preset = presets[requested.provider];
  if (!preset) throw new AgentConfigError("不支持的模型 Provider。");

  const apiKey = requested.apiKey?.trim() || readEnv(preset.apiKeyEnv);
  const model = requested.model.trim();
  const subagentModel = requested.subagentModel.trim() || model;
  const baseURL = requested.baseURL.trim() || readEnv(preset.baseURLEnv) || preset.defaultBaseURL;

  if (!apiKey) {
    throw new AgentConfigError(`缺少 ${preset.apiKeyEnv}。可在网页设置中临时填写，或在服务端 .env 配置。`);
  }
  if (!model) throw new AgentConfigError("主模型名称不能为空。");
  if (requested.provider === "custom" && !baseURL) {
    throw new AgentConfigError("自定义 Provider 必须填写 Base URL。");
  }
  if (!["responses", "chat_completions"].includes(requested.apiMode)) {
    throw new AgentConfigError("API 模式只能是 responses 或 chat_completions。");
  }

  const provider = new OpenAIProvider({
    apiKey,
    baseURL,
    useResponses: requested.apiMode === "responses",
  });
  const safety = await getSafetySettings();
  const nativeWebSearchEnabled = requested.webSearchEnabled && requested.provider === "openai" && requested.apiMode === "responses";
  const searchApiKey = requested.provider === "openai" ? apiKey : readEnv("OPENAI_API_KEY");
  const bridgedWebSearchEnabled = requested.webSearchEnabled && !nativeWebSearchEnabled && Boolean(searchApiKey);
  const managedMcpServers = await listMcpServers();
  const initialDefinitions = listAgentDefinitions(true);
  const neededBySpecialist = (id: string) => initialDefinitions.some((definition) => !definition.permissionsMigrated
    ? definition.mcpEnabled : definition.permissions.mcp.some((grant) => grant.serverId === id && grant.tools.length > 0));
  const connected: Array<{ config: ManagedMcpServer; server: MCPServer }> = [];
  try {
    for (const mcpConfig of managedMcpServers.filter((item) => item.enabled && (item.scope !== "subagent" || neededBySpecialist(item.id)))) {
      const server = buildMcpServer(mcpConfig);
      try {
        await server.connect();
      } catch (error) {
        await server.close().catch(() => undefined);
        throw error;
      }
      connected.push({ config: mcpConfig, server });
    }
  } catch (error) {
    await Promise.allSettled(connected.map(({ server }) => server.close()));
    throw new AgentConfigError(`MCP 连接失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
  try {
  const mcpFor = (target: "main" | "subagent") => connected
    .filter(({ config }) => (config.scope === target || config.scope === "both") && (target === "main" || neededBySpecialist(config.id)));
  const installedSkills = (await listInstalledSkills()).filter((skill) => skill.enabled);
  const activePrompt = await getActivePrompt();
  const persistedMemory = approvalContext?.sessionId ? memoryInstructions(approvalContext.sessionId) : "";
  const toolProfiles: Record<string, ToolSecurityProfile> = {};
  const skillProfile: ToolSecurityProfile = {
    source: "skill",
    capabilities: ["skills:read"],
    riskLevel: "low",
    effect: "read",
    description: "加载或读取已安装 Skill",
  };
  const demoProfile: ToolSecurityProfile = {
    source: "function",
    capabilities: ["external:action"],
    riskLevel: "high",
    effect: "external",
    description: "无真实副作用的安全策略演示",
  };
  const delegateProfile: ToolSecurityProfile = {
    source: "agent",
    capabilities: ["agent:delegate"],
    riskLevel: "low",
    effect: "read",
    description: "委派任务给项目内 Subagent",
  };
  const skillsFor = (target: "main" | "subagent") => installedSkills
    .filter((skill) => skill.scope === target || skill.scope === "both");
  const subagentMcpBindings = new Map<Tool, string>();
  const mcpToolsFor = async (target: "main" | "subagent") => {
    const reservedToolNames = new Set(target === "main"
      ? ["load_skill", "read_skill_file", "workspace_list_files", "workspace_read_file", "workspace_search", "workspace_apply_patch", "workspace_run_command", "simulate_sensitive_action", "simulate_undeclared_sensitive_action", "delegate_task", "get_current_time", "calculate", "web_fetch", "web_search"]
      : ["load_skill", "read_skill_file", "workspace_list_files", "workspace_read_file", "workspace_search", "get_current_time", "calculate", "web_fetch", "web_search"]);
    const tools: Tool[] = [];
    for (const { config, server } of mcpFor(target)) {
      const serverTools = target === "subagent" ? await listBoundMcpTools(server) : await getAllMcpTools({
        mcpServers: [server],
        includeServerInToolNames: true,
        reservedToolNames,
      });
      const profile: ToolSecurityProfile = {
        source: "mcp",
        capabilities: ["external:action"],
        riskLevel: "high",
        effect: "external",
        description: `由 MCP Server「${config.displayName || config.title}」提供的动态工具`,
        mcpServer: { id: config.id, title: config.title, displayName: config.displayName },
      };
      if (target === "subagent" && serverTools.some((item) => tools.some((existing) => existing.name === item.name))) {
        throw new AgentConfigError("MCP 工具名称冲突，请为 MCP 服务设置不同的标题。");
      }
      const secured = secureTools(serverTools, safety, profile, toolProfiles, approvalContext);
      tools.push(...secured);
      if (target === "subagent") secured.forEach((item) => subagentMcpBindings.set(item, config.id));
      for (const toolDefinition of serverTools) reservedToolNames.add(toolDefinition.name);
    }
    return tools;
  };
  const [mainMcpTools, subagentMcpTools] = await Promise.all([mcpToolsFor("main"), mcpToolsFor("subagent")]);
  const secureManagedTools = (managed: ManagedTool[], settings: SafetySettings = safety) => managed.map((item) => {
    toolProfiles[item.tool.name] = item.profile;
    return secureTool(item.tool, settings, item.profile, approvalContext);
  });
  const webSearchProfile: ToolSecurityProfile = {
    source: "function",
    capabilities: ["network:access"],
    riskLevel: "low",
    effect: "read",
    description: nativeWebSearchEnabled
      ? "OpenAI 托管的实时公开网页搜索"
      : "通过受限 OpenAI 搜索后端查询实时公开网页",
  };
  const runtimeCapabilitySafety: SafetySettings = {
    ...safety,
    toolPolicy: {
      ...safety.toolPolicy,
      rules: [
        ...safety.toolPolicy.rules,
        {
          id: "runtime-current-time",
          enabled: true,
          source: "function",
          pattern: "get_current_time",
          capability: "time:read",
          action: "allow",
          description: "允许读取当前时间",
        },
        {
          id: "runtime-calculator",
          enabled: true,
          source: "function",
          pattern: "calculate",
          capability: "compute:calculate",
          action: "allow",
          description: "允许执行无代码求值的受限数学计算",
        },
        {
          id: "runtime-web-read-enabled",
          enabled: requested.webSearchEnabled,
          source: "function",
          pattern: "web_fetch",
          capability: "network:access",
          action: "allow",
          description: "Agent 设置中的联网开关已显式授权只读公开网页访问",
        },
        {
          id: "runtime-web-search-enabled",
          enabled: requested.webSearchEnabled,
          source: "function",
          pattern: "web_search",
          capability: "network:access",
          action: "allow",
          description: "Agent 设置中的联网开关已显式授权只读搜索",
        },
      ],
    },
  };
  const coreCapabilityRegistry = createDefaultCapabilityRegistry({ webEnabled: requested.webSearchEnabled });
  const coreTools = secureManagedTools(enabledCapabilityTools(coreCapabilityRegistry), runtimeCapabilitySafety);
  const webSearchTools: Tool[] = nativeWebSearchEnabled
    ? [webSearchTool({ searchContextSize: "medium", externalWebAccess: true })]
    : bridgedWebSearchEnabled && searchApiKey
      ? secureTools(
          [createWebSearchBridgeTool(searchApiKey, readEnv("WEB_SEARCH_MODEL") ?? readEnv("OPENAI_MODEL") ?? "gpt-5.6-luna")],
          runtimeCapabilitySafety,
          webSearchProfile,
          toolProfiles,
          approvalContext,
        )
      : [];
  if (nativeWebSearchEnabled) toolProfiles.web_search = webSearchProfile;
  const webSearchAvailable = webSearchTools.length > 0;
  const coreInstructions = requested.webSearchEnabled
    ? "\n\n你可以使用 get_current_time 获取可信的当前时间，使用 calculate 完成精确计算，使用 web_fetch 读取已知的公开网页。用户询问‘能否访问某网站’或给出域名/URL 时，必须优先用 web_fetch 实测；web_search 只用于发现链接或核实时效信息。web_search 超时后最多重试一次；若目标网址已知，改用 web_fetch。只要 web_fetch 可用，就不得声称没有网页访问工具或无法联网，并应区分‘搜索后端超时’与‘目标网站无法访问’。"
    : "\n\n你可以使用 get_current_time 获取可信的当前时间，使用 calculate 完成精确计算。";
  for (const definition of initialDefinitions.filter((item) => !item.permissionsMigrated)) migrateAgentPermissions(skillsFor("subagent").map((skill) => skill.name), mcpFor("subagent").map(({ config }) => ({
    id: config.id, tools: subagentMcpTools.filter((item) => subagentMcpBindings.get(item) === config.id).map((item) => item.name),
  })), definition.id);
  const specialistDefinitions = listAgentDefinitions(true);
  const makeOutputGuardrails = () => safety.outputGuardrail.enabled ? [{
    name: "blocked_output_terms",
    async execute({ agentOutput }: { agentOutput: unknown }) {
      const text = typeof agentOutput === "string" ? agentOutput : JSON.stringify(agentOutput);
      const matched = findBlockedTerm(text, safety.outputGuardrail.blockedTerms);
      return { tripwireTriggered: Boolean(matched), outputInfo: { matchedTerm: matched } };
    },
  }] : [];
  const subagents = specialistDefinitions.map((definition) => {
    const permissions = definition.permissions;
    const selectedSkills = skillsFor("subagent").filter((skill) => permissions.skills.includes(skill.name));
    const workspaceTools = secureManagedTools(createWorkspaceTools(safety, { mutating: true }));
    const tools: Tool[] = [
      ...selectAllowedTools([...coreTools, ...webSearchTools, ...workspaceTools], permissions),
      ...secureTools(createSkillTools(selectedSkills), safety, skillProfile, toolProfiles, approvalContext),
      ...subagentMcpTools.filter((item) => permitsMcp(permissions, subagentMcpBindings.get(item)!, item.name)),
    ];
    return new Agent({
      name: definition.name,
      handoffDescription: definition.description,
      model: definition.model || subagentModel,
      instructions: instructionsWithSkillCatalog(`${activePrompt.subagentInstructions}\n\n# 专家角色\n${definition.instructions}`, selectedSkills)
        + persistedMemory
        + "\n\n你是可配置专家 Agent。若通过 Handoff 接管对话，你直接对最终用户负责；若作为工具被调用，你返回给 Main Agent 可验证、可汇总的结果。严格遵守当前工具与权限边界。"
        + `\n\n本次实际可用工具：${tools.map((item) => item.name).join("、") || "无"}。不得声称拥有未列出的工具。`
        + (tools.some((item) => item.name === "web_fetch") ? "\n已知目标 URL 时优先用 web_fetch 实测。" : ""),
      tools,
      outputGuardrails: makeOutputGuardrails(),
    });
  });
  const mainSkillTools = secureTools(createSkillTools(skillsFor("main")), safety, skillProfile, toolProfiles, approvalContext);
  const mainWorkspaceTools = secureManagedTools(createWorkspaceTools(safety, { mutating: true }));
  const demoTools = secureTools(createApprovalDemoTool(safety), safety, demoProfile, toolProfiles, approvalContext);
  const handoffAgents = subagents.filter((_agent, index) => ["handoff", "both"].includes(specialistDefinitions[index].collaboration));
  const delegateTools = subagents.flatMap((specialist, index) => {
    const definition = specialistDefinitions[index];
    if (!['tool', 'both'].includes(definition.collaboration)) return [];
    const delegateTool = secureTool(specialist.asTool({
      toolName: `delegate_${definition.id.replaceAll("-", "").slice(0, 12)}`,
      toolDescription: `${definition.description} 调用后由 Main Agent 继续掌控对话并汇总结果。`,
      runOptions: { maxTurns: definition.maxTurns ?? requested.subagentMaxTurns },
    }), safety, { ...delegateProfile, description: `委派任务给「${definition.name}」` }, approvalContext);
    toolProfiles[delegateTool.name] = { ...delegateProfile, description: `委派任务给「${definition.name}」` };
    return [delegateTool];
  });
  const orchestrationCatalog = specialistDefinitions.length
    ? specialistDefinitions.map((definition, index) => {
        const modes = definition.collaboration === "both" ? "Handoff + Tool" : definition.collaboration === "handoff" ? "Handoff" : "Tool";
        const toolName = delegateTools.find((tool) => tool.description?.startsWith(definition.description))?.name;
        return `- ${definition.name} [${modes}]：${definition.description}${toolName ? `；委派工具 ${toolName}` : ""}`;
      }).join("\n")
    : "- 当前没有启用的专家 Agent。";
  const mainAgent = new Agent({
    name: "通用助手",
    model,
    instructions: instructionsWithSkillCatalog(activePrompt.mainInstructions, skillsFor("main")) + persistedMemory + `\n\n# Multi-agent orchestration\n你可以使用以下专家：\n${orchestrationCatalog}\n\nTool 委派用于边界明确的子任务，完成后由你检查并汇总；原生 Handoff 用于让专家直接接管对话。简单问题自己完成，不要无意义委派。` + coreInstructions + (webSearchAvailable
      ? "\n\n你可以使用 web_search 查询实时公开信息。用户询问当前、最新、价格、排行、新闻或需要来源的事实时，应先搜索再回答，并提供来源链接。"
      : ""),
    inputGuardrails: safety.inputGuardrail.enabled ? [{
      name: "blocked_input_terms",
      runInParallel: false,
      async execute({ input }) {
        const text = typeof input === "string" ? input : JSON.stringify(input);
        const matched = findBlockedTerm(text, safety.inputGuardrail.blockedTerms);
        return { tripwireTriggered: Boolean(matched), outputInfo: { matchedTerm: matched } };
      },
    }] : [],
    outputGuardrails: safety.outputGuardrail.enabled ? [{
      name: "blocked_output_terms",
      async execute({ agentOutput }) {
        const text = typeof agentOutput === "string" ? agentOutput : JSON.stringify(agentOutput);
        const matched = findBlockedTerm(text, safety.outputGuardrail.blockedTerms);
        return { tripwireTriggered: Boolean(matched), outputInfo: { matchedTerm: matched } };
      },
    }] : [],
    handoffs: handoffAgents,
    tools: [...coreTools, ...mainSkillTools, ...mainWorkspaceTools, ...mainMcpTools, ...demoTools, ...delegateTools, ...webSearchTools],
  });

  if (approvalContext?.sessionId) {
    const observe = async (agent: Agent, id: string, modelName: string) => {
      agent.model = observeContextModel(await provider.getModel(modelName), approvalContext.sessionId, id, agent.name,
        { provider: requested.provider, model: modelName, baseURL: requested.baseURL, apiMode: requested.apiMode }, approvalContext.onCompaction);
    };
    await observe(mainAgent, "main", model);
    await Promise.all(subagents.map((agent, index) => observe(agent, specialistDefinitions[index].id, specialistDefinitions[index].model || subagentModel)));
  }
  return {
    provider: requested.provider,
    mainAgent,
    subagent: subagents[0],
    subagents,
    toolProfiles,
    runner: new Runner({
      modelProvider: provider,
      tracingDisabled: requested.provider !== "openai",
      workflowName: "Agent Studio Web Chat",
      toolExecution: { preApprovalInputGuardrails: true },
    }),
    close: async () => {
      await Promise.allSettled(connected.map(({ server }) => server.close()));
    },
  };
  } catch (error) {
    await Promise.allSettled(connected.map(({ server }) => server.close()));
    throw error;
  }
}

export function validateSessionId(value: string): string {
  const sessionId = value.trim();
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(sessionId)) {
    throw new Error("会话 ID 只能包含字母、数字、点、下划线和短横线，最长 80 个字符。");
  }
  return sessionId;
}

export function getSession(sessionId: string): Session {
  return new SqliteAgentSession(sessionId);
}

export function usedSubagent(result: { newItems: RunItem[] }): boolean {
  return result.newItems.some((item) => {
    if (item.type === "handoff_call_item" || item.type === "handoff_output_item") return true;
    if (item.type !== "tool_call_item") return false;
    const rawItem = item.rawItem;
    return rawItem?.type === "function_call" && typeof rawItem.name === "string" && (rawItem.name === "delegate_task" || rawItem.name.startsWith("delegate_"));
  });
}

export function usedToolNames(result: { newItems: RunItem[] }): string[] {
  return [...new Set(result.newItems.flatMap((item) => {
    if (item.type !== "tool_call_item") return [];
    const rawItem = item.rawItem;
    if (rawItem?.type === "function_call" && typeof rawItem.name === "string") return [rawItem.name];
    if (rawItem?.type === "hosted_tool_call" && typeof rawItem.name === "string") {
      return [rawItem.name === "web_search_call" ? "web_search" : rawItem.name];
    }
    return [];
  }))];
}

export function usedHostedToolNames(result: { newItems: RunItem[] }): string[] {
  return result.newItems.flatMap((item) => {
    if (item.type !== "tool_call_item" || item.rawItem?.type !== "hosted_tool_call") return [];
    const name = item.rawItem.name;
    if (typeof name !== "string") return [];
    return [name === "web_search_call" ? "web_search" : name];
  });
}

export function guardrailsRun(result: {
  inputGuardrailResults: Array<{ guardrail: { name: string } }>;
  outputGuardrailResults: Array<{ guardrail: { name: string } }>;
  toolInputGuardrailResults: Array<{ guardrail: { name: string } }>;
  toolOutputGuardrailResults: Array<{ guardrail: { name: string } }>;
}) {
  return {
    input: result.inputGuardrailResults.map((item) => item.guardrail.name),
    output: result.outputGuardrailResults.map((item) => item.guardrail.name),
    tool: [...result.toolInputGuardrailResults, ...result.toolOutputGuardrailResults].map((item) => item.guardrail.name),
  };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const value = "text" in part ? part.text : "content" in part ? part.content : "";
    return typeof value === "string" ? value : "";
  }).filter(Boolean).join("\n");
}

export function visibleMessages(items: AgentInputItem[]): Array<{ role: "user" | "assistant"; content: string }> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const item of items) {
    if (!("role" in item) || (item.role !== "user" && item.role !== "assistant")) continue;
    const content = contentText("content" in item ? item.content : "");
    if (content) messages.push({ role: item.role, content });
  }
  return messages;
}
