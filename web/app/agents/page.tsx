"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ManagementHeader } from "@/components/management-header";
import { AgentPermissionEditor } from "@/components/agent-permission-editor";
import { emptyPermissions, type AgentPermissions } from "@/lib/agent-permissions";

type Collaboration = "handoff" | "tool" | "both";
type WorkspaceAccess = "none" | "read" | "write";
type AgentDefinition = {
  id: string; name: string; description: string; instructions: string; model: string;
  collaboration: Collaboration; coreTools: boolean; webTools: boolean; workspaceAccess: WorkspaceAccess;
  skillsEnabled: boolean; mcpEnabled: boolean; maxTurns: number | null; enabled: boolean;
  sortOrder: number; createdAt: number; updatedAt: number;
  permissions: AgentPermissions; permissionsMigrated?: boolean;
};
type Draft = Omit<AgentDefinition, "id" | "createdAt" | "updatedAt">;

const empty: Draft = {
  name: "", description: "", instructions: "", model: "", collaboration: "tool",
  coreTools: false, webTools: false, workspaceAccess: "none", skillsEnabled: false,
  mcpEnabled: false, maxTurns: 15, enabled: true, sortOrder: 50,
  permissions: emptyPermissions(),
};
const collaborationLabels: Record<Collaboration, string> = { handoff: "Handoff 接管", tool: "Tool 委派", both: "Handoff + Tool" };
const workspaceLabels: Record<WorkspaceAccess, string> = { none: "无工作区", read: "工作区只读", write: "工作区读写/执行" };

