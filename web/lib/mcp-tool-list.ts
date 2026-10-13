import { getAllMcpTools, type MCPServer } from "@openai/agents";
import { builtinTools } from "@/lib/agent-permissions";

// Discovery and execution must use the same names and collision rules.
export function listBoundMcpTools(server: MCPServer) {
  return getAllMcpTools({ mcpServers: [server], includeServerInToolNames: true,
    reservedToolNames: new Set([...builtinTools.map((item) => item.name), "load_skill", "read_skill_file", "simulate_sensitive_action", "simulate_undeclared_sensitive_action", "delegate_task"]),
  });
}
