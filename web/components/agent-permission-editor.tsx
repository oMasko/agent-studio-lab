"use client";

import { useEffect, useState } from "react";
import { type AgentPermissions, type PermissionCatalog } from "@/lib/agent-permissions";

type McpTool = { name: string; description: string };
type Discovery = { loading?: boolean; tools?: McpTool[]; error?: string };
const toggle = (values: string[], value: string) => values.includes(value) ? values.filter((item) => item !== value) : [...values, value];

export function AgentPermissionEditor({ value, onChange, onReady }: {
  value: AgentPermissions; onChange: (value: AgentPermissions) => void; onReady: (ready: boolean) => void;
}) {
  const [catalog, setCatalog] = useState<PermissionCatalog | null>(null);
  const [error, setError] = useState("");
  const [discoveries, setDiscoveries] = useState<Record<string, Discovery>>({});
  const [tab, setTab] = useState<"tools" | "skills" | "mcp">("tools");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [response, configResponse] = await Promise.all([fetch("/api/agents/capabilities", { cache: "no-store" }), fetch("/api/config", { cache: "no-store" })]);
        if (!response.ok || !configResponse.ok) throw new Error("能力清单加载失败，请关闭后重新打开编辑器。");
        const next: PermissionCatalog = await response.json();
        const publicConfig = await configResponse.json();
        let local = {};
        try { local = JSON.parse(localStorage.getItem("agent-studio:model-settings") ?? "{}"); } catch { /* use server defaults */ }
        const config = { ...publicConfig.config, ...local };
        next.tools = next.tools.map((item) => {
          const reason = item.group === "联网" && !config.webSearchEnabled ? "当前聊天设置未启用联网"
            : item.name === "web_search" && !(config.provider === "openai" || publicConfig.providers.openai.hasServerApiKey) ? "搜索后端缺少 OpenAI API Key" : item.reason;
          return { ...item, available: !reason, reason };
        });
        if (active) { setCatalog(next); onReady(true); }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "加载失败"); }
    }
    void load();
    return () => { active = false; };
  }, [onReady]);

  async function discover(id: string) {
    setDiscoveries((current) => ({ ...current, [id]: { ...current[id], loading: true, error: undefined } }));
    try {
      const response = await fetch(`/api/agents/mcp/${id}/tools`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "工具发现失败");
      setDiscoveries((current) => ({ ...current, [id]: { tools: data.tools } }));
    } catch (reason) {
      setDiscoveries((current) => ({ ...current, [id]: { error: reason instanceof Error ? reason.message : "连接失败" } }));
    }
  }
  function setMcp(id: string, tools: string[]) {
    onChange({ ...value, mcp: [...value.mcp.filter((grant) => grant.serverId !== id), ...(tools.length ? [{ serverId: id, tools }] : [])] });
  }
  const totalMcp = value.mcp.reduce((sum, grant) => sum + grant.tools.length, 0);
  const unavailableSkills = value.skills.filter((name) => !catalog?.skills.some((skill) => skill.name === name));
  const missingServers = value.mcp.filter((grant) => !catalog?.servers.some((server) => server.id === grant.serverId));
  const preview = catalog ? [
    ...value.tools.map((name) => ({ name, status: catalog.tools.find((item) => item.name === name)?.reason || "可挂载" })),
    ...value.skills.map((name) => { const skill = catalog.skills.find((item) => item.name === name); return { name: `Skill · ${name}`, status: skill ? skill.reason || "可加载" : "已删除或不可用" }; }),
    ...value.mcp.flatMap((grant) => grant.tools.map((name) => {
      const server = catalog.servers.find((item) => item.id === grant.serverId);
      const discovery = discoveries[grant.serverId];
      return { name: `${server?.label || grant.serverId} · ${name}`, status: !server ? "服务已删除" : server.reason || (discovery?.error ? "连接失败" : discovery?.tools ? (discovery.tools.some((tool) => tool.name === name) ? "已发现，可挂载" : "工具已移除") : "连接及工具存在性待运行时确认") };
    })),
  ] : [];

  return <section className="permission-editor" aria-label="专家能力权限">
    <div className="permission-heading"><div><strong>能力清单</strong><p>仅勾选项会授予当前专家；空清单不授予工具。</p></div><span>{value.tools.length + value.skills.length + totalMcp} 项已选</span></div>
    <div className="permission-tabs" role="tablist" aria-label="能力类型">
      {([ ["tools", "Tools", value.tools.length], ["skills", "Skills", value.skills.length], ["mcp", "MCP", totalMcp] ] as const).map(([id, label, count]) => <button type="button" key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}<b>{count}</b></button>)}
    </div>
    {error ? <p role="alert" className="permission-error">{error}</p> : !catalog ? <p className="permission-empty">正在加载能力清单…</p> : <>
      {tab === "tools" && <div className="permission-options">{catalog.tools.map((item) => <label className="permission-option" key={item.name}>
        <input type="checkbox" checked={value.tools.includes(item.name as AgentPermissions["tools"][number])} onChange={() => onChange({ ...value, tools: toggle(value.tools, item.name) as AgentPermissions["tools"] })} />
        <span><strong>{item.label}<code>{item.name}</code></strong><small>{item.reason || item.description}</small></span><em>{item.available ? item.group : "暂不可用"}</em>
      </label>)}</div>}
      {tab === "skills" && <div className="permission-options">
        {!catalog.skills.length && <p className="permission-empty">还没有安装 Skill。可先到 Skills 管理页导入。</p>}
        {catalog.skills.map((item) => <label className="permission-option" key={item.name}><input type="checkbox" checked={value.skills.includes(item.name)} onChange={() => onChange({ ...value, skills: toggle(value.skills, item.name) })} /><span><strong>{item.name}</strong><small>{item.reason || item.description}</small></span><em>{item.available ? "可加载" : "暂不可用"}</em></label>)}
        {unavailableSkills.map((name) => <label className="permission-option" key={name}><input type="checkbox" checked onChange={() => onChange({ ...value, skills: value.skills.filter((item) => item !== name) })} /><span><strong>{name}</strong><small>已删除或不可用，取消勾选可移除授权。</small></span></label>)}
      </div>}
      {tab === "mcp" && <div className="permission-servers">
        {!catalog.servers.length && <p className="permission-empty">还没有配置 MCP 服务。可先到 MCP 管理页添加。</p>}
        {catalog.servers.map((server) => {
          const discovery = discoveries[server.id];
          const selected = value.mcp.find((grant) => grant.serverId === server.id)?.tools ?? [];
          const items = [...(discovery?.tools ?? []), ...selected.filter((name) => !discovery?.tools?.some((item) => item.name === name)).map((name) => ({ name, description: discovery?.tools ? "工具已移除，可取消授权" : "已保存授权，点击发现工具核对" }))];
          return <div className="permission-server" key={server.id}>
            <div className="permission-server-heading"><div><strong>{server.label}</strong><small>{server.reason || `已选 ${selected.length} 个工具`}</small></div><button type="button" disabled={!server.available || discovery?.loading} onClick={() => void discover(server.id)}>{discovery?.loading ? "连接中…" : "发现 / 刷新工具"}</button></div>
            {discovery?.error && <p role="alert" className="permission-error">{discovery.error}；已有选择保留，可重试。</p>}
            {discovery?.tools && <div className="permission-batch"><button type="button" onClick={() => setMcp(server.id, discovery.tools!.map((item) => item.name))}>选择当前全部 {discovery.tools.length} 项</button><button type="button" onClick={() => setMcp(server.id, [])}>清空</button></div>}
            {items.map((item) => <label className="permission-option" key={item.name}><input type="checkbox" checked={selected.includes(item.name)} onChange={() => setMcp(server.id, toggle(selected, item.name))} /><span><strong>{item.name}</strong><small>{item.description || "未提供工具描述"}</small></span></label>)}
          </div>;
        })}
        {missingServers.map((grant) => <div className="permission-server" key={grant.serverId}><p>服务已删除：{grant.serverId}（{grant.tools.length} 项授权无效）</p><button type="button" onClick={() => setMcp(grant.serverId, [])}>移除失效授权</button></div>)}
        <p className="permission-footnote">整组选择仅保存当前工具清单。服务以后新增工具，需要重新勾选。</p>
      </div>}
      <details className="permission-preview" open><summary>生效范围预览</summary>
        {preview.length ? <ul>{preview.map((item, index) => <li key={`${item.name}-${index}`}><code>{item.name}</code><span>{item.status}</span></li>)}</ul> : <p>未授予任何工具或 Skill，专家仅能根据对话内容作答。</p>}
        {!!value.skills.length && <p>可用 Skill 会附带 load_skill / read_skill_file，参数也受所选 Skill 名单限制。</p>}
        <p>预览基于当前设置；运行时会再次核验可用性，安全策略仍可拒绝或要求审批。Skill 选择不限制已另行授权的文件读取或命令执行范围。</p>
      </details>
    </>}
  </section>;
}
