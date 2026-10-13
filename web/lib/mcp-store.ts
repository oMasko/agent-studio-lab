import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type McpScope = "main" | "subagent" | "both";
export type McpTransport = "streamable_http" | "sse" | "stdio";
export type McpPreset = "custom" | "fetch" | "time" | "memory" | "sequential-thinking" | "context7";

export type McpConnection = {
  type: McpTransport;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export type ManagedMcpServer = {
  id: string;
  title: string;
  displayName: string;
  description: string;
  preset: McpPreset;
  enabled: boolean;
  scope: McpScope;
  trusted: boolean;
  config: McpConnection;
  createdAt: string;
  updatedAt: string;
};

type McpStore = { version: 1; servers: ManagedMcpServer[] };
const storePath = resolve(process.cwd(), "..", ".agent-studio", "mcp-servers.json");

export class McpStoreError extends Error {}

export const mcpPresetConfigs: Record<McpPreset, McpConnection> = {
  custom: { type: "streamable_http", url: "https://example.com/mcp" },
  fetch: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
  time: { type: "stdio", command: "uvx", args: ["mcp-server-time"] },
  memory: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
  "sequential-thinking": { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] },
  context7: { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"] },
};

async function readStore(): Promise<McpStore> {
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as McpStore;
    return parsed.version === 1 && Array.isArray(parsed.servers) ? parsed : { version: 1, servers: [] };
  } catch {
    return { version: 1, servers: [] };
  }
}

async function saveStore(store: McpStore) {
  await mkdir(dirname(storePath), { recursive: true });
  const temporary = `${storePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, storePath);
}

function cleanMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpStoreError(`${label} 必须是字符串键值对象。`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 50 || entries.some(([key, item]) => !key.trim() || typeof item !== "string")) throw new McpStoreError(`${label} 必须是字符串键值对象，最多 50 项。`);
  return Object.fromEntries(entries.map(([key, item]) => [key.trim(), item as string]));
}

export function validateMcpConnection(value: unknown): McpConnection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpStoreError("完整 JSON 配置必须是对象。");
  const source = value as Record<string, unknown>;
  if (!(["streamable_http", "sse", "stdio"] as unknown[]).includes(source.type)) throw new McpStoreError("type 必须是 streamable_http、sse 或 stdio。");
  const type = source.type as McpTransport;
  if (type === "stdio") {
    if (typeof source.command !== "string" || !source.command.trim()) throw new McpStoreError("stdio 配置必须包含 command。");
    if (source.args !== undefined && (!Array.isArray(source.args) || source.args.some((item) => typeof item !== "string"))) throw new McpStoreError("args 必须是字符串数组。");
    return {
      type,
      command: source.command.trim(),
      args: source.args as string[] | undefined,
      env: cleanMap(source.env, "env"),
      cwd: typeof source.cwd === "string" && source.cwd.trim() ? source.cwd.trim() : undefined,
    };
  }
  if (typeof source.url !== "string" || !source.url.trim()) throw new McpStoreError(`${type} 配置必须包含 url。`);
  let url: URL;
  try { url = new URL(source.url); } catch { throw new McpStoreError("MCP URL 无效。"); }
  if (!(["http:", "https:"] as string[]).includes(url.protocol)) throw new McpStoreError("MCP URL 只支持 HTTP 或 HTTPS。");
  return { type, url: url.toString(), headers: cleanMap(source.headers, "headers") };
}

type McpInput = Pick<ManagedMcpServer, "title" | "displayName" | "description" | "preset" | "enabled" | "scope" | "trusted"> & { config: unknown };

function validateInput(input: McpInput) {
  const title = input.title.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(title)) throw new McpStoreError("MCP 标题只能包含字母、数字、点、下划线和短横线，最长 80 个字符。");
  if (!(["custom", "fetch", "time", "memory", "sequential-thinking", "context7"] as unknown[]).includes(input.preset)) throw new McpStoreError("MCP 预设类型无效。");
  if (!(["main", "subagent", "both"] as unknown[]).includes(input.scope)) throw new McpStoreError("Agent 作用范围无效。");
  return {
    title,
    displayName: input.displayName.trim().slice(0, 120),
    description: input.description.trim().slice(0, 500),
    preset: input.preset,
    enabled: Boolean(input.enabled),
    scope: input.scope,
    trusted: Boolean(input.trusted),
    config: validateMcpConnection(input.config),
  };
}

export async function listMcpServers() { return (await readStore()).servers; }

export async function getMcpServer(id: string) {
  const server = (await readStore()).servers.find((item) => item.id === id);
  if (!server) throw new McpStoreError("MCP Server 不存在。");
  return server;
}

export async function createMcpServer(input: McpInput) {
  const store = await readStore();
  const value = validateInput(input);
  if (store.servers.some((item) => item.title === value.title)) throw new McpStoreError("MCP 标题已存在。");
  const now = new Date().toISOString();
  const server: ManagedMcpServer = { id: randomUUID(), ...value, createdAt: now, updatedAt: now };
  store.servers.push(server);
  await saveStore(store);
  return server;
}

export async function updateMcpServer(id: string, input: McpInput) {
  const store = await readStore();
  const index = store.servers.findIndex((item) => item.id === id);
  if (index < 0) throw new McpStoreError("MCP Server 不存在。");
  const value = validateInput(input);
  if (store.servers.some((item) => item.id !== id && item.title === value.title)) throw new McpStoreError("MCP 标题已存在。");
  store.servers[index] = { ...store.servers[index], ...value, updatedAt: new Date().toISOString() };
  await saveStore(store);
  return store.servers[index];
}

export async function patchMcpServer(id: string, patch: Partial<Pick<ManagedMcpServer, "enabled" | "scope">>) {
  const current = await getMcpServer(id);
  return updateMcpServer(id, { ...current, ...patch });
}

export async function deleteMcpServer(id: string) {
  const store = await readStore();
  if (!store.servers.some((item) => item.id === id)) throw new McpStoreError("MCP Server 不存在。");
  store.servers = store.servers.filter((item) => item.id !== id);
  await saveStore(store);
}
