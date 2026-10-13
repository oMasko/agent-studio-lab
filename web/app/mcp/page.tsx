"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ManagementHeader } from "@/components/management-header";

type Scope = "main" | "subagent" | "both";
type Server = { id: string; title: string; displayName: string; description: string; preset: string; enabled: boolean; scope: Scope; trusted: boolean; config: { type: string }; updatedAt: string };
const scopeLabels: Record<Scope, string> = { main: "Main Agent", subagent: "Subagent", both: "两者" };

export default function McpPage() {
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState("");
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try { const response = await fetch("/api/mcp/servers", { cache: "no-store" }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "加载失败"); setServers(data.servers); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "加载失败"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function patch(id: string, body: object) {
    const response = await fetch(`/api/mcp/servers/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) { setError(data.error || "更新失败"); return; } await refresh();
  }
  async function remove(server: Server) {
    if (!window.confirm(`确定删除 MCP「${server.title}」吗？`)) return;
    const response = await fetch(`/api/mcp/servers/${server.id}`, { method: "DELETE" });
    if (!response.ok) { const data = await response.json(); setError(data.error || "删除失败"); return; } await refresh();
  }
  async function test(server: Server) {
    setTesting(server.id); setTestResult((current) => ({ ...current, [server.id]: "正在连接…" }));
    try { const response = await fetch(`/api/mcp/servers/${server.id}/test`, { method: "POST" }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "连接失败"); const names = data.tools.map((item: { name: string }) => item.name); setTestResult((current) => ({ ...current, [server.id]: names.length ? `连接成功 · ${names.length} 个工具：${names.slice(0, 4).join("、")}` : "连接成功 · 未发现工具" })); }
    catch (reason) { setTestResult((current) => ({ ...current, [server.id]: reason instanceof Error ? reason.message : "连接失败" })); }
    finally { setTesting(""); }
  }

  return <main className="management-page">
    <ManagementHeader current="mcp" eyebrow="TOOL CONNECTIONS" title="MCP 管理" description="项目级配置 MCP Server，并决定挂载到哪个 Agent。" actions={<Link className="management-primary-action" href="/mcp/new">＋ 新增 MCP</Link>} />
    {error && <div className="management-error">{error}</div>}
    <section className="management-summary"><div><strong>{servers.length}</strong><span>已配置</span></div><div><strong>{servers.filter((item) => item.enabled).length}</strong><span>已启用</span></div><div className="summary-pills"><span>HTTP: {servers.filter((item) => item.config.type === "streamable_http").length}</span><span>SSE: {servers.filter((item) => item.config.type === "sse").length}</span><span>stdio: {servers.filter((item) => item.config.type === "stdio").length}</span></div></section>
    <section className="asset-list">{loading ? <div className="asset-empty">正在加载…</div> : servers.length === 0 ? <div className="asset-empty"><strong>还没有 MCP Server</strong><span>可以从预设开始，也可以直接粘贴完整 JSON 配置。</span><Link className="primary" href="/mcp/new">新增第一个 MCP</Link></div> : servers.map((server) => <article className={`asset-row ${server.enabled ? "active" : ""}`} key={server.id}>
      <div className="asset-main"><span className={`asset-dot ${server.enabled ? "enabled" : ""}`} /><div><div className="asset-name"><strong>{server.displayName || server.title}</strong><b>{server.config.type}</b></div><p>{server.description || server.title}</p><small>{server.title} · {server.preset}</small>{testResult[server.id] && <em className="test-result">{testResult[server.id]}</em>}</div></div>
      <div className="asset-actions"><select value={server.scope} onChange={(event) => void patch(server.id, { scope: event.target.value })}>{Object.entries(scopeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><label className="skill-switch"><input type="checkbox" checked={server.enabled} onChange={(event) => void patch(server.id, { enabled: event.target.checked })} /><span /></label><button disabled={testing === server.id} onClick={() => void test(server)}>测试</button><Link href={`/mcp/${server.id}`}>编辑</Link><button className="danger" onClick={() => void remove(server)}>删除</button></div>
    </article>)}</section>
  </main>;
}
