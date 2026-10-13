"use client";

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { AgentSettingsMenu } from "@/components/agent-settings-menu";
import { SettingsModal } from "@/components/settings-modal";
import { ContextUsage } from "@/components/context-usage";
import type { ConfigResponse, EditableConfig, ProviderName } from "@/lib/config-types";
import type { RunMetrics } from "@/lib/run-metrics";

type Role = "user" | "assistant";

type ApprovalItem = {
  id: string;
  toolName: string;
  agentName: string;
  arguments: unknown;
  argumentsText: string;
  capabilities: string[];
  source?: "function" | "skill" | "mcp" | "agent";
  riskLevel?: "low" | "medium" | "high" | "critical";
  effect?: "read" | "write" | "execute" | "external";
  sessionScope?: {
    kind: "mcp_server" | "workspace_path" | "command" | "exact_arguments";
    description: string;
  };
};

type ApprovalRequest = {
  id: string;
  sessionId: string;
  expiresAt: string | null;
  items: ApprovalItem[];
  status: "pending" | "approved" | "approved_session" | "rejected" | "expired";
};

type GuardrailSummary = { input: string[]; output: string[]; tool: string[] };

type ChatMessage = {
  id: string;
  role: Role;
  content: string;
  pending?: boolean;
  pendingStartedAt?: number;
  pendingInput?: string;
  requestId?: string;
  runId?: string;
  streamingStatus?: string;
  activeAgent?: string;
  cancelled?: boolean;
  delegated?: boolean;
  tools?: string[];
  guardrails?: GuardrailSummary;
  guardrailBlock?: { type: string; name: string; outputInfo?: unknown };
  approval?: ApprovalRequest;
  metrics?: RunMetrics;
  traceId?: string;
  time?: string;
};

type ConversationSummary = {
  id: string;
  title: string;
  updatedAt: number;
};

type ConfiguredAgentSummary = { id: string; name: string; description: string; collaboration: "handoff" | "tool" | "both"; enabled: boolean };

type TraceSummary = {
  id: string;
  sessionId: string;
  inputPreview: string;
  status: "running" | "awaiting_approval" | "completed" | "blocked" | "failed" | "cancelled";
  startedAt: string;
  metrics?: RunMetrics;
};

type RunSnapshot = {
  id: string;
  status: "running" | "awaiting_approval" | "completed" | "blocked" | "failed" | "cancelled";
  traceId?: string;
  result?: Record<string, unknown>;
  error?: string;
};

const starterPrompts = [
  "请列出当前项目的顶层文件，并概括它的技术栈",
  "请创建 workspace-notes.md，记录当前 Agent 的真实能力边界",
  "请运行 npm run typecheck，并解释检查结果",
];

const settingsKey = "agent-studio:model-settings";
const conversationsKey = "agent-studio:conversations";

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function makeSessionId(): string {
  return `web-${crypto.randomUUID().slice(0, 8)}`;
}

function storageKey(sessionId: string): string {
  return `agent-studio:messages:${sessionId}`;
}

function loadLocalMessages(sessionId: string): ChatMessage[] {
  try {
    return JSON.parse(localStorage.getItem(storageKey(sessionId)) ?? "[]") as ChatMessage[];
  } catch {
    return [];
  }
}

function loadConversations(): ConversationSummary[] {
  try {
    return JSON.parse(localStorage.getItem(conversationsKey) ?? "[]") as ConversationSummary[];
  } catch {
    return [];
  }
}

function loadSavedConfig(): Partial<EditableConfig> {
  try {
    return JSON.parse(localStorage.getItem(settingsKey) ?? "{}") as Partial<EditableConfig>;
  } catch {
    return {};
  }
}

function shortTitle(text: string): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > 24 ? `${value.slice(0, 24)}…` : value || "新会话";
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return new Date(timestamp).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

type IconName = "plus" | "send" | "stop" | "trash" | "copy" | "menu" | "spark" | "settings" | "close" | "eye" | "history" | "shield" | "gauge" | "database";

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    trash: <><path d="M3 6h18" /><path d="M8 6V4h8v2M19 6l-1 14H6L5 6" /></>,
    copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" /></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
    spark: <><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2Z" /><path d="m18 14 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8Z" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" /></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
    shield: <><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6Z" /><path d="m9 12 2 2 4-4" /></>,
    gauge: <><path d="M4.9 19a9 9 0 1 1 14.2 0" /><path d="m12 13 4-4" /><path d="M12 19v.01" /></>,
    database: <><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5" /><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></>,
  };
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function MessageBody({ content }: { content: string }) {
  return <div className="message-content">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
        table: ({ children, ...props }) => <div className="markdown-table-wrap"><table {...props}>{children}</table></div>,
        pre: ({ children, ...props }) => <pre {...props} className="markdown-code-block">{children}</pre>,
      }}
    >
      {content}
    </ReactMarkdown>
  </div>;
}

