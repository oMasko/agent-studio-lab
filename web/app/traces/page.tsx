"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ManagementHeader } from "@/components/management-header";
import type { AgentTrace, TraceEvent, TraceStatus, TraceSummary } from "@/lib/trace-store";

const statusLabels: Record<TraceStatus, string> = {
  running: "运行中",
  awaiting_approval: "等待审批",
  completed: "已完成",
  blocked: "已拦截",
  failed: "失败",
  cancelled: "已取消",
};

const eventLabels: Record<TraceEvent["type"], string> = {
  run_start: "RUN",
  agent_start: "AGENT",
  agent_end: "AGENT",
  agent_handoff: "HANDOFF",
  tool_start: "TOOL",
  tool_end: "TOOL",
  hosted_tool: "HOSTED TOOL",
  approval_required: "APPROVAL",
  approval_decision: "APPROVAL",
  approval_grant_created: "GRANT",
  approval_grant_used: "GRANT",
  guardrail_blocked: "GUARDRAIL",
  run_end: "RUN",
  run_error: "ERROR",
  compaction_start: "COMPACT",
  compaction_end: "COMPACT",
  compaction_failed: "COMPACT",
};

function duration(value?: number): string {
  if (typeof value !== "number") return "—";
  if (value < 1_000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(2)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function eventData(event: TraceEvent): string {
  if (typeof event.data === "undefined") return "";
  return JSON.stringify(event.data, null, 2);
}

function ExecutionGraph({ trace }: { trace: AgentTrace }) {
  const agentNames = [...new Set(trace.events
    .filter((event) => event.type === "agent_start" && event.agentName)
    .map((event) => event.agentName!))];
  if (agentNames.length === 0) agentNames.push("Main Agent");
  const toolsByAgent = new Map<string, string[]>();
  for (const event of trace.events) {
    if (event.type !== "tool_start" || !event.toolName) continue;
    const agent = event.agentName ?? agentNames[0];
    const tools = toolsByAgent.get(agent) ?? [];
    if (!tools.includes(event.toolName)) tools.push(event.toolName);
    toolsByAgent.set(agent, tools);
  }
  const handoffCount = trace.events.filter((event) => event.type === "agent_handoff").length;
  const handoffTargets = new Set(trace.events.filter((event) => event.type === "agent_handoff").map((event) => {
    const data = event.data && typeof event.data === "object" ? event.data as { toAgent?: unknown } : undefined;
    return typeof data?.toAgent === "string" ? data.toAgent : event.agentName;
  }).filter((name): name is string => Boolean(name)));
  const completedAgents = new Set(trace.events
    .filter((event) => event.type === "agent_end" && event.agentName)
    .map((event) => event.agentName!));
  return <section className="execution-graph">
    <header><div><strong>Agent 执行图</strong><span>由真实 Hook 事件生成</span></div><small>{agentNames.length} Agents · {[...toolsByAgent.values()].reduce((sum, tools) => sum + tools.length, 0)} Tools · {handoffCount} Handoffs</small></header>
    <div className="graph-flow">
      {agentNames.map((agentName, index) => <div className="graph-stage" key={agentName}>
        {index > 0 && <div className="graph-arrow"><span>{handoffTargets.has(agentName) ? "HANDOFF" : "TOOL"}</span>→</div>}
        <article className={`graph-agent ${index === 0 ? "main" : "subagent"}`}>
          <div className="graph-agent-head"><i /><div><strong>{agentName}</strong><span>{index === 0 ? "Main Agent" : "Subagent"}</span></div><b className={completedAgents.has(agentName) ? "done" : trace.status}>{completedAgents.has(agentName) ? "完成" : statusLabels[trace.status]}</b></div>
          <div className="graph-tools">{(toolsByAgent.get(agentName) ?? []).length === 0
            ? <span className="graph-empty-tool">未调用工具</span>
            : (toolsByAgent.get(agentName) ?? []).map((tool) => <span key={tool}>⌁ {tool}</span>)}</div>
        </article>
      </div>)}
    </div>
  </section>;
}

export default function TracesPage() {
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<AgentTrace | null>(null);
  const [status, setStatus] = useState<"all" | TraceStatus>("all");
  const [sessionQuery, setSessionQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch("/api/traces?limit=200", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Trace 加载失败");
      const next = data.traces as TraceSummary[];
      setTraces(next);
      setSelectedId((current) => current && next.some((item) => item.id === current) ? current : next[0]?.id ?? "");
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Trace 加载失败");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 4_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("trace");
    if (requested) setSelectedId(requested);
  }, []);

  useEffect(() => {
    if (!selectedId) { setSelected(null); return; }
    let cancelled = false;
    setDetailLoading(true);
    fetch(`/api/traces/${selectedId}`, { cache: "no-store" }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Trace 详情加载失败");
      if (!cancelled) setSelected(data.trace as AgentTrace);
    }).catch((reason: Error) => { if (!cancelled) setError(reason.message); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId, traces]);

  const visible = useMemo(() => traces.filter((trace) => {
    if (status !== "all" && trace.status !== status) return false;
    const query = sessionQuery.trim().toLowerCase();
    return !query || trace.sessionId.toLowerCase().includes(query) || trace.id.toLowerCase().includes(query);
  }), [sessionQuery, status, traces]);

  async function clearAll() {
    if (!window.confirm("确定清空全部本地 Trace 日志吗？此操作无法撤销。")) return;
    const response = await fetch("/api/traces", { method: "DELETE" });
    if (!response.ok) { const data = await response.json(); setError(data.error || "清空失败"); return; }
    setSelected(null);
    setSelectedId("");
    await refresh();
  }

  return <main className="management-page trace-page">
    <ManagementHeader current="traces" eyebrow="AGENT OBSERVABILITY" title="Trace 监控" description="查看 Agent、工具、Subagent、审批与安全围栏的完整运行时间线。" actions={<button className="trace-clear" disabled={traces.length === 0} onClick={() => void clearAll()}>清空日志</button>} />
    {error && <div className="management-error">{error}</div>}
    <section className="management-summary trace-summary">
      <div><strong>{traces.length}</strong><span>Trace 总数</span></div>
      <div><strong>{traces.filter((item) => item.status === "completed").length}</strong><span>成功完成</span></div>
      <div><strong>{traces.filter((item) => item.status === "blocked" || item.status === "failed").length}</strong><span>拦截 / 失败</span></div>
      <p><i className="trace-live-dot" /> 每 4 秒自动刷新，本地日志已做基础脱敏。</p>
    </section>

    <section className="trace-workspace">
      <aside className="trace-list-panel">
        <div className="trace-filters">
          <input value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder="搜索 Session ID / Trace ID" />
          <select value={status} onChange={(event) => setStatus(event.target.value as "all" | TraceStatus)}>
            <option value="all">全部状态</option>
            {Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
        </div>
        <div className="trace-list">
          {loading ? <div className="trace-placeholder">正在加载 Trace…</div> : visible.length === 0 ? <div className="trace-placeholder"><strong>还没有监控日志</strong><span>回到聊天页发送一条消息，这里就会生成第一条 Trace。</span></div> : visible.map((trace) => <button className={`trace-list-item ${selectedId === trace.id ? "active" : ""}`} onClick={() => setSelectedId(trace.id)} key={trace.id}>
            <div><span className={`trace-status ${trace.status}`}>{statusLabels[trace.status]}</span><time>{new Date(trace.startedAt).toLocaleString("zh-CN")}</time></div>
            <strong>{trace.inputPreview || "无输入摘要"}</strong>
            <p>{trace.sessionId}</p>
            <footer><span>{trace.provider} · {trace.model}</span><span>{trace.eventCount} events · {duration(trace.durationMs)}</span></footer>
          </button>)}
        </div>
      </aside>

      <article className="trace-detail-panel">
        {!selectedId ? <div className="trace-placeholder"><strong>选择一条 Trace</strong><span>右侧会展示运行信息和生命周期事件。</span></div> : detailLoading && !selected ? <div className="trace-placeholder">正在加载详情…</div> : selected && <>
          <header className="trace-detail-header">
            <div><span className={`trace-status ${selected.status}`}>{statusLabels[selected.status]}</span><h2>{selected.inputPreview || "Agent Run"}</h2><code>{selected.id}</code></div>
            <dl><div><dt>Provider / Model</dt><dd>{selected.provider} / {selected.model}</dd></div><div><dt>Session</dt><dd>{selected.sessionId}</dd></div><div><dt>总耗时</dt><dd>{duration(selected.durationMs)}</dd></div><div><dt>开始时间</dt><dd>{new Date(selected.startedAt).toLocaleString("zh-CN")}</dd></div></dl>
          </header>
          <ExecutionGraph trace={selected} />
          <div className="trace-timeline">
            {selected.events.map((event) => <section className={`trace-event ${event.scope}`} key={event.id}>
              <div className="trace-event-rail"><i /><span /></div>
              <div className="trace-event-card">
                <header><b>{eventLabels[event.type]}</b><strong>{event.title}</strong><time>+{duration(event.elapsedMs)}</time></header>
                {(event.agentName || event.toolName) && <p className="trace-event-meta">{event.agentName && <span>Agent: {event.agentName}</span>}{event.toolName && <span>Tool: {event.toolName}</span>}<span>Scope: {event.scope}</span></p>}
                {eventData(event) && <details><summary>查看事件数据</summary><pre>{eventData(event)}</pre></details>}
              </div>
            </section>)}
          </div>
        </>}
      </article>
    </section>
  </main>;
}
