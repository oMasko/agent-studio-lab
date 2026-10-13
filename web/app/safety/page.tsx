"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { ManagementHeader } from "@/components/management-header";

type RuleSection = { enabled: boolean; blockedTerms: string[] };
type ToolPolicyAction = "allow" | "approval" | "deny";
type ToolPolicySource = "all" | "function" | "skill" | "mcp" | "agent";
type ToolPolicyRule = { id: string; enabled: boolean; source: ToolPolicySource; pattern: string; capability: string; action: ToolPolicyAction; description: string };
type SafetySettings = {
  inputGuardrail: RuleSection;
  outputGuardrail: RuleSection;
  toolGuardrail: RuleSection;
  approval: { enabled: boolean; demoToolEnabled: boolean };
  workspace: { readEnabled: boolean; writeEnabled: boolean; shellEnabled: boolean; maxCommandSeconds: number };
  toolPolicy: { enabled: boolean; defaultAction: ToolPolicyAction; rules: ToolPolicyRule[] };
  updatedAt?: string;
};

type SectionKey = "inputGuardrail" | "outputGuardrail" | "toolGuardrail";

const sectionCopy: Array<{ key: SectionKey; eyebrow: string; title: string; description: string; placeholder: string }> = [
  {
    key: "inputGuardrail",
    eyebrow: "BEFORE MODEL",
    title: "Input Guardrail",
    description: "在模型调用前检查用户输入；命中后立即停止本次 Run，不消耗后续模型与工具调用。",
    placeholder: "每行一个拦截词，例如：\n<script\nsk-demo-secret",
  },
  {
    key: "outputGuardrail",
    eyebrow: "BEFORE DISPLAY",
    title: "Output Guardrail",
    description: "检查最终回复；命中时终止 Run，并阻止该内容展示到聊天界面。",
    placeholder: "每行一个拦截词，例如：\nBEGIN_PRIVATE_DATA",
  },
  {
    key: "toolGuardrail",
    eyebrow: "TOOL BOUNDARY",
    title: "Tool Input Guardrail",
    description: "在函数工具或 MCP 工具执行前检查参数；命中后把拒绝结果返回给模型，真实工具不会执行。",
    placeholder: "每行一个拦截词，例如：\nproduction\n/etc\n../",
  },
];

