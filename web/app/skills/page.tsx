"use client";

import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";

import { ManagementHeader } from "@/components/management-header";

type SkillScope = "main" | "subagent" | "both";
type SkillFile = { path: string; size: number; kind: "file" | "directory" };
type Skill = {
  name: string;
  description: string;
  requiredCapabilities: string[];
  enabled: boolean;
  scope: SkillScope;
  fileCount: number;
  totalSize: number;
  updatedAt: number;
  hasScripts: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
  files?: SkillFile[];
};

const scopeLabel: Record<SkillScope, string> = { main: "Main Agent", subagent: "Subagent", both: "两者" };

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<Skill | null>(null);
  const [selectedFile, setSelectedFile] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const directoryInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/skills", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "加载失败");
      setSkills(data.skills);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { directoryInputRef.current?.setAttribute("webkitdirectory", ""); }, []);

  async function install(form: FormData) {
    setWorking(true);
    setError("");
    try {
      const response = await fetch("/api/skills", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "安装失败");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "安装失败");
    } finally {
      setWorking(false);
    }
  }

  async function importZip(event: ChangeEvent<HTMLInputElement>) {
    const archive = event.target.files?.[0];
    event.target.value = "";
    if (!archive) return;
    const form = new FormData();
    form.set("mode", "zip");
    form.set("archive", archive);
    await install(form);
  }

  async function importDirectory(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    const form = new FormData();
    form.set("mode", "directory");
    for (const file of files) {
      form.append("files", file, file.name);
      form.append("paths", file.webkitRelativePath || file.name);
    }
    await install(form);
  }

  async function patchSkill(name: string, patch: Partial<Pick<Skill, "enabled" | "scope">>) {
    setError("");
    const response = await fetch(`/api/skills/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = response.status === 204 ? {} : await response.json();
    if (!response.ok) {
      setError(data.error || "更新失败");
      return;
    }
    setSkills((current) => current.map((skill) => skill.name === name ? { ...skill, ...patch } : skill));
    setDetail((current) => current?.name === name ? { ...current, ...patch } : current);
  }

  async function removeSkill(name: string) {
    if (!window.confirm(`确定删除 Skill「${name}」及其全部文件吗？`)) return;
    const response = await fetch(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!response.ok) {
      const data = await response.json();
      setError(data.error || "删除失败");
      return;
    }
    if (detail?.name === name) setDetail(null);
    await refresh();
  }

  async function openDetail(name: string) {
    setError("");
    const response = await fetch(`/api/skills/${encodeURIComponent(name)}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || "读取详情失败");
      return;
    }
    setDetail(data.skill);
    setSelectedFile("");
    setFileContent("");
  }

  async function openFile(skill: string, path: string) {
    setSelectedFile(path);
    setFileLoading(true);
    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(skill)}/file?path=${encodeURIComponent(path)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "文件读取失败");
      setFileContent(data.content);
    } catch (reason) {
      setFileContent(reason instanceof Error ? reason.message : "文件读取失败");
    } finally {
      setFileLoading(false);
    }
  }

  return (
    <main className="management-page skills-page">
      <ManagementHeader
        current="skills"
        eyebrow="AGENT CAPABILITIES"
        title="Skills 管理"
        description="管理完整 Skill 项目，并控制其对 Main Agent 与 Subagent 的授权范围。"
        actionsClassName="skills-actions"
        actions={<>
            <button onClick={() => void refresh()} disabled={loading || working}>↻ 扫描本地</button>
            <button onClick={() => directoryInputRef.current?.click()} disabled={working}>▣ 导入目录</button>
            <button className="primary" onClick={() => zipInputRef.current?.click()} disabled={working}>↓ 从 ZIP 安装</button>
        </>}
      />
      <input ref={zipInputRef} className="hidden-input" type="file" accept=".zip,application/zip" onChange={(event) => void importZip(event)} />
      <input ref={directoryInputRef} className="hidden-input" type="file" multiple onChange={(event) => void importDirectory(event)} />

      <section className="skills-summary">
        <div><strong>{skills.length}</strong><span>已安装</span></div>
        <div><strong>{skills.filter((skill) => skill.enabled).length}</strong><span>已启用</span></div>
        <div className="summary-pills"><span>Main: {skills.filter((skill) => skill.enabled && (skill.scope === "main" || skill.scope === "both")).length}</span><span>Subagent: {skills.filter((skill) => skill.enabled && (skill.scope === "subagent" || skill.scope === "both")).length}</span><span>项目目录：.agents/skills</span></div>
      </section>

      {error && <div className="skills-error">{error}</div>}
      {working && <div className="skills-progress">正在校验并安装 Skill 项目…</div>}

      <section className="skills-list-panel">
        {loading ? <div className="skills-empty">正在扫描 Skills…</div> : skills.length === 0 ? (
          <div className="skills-empty"><strong>还没有安装 Skill</strong><span>从 ZIP 安装，或选择一个包含 SKILL.md 的完整目录。</span></div>
        ) : skills.map((skill) => (
          <article className="skill-row" key={skill.name}>
            <button className="skill-info" onClick={() => void openDetail(skill.name)}>
              <div className={`skill-status-dot ${skill.enabled ? "enabled" : ""}`} />
              <div><div className="skill-name-line"><strong>{skill.name}</strong><span>本地项目</span></div><p>{skill.description}</p><div className="skill-package-meta"><span>{skill.fileCount} files</span><span>{formatSize(skill.totalSize)}</span>{skill.hasScripts && <span>scripts</span>}{skill.hasReferences && <span>references</span>}{skill.hasAssets && <span>assets</span>}{skill.requiredCapabilities.map((capability) => <span className="required-capability" key={capability}>requires {capability}</span>)}</div></div>
            </button>
            <div className="skill-row-actions">
              <select value={skill.scope} onChange={(event) => void patchSkill(skill.name, { scope: event.target.value as SkillScope })} aria-label="作用范围">{Object.entries(scopeLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
              <label className="skill-switch"><input type="checkbox" checked={skill.enabled} onChange={(event) => void patchSkill(skill.name, { enabled: event.target.checked })} /><span /></label>
              <a href={`/api/skills/${encodeURIComponent(skill.name)}/backup`} title="下载 ZIP 备份">↓</a>
              <button onClick={() => void removeSkill(skill.name)} title="删除">⌫</button>
            </div>
          </article>
        ))}
      </section>

      <aside className={`skill-detail-drawer ${detail ? "open" : ""}`} aria-hidden={!detail}>
        {detail && <>
          <header><div><span>SKILL PROJECT</span><h2>{detail.name}</h2><p>{detail.description}</p></div><button onClick={() => setDetail(null)}>×</button></header>
          <div className="detail-controls"><label className="skill-switch"><input type="checkbox" checked={detail.enabled} onChange={(event) => void patchSkill(detail.name, { enabled: event.target.checked })} /><span /></label><b>{detail.enabled ? "已启用" : "已禁用"}</b>{detail.requiredCapabilities.map((capability) => <em key={capability}>{capability}</em>)}<select value={detail.scope} onChange={(event) => void patchSkill(detail.name, { scope: event.target.value as SkillScope })}>{Object.entries(scopeLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
          <div className="skill-browser">
            <nav>{detail.files?.filter((file) => file.kind === "file").map((file) => <button className={selectedFile === file.path ? "active" : ""} key={file.path} onClick={() => void openFile(detail.name, file.path)}><span>{file.path.includes("/") ? "└" : "•"}</span>{file.path}<small>{formatSize(file.size)}</small></button>)}</nav>
            <section>{selectedFile ? <><div className="file-preview-title">{selectedFile}</div><pre>{fileLoading ? "加载中…" : fileContent}</pre></> : <div className="file-placeholder">选择文件查看内容。二进制 assets 会保留，但不会作为文本打开。</div>}</section>
          </div>
          <footer><span>Skill 不能自行执行脚本；脚本必须通过受控命令 Tool，并经过统一策略与人工审批。</span><a href={`/api/skills/${encodeURIComponent(detail.name)}/backup`}>下载 ZIP 备份</a></footer>
        </>}
      </aside>
      {detail && <button className="drawer-backdrop" onClick={() => setDetail(null)} aria-label="关闭详情" />}
    </main>
  );
}
