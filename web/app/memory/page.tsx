"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

import { ManagementHeader } from "@/components/management-header";
import type { CompactionSettings } from "@/lib/compaction-types";

type Memory = { id: string; scope: "global" | "session"; sessionId?: string; content: string; tags: string[]; enabled: boolean; updatedAt: number };
type ContextData = CompactionSettings & { sessionId: string; summary: string; autoCompact: boolean; recentItemLimit: number; updatedAt: number };
type Stats = { itemCount: number; estimatedTokens: number };

export default function MemoryPage() {
  const [sessionId, setSessionId] = useState("");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [context, setContext] = useState<ContextData | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<"global" | "session">("global");
  const [tags, setTags] = useState("");
  const [error, setError] = useState("");

  useEffect(() => setSessionId(localStorage.getItem("agent-studio:session") ?? ""), []);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const [memoryResponse, contextResponse] = await Promise.all([
        fetch(`/api/memories?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" }),
        fetch(`/api/context/${encodeURIComponent(sessionId)}`, { cache: "no-store" }),
      ]);
      const memoryData = await memoryResponse.json(); const contextResult = await contextResponse.json();
      if (!memoryResponse.ok || !contextResponse.ok) throw new Error(memoryData.error || contextResult.error || "加载失败");
      setMemories(memoryData.memories); setContext(contextResult.context); setStats(contextResult.stats); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "加载失败"); }
  }, [sessionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function addMemory(event: FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/memories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope, sessionId: scope === "session" ? sessionId : undefined, content, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean) }) });
    const data = await response.json();
    if (!response.ok) { setError(data.error || "添加失败"); return; }
    setContent(""); setTags(""); await refresh();
  }

  async function patchMemory(id: string, patch: { enabled?: boolean; content?: string }) {
    await fetch(`/api/memories/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    await refresh();
  }

  async function removeMemory(id: string) { await fetch(`/api/memories/${id}`, { method: "DELETE" }); await refresh(); }

  async function editMemory(memory: Memory) {
    const next = window.prompt("编辑长期记忆", memory.content)?.trim();
    if (!next || next === memory.content) return;
    await patchMemory(memory.id, { content: next });
  }

  async function saveContext() {
    if (!context) return;
    const response = await fetch(`/api/context/${encodeURIComponent(sessionId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(context) });
    const data = await response.json(); if (!response.ok) { setError(data.error || "保存失败"); return; }
    setContext(data.context); setStats(data.stats);
  }

  return <main className="management-page memory-page">
    <ManagementHeader current="memory" eyebrow="CONTEXT ENGINEERING" title="上下文与长期记忆" description="原始历史保留在 SQLite；送入模型的上下文可压缩，长期记忆可跨会话或仅作用于当前会话。" />
    {error && <div className="management-error">{error}</div>}
    <section className="management-summary">
      <div><strong>{stats?.itemCount ?? 0}</strong><span>历史 Items</span></div><div><strong>{new Intl.NumberFormat("en", { notation: "compact" }).format(stats?.estimatedTokens ?? 0)}</strong><span>估算 Token</span></div>
      <div><strong>{memories.filter((item) => item.enabled).length}</strong><span>启用记忆</span></div><p>当前 Session：<code>{sessionId || "—"}</code></p>
    </section>
    <section className="memory-grid">
      <article className="memory-card"><header><div><strong>上下文压缩</strong><p>每次模型请求前检查 Token 预算，达到阈值后滚动总结较早历史；保留最近完整交互和当前要求。摘要调用会产生额外 Token 费用。</p></div><button onClick={() => void saveContext()}>保存</button></header>
        {context && <div className="context-form">
          <label className="memory-switch"><input type="checkbox" checked={context.autoCompact} onChange={(event) => setContext({ ...context, autoCompact: event.target.checked })} /><span>自动语义压缩</span></label>
          <label><span>优先保留最近 Items（预算不足时缩减，不拆工具配对）</span><input type="number" min={10} max={200} value={context.recentItemLimit} onChange={(event) => setContext({ ...context, recentItemLimit: Number(event.target.value) })} /></label>
          <label><span>触发比例 %</span><input type="number" min={40} max={90} value={context.triggerPercent} onChange={(event) => setContext({ ...context, triggerPercent: Number(event.target.value) })} /></label>
          <label><span>压缩目标 %（至少低于触发 10%）</span><input type="number" min={20} max={80} value={context.targetPercent} onChange={(event) => setContext({ ...context, targetPercent: Number(event.target.value) })} /></label>
          <label><span>摘要输出预算 Token</span><input type="number" min={256} max={8192} value={context.summaryTokens} onChange={(event) => setContext({ ...context, summaryTokens: Number(event.target.value) })} /></label>
          <label><span>未知窗口时的压缩预算（不是模型容量）</span><input type="number" min={4096} max={1000000} value={context.fallbackTokenBudget} onChange={(event) => setContext({ ...context, fallbackTokenBudget: Number(event.target.value) })} /></label>
          <label className="summary-field"><span>补充上下文 / 旧版摘要（人工维护，不作为新滚动摘要）</span><textarea value={context.summary} onChange={(event) => setContext({ ...context, summary: event.target.value })} placeholder="可填写需要长期保留的任务背景；自动生成的分 Agent 摘要请在聊天输入框的上下文圆环中查看。" /></label>
        </div>}
      </article>
      <article className="memory-card"><header><div><strong>新增长期记忆</strong><p>启用的记忆会注入 Main Agent 与 Subagent 的系统上下文。</p></div></header><form className="memory-create" onSubmit={(event) => void addMemory(event)}><textarea required value={content} onChange={(event) => setContent(event.target.value)} placeholder="例如：用户偏好中文回答，并希望先给结论。" /><div><select value={scope} onChange={(event) => setScope(event.target.value as "global" | "session")}><option value="global">全局记忆</option><option value="session">当前会话</option></select><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签，逗号分隔" /><button disabled={!content.trim()}>添加</button></div></form></article>
    </section>
    <section className="memory-list-card"><header><strong>已保存记忆</strong><span>{memories.length} 条</span></header>{memories.length === 0 ? <div className="asset-empty"><strong>还没有长期记忆</strong><span>添加后会从下一次 Agent Run 开始生效。</span></div> : memories.map((memory) => <article className="memory-row" key={memory.id}><label><input type="checkbox" checked={memory.enabled} onChange={(event) => void patchMemory(memory.id, { enabled: event.target.checked })} /><span /></label><div><strong>{memory.content}</strong><p>{memory.scope === "global" ? "全局" : `Session · ${memory.sessionId}`} {memory.tags.length ? `· ${memory.tags.join(" · ")}` : ""}</p></div><div className="memory-row-actions"><button onClick={() => void editMemory(memory)}>编辑</button><button onClick={() => void removeMemory(memory.id)}>删除</button></div></article>)}</section>
  </main>;
}
