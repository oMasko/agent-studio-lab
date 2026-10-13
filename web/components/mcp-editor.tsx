"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ManagementHeader } from "@/components/management-header";

type Preset = "custom" | "fetch" | "time" | "memory" | "sequential-thinking" | "context7";
type Scope = "main" | "subagent" | "both";
type Draft = { title: string; displayName: string; description: string; preset: Preset; enabled: boolean; scope: Scope; trusted: boolean; config: unknown };

const templates: Record<Preset, object> = {
  custom: { type: "streamable_http", url: "https://example.com/mcp", headers: {} },
  fetch: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
  time: { type: "stdio", command: "uvx", args: ["mcp-server-time"] },
  memory: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
  "sequential-thinking": { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] },
  context7: { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"] },
};
const labels: Record<Preset, string> = { custom: "自定义", fetch: "fetch", time: "time", memory: "memory", "sequential-thinking": "sequential-thinking", context7: "context7" };
const initial: Draft = { title: "", displayName: "", description: "", preset: "custom", enabled: true, scope: "main", trusted: false, config: templates.custom };

function pretty(value: unknown) { return JSON.stringify(value, null, 2); }

export function McpEditor({ id }: { id?: string }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(initial);
  const [json, setJson] = useState(pretty(initial.config));
  const [loading, setLoading] = useState(Boolean(id));
  const [saving, setSaving] = useState(false);
  const [stdioAllowed, setStdioAllowed] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) {
      fetch("/api/mcp/servers", { cache: "no-store" }).then((response) => response.json()).then((data) => setStdioAllowed(Boolean(data.stdioAllowed))).catch(() => undefined);
      return;
    }
    fetch(`/api/mcp/servers/${id}`, { cache: "no-store" }).then(async (response) => {
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "加载失败");
      setDraft(data.server); setJson(pretty(data.server.config)); setStdioAllowed(Boolean(data.stdioAllowed));
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "加载失败")).finally(() => setLoading(false));
  }, [id]);

  function choosePreset(preset: Preset) {
    const config = templates[preset];
    setDraft((current) => ({ ...current, preset, config, trusted: preset === "custom" ? current.trusted : false, title: current.title || (preset === "custom" ? "" : preset) }));
    setJson(pretty(config)); setError("");
  }

  function setTarget(target: "main" | "subagent", checked: boolean) {
    const main = draft.scope === "main" || draft.scope === "both";
    const subagent = draft.scope === "subagent" || draft.scope === "both";
    const nextMain = target === "main" ? checked : main;
    const nextSubagent = target === "subagent" ? checked : subagent;
    if (!nextMain && !nextSubagent) return;
    setDraft({ ...draft, scope: nextMain && nextSubagent ? "both" : nextMain ? "main" : "subagent" });
  }

  function formatJson() {
    try { const value = JSON.parse(json); setJson(pretty(value)); setError(""); }
    catch (reason) { setError(`JSON 格式错误：${reason instanceof Error ? reason.message : "无法解析"}`); }
  }

  async function save() {
    setSaving(true); setError("");
    try {
      let config: unknown;
      try { config = JSON.parse(json); } catch (reason) { throw new Error(`JSON 格式错误：${reason instanceof Error ? reason.message : "无法解析"}`); }
      const body = { ...draft, config };
      const response = await fetch(id ? `/api/mcp/servers/${id}` : "/api/mcp/servers", { method: id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "保存失败");
      router.push("/mcp"); router.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setSaving(false); }
  }

  const isStdio = (() => { try { return JSON.parse(json).type === "stdio"; } catch { return false; } })();
  const mainEnabled = draft.scope === "main" || draft.scope === "both";
  const subagentEnabled = draft.scope === "subagent" || draft.scope === "both";

  return <main className="mcp-editor-page">
    <ManagementHeader current="mcp" eyebrow="MCP CONFIGURATION" title={id ? "编辑 MCP" : "新增 MCP"} description="配置连接方式、作用范围与安全选项。" backHref="/mcp" />
    {error && <div className="management-error">{error}</div>}
    {loading ? <div className="asset-empty">正在加载…</div> : <>
      <section className="mcp-form-card">
        <h2>选择 MCP 类型</h2>
        <div className="preset-tabs">{(Object.keys(labels) as Preset[]).map((preset) => <button className={draft.preset === preset ? "active" : ""} onClick={() => choosePreset(preset)} key={preset}>{labels[preset]}</button>)}</div>
        <div className="mcp-fields">
          <label><span>MCP 标题（唯一）*</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="my-mcp-server" /></label>
          <label><span>显示名称</span><input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} placeholder="例如：项目文档检索" /></label>
          <label><span>说明</span><input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="这个 MCP 提供什么能力" /></label>
          <div className="target-field"><span>启用到 Agent</span><label><input type="checkbox" checked={mainEnabled} onChange={(event) => setTarget("main", event.target.checked)} /> Main Agent</label><label><input type="checkbox" checked={subagentEnabled} onChange={(event) => setTarget("subagent", event.target.checked)} /> Subagent</label><label><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> 保存后立即启用</label></div>
          {isStdio && <div className="stdio-trust"><label><input type="checkbox" checked={draft.trusted} onChange={(event) => setDraft({ ...draft, trusted: event.target.checked })} /> 我信任此配置执行本地命令</label><p>{stdioAllowed ? "服务端已允许 stdio MCP。" : "服务端尚未开启。保存后不会执行，需在 .env 配置 ALLOW_STDIO_MCP=true 并重启。"}</p></div>}
        </div>
      </section>
      <section className="json-editor-card"><header><div><h2>完整的 JSON 配置</h2><p>支持 streamable_http、sse 和 stdio。HTTP 认证信息可放在 headers 中。</p></div><button onClick={formatJson}>✣ 格式化</button></header><div className="json-editor"><span>1</span><textarea spellCheck={false} value={json} onChange={(event) => setJson(event.target.value)} /></div></section>
      <div className="mcp-security-note"><strong>安全边界</strong><span>stdio 会启动本地进程；必须同时勾选信任并由服务端开启环境变量。MCP 配置保存在本机项目中，不会随聊天请求上传到浏览器存储。</span></div>
    </>}
    <footer className="sticky-editor-footer"><Link href="/mcp">取消</Link><button className="primary" disabled={saving || loading} onClick={() => void save()}>{saving ? "保存中…" : id ? "保存修改" : "＋ 添加"}</button></footer>
  </main>;
}
