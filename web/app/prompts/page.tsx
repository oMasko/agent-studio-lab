"use client";

import { useCallback, useEffect, useState } from "react";

import { ManagementHeader } from "@/components/management-header";

type PromptPreset = {
  id: string; name: string; description: string; mainInstructions: string; subagentInstructions: string;
  active: boolean; createdAt: string; updatedAt: string;
};

const empty = { name: "", description: "", mainInstructions: "", subagentInstructions: "" };

export default function PromptsPage() {
  const [prompts, setPrompts] = useState<PromptPreset[]>([]);
  const [editing, setEditing] = useState<PromptPreset | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/prompts", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "加载失败");
      setPrompts(data.prompts);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "加载失败"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  function openEditor(prompt?: PromptPreset) {
    setEditing(prompt ?? null);
    setDraft(prompt ? { name: prompt.name, description: prompt.description, mainInstructions: prompt.mainInstructions, subagentInstructions: prompt.subagentInstructions } : empty);
    setEditorOpen(true);
    setError("");
  }

  async function save() {
    setSaving(true); setError("");
    try {
      const response = await fetch(editing ? `/api/prompts/${editing.id}` : "/api/prompts", {
        method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      setEditing(null); setDraft(empty); setEditorOpen(false); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setSaving(false); }
  }

  async function activate(id: string) {
    const response = await fetch(`/api/prompts/${id}/activate`, { method: "POST" });
    const data = await response.json();
    if (!response.ok) { setError(data.error || "启用失败"); return; }
    await refresh();
  }

  async function remove(prompt: PromptPreset) {
    if (!window.confirm(`确定删除提示词方案「${prompt.name}」吗？`)) return;
    const response = await fetch(`/api/prompts/${prompt.id}`, { method: "DELETE" });
    if (!response.ok) { const data = await response.json(); setError(data.error || "删除失败"); return; }
    await refresh();
  }

  return <main className="management-page">
    <ManagementHeader current="prompts" eyebrow="CONFIGURATION ASSETS" title="系统提示词" description="统一管理 Main Agent 与所有 Subagent 共享的基础提示词，同一时间启用一套。" actions={<button className="management-primary-action" onClick={() => openEditor()}>＋ 新建方案</button>} />
    {error && <div className="management-error">{error}</div>}
    <section className="management-summary"><div><strong>{prompts.length}</strong><span>方案总数</span></div><div><strong>{prompts.find((item) => item.active)?.name ?? "—"}</strong><span>当前启用</span></div><p>新对话与下一次 Agent Run 会自动读取当前方案。</p></section>
    <section className="asset-list">
      {loading ? <div className="asset-empty">正在加载…</div> : prompts.map((prompt) => <article className={`asset-row ${prompt.active ? "active" : ""}`} key={prompt.id}>
        <div className="asset-main"><span className={`asset-dot ${prompt.active ? "enabled" : ""}`} /><div><div className="asset-name"><strong>{prompt.name}</strong>{prompt.active && <b>正在使用</b>}</div><p>{prompt.description || "未填写描述"}</p><small>更新于 {new Date(prompt.updatedAt).toLocaleString("zh-CN")}</small></div></div>
        <div className="asset-actions">{!prompt.active && <button onClick={() => void activate(prompt.id)}>设为当前</button>}<button onClick={() => openEditor(prompt)}>编辑</button><button className="danger" disabled={prompt.active} onClick={() => void remove(prompt)}>删除</button></div>
      </article>)}
    </section>
    <aside className={`editor-drawer ${editorOpen ? "open" : ""}`}>
      <header><div><span>PROMPT PRESET</span><h2>{editing ? "编辑提示词方案" : "新建提示词方案"}</h2></div><button onClick={() => { setEditing(null); setDraft(empty); setEditorOpen(false); }}>×</button></header>
      <div className="editor-body">
        <label><span>方案名称 *</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：通用开发助手" /></label>
        <label><span>说明</span><input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="这套提示词适合什么场景" /></label>
        <label><span>Main Agent 系统提示词 *</span><textarea value={draft.mainInstructions} onChange={(event) => setDraft({ ...draft, mainInstructions: event.target.value })} /></label>
        <label><span>Subagent 共享基础提示词 *</span><textarea value={draft.subagentInstructions} onChange={(event) => setDraft({ ...draft, subagentInstructions: event.target.value })} /><small className="prompt-field-help">会应用到所有专家 Agent；每个专家自己的角色提示词会追加在它后面。</small></label>
      </div>
      <footer><button onClick={() => { setEditing(null); setDraft(empty); setEditorOpen(false); }}>取消</button><button className="primary" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存方案"}</button></footer>
    </aside>
    {editorOpen && <button className="drawer-backdrop" onClick={() => { setEditing(null); setDraft(empty); setEditorOpen(false); }} />}
  </main>;
}
