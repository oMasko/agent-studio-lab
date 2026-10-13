"use client";

import { useEffect, useRef, useState } from "react";
import type { EditableConfig } from "@/lib/config-types";
import { contextBudget, estimateContextTokens, type ContextAgentUsage, type ContextUsageView } from "@/lib/context-usage-types";

const number = (value: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);

function LimitEditor({ agent, onSaved }: { agent: ContextAgentUsage; onSaved: () => void }) {
  const [window, setWindow] = useState(agent.limits.contextWindow?.toString() ?? "");
  const [reserve, setReserve] = useState(agent.limits.outputReserve.toString());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function save() {
    setSaving(true); setError(""); setSaved(false);
    try {
      const response = await fetch("/api/context/limits", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity: agent.identity, limits: { contextWindow: window.trim() ? Number(window) : null, outputReserve: Number(reserve) } }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      setSaved(true); onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setSaving(false); }
  }
  return <details className="context-limit-editor"><summary>设置此模型的窗口上限</summary>
    <p>按 Provider、模型、Base URL 与 API 模式保存。请填入服务商公布的上限；留空表示未知。</p>
    <div><label>窗口 Token 上限<input type="number" min="1" max="100000000" value={window} placeholder="未知" onChange={(event) => setWindow(event.target.value)} /></label>
      <label>输出预留 Token<input type="number" min="0" value={reserve} onChange={(event) => setReserve(event.target.value)} /></label>
      <button type="button" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</button></div>
    <p>输出预留仅用于预算提示，不会修改模型的输出上限或自动截断请求。</p>
    {error && <p role="alert" className="context-usage-error">{error}</p>}{saved && <p role="status">已保存。</p>}
  </details>;
}

