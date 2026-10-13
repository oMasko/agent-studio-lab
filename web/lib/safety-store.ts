import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ToolCapability } from "@/lib/tool-capabilities";

export type SafetySettings = {
  version: 1;
  inputGuardrail: {
    enabled: boolean;
    blockedTerms: string[];
  };
  outputGuardrail: {
    enabled: boolean;
    blockedTerms: string[];
  };
  toolGuardrail: {
    enabled: boolean;
    blockedTerms: string[];
  };
  approval: {
    enabled: boolean;
    demoToolEnabled: boolean;
  };
  workspace: {
    readEnabled: boolean;
    writeEnabled: boolean;
    shellEnabled: boolean;
    maxCommandSeconds: number;
  };
  toolPolicy: ToolPolicySettings;
  updatedAt: string;
};

export type ToolPolicyAction = "allow" | "approval" | "deny";
export type ToolPolicySource = "all" | "function" | "skill" | "mcp" | "agent";

export type ToolPolicyRule = {
  id: string;
  enabled: boolean;
  source: ToolPolicySource;
  pattern: string;
  capability: string;
  action: ToolPolicyAction;
  description: string;
};

export type ToolPolicySettings = {
  enabled: boolean;
  defaultAction: ToolPolicyAction;
  rules: ToolPolicyRule[];
};

export type SafetySettingsInput = Omit<SafetySettings, "version" | "updatedAt">;

const storePath = resolve(process.cwd(), "..", ".agent-studio", "safety.json");

export class SafetyStoreError extends Error {}

function defaults(): SafetySettings {
  return {
    version: 1,
    inputGuardrail: {
      enabled: true,
      blockedTerms: ["<script", "sk-demo-secret"],
    },
    outputGuardrail: {
      enabled: true,
      blockedTerms: ["BEGIN_PRIVATE_DATA"],
    },
    toolGuardrail: {
      enabled: true,
      blockedTerms: ["production", "/etc", "../"],
    },
    approval: {
      enabled: true,
      demoToolEnabled: false,
    },
    workspace: {
      readEnabled: true,
      writeEnabled: true,
      shellEnabled: true,
      maxCommandSeconds: 60,
    },
    toolPolicy: {
      enabled: true,
      defaultAction: "approval",
      rules: [
        { id: "approve-process", enabled: true, source: "all", pattern: "*", capability: "process:execute", action: "approval", description: "本地主机命令始终需要审批" },
        { id: "approve-workspace-write", enabled: true, source: "all", pattern: "*", capability: "filesystem:write", action: "approval", description: "工作区修改始终需要审批" },
        { id: "allow-workspace-read", enabled: true, source: "function", pattern: "workspace_*", capability: "filesystem:read", action: "allow", description: "允许受限的工作区读取与搜索" },
        { id: "allow-load-skill", enabled: true, source: "skill", pattern: "load_skill", capability: "skills:read", action: "allow", description: "读取已安装 Skill 的入口说明" },
        { id: "allow-read-skill", enabled: true, source: "skill", pattern: "read_skill_file", capability: "skills:read", action: "allow", description: "读取 Skill 目录内的文本文件" },
        { id: "allow-delegate", enabled: true, source: "agent", pattern: "delegate_task", capability: "agent:delegate", action: "allow", description: "允许主 Agent 委派给项目内 Subagent" },
        { id: "approve-demo", enabled: true, source: "function", pattern: "simulate_*", capability: "external:action", action: "approval", description: "敏感操作演示始终需要审批" },
      ],
    },
    updatedAt: new Date().toISOString(),
  };
}

function normalizeTerms(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new SafetyStoreError(`${field} 必须是字符串数组。`);
  const terms = [...new Set(value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean))];
  if (terms.length > 100) throw new SafetyStoreError(`${field} 最多配置 100 条规则。`);
  if (terms.some((item) => item.length > 200)) throw new SafetyStoreError(`${field} 的单条规则不能超过 200 字符。`);
  return terms;
}

const policyActions = new Set<ToolPolicyAction>(["allow", "approval", "deny"]);
const policySources = new Set<ToolPolicySource>(["all", "function", "skill", "mcp", "agent"]);

