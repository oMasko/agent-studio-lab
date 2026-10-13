import type { Tool } from "@openai/agents";

export const knownToolCapabilities = [
  "skills:read",
  "agent:delegate",
  "filesystem:read",
  "filesystem:write",
  "process:execute",
  "network:access",
  "time:read",
  "compute:calculate",
  "external:action",
] as const;

export type ToolCapability = typeof knownToolCapabilities[number] | (string & {});
export type ToolRiskLevel = "low" | "medium" | "high" | "critical";
export type ToolEffect = "read" | "write" | "execute" | "external";

export type ToolSecurityProfile = {
  source: "function" | "skill" | "mcp" | "agent";
  capabilities: ToolCapability[];
  riskLevel: ToolRiskLevel;
  effect: ToolEffect;
  description: string;
  mcpServer?: {
    id: string;
    title: string;
    displayName: string;
  };
};

export type ManagedTool = {
  tool: Tool;
  profile: ToolSecurityProfile;
};