export function ContextUsage({ sessionId, config, busy, revision, draft }: {
  sessionId: string; config: EditableConfig; busy: boolean; revision: number; draft: string;
}) {
  const [data, setData] = useState<ContextUsageView | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState("main");
  const [refresh, setRefresh] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setExpanded(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [expanded]);
  const { provider, model, subagentModel, baseURL, apiMode } = config;
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    setError("");
    async function load() {
      try {
        const response = await fetch(`/api/context/${encodeURIComponent(sessionId)}/usage`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ provider, model, subagentModel, baseURL, apiMode }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "上下文统计读取失败");
        if (!controller.signal.aborted) { setData(result); setError(""); }
      } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "读取失败"); }
      finally {
        if (!controller.signal.aborted && (busy || expanded)) timer = setTimeout(() => void load(), busy ? 2500 : 10000);
      }
    }
    void load();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [sessionId, provider, model, subagentModel, baseURL, apiMode, busy, revision, refresh, expanded]);

  const agent = data?.agents.find((item) => item.agentId === selected) ?? data?.agents[0];
  const snapshot = agent?.snapshot;
  const budget = agent && snapshot ? contextBudget(snapshot.inputTokens, snapshot.outputTokens, agent.limits) : null;
  const percent = budget?.percent;
  const tone = percent != null && percent >= 90 ? "high" : percent != null && percent >= 75 ? "medium" : "normal";
  const compacting = agent?.compaction?.status === "running" && busy;
  const label = compacting ? "正在压缩…" : !data ? error ? "统计暂不可用" : "读取中…" : !snapshot ? "待测量" : percent == null ? "上限未知" : `${snapshot.source === "estimate" ? "约 " : ""}${Math.round(percent)}%`;

  return <div ref={root} className={`context-usage ${tone} ${compacting ? "compacting" : ""}`}>
    <button type="button" className="context-usage-trigger" aria-label={`上下文窗口使用情况：${label}`} aria-expanded={expanded} aria-controls="context-usage-panel" onClick={() => setExpanded((value) => !value)}>
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
        <circle className="context-ring-track" cx="12" cy="12" r="8" fill="none" strokeWidth="3" />
        {percent != null ? <circle className="context-ring-value" cx="12" cy="12" r="8" fill="none" strokeWidth="3" pathLength="100" strokeDasharray={`${Math.max(0, Math.min(100, percent))} 100`} transform="rotate(-90 12 12)" />
          : <circle className="context-ring-unknown" cx="12" cy="12" r="8" fill="none" strokeWidth="3" strokeDasharray="2 4" />}
      </svg>
    </button>
    {!expanded && <div className="context-ring-tooltip" role="tooltip"><strong>{agent?.agentName ?? "Main Agent"} 上下文 · {label}</strong>
      {budget && <span>{number(budget.used)} / {agent?.limits.contextWindow == null ? "未知" : number(agent.limits.contextWindow)} tok{percent != null ? ` · 剩余 ${Math.max(0, 100 - percent).toFixed(0)}%` : ""}</span>}
      <span>最近一次请求 · 点击查看详情和设置上限</span></div>}
    {expanded && <section id="context-usage-panel" className="context-usage-panel" aria-label="上下文窗口使用情况" onKeyDown={(event) => { if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault(); }}>
      <div className="context-usage-heading"><strong>上下文窗口使用情况</strong><button type="button" onClick={() => setExpanded(false)} aria-label="关闭上下文详情">×</button></div>
      {error && <p role="alert" className="context-usage-error">{error}<button type="button" onClick={() => setRefresh((value) => value + 1)}>重试</button></p>}
      {!data && !error && <p role="status">正在读取上下文统计…</p>}
      {data && agent && <>
        <label className="context-agent-selector">查看 Agent<select value={agent.agentId} onChange={(event) => setSelected(event.target.value)}>{data.agents.map((item) => <option key={item.agentId} value={item.agentId}>{item.agentName} · {item.identity.model}</option>)}</select></label>
        <p className="context-model-label">{agent.identity.provider} / {agent.identity.model} · {agent.identity.apiMode}</p>
        <p>窗口上限：{agent.limits.contextWindow?.toLocaleString() ?? "未知"} tok · {agent.limits.source === "official" ? <><a href={agent.limits.sourceURL} target="_blank" rel="noreferrer">官方文档</a>（核对于 {agent.limits.verifiedAt}）{agent.limits.approximate ? "，按文档 K/M 标称值取保守预算，可手动校准" : ""}</> : agent.limits.source === "manual" ? "手动设置" : "尚未收录此模型或服务端点，请手动设置"}</p>
        {snapshot && budget ? <>
          <div className="context-usage-value"><strong>{percent == null ? "上限未知" : `${snapshot.source === "estimate" ? "约 " : ""}${Math.round(percent)}%`}</strong><span>{number(budget.used)} / {agent.limits.contextWindow == null ? "未知" : number(agent.limits.contextWindow)} tok</span></div>
          {percent != null && <div className="context-usage-bar" role="meter" aria-label="上下文使用率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, percent)} aria-valuetext={`${Math.round(percent)}%`}><i style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} /></div>}
          <p>{snapshot.source === "provider" ? "接口报告的最近一次请求" : "最近一次请求的本地估算"} · {new Date(snapshot.updatedAt).toLocaleTimeString()} · {snapshot.status === "completed" ? "已返回" : snapshot.status === "requesting" && busy ? "请求中" : "未完成"}</p>
          <dl className="context-usage-numbers"><div><dt>输入</dt><dd>{number(snapshot.inputTokens)} tok</dd></div><div><dt>输出（含服务商计入的推理）</dt><dd>{snapshot.outputTokens === null ? "尚未报告" : `${number(snapshot.outputTokens)} tok`}</dd></div><div><dt>窗口剩余</dt><dd>{budget.remaining === null ? "未知" : `${number(budget.remaining)} tok`}</dd></div><div><dt>扣除输出预留后的输入预算</dt><dd>{budget.inputBudget === null ? "未知" : `${number(budget.inputBudget)} tok`}</dd></div></dl>
          {budget.inputBudget !== null && snapshot.inputTokens > budget.inputBudget && <p className="context-usage-warning">输入已超过预留输出后的预算，可压缩上下文或减少工具返回内容。</p>}
          <details className="context-breakdown"><summary>请求组成（各项均为估算）</summary><ul><li>系统提示词、Skill 目录与注入记忆：{number(snapshot.estimate.instructions)} tok</li><li>消息、工具调用与返回结果：{number(snapshot.estimate.messages)} tok</li><li>工具定义、Handoff 与输出格式：{number(snapshot.estimate.tools)} tok</li></ul><p>按文本特征粗估，不是模型 tokenizer；各项总和可能与接口报告不同。</p>{snapshot.estimate.partial && <p>请求引用了服务端历史或模板，本地估算不包含这些隐藏内容。</p>}</details>
        </> : <p className="context-usage-empty">该 Agent 在当前会话、当前模型配置下尚无请求记录。发起一次新任务后开始统计；旧累计 Token 不会被当成窗口占用。</p>}
        <div className="context-history"><strong>Token 预算自动压缩</strong>
          <p>自动压缩：{data.history.autoCompact ? "开启" : "关闭"} · 触发 {data.compactionSettings?.triggerPercent ?? 75}% / 目标 {data.compactionSettings?.targetPercent ?? 50}%（输出预留较大时提前触发）</p>
          <p>按含安全余量的 Token 估算判断，不等同于圆环实测百分比；摘要生成会额外调用当前模型。</p>
          {agent.limits.contextWindow === null && <p>模型窗口未知，暂按 {number(data.compactionSettings?.fallbackTokenBudget ?? 32000)} tok 的压缩预算工作；这不是模型实际容量。</p>}
          <p>Main 原始历史：{data.history.storedItems} 项，约 {number(data.history.estimatedTokens)} tok；原始记录不删除。当前所选 Agent 最近请求实际发送 {snapshot?.effectiveItems ?? "—"} 项。</p>
          {agent.compaction && <><p role="status">{compacting ? "正在生成滚动摘要…" : agent.compaction.status === "running" ? "上次压缩未完成，可在下一次请求重试。" : agent.compaction.message}</p>
            <p>已压缩 {agent.compaction.count} 次 · 最近压缩前约 {number(agent.compaction.beforeTokens)} tok → {agent.compaction.afterTokens === null ? "未完成" : `约 ${number(agent.compaction.afterTokens)} tok`}</p>
            <p>本次摘要额外消耗：输入 {number(agent.compaction.summaryInputTokens)} / 输出 {number(agent.compaction.summaryOutputTokens)} tok（与主任务累计统计分开）</p>
            {agent.compaction.summary && <details className="context-breakdown"><summary>查看当前滚动摘要</summary><pre className="context-summary-text">{agent.compaction.summary}</pre></details>}</>}
          <a href="/memory">管理压缩预算与补充上下文 ↗</a></div>
        {draft.trim() && <p>未发送草稿约 {number(estimateContextTokens(draft))} tok，尚未计入上方请求。</p>}
        <LimitEditor key={JSON.stringify([agent.identity, agent.limits])} agent={agent} onSaved={() => setRefresh((value) => value + 1)} />
        <p className="context-usage-footnote">显示最近一次模型请求的输入 + 已报告输出，不是会话累计消耗，也不是下一次请求的精确预测。各专家单独统计；缓存输入仍占上下文。</p>
      </>}
    </section>}
  </div>;
}
