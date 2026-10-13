"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ManagementHeader } from "@/components/management-header";

type RunStatus = "running" | "awaiting_approval" | "completed" | "blocked" | "failed" | "cancelled";
type RunItem = {
  id: string; sessionId: string; status: RunStatus; input: string; traceId?: string; error?: string;
  createdAt: number; updatedAt: number; completedAt?: number; active: boolean;
};

const labels: Record<RunStatus, string> = {
  running: "运行中", awaiting_approval: "等待审批", completed: "已完成", blocked: "已拦截", failed: "失败", cancelled: "已取消",
};

function elapsed(run: RunItem): string {
  const ms = (run.completedAt ?? Date.now()) - run.createdAt;
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

export default function RunsPage() {
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [filter, setFilter] = useState<"all" | RunStatus>("all");
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/runs?limit=200${filter === "all" ? "" : `&status=${filter}`}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Run 加载失败");
      setRuns(data.runs as RunItem[]);
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Run 加载失败"); }
  }, [filter]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const counts = useMemo(() => ({
    active: runs.filter((run) => run.status === "running" || run.status === "awaiting_approval").length,
    completed: runs.filter((run) => run.status === "completed").length,
    failed: runs.filter((run) => run.status === "failed" || run.status === "blocked").length,
  }), [runs]);

  async function act(run: RunItem, action: "cancel" | "retry") {
    setBusy((current) => new Set(current).add(run.id));
    try {
      const response = await fetch(`/api/runs/${run.id}/${action}`, { method: "POST" });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error || "操作失败"); }
      if (action === "retry" && response.body) {
        const reader = response.body.getReader();
        while (!(await reader.read()).done) { /* Drain SSE while the retried Run continues. */ }
      }
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败"); }
    finally { setBusy((current) => { const next = new Set(current); next.delete(run.id); return next; }); }
  }

  return <main className="management-page runs-page">
    <ManagementHeader current="runs" eyebrow="AGENT RUNTIME" title="运行中心" description="后台运行、审批等待、取消和失败重试都使用同一份持久化 Run 状态。" />
    {error && <div className="management-error">{error}</div>}
    <section className="management-summary">
      <div><strong>{runs.length}</strong><span>当前筛选</span></div><div><strong>{counts.active}</strong><span>活跃 / 等待</span></div>
      <div><strong>{counts.completed}</strong><span>已完成</span></div><div><strong>{counts.failed}</strong><span>失败 / 拦截</span></div>
      <p><i className="trace-live-dot" /> 每 2 秒同步服务端状态</p>
    </section>
    <section className="runs-panel">
      <header className="runs-toolbar"><strong>Run 列表</strong><select value={filter} onChange={(event) => setFilter(event.target.value as "all" | RunStatus)}><option value="all">全部状态</option>{Object.entries(labels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></header>
      {runs.length === 0 ? <div className="asset-empty"><strong>还没有 Run</strong><span>回到聊天页发送消息后，这里会显示运行记录。</span></div> : <div className="runs-list">{runs.map((run) => <article className="run-row" key={run.id}>
        <div className="run-state"><span className={`trace-status ${run.status}`}>{labels[run.status]}</span>{run.active && <i>LIVE</i>}</div>
        <div className="run-main"><strong>{run.input}</strong><p>{run.sessionId} · {run.id}</p>{run.error && <small>{run.error}</small>}</div>
        <div className="run-time"><span>{new Date(run.createdAt).toLocaleString("zh-CN")}</span><b>{elapsed(run)}</b></div>
        <div className="run-actions">
          {run.traceId && <Link href={`/traces?trace=${run.traceId}`}>执行图</Link>}
          {run.status === "awaiting_approval" && <Link href={`/?session=${encodeURIComponent(run.sessionId)}`}>处理审批</Link>}
          {(run.status === "running" || run.status === "awaiting_approval") && <button className="danger" disabled={busy.has(run.id)} onClick={() => void act(run, "cancel")}>停止</button>}
          {!["running", "awaiting_approval"].includes(run.status) && <button disabled={busy.has(run.id)} onClick={() => void act(run, "retry")}>{busy.has(run.id) ? "重试中…" : "重试"}</button>}
        </div>
      </article>)}</div>}
    </section>
  </main>;
}