function normalizeToolPolicy(value: unknown): ToolPolicySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults().toolPolicy;
  const input = value as Partial<ToolPolicySettings>;
  const defaultAction = policyActions.has(input.defaultAction as ToolPolicyAction) ? input.defaultAction as ToolPolicyAction : "approval";
  if (!Array.isArray(input.rules)) throw new SafetyStoreError("工具策略规则必须是数组。");
  if (input.rules.length > 100) throw new SafetyStoreError("工具策略最多配置 100 条规则。");
  const rules = input.rules.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new SafetyStoreError(`第 ${index + 1} 条工具策略格式无效。`);
    const rule = item as Partial<ToolPolicyRule>;
    const source = policySources.has(rule.source as ToolPolicySource) ? rule.source as ToolPolicySource : undefined;
    const action = policyActions.has(rule.action as ToolPolicyAction) ? rule.action as ToolPolicyAction : undefined;
    const pattern = typeof rule.pattern === "string" ? rule.pattern.trim() : "";
    const capability = typeof rule.capability === "string" && rule.capability.trim() ? rule.capability.trim() : "*";
    if (!source || !action || !pattern) throw new SafetyStoreError(`第 ${index + 1} 条工具策略缺少来源、匹配规则或动作。`);
    if (pattern.length > 200) throw new SafetyStoreError(`第 ${index + 1} 条工具策略匹配规则过长。`);
    if (capability.length > 100) throw new SafetyStoreError(`第 ${index + 1} 条工具策略能力匹配规则过长。`);
    return {
      id: typeof rule.id === "string" && rule.id.trim() ? rule.id.trim().slice(0, 100) : randomUUID(),
      enabled: Boolean(rule.enabled),
      source,
      pattern,
      capability,
      action,
      description: typeof rule.description === "string" ? rule.description.trim().slice(0, 300) : "",
    };
  });
  return { enabled: input.enabled !== false, defaultAction, rules };
}

function normalize(input: SafetySettingsInput): SafetySettings {
  if (!input || typeof input !== "object") throw new SafetyStoreError("安全策略格式无效。");
  return {
    version: 1,
    inputGuardrail: {
      enabled: Boolean(input.inputGuardrail?.enabled),
      blockedTerms: normalizeTerms(input.inputGuardrail?.blockedTerms, "输入拦截词"),
    },
    outputGuardrail: {
      enabled: Boolean(input.outputGuardrail?.enabled),
      blockedTerms: normalizeTerms(input.outputGuardrail?.blockedTerms, "输出拦截词"),
    },
    toolGuardrail: {
      enabled: Boolean(input.toolGuardrail?.enabled),
      blockedTerms: normalizeTerms(input.toolGuardrail?.blockedTerms, "工具参数拦截词"),
    },
    approval: {
      enabled: Boolean(input.approval?.enabled),
      demoToolEnabled: Boolean(input.approval?.demoToolEnabled),
    },
    workspace: {
      readEnabled: input.workspace?.readEnabled !== false,
      writeEnabled: input.workspace?.writeEnabled !== false,
      shellEnabled: input.workspace?.shellEnabled !== false,
      maxCommandSeconds: Number.isInteger(input.workspace?.maxCommandSeconds)
        ? Math.min(Math.max(Number(input.workspace.maxCommandSeconds), 5), 120)
        : 60,
    },
    toolPolicy: normalizeToolPolicy(input.toolPolicy),
    updatedAt: new Date().toISOString(),
  };
}

export async function getSafetySettings(): Promise<SafetySettings> {
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as SafetySettings;
    if (parsed.version !== 1) return defaults();
    return normalize(parsed);
  } catch {
    return defaults();
  }
}

export async function saveSafetySettings(input: SafetySettingsInput): Promise<SafetySettings> {
  const value = normalize(input);
  await mkdir(dirname(storePath), { recursive: true });
  const temporary = `${storePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, storePath);
  return value;
}

export function findBlockedTerm(text: string, terms: string[]): string | undefined {
  const normalized = text.toLocaleLowerCase();
  return terms.find((term) => normalized.includes(term.toLocaleLowerCase()));
}

function wildcardMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

export type ToolPolicyDecision = {
  action: ToolPolicyAction;
  reason: string;
  rule?: ToolPolicyRule;
};

export function evaluateToolPolicy(
  settings: SafetySettings,
  input: { toolName: string; source: Exclude<ToolPolicySource, "all">; capabilities?: ToolCapability[]; selfRequiresApproval?: boolean },
): ToolPolicyDecision {
  if (!settings.toolPolicy.enabled) {
    if (input.selfRequiresApproval) {
      return settings.approval.enabled
        ? { action: "approval", reason: "工具自身要求人工审批" }
        : { action: "deny", reason: "工具要求审批，但人工审批功能当前已关闭" };
    }
    return { action: "allow", reason: "统一工具策略已关闭" };
  }

  const capabilities = input.capabilities?.length ? input.capabilities : ["unknown"];
  const rule = settings.toolPolicy.rules.find((candidate) => candidate.enabled
    && (candidate.source === "all" || candidate.source === input.source)
    && wildcardMatch(input.toolName, candidate.pattern)
    && (candidate.capability === "*" || capabilities.some((capability) => wildcardMatch(capability, candidate.capability))));
  let action = rule?.action ?? settings.toolPolicy.defaultAction;
  let reason = rule
    ? `命中规则：${rule.pattern} / ${rule.capability}`
    : `使用默认策略：${settings.toolPolicy.defaultAction}`;
  if (input.selfRequiresApproval && action === "allow") {
    action = "approval";
    reason = `${reason}；工具自身要求审批，安全等级已提升`;
  }
  if (action === "approval" && !settings.approval.enabled) {
    action = "deny";
    reason = `${reason}；人工审批功能已关闭，因此按拒绝处理`;
  }
  return { action, reason, ...(rule ? { rule } : {}) };
}
