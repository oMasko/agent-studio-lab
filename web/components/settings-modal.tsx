"use client";

import { FormEvent, useState } from "react";

import type { ApiMode, EditableConfig, ProviderInfo, ProviderName } from "@/lib/config-types";

type Props = {
  config: EditableConfig;
  providers: Record<ProviderName, ProviderInfo>;
  onChange: (config: EditableConfig) => void;
  onChooseProvider: (provider: ProviderName) => void;
  onApply: (event: FormEvent<HTMLFormElement>) => void;
  onRestore: () => void;
  onClose: () => void;
  validationError?: string;
};

export function SettingsModal({ config, providers, onChange, onChooseProvider, onApply, onRestore, onClose, validationError }: Props) {
  const [showApiKey, setShowApiKey] = useState(false);
  const nativeWebSearchSupported = config.provider === "openai" && config.apiMode === "responses";
  const bridgedWebSearchSupported = !nativeWebSearchSupported && providers.openai.hasServerApiKey;
  const updateTurnLimit = (key: "mainMaxTurns" | "subagentMaxTurns", value: number | null) => onChange({ ...config, [key]: value });
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-header"><div><span>AGENT SETTINGS</span><h2 id="settings-title">模型与运行时</h2></div><button onClick={onClose} aria-label="关闭">×</button></header>
        <form onSubmit={onApply}>
          <div className="provider-picker">
            {(Object.entries(providers) as [ProviderName, ProviderInfo][]).map(([key, provider]) => (
              <button type="button" key={key} className={config.provider === key ? "selected" : ""} onClick={() => onChooseProvider(key)}><strong>{provider.label}</strong><span>{provider.hasServerApiKey ? "服务端 Key 已配置" : "需要 API Key"}</span></button>
            ))}
          </div>
          <div className="settings-grid">
            <label><span>主 Agent 模型</span><input value={config.model} onChange={(event) => onChange({ ...config, model: event.target.value })} required /></label>
            <label><span>Subagent 模型</span><input value={config.subagentModel} onChange={(event) => onChange({ ...config, subagentModel: event.target.value })} /></label>
            <label className="wide-field"><span>Base URL</span><input value={config.baseURL} onChange={(event) => onChange({ ...config, baseURL: event.target.value })} placeholder="https://..." /></label>
            <label><span>API 模式</span><select value={config.apiMode} onChange={(event) => onChange({ ...config, apiMode: event.target.value as ApiMode })}><option value="responses">Responses API</option><option value="chat_completions">Chat Completions</option></select></label>
            <label className="runtime-capability-field wide-field">
              <input type="checkbox" checked={config.webSearchEnabled} onChange={(event) => onChange({ ...config, webSearchEnabled: event.target.checked })} />
              <span><strong>联网与实时搜索</strong><small>{nativeWebSearchSupported ? "启用 OpenAI hosted Web Search 与受限公开网页读取；这是运行级只读授权，不会逐次弹出审批。" : bridgedWebSearchSupported ? `当前 ${providers[config.provider].label} 对话使用服务端 OpenAI 搜索后端，并支持受限公开网页读取。` : "支持读取明确的公开 URL；配置服务端 OPENAI_API_KEY 或搜索 MCP 后，还可发现与搜索网页。"} 默认核心工具：get_current_time · calculate · web_fetch{nativeWebSearchSupported || bridgedWebSearchSupported ? " · web_search" : ""}</small></span>
            </label>
            <div className="turn-limit-field">
              <label htmlFor="main-max-turns"><span>主 Agent 单次 Run 最大循环</span></label>
              <div className="turn-limit-control"><input id="main-max-turns" type="number" min="1" max="500" disabled={config.mainMaxTurns === null} value={config.mainMaxTurns ?? ""} onChange={(event) => updateTurnLimit("mainMaxTurns", Math.min(500, Math.max(1, event.target.valueAsNumber || 1)))} /><label><input type="checkbox" checked={config.mainMaxTurns === null} onChange={(event) => updateTurnLimit("mainMaxTurns", event.target.checked ? null : 30)} />不限制</label></div>
              <small>只限制一条消息内部的模型/工具循环，不限制整段聊天轮数。</small>
            </div>
            <div className="turn-limit-field">
              <label htmlFor="subagent-max-turns"><span>Subagent 单次 Run 最大循环</span></label>
              <div className="turn-limit-control"><input id="subagent-max-turns" type="number" min="1" max="500" disabled={config.subagentMaxTurns === null} value={config.subagentMaxTurns ?? ""} onChange={(event) => updateTurnLimit("subagentMaxTurns", Math.min(500, Math.max(1, event.target.valueAsNumber || 1)))} /><label><input type="checkbox" checked={config.subagentMaxTurns === null} onChange={(event) => updateTurnLimit("subagentMaxTurns", event.target.checked ? null : 15)} />不限制</label></div>
              <small>复杂任务可提高；不限制可能增加成本并放大循环风险。</small>
            </div>
            <label className="wide-field"><span>API Key（可选）</span><div className="secret-input"><input type={showApiKey ? "text" : "password"} value={config.apiKey} onChange={(event) => onChange({ ...config, apiKey: event.target.value })} placeholder={providers[config.provider].hasServerApiKey ? "留空使用服务端 .env 中的 Key" : "仅用于当前页面会话"} autoComplete="off" /><button type="button" onClick={() => setShowApiKey((value) => !value)}>{showApiKey ? "隐藏" : "显示"}</button></div><small>API Key 不会保存到浏览器存储。</small></label>
          </div>
          {validationError && <div className="settings-error">{validationError}</div>}
          <footer className="settings-footer"><button type="button" className="secondary-action" onClick={onRestore}>恢复 .env 默认</button><div><button type="button" className="secondary-action" onClick={onClose}>取消</button><button type="submit" className="primary-action">保存并应用</button></div></footer>
        </form>
      </section>
    </div>
  );
}