function payload(agent: AgentDefinition | Draft): Draft {
  return {
    name: agent.name, description: agent.description, instructions: agent.instructions, model: agent.model,
    collaboration: agent.collaboration, coreTools: agent.coreTools, webTools: agent.webTools,
    workspaceAccess: agent.workspaceAccess, skillsEnabled: agent.skillsEnabled, mcpEnabled: agent.mcpEnabled,
    maxTurns: agent.maxTurns, enabled: agent.enabled, sortOrder: agent.sortOrder,
    permissions: agent.permissions,
  };
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [editing, setEditing] = useState<AgentDefinition | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [permissionsReady, setPermissionsReady] = useState(false);
  const [migrating, setMigrating] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/agents", { cache: "no-store" }); const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Agent 配置加载失败");
      setAgents(data.agents); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "加载失败"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const counts = useMemo(() => ({
    enabled: agents.filter((agent) => agent.enabled).length,
    handoff: agents.filter((agent) => agent.enabled && agent.collaboration !== "tool").length,
    tools: agents.filter((agent) => agent.enabled && agent.collaboration !== "handoff").length,
  }), [agents]);
  async function migrate(agent: AgentDefinition) {
    if (agent.permissionsMigrated !== false) return agent;
    setMigrating(true);
    try {
      const response = await fetch(`/api/agents/${agent.id}/migrate`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "旧权限迁移失败");
      await refresh();
      return data.agent as AgentDefinition;
    } finally { setMigrating(false); }
  }
  async function edit(agent?: AgentDefinition) {
    try {
    if (agent) agent = await migrate(agent);
    setPermissionsReady(false);
    setEditing(agent ?? null); setDraft(agent ? payload(agent) : { ...empty, sortOrder: (agents.length + 1) * 10 }); setOpen(true); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "迁移失败"); }
  }
  async function save() {
    setSaving(true);
    try {
      const response = await fetch(editing ? `/api/agents/${editing.id}` : "/api/agents", {
        method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft),
      });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "保存失败");
      setOpen(false); setEditing(null); setDraft(empty); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setSaving(false); }
  }
  async function update(agent: AgentDefinition, patch: Partial<Draft>) {
    try {
    agent = await migrate(agent);
    const response = await fetch(`/api/agents/${agent.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload(agent), ...patch }) });
    const data = await response.json(); if (!response.ok) { setError(data.error || "更新失败"); return; } await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "更新失败"); }
  }
  async function remove(agent: AgentDefinition) {
    if (!window.confirm(`确定删除 Agent「${agent.name}」吗？`)) return;
    const response = await fetch(`/api/agents/${agent.id}`, { method: "DELETE" });
    if (!response.ok) { const data = await response.json(); setError(data.error || "删除失败"); return; } await refresh();
  }
  async function installTemplate() {
    const response = await fetch("/api/agents/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ template: "planner_executor_reviewer" }) });
    const data = await response.json(); if (!response.ok) { setError(data.error || "模板安装失败"); return; } await refresh();
  }

  return <main className="management-page agents-page">
    <ManagementHeader current="agents" eyebrow="MULTI-AGENT ORCHESTRATION" title="Agent 编排" description="配置 Main Agent 可调用或交接的专家角色；权限在宿主侧生效，不依赖专家自觉声明。" actions={<><button className="template-action" disabled={migrating} onClick={() => void installTemplate()}>安装 Planner 模板</button><button className="management-primary-action" disabled={migrating} onClick={() => void edit()}>＋ 新建 Agent</button></>} />
    {error && <div className="management-error">{error}</div>}
    {migrating && <div className="permission-migration" role="status">正在将旧权限转换为显式清单；若已启用 MCP，会连接服务读取当前工具列表…</div>}
    <section className="management-summary"><div><strong>{agents.length}</strong><span>专家总数</span></div><div><strong>{counts.enabled}</strong><span>已启用</span></div><div><strong>{counts.handoff}</strong><span>可 Handoff</span></div><div><strong>{counts.tools}</strong><span>可 Tool 委派</span></div><p>配置变更从下一次 Agent Run 生效。</p></section>
    <section className="orchestration-map"><article className="orchestration-main"><i /><div><strong>Main Agent</strong><span>决策、委派、交接与最终汇总</span></div></article><div className="orchestration-line" /><div className="orchestration-agents">{agents.filter((agent) => agent.enabled).map((agent) => <article key={agent.id}><i /><strong>{agent.name}</strong><span>{collaborationLabels[agent.collaboration]}</span></article>)}</div></section>
    <section className="agent-definition-list">
      {loading ? <div className="asset-empty">正在加载…</div> : agents.length === 0 ? <div className="asset-empty"><strong>还没有专家 Agent</strong><span>创建一个 Agent，或安装 Planner–Executor–Reviewer 模板。</span></div> : agents.map((agent) => <article className={`agent-definition ${agent.enabled ? "enabled" : ""}`} key={agent.id}>
        <div className="agent-definition-main"><span className={`asset-dot ${agent.enabled ? "enabled" : ""}`} /><div><div className="asset-name"><strong>{agent.name}</strong><b>{collaborationLabels[agent.collaboration]}</b>{agent.model && <b>{agent.model}</b>}</div><p>{agent.description}</p><div className="agent-capability-chips">{agent.permissionsMigrated === false ? <span>旧配置 · 编辑时迁移</span> : <><span>{agent.permissions.tools.length} Tools</span><span>{agent.permissions.skills.length} Skills</span><span>{agent.permissions.mcp.reduce((count, grant) => count + grant.tools.length, 0)} MCP Tools</span></>}<span>{workspaceLabels[agent.workspaceAccess]}</span><span>{agent.maxTurns === null ? "默认循环" : `${agent.maxTurns} turns`}</span></div></div></div>
        <div className="asset-actions"><label className="agent-toggle"><input type="checkbox" disabled={migrating} checked={agent.enabled} onChange={(event) => void update(agent, { enabled: event.target.checked })} /><span>{agent.enabled ? "已启用" : "已停用"}</span></label><button disabled={migrating} onClick={() => void edit(agent)}>编辑</button><button className="danger" disabled={migrating} onClick={() => void remove(agent)}>删除</button></div>
      </article>)}
    </section>
    <aside className={`editor-drawer agent-editor ${open ? "open" : ""}`}>
      <header><div><span>AGENT DEFINITION</span><h2>{editing ? "编辑专家 Agent" : "新建专家 Agent"}</h2></div><button onClick={() => setOpen(false)}>×</button></header>
      <div className="editor-body">
        <label><span>Agent 名称 *</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：代码审查员" /></label>
        <label><span>职责描述 *</span><input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="帮助 Main Agent 判断什么时候使用它" /></label>
        <div className="agent-editor-grid"><label><span>协作方式</span><select value={draft.collaboration} onChange={(event) => setDraft({ ...draft, collaboration: event.target.value as Collaboration })}><option value="tool">Tool 委派</option><option value="handoff">Handoff 接管</option><option value="both">两者都支持</option></select></label><label><span>模型覆盖</span><input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="留空继承 Subagent 模型" /></label><label><span>最大循环</span><input type="number" min={1} max={500} value={draft.maxTurns ?? ""} placeholder="留空继承运行时设置" onChange={(event) => setDraft({ ...draft, maxTurns: event.target.value ? Number(event.target.value) : null })} /></label></div>
        <label className="agent-instructions-field">
          <span className="agent-field-heading"><b>专家角色提示词（追加）*</b><small>{draft.instructions.length} 字符</small></span>
          <textarea value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} placeholder="在共享 Subagent 提示词之上，定义这个专家特有的角色、目标、输出格式和能力边界。" />
          <small className="agent-prompt-order">运行时顺序：共享 Subagent 提示词 → 本专家角色提示词 → 宿主权限与工具约束。</small>
        </label>
        {open && <AgentPermissionEditor value={draft.permissions} onChange={(permissions) => setDraft((current) => ({ ...current, permissions }))} onReady={setPermissionsReady} />}
        {open && error && <div className="management-error" role="alert">{error}</div>}
      </div>
      <footer><button onClick={() => setOpen(false)}>取消</button><button className="primary" disabled={saving || !permissionsReady || !draft.name.trim() || !draft.description.trim() || !draft.instructions.trim()} onClick={() => void save()}>{saving ? "保存中…" : "保存 Agent"}</button></footer>
    </aside>
    {open && <button className="drawer-backdrop" onClick={() => setOpen(false)} aria-label="关闭编辑器" />}
  </main>;
}