export default function Home() {
  const [sessionId, setSessionId] = useState("");
  const [sessionDraft, setSessionDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [input, setInput] = useState("");
  const [pendingSessionIds, setPendingSessionIds] = useState<Set<string>>(() => new Set());
  const [approvalBusyIds, setApprovalBusyIds] = useState<Set<string>>(() => new Set());
  const [activeConfig, setActiveConfig] = useState<EditableConfig | null>(null);
  const [draftConfig, setDraftConfig] = useState<EditableConfig | null>(null);
  const [serverConfig, setServerConfig] = useState<ConfigResponse | null>(null);
  const [configuredAgents, setConfiguredAgents] = useState<ConfiguredAgentSummary[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeSessionRef = useRef("");
  const approvalBusyRef = useRef<Set<string>>(new Set());
  const activeRequestIdsRef = useRef<Set<string>>(new Set());

  const sessionReady = Boolean(sessionId);
  const busy = pendingSessionIds.has(sessionId);
  const waitingApproval = messages.some((message) => message.approval?.status === "pending");
  const hasMessages = messages.length > 0;
  const sortedConversations = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations],
  );
  const sessionMetrics = useMemo(() => {
    const metricsByRun = new Map<string, RunMetrics>();
    for (const message of messages) {
      if (message.metrics) metricsByRun.set(message.traceId ?? message.id, message.metrics);
    }
    const runs = [...metricsByRun.values()];
    if (runs.length === 0) return null;
    const inputTokens = runs.reduce((total, item) => total + item.inputTokens, 0);
    const outputTokens = runs.reduce((total, item) => total + item.outputTokens, 0);
    const activeDurationMs = runs.reduce((total, item) => total + item.activeDurationMs, 0);
    const cacheKnown = runs.every((item) => item.cachedInputTokens !== null);
    const cachedInputTokens = cacheKnown
      ? runs.reduce((total, item) => total + (item.cachedInputTokens ?? 0), 0)
      : null;
    return {
      modelTurns: runs.reduce((total, item) => total + item.modelTurns, 0),
      steps: runs.reduce((total, item) => total + item.steps, 0),
      totalTokens: runs.reduce((total, item) => total + item.totalTokens, 0),
      tokensPerSecond: outputTokens > 0 && activeDurationMs > 0 ? outputTokens / (activeDurationMs / 1_000) : null,
      cacheHitRate: cachedInputTokens !== null && inputTokens > 0 ? cachedInputTokens / inputTokens : null,
    };
  }, [messages]);

  useEffect(() => {
    const requestedSession = new URLSearchParams(window.location.search).get("session")?.trim();
    const currentSession = requestedSession && /^[A-Za-z0-9_.-]{1,80}$/.test(requestedSession)
      ? requestedSession
      : localStorage.getItem("agent-studio:session") || makeSessionId();
    localStorage.setItem("agent-studio:session", currentSession);
    activeSessionRef.current = currentSession;
    setSessionId(currentSession);
    setSessionDraft(currentSession);
    setMessages(loadLocalMessages(currentSession));

    const savedConversations = loadConversations();
    const initialConversations = savedConversations.some((item) => item.id === currentSession)
      ? savedConversations
      : [{ id: currentSession, title: "新会话", updatedAt: Date.now() }, ...savedConversations];
    setConversations(initialConversations);
    localStorage.setItem(conversationsKey, JSON.stringify(initialConversations));

    fetch("/api/config").then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "模型配置加载失败");
      const received = data as ConfigResponse;
      const saved = loadSavedConfig();
      const base: EditableConfig = { ...received.config, apiKey: "" };
      const restored: EditableConfig = { ...base, ...saved, apiKey: "" };
      setServerConfig(received);
      setActiveConfig(restored);
      setDraftConfig(restored);
      const location = new URL(window.location.href);
      if (location.searchParams.get("settings") === "1") {
        setSettingsOpen(true);
        location.searchParams.delete("settings");
        window.history.replaceState({}, "", `${location.pathname}${location.search}${location.hash}`);
      }
    }).catch((reason: Error) => setError(reason.message));
    fetch("/api/agents", { cache: "no-store" }).then(async (response) => {
      const data = await response.json();
      if (response.ok) setConfiguredAgents((data.agents as ConfiguredAgentSummary[]).filter((agent) => agent.enabled));
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!sessionReady) return;
    localStorage.setItem(storageKey(sessionId), JSON.stringify(messages));
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sessionId, sessionReady]);

  useEffect(() => {
    if (!sessionReady) return;
    const pendingMessage = [...messages].reverse().find((message) => message.pending && !activeRequestIdsRef.current.has(message.id));
    if (!pendingMessage) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finishRecovery = () => setPendingSessionIds((current) => {
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
    const schedule = () => { timer = setTimeout(() => void reconcile(), 1_500); };
    const reconcile = async () => {
      try {
        if (pendingMessage.runId || pendingMessage.requestId) {
          const url = pendingMessage.runId
            ? `/api/runs/${encodeURIComponent(pendingMessage.runId)}`
            : `/api/runs/request/${encodeURIComponent(pendingMessage.requestId!)}`;
          const runResponse = await fetch(url, { cache: "no-store" });
          if (runResponse.status === 404) { schedule(); return; }
          const runData = await runResponse.json();
          if (!runResponse.ok) throw new Error(runData.error || "Run 状态读取失败");
          const run = runData.run as RunSnapshot;
          if (cancelled) return;
          if (run.status === "running") {
            patchMessage(sessionId, pendingMessage.id, { runId: run.id, traceId: run.traceId, streamingStatus: "后台 Run 正在继续执行…" });
            setPendingSessionIds((current) => new Set(current).add(sessionId));
            schedule();
            return;
          }
          if (run.status === "awaiting_approval" && run.result) {
            replaceMessage(sessionId, pendingMessage.id, makeApprovalMessage(run.result));
            finishRecovery();
            return;
          }
          if (run.status === "completed" && run.result) {
            replaceMessage(sessionId, pendingMessage.id, makeAssistantMessage(run.result));
            finishRecovery();
            return;
          }
          if (run.status === "cancelled") {
            replaceMessage(sessionId, pendingMessage.id, {
              id: makeId("assistant-cancelled"), role: "assistant", content: "任务已取消。",
              cancelled: true, traceId: run.traceId,
              time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
            });
            finishRecovery();
            return;
          }
          replaceMessage(sessionId, pendingMessage.id, {
            id: makeId("assistant-error"), role: "assistant",
            content: run.status === "blocked" ? `本次运行已被安全策略终止：${run.error ?? "请查看 Trace。"}` : `本次运行未能完成：${run.error ?? run.status}`,
            traceId: run.traceId,
            time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
          });
          finishRecovery();
          return;
        }
        const response = await fetch(`/api/traces?sessionId=${encodeURIComponent(sessionId)}&limit=10`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "运行状态读取失败");
        const traces = (Array.isArray(data.traces) ? data.traces : []) as TraceSummary[];
        const earliest = (pendingMessage.pendingStartedAt ?? 0) - 5_000;
        const trace = traces.find((item) => new Date(item.startedAt).getTime() >= earliest
          && (!pendingMessage.pendingInput || item.inputPreview === pendingMessage.pendingInput.slice(0, item.inputPreview.length)));
        if (cancelled) return;
        if (!trace || trace.status === "running") {
          setPendingSessionIds((current) => new Set(current).add(sessionId));
          schedule();
          return;
        }
        if (trace.status === "awaiting_approval") {
          const approvalResponse = await fetch(`/api/approvals?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
          const approvalData = await approvalResponse.json();
          if (!approvalResponse.ok) { schedule(); return; }
          replaceMessage(sessionId, pendingMessage.id, makeApprovalMessage({ ...approvalData, traceId: trace.id, metrics: trace.metrics }));
          finishRecovery();
          return;
        }
        if (trace.status === "completed") {
          const historyResponse = await fetch(`/api/history?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
          const historyData = await historyResponse.json();
          const history = Array.isArray(historyData.messages) ? historyData.messages as Array<{ role: Role; content: string }> : [];
          const finalAnswer = [...history].reverse().find((item) => item.role === "assistant" && item.content)?.content;
          if (finalAnswer) {
            replaceMessage(sessionId, pendingMessage.id, makeAssistantMessage({ message: finalAnswer, traceId: trace.id, metrics: trace.metrics }));
            finishRecovery();
            return;
          }
          schedule();
          return;
        }
        replaceMessage(sessionId, pendingMessage.id, {
          id: makeId("assistant-error"), role: "assistant",
          content: trace.status === "blocked" ? "本次运行已被安全策略终止，请前往 Trace 查看原因。" : `本次运行状态为 ${trace.status}，请前往 Trace 查看详情。`,
          traceId: trace.id, metrics: trace.metrics,
          time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
        });
        finishRecovery();
      } catch {
        if (!cancelled) schedule();
      }
    };

    setPendingSessionIds((current) => new Set(current).add(sessionId));
    void reconcile();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [messages, sessionId, sessionReady]);

  const statusLabel = !activeConfig ? "配置加载中" : "服务正常";

  function saveConversationList(next: ConversationSummary[]) {
    setConversations(next);
    localStorage.setItem(conversationsKey, JSON.stringify(next));
  }

  function touchConversation(id: string, title?: string) {
    setConversations((current) => {
      const existing = current.find((item) => item.id === id);
      const next = [
        { id, title: title ?? existing?.title ?? "新会话", updatedAt: Date.now() },
        ...current.filter((item) => item.id !== id),
      ];
      localStorage.setItem(conversationsKey, JSON.stringify(next));
      return next;
    });
  }

  function switchSession(nextId: string) {
    const clean = nextId.trim();
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(clean)) {
      setError("会话 ID 只能包含字母、数字、点、下划线和短横线。");
      return;
    }
    localStorage.setItem("agent-studio:session", clean);
    activeSessionRef.current = clean;
    setSessionId(clean);
    setSessionDraft(clean);
    setMessages(loadLocalMessages(clean));
    touchConversation(clean);
    setError("");
    setSidebarOpen(false);
  }

  function createConversation() {
    switchSession(makeSessionId());
    setInput("");
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function clearConversation() {
    if (!sessionId || busy) return;
    try {
      await fetch(`/api/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    } finally {
      setMessages([]);
      localStorage.removeItem(storageKey(sessionId));
      touchConversation(sessionId, "新会话");
    }
  }

  async function deleteConversation(id: string) {
    if (pendingSessionIds.has(id)) return;
    await fetch(`/api/session/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    localStorage.removeItem(storageKey(id));
    const next = conversations.filter((item) => item.id !== id);
    saveConversationList(next);
    if (id === sessionId) createConversation();
  }

  async function copySessionId() {
    await navigator.clipboard.writeText(sessionId);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  function chooseProvider(provider: ProviderName) {
    if (!draftConfig || !serverConfig) return;
    const defaults = serverConfig.providers[provider];
    setDraftConfig({
      ...draftConfig,
      provider,
      model: defaults.defaultModel,
      subagentModel: defaults.defaultModel,
      baseURL: defaults.defaultBaseURL,
      apiMode: defaults.defaultApiMode,
      apiKey: "",
    });
  }

  function applySettings(event: FormEvent) {
    event.preventDefault();
    if (!draftConfig?.model.trim()) {
      setSettingsError("请填写主模型名称。");
      return;
    }
    if (draftConfig.provider === "custom" && !draftConfig.baseURL.trim()) {
      setSettingsError("自定义 Provider 必须填写 Base URL。");
      return;
    }
    const invalidTurnLimit = [draftConfig.mainMaxTurns, draftConfig.subagentMaxTurns]
      .some((value) => value !== null && (!Number.isInteger(value) || value < 1 || value > 500));
    if (invalidTurnLimit) {
      setSettingsError("单次 Run 最大循环必须为 1 到 500 的整数，或选择“不限制”。");
      return;
    }
    const normalized = {
      ...draftConfig,
      model: draftConfig.model.trim(),
      subagentModel: draftConfig.subagentModel.trim() || draftConfig.model.trim(),
      baseURL: draftConfig.baseURL.trim(),
    };
    const { apiKey: _secret, ...safeConfig } = normalized;
    localStorage.setItem(settingsKey, JSON.stringify(safeConfig));
    setActiveConfig(normalized);
    setDraftConfig(normalized);
    setSettingsOpen(false);
    setSettingsError("");
    setError("");
  }

  function restoreServerSettings() {
    if (!serverConfig) return;
    const restored: EditableConfig = { ...serverConfig.config, apiKey: "" };
    localStorage.removeItem(settingsKey);
    setDraftConfig(restored);
    setActiveConfig(restored);
    setSettingsError("");
  }

  function makeAssistantMessage(data: Record<string, unknown>): ChatMessage {
    return {
      id: makeId("assistant"),
      role: "assistant",
      content: typeof data.message === "string" ? data.message : "",
      delegated: Boolean(data.delegated),
      tools: Array.isArray(data.tools) ? data.tools.filter((item): item is string => typeof item === "string") : [],
      guardrails: data.guardrails as GuardrailSummary | undefined,
      metrics: data.metrics as RunMetrics | undefined,
      traceId: typeof data.traceId === "string" ? data.traceId : undefined,
      time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    };
  }

  function makeApprovalMessage(data: Record<string, unknown>): ChatMessage {
    const approval = data.approval as Omit<ApprovalRequest, "status">;
    return {
      id: makeId("approval"),
      role: "assistant",
      content: "",
      approval: { ...approval, status: "pending" },
      metrics: data.metrics as RunMetrics | undefined,
      traceId: typeof data.traceId === "string" ? data.traceId : undefined,
      time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    };
  }

  function appendMessage(targetSessionId: string, message: ChatMessage) {
    if (activeSessionRef.current === targetSessionId) {
      setMessages((current) => [...current, message]);
    } else {
      const storedMessages = loadLocalMessages(targetSessionId);
      localStorage.setItem(storageKey(targetSessionId), JSON.stringify([...storedMessages, message]));
    }
  }

  function replaceMessage(targetSessionId: string, messageId: string, replacement: ChatMessage) {
    const replace = (items: ChatMessage[]) => items.map((item) => item.id === messageId ? replacement : item);
    if (activeSessionRef.current === targetSessionId) {
      setMessages(replace);
    } else {
      localStorage.setItem(storageKey(targetSessionId), JSON.stringify(replace(loadLocalMessages(targetSessionId))));
    }
  }

  function patchMessage(targetSessionId: string, messageId: string, patch: Partial<ChatMessage>) {
    const update = (items: ChatMessage[]) => items.map((item) => item.id === messageId ? { ...item, ...patch } : item);
    if (activeSessionRef.current === targetSessionId) setMessages(update);
    else localStorage.setItem(storageKey(targetSessionId), JSON.stringify(update(loadLocalMessages(targetSessionId))));
  }

  function updateApprovalMessage(targetSessionId: string, approvalId: string, status: ApprovalRequest["status"]) {
    const update = (items: ChatMessage[]) => items.map((item) => item.approval?.id === approvalId
      ? { ...item, approval: { ...item.approval, status } }
      : item);
    if (activeSessionRef.current === targetSessionId) {
      setMessages(update);
    } else {
      localStorage.setItem(storageKey(targetSessionId), JSON.stringify(update(loadLocalMessages(targetSessionId))));
    }
  }

  async function submit(messageText?: string) {
    const content = (messageText ?? input).trim();
    if (!content || busy || waitingApproval || !sessionId || !activeConfig) return;
    const requestSessionId = sessionId;

    const userMessage: ChatMessage = {
      id: makeId("user"), role: "user", content,
      time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    };
    const requestId = crypto.randomUUID();
    const pendingMessage: ChatMessage = {
      id: makeId("pending"), role: "assistant", content: "", pending: true,
      pendingStartedAt: Date.now(), pendingInput: content, requestId,
      streamingStatus: "正在启动 Agent Run…", activeAgent: "通用助手",
      time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    };
    activeRequestIdsRef.current.add(pendingMessage.id);
    const requestMessages = [...messages, userMessage, pendingMessage];
    setMessages(requestMessages);
    localStorage.setItem(storageKey(requestSessionId), JSON.stringify(requestMessages));
    const firstUserMessage = messages.find((item) => item.role === "user");
    touchConversation(requestSessionId, shortTitle(firstUserMessage?.content ?? content));
    setInput("");
    setPendingSessionIds((current) => new Set(current).add(requestSessionId));
    setError("");

    try {
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId,
          sessionId: requestSessionId,
          message: content,
          history: messages.filter((item) => !item.pending && !item.approval && item.content).map(({ role, content: text }) => ({ role, content: text })),
          config: { ...activeConfig, apiKey: activeConfig.apiKey || undefined },
        }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "请求失败");
      }
      if (!response.body) throw new Error("服务端没有返回流式响应。");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let terminal = false;
      const handleEvent = (event: Record<string, unknown>) => {
        if (event.type === "run_started") {
          patchMessage(requestSessionId, pendingMessage.id, {
            runId: typeof event.runId === "string" ? event.runId : undefined,
            traceId: typeof event.traceId === "string" ? event.traceId : undefined,
            streamingStatus: event.recovered ? "已重新连接后台 Run…" : "Agent Run 已启动…",
          });
        } else if (event.type === "text_delta" && typeof event.delta === "string") {
          const update = (items: ChatMessage[]) => items.map((item) => item.id === pendingMessage.id
            ? { ...item, content: `${item.content}${event.delta}`, streamingStatus: "正在生成回复…" }
            : item);
          if (activeSessionRef.current === requestSessionId) setMessages(update);
          else localStorage.setItem(storageKey(requestSessionId), JSON.stringify(update(loadLocalMessages(requestSessionId))));
        } else if (event.type === "activity" || event.type === "handoff" || event.type === "agent_updated") {
          patchMessage(requestSessionId, pendingMessage.id, {
            streamingStatus: typeof event.label === "string" ? event.label : "Agent 正在运行…",
            activeAgent: typeof event.agentName === "string" ? event.agentName : typeof event.toAgent === "string" ? event.toAgent : undefined,
          });
        } else if (event.type === "approval_required" && event.data && typeof event.data === "object") {
          terminal = true;
          replaceMessage(requestSessionId, pendingMessage.id, makeApprovalMessage(event.data as Record<string, unknown>));
        } else if (event.type === "completed" && event.data && typeof event.data === "object") {
          terminal = true;
          replaceMessage(requestSessionId, pendingMessage.id, makeAssistantMessage(event.data as Record<string, unknown>));
          touchConversation(requestSessionId);
        } else if (event.type === "cancelled") {
          terminal = true;
          replaceMessage(requestSessionId, pendingMessage.id, {
            id: makeId("assistant-cancelled"), role: "assistant",
            content: typeof event.message === "string" ? event.message : "任务已取消。",
            cancelled: true,
            traceId: typeof event.traceId === "string" ? event.traceId : undefined,
            time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
          });
        } else if (event.type === "error") {
          terminal = true;
          const guardrail = event.guardrail as ChatMessage["guardrailBlock"] | undefined;
          replaceMessage(requestSessionId, pendingMessage.id, {
            id: makeId("assistant-error"), role: "assistant", content: typeof event.error === "string" ? event.error : "Agent Run 执行失败。",
            guardrailBlock: guardrail,
            traceId: typeof event.traceId === "string" ? event.traceId : undefined,
            time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
          });
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (data) handleEvent(JSON.parse(data) as Record<string, unknown>);
          boundary = buffer.indexOf("\n\n");
        }
        if (done) break;
      }
      if (!terminal) patchMessage(requestSessionId, pendingMessage.id, { streamingStatus: "连接已中断，正在恢复后台 Run…" });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "请求失败，请稍后再试。";
      patchMessage(requestSessionId, pendingMessage.id, { streamingStatus: `连接异常，正在恢复：${message}` });
    } finally {
      activeRequestIdsRef.current.delete(pendingMessage.id);
      setPendingSessionIds((current) => {
        const next = new Set(current);
        next.delete(requestSessionId);
        return next;
      });
      if (activeSessionRef.current === requestSessionId) {
        setMessages((current) => [...current]);
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    }
  }

  async function cancelCurrentRun() {
    const pending = [...messages].reverse().find((message) => message.pending && message.runId);
    if (!pending?.runId) return;
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(pending.runId)}/cancel`, { method: "POST" });
      const data = await response.json();
      if (!response.ok && response.status !== 409) throw new Error(data.error || "停止失败");
      replaceMessage(sessionId, pending.id, {
        id: makeId("assistant-cancelled"), role: "assistant", content: "任务已取消。",
        cancelled: true, traceId: pending.traceId,
        time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "停止失败");
    }
  }

  async function decideApproval(message: ChatMessage, decision: "approve_once" | "approve_session" | "reject") {
    const approval = message.approval;
    if (!approval || approval.status !== "pending" || approvalBusyRef.current.has(approval.id)) return;
    const requestSessionId = approval.sessionId;
    approvalBusyRef.current.add(approval.id);
    setApprovalBusyIds((current) => new Set(current).add(approval.id));
    setPendingSessionIds((current) => new Set(current).add(requestSessionId));
    setError("");
    try {
      const response = await fetch(`/api/approvals/${encodeURIComponent(approval.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 410) updateApprovalMessage(requestSessionId, approval.id, "expired");
        if (data.guardrail) {
          updateApprovalMessage(requestSessionId, approval.id, decision === "reject" ? "rejected" : decision === "approve_session" ? "approved_session" : "approved");
          appendMessage(requestSessionId, {
            id: makeId("guardrail"), role: "assistant", content: data.error || "恢复运行时触发 Guardrail。",
            guardrailBlock: data.guardrail,
            time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
          });
          return;
        }
        throw new Error(data.error || "审批失败");
      }
      updateApprovalMessage(requestSessionId, approval.id, decision === "reject" ? "rejected" : decision === "approve_session" ? "approved_session" : "approved");
      appendMessage(requestSessionId, data.status === "approval_required" ? makeApprovalMessage(data) : makeAssistantMessage(data));
      touchConversation(requestSessionId);
    } catch (reason) {
      if (activeSessionRef.current === requestSessionId) setError(reason instanceof Error ? reason.message : "审批失败，请稍后再试。");
    } finally {
      approvalBusyRef.current.delete(approval.id);
      setApprovalBusyIds((current) => { const next = new Set(current); next.delete(approval.id); return next; });
      setPendingSessionIds((current) => { const next = new Set(current); next.delete(requestSessionId); return next; });
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`}>
        <div className="brand"><div className="brand-mark"><Icon name="spark" size={21} /></div><div><strong>Agent Studio</strong><span>Multi-agent workspace</span></div></div>
        <button className="new-chat" onClick={createConversation}><Icon name="plus" /> 新建会话</button>

        <section className="side-section">
          <div className="side-heading">当前编排</div>
          <div className="agent-map">
            <div className="agent-node main-node"><span className="node-dot" /><div><strong>Main Agent</strong><small>决策 · 汇总 · 回复</small></div></div>
            <div className="agent-connector"><span /></div>
            {configuredAgents.length === 0 ? <div className="agent-node worker-node"><span className="node-dot" /><div><strong>暂无专家</strong><small>前往 Agent 编排配置</small></div></div> : configuredAgents.map((agent) => <div className="agent-node worker-node" key={agent.id}><span className="node-dot" /><div><strong>{agent.name}</strong><small>{agent.collaboration === "both" ? "Handoff · Tool" : agent.collaboration === "handoff" ? "Handoff 接管" : "Tool 委派"}</small></div></div>)}
          </div>
        </section>

        <section className="side-section history-section">
          <div className="side-heading history-heading"><span>聊天记录</span><Icon name="history" size={13} /></div>
          <div className="history-list">
            {sortedConversations.map((conversation) => (
              <div className={`history-item ${conversation.id === sessionId ? "active" : ""}`} key={conversation.id}>
                <button className="history-main" onClick={() => switchSession(conversation.id)}>
                  <strong>{conversation.title}</strong><span>{pendingSessionIds.has(conversation.id) ? "处理中 · " : ""}{relativeTime(conversation.updatedAt)}</span>
                </button>
                <button className="history-delete" onClick={() => void deleteConversation(conversation.id)} disabled={pendingSessionIds.has(conversation.id)} title={pendingSessionIds.has(conversation.id) ? "请求完成后可删除" : "删除记录"}><Icon name="trash" size={13} /></button>
              </div>
            ))}
          </div>
        </section>

        <section className="side-section session-section">
          <div className="side-heading">会话 ID</div>
          <div className="session-control">
            <input value={sessionDraft} onChange={(event) => setSessionDraft(event.target.value)} onBlur={() => switchSession(sessionDraft)} onKeyDown={(event) => { if (event.key === "Enter") switchSession(sessionDraft); }} aria-label="会话 ID" />
            <button onClick={copySessionId} title="复制会话 ID"><Icon name="copy" size={16} /></button>
          </div>
          {copied && <div className="copy-note">已复制</div>}
        </section>

        <div className="sidebar-footer">
          <div className={`connection-status ${activeConfig ? "online" : ""}`}><span />{statusLabel}</div>
          <button className="clear-button" onClick={clearConversation} disabled={!hasMessages || busy}><Icon name="trash" size={16} />清空当前会话</button>
        </div>
      </aside>

      {sidebarOpen && <button className="sidebar-backdrop" aria-label="关闭菜单" onClick={() => setSidebarOpen(false)} />}

      <main className="main-panel">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="打开菜单"><Icon name="menu" /></button>
          <div className="topbar-title"><strong>通用助手</strong><span>{configuredAgents.length ? `已连接 ${configuredAgents.length} 个专家 Agent` : "当前未启用专家 Agent"}</span></div>
          <div className="runtime-badges">
            <span className="runtime-badge provider-badge">{activeConfig?.provider ?? "provider"}</span>
            <span className="runtime-badge">{activeConfig?.model ?? "loading model"}</span>
          </div>
          <AgentSettingsMenu current="runtime" onOpenRuntime={() => { setDraftConfig(activeConfig); setSettingsError(""); setSettingsOpen(true); }} />
        </header>

        <div className="chat-area">
          {!hasMessages && !busy ? (
            <section className="welcome">
              <div className="welcome-orbit"><div className="welcome-core"><Icon name="spark" size={30} /></div><i /><i /><i /></div>
              <p className="eyebrow">MAIN AGENT · SUBAGENT</p><h1>今天想一起解决什么？</h1>
              <p className="welcome-copy">简单问题由主 Agent 直接回答，复杂任务会拆分并交给 Subagent 独立分析，再统一汇总结果。</p>
              <div className="prompt-grid">{starterPrompts.map((prompt, index) => <button key={prompt} onClick={() => void submit(prompt)}><span>0{index + 1}</span>{prompt}</button>)}</div>
            </section>
          ) : (
            <div className="message-list" aria-live="polite">
              {messages.map((message) => (
                <article className={`message-row ${message.role}`} key={message.id}>
                  <div className="avatar">{message.role === "assistant" ? <Icon name="spark" size={17} /> : "你"}</div>
                  <div className="message-stack">
                    <div className="message-meta"><strong>{message.role === "assistant" ? "通用助手" : "你"}</strong>{message.delegated && <span className="delegated-badge">Subagent 参与</span>}{Boolean(message.tools?.some((name) => name === "load_skill" || name === "read_skill_file")) && <span className="skill-badge">Skill 已加载</span>}{Boolean(message.tools?.some((name) => !["delegate_task", "load_skill", "read_skill_file"].includes(name))) && <span className="tool-badge">工具已调用</span>}{Boolean(message.guardrails && [...message.guardrails.input, ...message.guardrails.output, ...message.guardrails.tool].length) && <span className="guardrail-pass-badge">Guardrails 已检查</span>}{message.guardrailBlock && <span className="guardrail-block-badge">Guardrail 已拦截</span>}<time>{message.time}</time></div>
                    {message.pending ? <div className={`message-bubble streaming-bubble ${message.content ? "has-content" : ""}`} role="status" aria-label="Agent 正在运行">{message.content ? <MessageBody content={message.content} /> : null}<div className="streaming-progress"><i /><i /><i /><span>{message.activeAgent ? `${message.activeAgent} · ` : ""}{message.streamingStatus ?? "Agent 正在运行，工具调用可能需要一些时间…"}</span></div></div> : message.approval ? <div className={`approval-card ${message.approval.status}`}>
                      <div className="approval-card-header"><span className="approval-icon"><Icon name="shield" size={19} /></span><div><strong>{message.approval.status === "pending" ? "敏感操作等待你的审批" : message.approval.status === "approved_session" ? "已批准并授权当前会话" : message.approval.status === "approved" ? "敏感操作已批准" : message.approval.status === "rejected" ? "敏感操作已拒绝" : "审批运行上下文已失效"}</strong><p>{message.approval.status === "pending" ? "Agent Run 已暂停且不会自动过期；处理审批或删除会话后才会结束。" : message.approval.status === "approved_session" ? "参数落在下方授权范围内时，后续调用将自动放行。" : message.approval.status === "expired" ? "通常是服务进程重启导致，当前会话仍可继续发送新消息。" : "这条审批已经完成，不可重复操作。"}</p></div></div>
                      <div className="approval-items">{message.approval.items.map((item) => <section key={item.id}><div><span>工具</span><strong>{item.toolName}</strong>{item.riskLevel && <b className={`approval-risk ${item.riskLevel}`}>{item.riskLevel}</b>}<small>{item.capabilities?.join(" · ") || item.agentName}</small></div><pre>{JSON.stringify(item.arguments, null, 2)}</pre><p className="approval-session-scope"><Icon name="shield" size={12} /><span>会话授权范围</span>{item.sessionScope?.description ?? "旧审批请求不支持会话授权，请仅批准本次或重新发起。"}</p></section>)}</div>
                      {message.approval.status === "pending" && <div className="approval-actions"><span>{message.approval.items.every((item) => item.source === "mcp") ? "将信任所列 MCP 服务，本会话内不再逐个审批" : "会话授权只匹配显示的受控范围"}</span><button className="reject" disabled={approvalBusyIds.has(message.approval.id)} onClick={() => void decideApproval(message, "reject")}>拒绝</button><button className="approve-once" disabled={approvalBusyIds.has(message.approval.id)} onClick={() => void decideApproval(message, "approve_once")}>仅批准本次</button><button className="approve" disabled={approvalBusyIds.has(message.approval.id)} onClick={() => void decideApproval(message, "approve_session")}>{approvalBusyIds.has(message.approval.id) ? "处理中…" : message.approval.items.every((item) => item.source === "mcp") ? "本会话信任服务" : "本会话允许"}</button></div>}
                    </div> : <div className={`message-bubble ${message.guardrailBlock ? "guardrail-block-message" : ""} ${message.cancelled ? "cancelled-message" : ""}`}>{message.cancelled && <div className="cancelled-message-title"><span>■</span> Agent Run 已取消</div>}<MessageBody content={message.content} />{message.guardrailBlock?.outputInfo ? <pre className="guardrail-detail">{JSON.stringify(message.guardrailBlock.outputInfo, null, 2)}</pre> : null}</div>}
                  </div>
                </article>
              ))}
              <div ref={chatEndRef} />
            </div>
          )}
        </div>

        <div className="composer-wrap">
          {sessionMetrics && <div className="run-metrics" aria-label="当前会话运行统计">
            <div className="run-metrics-group" title="模型轮次为实际模型请求数；步骤还包含工具调用、交接和审批继续；速度为输出 Token / Agent 实际运行时间">
              <Icon name="gauge" size={16} />
              <span><strong>{sessionMetrics.modelTurns}</strong> 轮</span>
              <span><strong>{sessionMetrics.steps}</strong> 步</span>
              <i>·</i>
              <span>均速 {sessionMetrics.tokensPerSecond === null ? "—" : Math.round(sessionMetrics.tokensPerSecond)} tok/s</span>
              {busy && <b className="metrics-running">更新中</b>}
            </div>
            <div className="run-metrics-group" title="Token 为当前会话累计；缓存命中率 = 缓存输入 Token / 输入 Token">
              <Icon name="database" size={16} />
              <span>{new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(sessionMetrics.totalTokens)} tok</span>
              <i>·</i>
              <span>缓存命中 {sessionMetrics.cacheHitRate === null ? "—" : `${Math.round(sessionMetrics.cacheHitRate * 100)}%`}</span>
            </div>
          </div>}
          {error && <div className="error-banner">{error}</div>}
          <form className="composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <textarea ref={textareaRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleKeyDown} placeholder={waitingApproval ? "请先处理上方的待审批操作…" : "输入消息，Shift + Enter 换行…"} rows={1} disabled={busy || waitingApproval || !activeConfig} />
            {sessionId && activeConfig && <ContextUsage key={JSON.stringify([sessionId, activeConfig.provider, activeConfig.model, activeConfig.baseURL, activeConfig.apiMode])} sessionId={sessionId} config={activeConfig} busy={busy} revision={messages.length} draft={input} />}
            {busy
              ? <button type="button" className="stop-run" onClick={() => void cancelCurrentRun()} aria-label="停止运行"><Icon name="stop" size={17} /></button>
              : <button type="submit" disabled={!input.trim() || waitingApproval || !activeConfig} aria-label="发送"><Icon name="send" size={19} /></button>}
          </form>
          <div className="composer-note">当前：{activeConfig?.provider ?? "加载中"} / {activeConfig?.model ?? "加载中"} · Subagent：{activeConfig?.subagentModel ?? "加载中"}</div>
        </div>
      </main>

      {settingsOpen && draftConfig && serverConfig && (
        <SettingsModal
          config={draftConfig}
          providers={serverConfig.providers}
          onChange={setDraftConfig}
          onChooseProvider={chooseProvider}
          onApply={applySettings}
          onRestore={restoreServerSettings}
          onClose={() => setSettingsOpen(false)}
          validationError={settingsError}
        />
      )}
    </div>
  );
}
