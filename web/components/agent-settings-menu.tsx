"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export type ManagementSection = "experiments" | "runs" | "memory" | "agents" | "prompts" | "mcp" | "skills" | "safety" | "traces";
export type AgentSettingsSection = "runtime" | ManagementSection;

type AgentSettingsMenuProps = {
  current?: AgentSettingsSection;
  onOpenRuntime?: () => void;
};

const sections: Array<{
  id: ManagementSection;
  href: string;
  label: string;
  description: string;
}> = [
  { id: "runs", href: "/runs", label: "运行中心", description: "后台 Run、停止、重试与状态" },
  { id: "memory", href: "/memory", label: "上下文与记忆", description: "会话摘要、压缩和长期记忆" },
  { id: "agents", href: "/agents", label: "Agent 编排", description: "专家角色、协作方式与能力边界" },
  { id: "prompts", href: "/prompts", label: "系统提示词", description: "Main Agent 与 Subagent 指令" },
  { id: "mcp", href: "/mcp", label: "MCP", description: "外部服务与工具连接" },
  { id: "skills", href: "/skills", label: "Skills", description: "项目级技能包与启用范围" },
  { id: "safety", href: "/safety", label: "安全与审批", description: "Guardrails、权限和审批策略" },
  { id: "traces", href: "/traces", label: "Trace", description: "运行链路与监控日志" },
];

function GearIcon() {
  return <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.13.38.34.72.6 1 .3.27.68.4 1.1.4h.09v4h-.09c-.42 0-.8.14-1.1.4-.26.28-.47.62-.6 1Z" />
  </svg>;
}

export function AgentSettingsMenu({ current, onOpenRuntime }: AgentSettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const runtimeItem = onOpenRuntime ? (
    <button
      type="button"
      className={`agent-settings-item ${current === "runtime" ? "active" : ""}`}
      onClick={() => { setOpen(false); onOpenRuntime(); }}
    >
      <span><strong>模型与运行时</strong><small>Provider、模型、API 与循环限制</small></span><b>›</b>
    </button>
  ) : (
    <Link className={`agent-settings-item ${current === "runtime" ? "active" : ""}`} href="/?settings=1" onClick={() => setOpen(false)}>
      <span><strong>模型与运行时</strong><small>Provider、模型、API 与循环限制</small></span><b>›</b>
    </Link>
  );

  return <div className="agent-settings-menu" ref={rootRef}>
    <button
      type="button"
      className={`agent-settings-trigger ${open ? "open" : ""}`}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
    >
      <GearIcon /><span>Agent 设置</span><i aria-hidden="true">⌄</i>
    </button>
    {open && <div className="agent-settings-popover" role="menu">
      <div className="agent-settings-popover-header"><span>AGENT SETTINGS</span><strong>配置与能力</strong></div>
      <nav aria-label="Agent 设置">
        {runtimeItem}
        <div className="agent-settings-divider" />
        {sections.map((section) => <Link
          aria-current={current === section.id ? "page" : undefined}
          className={`agent-settings-item ${current === section.id ? "active" : ""}`}
          href={section.href}
          key={section.id}
          onClick={() => setOpen(false)}
        >
          <span><strong>{section.label}</strong><small>{section.description}</small></span><b>›</b>
        </Link>)}
      </nav>
      <div className="agent-settings-divider" />
      <Link
        href="/experiments"
        aria-current={current === "experiments" ? "page" : undefined}
        className={`agent-settings-item ${current === "experiments" ? "active" : ""}`}
        onClick={() => setOpen(false)}
      >
        <span><strong>实验功能</strong><small>探索中的能力，按需体验</small></span><b>›</b>
      </Link>
    </div>}
  </div>;
}