function textToTerms(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

const sourceLabels: Record<ToolPolicySource, string> = {
  all: "全部来源",
  function: "Function",
  skill: "Skill",
  mcp: "MCP",
  agent: "Subagent",
};

const actionLabels: Record<ToolPolicyAction, string> = {
  allow: "直接允许",
  approval: "需要审批",
  deny: "拒绝执行",
};

const capabilityLabels: Record<string, string> = {
  "*": "全部能力",
  "skills:read": "Skill 读取",
  "agent:delegate": "Subagent 委派",
  "filesystem:read": "文件读取",
  "filesystem:write": "文件修改",
  "process:execute": "命令执行",
  "network:access": "网络访问",
  "time:read": "当前时间",
  "compute:calculate": "精确计算",
  "external:action": "外部动作",
};

export default function SafetyPage() {
  const [settings, setSettings] = useState<SafetySettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/safety", { cache: "no-store" }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "加载失败");
      setSettings(data.settings);
    }).catch((reason: Error) => setError(reason.message));
  }, []);

  function updateSection(key: SectionKey, patch: Partial<RuleSection>) {
    setSettings((current) => current ? { ...current, [key]: { ...current[key], ...patch } } : current);
    setNotice("");
  }

  function updatePolicyRule(id: string, patch: Partial<ToolPolicyRule>) {
    setSettings((current) => current ? {
      ...current,
      toolPolicy: {
        ...current.toolPolicy,
        rules: current.toolPolicy.rules.map((rule) => rule.id === id ? { ...rule, ...patch } : rule),
      },
    } : current);
    setNotice("");
  }

  function addPolicyRule() {
    if (!settings) return;
    setSettings({
      ...settings,
      toolPolicy: {
        ...settings.toolPolicy,
        rules: [...settings.toolPolicy.rules, {
          id: crypto.randomUUID(),
          enabled: true,
          source: "all",
          pattern: "*",
          capability: "*",
          action: "approval",
          description: "",
        }],
      },
    });
    setNotice("");
  }

  function removePolicyRule(id: string) {
    if (!settings) return;
    setSettings({ ...settings, toolPolicy: { ...settings.toolPolicy, rules: settings.toolPolicy.rules.filter((rule) => rule.id !== id) } });
    setNotice("");
  }

  function movePolicyRule(id: string, direction: -1 | 1) {
    if (!settings) return;
    const rules = [...settings.toolPolicy.rules];
    const from = rules.findIndex((rule) => rule.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= rules.length) return;
    [rules[from], rules[to]] = [rules[to], rules[from]];
    setSettings({ ...settings, toolPolicy: { ...settings.toolPolicy, rules } });
    setNotice("");
  }

  async function save() {
    if (!settings) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/safety", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      setSettings(data.settings);
      setNotice("策略已保存，将从下一次 Agent Run 起生效。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return <main className="management-page safety-page">
    <ManagementHeader current="safety" eyebrow="RUNTIME SAFETY" title="Guardrails 与审批" description="管理确定性边界检查，以及需要人工确认的敏感工具调用。" actions={<button className="management-primary-action" disabled={!settings || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存策略"}</button>} />

    {error && <div className="management-error">{error}</div>}
    {notice && <div className="safety-notice">{notice}</div>}

    {!settings ? <section className="asset-empty">正在加载安全策略…</section> : <>
      <section className="safety-overview">
        <div><span>运行顺序</span><strong>输入检查 → 模型 → 统一工具策略 → 参数检查 / 人工审批 → 输出检查</strong></div>
        <p>Guardrail 是自动策略，Approval 是人在回路。审批中的 Run 会被安全挂起，只有在聊天页批准或拒绝后才从原状态继续。</p>
      </section>

      <section className="safety-grid">
        <article className="safety-card workspace-capability-card">
          <header><div><span>REAL CAPABILITIES</span><h2>Workspace Runtime</h2></div></header>
          <p>为 Main Agent 提供真实文件修改与本地命令能力；Subagent 只获得读取和搜索能力。写入与命令工具自身始终要求审批，Skill 不能绕过。</p>
          <div className="workspace-capability-grid">
            <label><input type="checkbox" checked={settings.workspace.readEnabled} onChange={(event) => setSettings({ ...settings, workspace: { ...settings.workspace, readEnabled: event.target.checked } })} /><span><strong>文件读取与搜索</strong><small>限制在项目目录，排除 .env、.git、内部状态与凭据文件</small></span></label>
            <label><input type="checkbox" checked={settings.workspace.writeEnabled} onChange={(event) => setSettings({ ...settings, workspace: { ...settings.workspace, writeEnabled: event.target.checked } })} /><span><strong>文件修改</strong><small>支持创建、精确替换、追加和可恢复删除；每次审批</small></span></label>
            <label><input type="checkbox" checked={settings.workspace.shellEnabled} onChange={(event) => setSettings({ ...settings, workspace: { ...settings.workspace, shellEnabled: event.target.checked } })} /><span><strong>本地命令执行</strong><small>真实主机进程、无隐式 Shell、清理环境变量；每次审批</small></span></label>
            <label className="workspace-timeout"><span>命令最长执行秒数</span><input type="number" min={5} max={120} value={settings.workspace.maxCommandSeconds} onChange={(event) => setSettings({ ...settings, workspace: { ...settings.workspace, maxCommandSeconds: Math.min(120, Math.max(5, Number(event.target.value) || 5)) } })} /></label>
          </div>
          <div className="workspace-warning"><strong>边界说明</strong><span>文件工具具备路径隔离；本地命令虽然限制 cwd、环境和超时，但不是容器级沙箱。批准前必须检查完整 command 与 args。</span></div>
        </article>

        {sectionCopy.map((section) => <article className="safety-card" key={section.key}>
          <header><div><span>{section.eyebrow}</span><h2>{section.title}</h2></div><label className="skill-switch"><input type="checkbox" checked={settings[section.key].enabled} onChange={(event) => updateSection(section.key, { enabled: event.target.checked })} /><span /></label></header>
          <p>{section.description}</p>
          <label><span>拦截词（不区分大小写）</span><textarea disabled={!settings[section.key].enabled} value={settings[section.key].blockedTerms.join("\n")} onChange={(event) => updateSection(section.key, { blockedTerms: textToTerms(event.target.value) })} placeholder={section.placeholder} /></label>
        </article>)}

        <article className="safety-card tool-policy-card">
          <header><div><span>HOST ENFORCED</span><h2>统一工具策略</h2></div><label className="skill-switch"><input type="checkbox" checked={settings.toolPolicy.enabled} onChange={(event) => setSettings({ ...settings, toolPolicy: { ...settings.toolPolicy, enabled: event.target.checked } })} /><span /></label></header>
          <p>策略由 Agent Studio 强制执行，不信任工具自己的风险声明。规则同时匹配来源、工具名和能力，从上到下首次命中；支持 <code>*</code> 和 <code>?</code>。</p>
          <div className="policy-default-row"><label><span>未匹配工具的默认动作</span><select disabled={!settings.toolPolicy.enabled} value={settings.toolPolicy.defaultAction} onChange={(event) => setSettings({ ...settings, toolPolicy: { ...settings.toolPolicy, defaultAction: event.target.value as ToolPolicyAction } })}>{Object.entries(actionLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><div><strong>推荐：需要审批</strong><small>关闭人工审批时，所有“需要审批”的工具会自动拒绝，不会降级成直接执行。</small></div></div>
          <div className="policy-rules-header"><div><strong>工具规则</strong><span>{settings.toolPolicy.rules.length} 条 · 从上到下匹配</span></div><button type="button" onClick={addPolicyRule}>＋ 添加规则</button></div>
          <div className="policy-rules">
            {settings.toolPolicy.rules.length === 0 ? <div className="policy-empty">没有单独规则，所有工具使用默认动作。</div> : settings.toolPolicy.rules.map((rule, index) => <div className={`policy-rule ${rule.enabled ? "" : "disabled"}`} key={rule.id}>
              <div className="policy-order">
                <span>{index + 1}</span>
                <button type="button" aria-label="上移规则" disabled={index === 0} onClick={() => movePolicyRule(rule.id, -1)}>↑</button>
                <button type="button" aria-label="下移规则" disabled={index === settings.toolPolicy.rules.length - 1} onClick={() => movePolicyRule(rule.id, 1)}>↓</button>
              </div>
              <label className="policy-enabled"><input type="checkbox" checked={rule.enabled} onChange={(event) => updatePolicyRule(rule.id, { enabled: event.target.checked })} /><span /></label>
              <select aria-label="工具来源" value={rule.source} onChange={(event) => updatePolicyRule(rule.id, { source: event.target.value as ToolPolicySource })}>{Object.entries(sourceLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
              <input aria-label="工具名匹配" value={rule.pattern} onChange={(event) => updatePolicyRule(rule.id, { pattern: event.target.value })} placeholder="例如：*delete*" />
              <select aria-label="能力匹配" value={rule.capability} onChange={(event) => updatePolicyRule(rule.id, { capability: event.target.value })}>{Object.entries(capabilityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
              <select aria-label="策略动作" className={`policy-action-${rule.action}`} value={rule.action} onChange={(event) => updatePolicyRule(rule.id, { action: event.target.value as ToolPolicyAction })}>{Object.entries(actionLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
              <input aria-label="规则说明" value={rule.description} onChange={(event) => updatePolicyRule(rule.id, { description: event.target.value })} placeholder="规则说明（可选）" />
              <button type="button" className="policy-remove" aria-label="删除规则" onClick={() => removePolicyRule(rule.id)}>×</button>
            </div>)}
          </div>
        </article>

        <article className="safety-card approval-settings-card">
          <header><div><span>HUMAN IN THE LOOP</span><h2>工具执行审批</h2></div><label className="skill-switch"><input type="checkbox" checked={settings.approval.enabled} onChange={(event) => setSettings({ ...settings, approval: { ...settings.approval, enabled: event.target.checked } })} /><span /></label></header>
          <p>统一策略判定为“需要审批”后，通过 SDK 的 <code>needsApproval</code> 暂停 Run。关闭此功能不会放行工具，而是拒绝所有需要审批的调用。</p>
          <label className="approval-demo-toggle"><input type="checkbox" checked={settings.approval.demoToolEnabled} onChange={(event) => setSettings({ ...settings, approval: { ...settings.approval, demoToolEnabled: event.target.checked } })} /><span><strong>启用安全演示工具</strong><small>只模拟操作，不会修改外部系统</small></span></label>
          <div className="safety-test"><span>推荐测试</span><code>使用 safety-policy-lab 做“未声明审批测试”。</code><Link href="/">去聊天测试 →</Link></div>
        </article>
      </section>
      <section className="safety-footnote"><strong>能力不会随 Skill 自动提升</strong><p>Skill 的 requires 只声明工作流需要什么；实际文件、命令、网络与外部动作仍由 Tool profile、统一策略、人工审批和运行时边界共同决定。</p></section>
    </>}
  </main>;
}
