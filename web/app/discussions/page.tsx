"use client";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ManagementHeader } from "@/components/management-header";
import { statusLabels, phaseLabels, participantStatus, type Room, type RoomSummary } from "@/lib/discussion-hub-types";

const initialSeats = [
  { id: "product", name: "产品与主持人", role: "澄清用户价值与范围，最后中立总结方案、分歧和待验证假设。" },
  { id: "architect", name: "架构审查者", role: "评估技术可行性、复杂度和实施步骤，主动回应质疑。" },
  { id: "reviewer", name: "风险审查者", role: "寻找风险、反例与缺失证据，提出建设性改进。" },
];
export default function DiscussionPage() {
  const [admin, setAdmin] = useState(""); const adminRef = useRef("");
  const [unlocked, setUnlocked] = useState(false);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [room, setRoom] = useState<Room | null>(null);
  const [selected, setSelected] = useState(""); const selectedRef = useRef("");
  const [topic, setTopic] = useState(""); const [rules, setRules] = useState("");
  const [seats, setSeats] = useState(initialSeats); const [moderator, setModerator] = useState("product");
  const [rounds, setRounds] = useState(1); const [note, setNote] = useState("");
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false); const [baseURL, setBaseURL] = useState("");
  const [invitation, setInvitation] = useState<{ participantId: string; token: string } | null>(null);
  const requestRef = useRef({ fingerprint: "", id: "" });
  useEffect(() => setBaseURL(window.location.origin), []);
  async function api(path: string, body?: unknown, method = "POST", signal?: AbortSignal) {
    const response = await fetch(path, { method: body ? method : "GET", cache: "no-store", signal,
      headers: { Authorization: `Bearer ${adminRef.current}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || "请求失败"); return result;
  }
  function choose(id: string) { selectedRef.current = id; setSelected(id); setRoom(null); setInvitation(null); setNote(""); setError(""); setNotice(""); }
  async function refresh() { const data = await api("/api/discussions"); setRooms(data.rooms); }
  async function unlock() {
    setBusy(true); setError(""); adminRef.current = admin.trim();
    try { await refresh(); setUnlocked(true); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  useEffect(() => {
    if (!selected || !unlocked) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await api(`/api/discussions/${selected}`, undefined, "GET", controller.signal);
        if (controller.signal.aborted || selectedRef.current !== selected) return;
        setRoom((old) => old && old.updatedAt > data.room.updatedAt ? old : data.room);
        setRooms((list) => list.map((r) => r.id === selected ? { ...r, status: data.room.status, updatedAt: data.room.updatedAt } : r));
      } catch (reason) { if (!controller.signal.aborted && selectedRef.current === selected) setError((reason as Error).message); }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2500);
    }
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [selected, unlocked]);
  async function create() {
    setBusy(true); setError("");
    const payload = { topic, rules, participants: seats, moderatorId: moderator, rounds };
    const fingerprint = JSON.stringify(payload);
    if (requestRef.current.fingerprint !== fingerprint) requestRef.current = { fingerprint, id: crypto.randomUUID() };
    try {
      const data = await api("/api/discussions", { ...payload, requestId: requestRef.current.id });
      choose(data.room.id); setRoom(data.room); requestRef.current = { fingerprint: "", id: "" }; await refresh();
    } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  async function act(body: Record<string, string>) {
    const target = selectedRef.current;
    if (body.action === "invite" && room?.participants.find((p) => p.id === body.participantId)?.joined && !confirm("重新邀请会使旧令牌和正在准备的发言租约失效，确认继续？")) return;
    if (body.action === "cancel" && !confirm("结束本场讨论并拒绝后续提交？已发表内容保留。")) return;
    setBusy(true); setError("");
    try {
      const data = await api(`/api/discussions/${target}`, body, "PATCH");
      if (selectedRef.current === target) {
        setRoom(data.room); setNote("");
        if (data.token) setInvitation({ participantId: data.participantId, token: data.token });
        else if (body.action === "revoke" || body.action === "cancel") setInvitation(null);
      }
      await refresh();
    } catch (reason) { if (selectedRef.current === target) setError((reason as Error).message); } finally { setBusy(false); }
  }
  function origin() {
    const url = new URL(baseURL); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("接入地址必须是 HTTP(S) origin，不含路径、凭据或参数"); return url.origin;
  }
  async function copy(value: string) { try { await navigator.clipboard.writeText(value); setNotice("已复制。邀请令牌请私下交给对应 Agent，不要放进公共记录。"); } catch { setError("剪贴板不可用，请手动复制下方内容。"); } }
  function invitationText() {
    const participant = room?.participants.find((p) => p.id === invitation?.participantId);
    return `请加入 Agent 讨论室「${room?.topic}」，以「${participant?.name}」席位参与。\n接入地址：${origin()}\n先完整阅读 Skill：${origin()}/api/discussion-connect/skill\n可下载完整 Skill 包：${origin()}/api/discussion-connect/skill?format=zip\n角色职责：${participant?.role}\n邀请令牌会单独私下提供，请通过 DISCUSSION_TOKEN 环境变量使用，不要写入公开发言。保持你自己的身份与私有上下文，只共享公开观点。加入后等待主持人开始，并按 Skill 领取和提交发言；我停止参与或房间结束时退出。`;
  }
  const live = room?.mode === "external" && ["lobby", "running", "paused"].includes(room.status);
  const current = room?.tasks.find((t) => !t.completed);
  return <main className="management-page discussion-page">
    <ManagementHeader current="experiments" backHref="/experiments" eyebrow="EXPERIMENTAL · AGENT DISCUSSION" title="Agent 讨论室 · 实验功能" description="邀请独立 Agent 共享公开讨论空间。当前作为实验保留，现有功能与记录不变。" />
    {error && <div role="alert" className="management-error">{error}</div>}
    {notice && <div role="status" className="discussion-notice">{notice}</div>}
    {!unlocked ? <section className="discussion-card discussion-unlock"><h2>房主管理入口</h2>
      <p>本入口使用独立管理口令，参与者邀请只能读取所属房间和发表自己的观点。管理口令仅保存在当前页面内存中。</p>
      <label>管理口令<input type="password" autoComplete="off" value={admin} onChange={(e) => setAdmin(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !busy) void unlock(); }} /></label>
      <button className="discussion-primary" disabled={busy || !admin.trim()} onClick={() => void unlock()}>{busy ? "验证中…" : "进入讨论室"}</button>
      <details><summary>首次配置</summary><p>在项目根目录 .env 添加 DISCUSSION_ADMIN_TOKEN（至少 24 位字母、数字、下划线或连字符），重启 Web 服务。可用 <code>openssl rand -hex 32</code> 生成。不要将管理口令交给参与者。</p><p>远程部署只代理 /api/discussion-connect 及其 Skill 子路径；不要把主应用其他未鉴权接口直接暴露公网。</p></details>
    </section> : <div className="discussion-layout">
      <aside className="discussion-history"><button className="discussion-primary" disabled={busy} onClick={() => choose("")}>＋ 新建讨论</button>
        <div className="discussion-history-heading"><strong>讨论记录</strong><button onClick={() => void refresh().catch((e) => setError(e.message))}>↻</button></div>
        {rooms.map((r) => <button key={r.id} disabled={busy} className={`discussion-history-item ${r.id === selected ? "selected" : ""}`} onClick={() => choose(r.id)}><strong>{r.topic}</strong><span>{r.mode === "legacy" ? "旧版 · " : ""}{statusLabels[r.status]}</span></button>)}
        <p>房间和任务自动保存。断线不会结束讨论，原身份可以重连。</p>
        <button onClick={() => { adminRef.current = ""; setAdmin(""); setUnlocked(false); choose(""); setRooms([]); }}>锁定管理入口</button>
      </aside>
      <section className="discussion-main">
        {!selected && <section className="discussion-card"><h2>创建讨论空间</h2><p>先设定席位，再邀请外部 Agent 加入。这里不再填写模型 Key，也不启动本机进程。</p>
          <label>议题<textarea rows={4} value={topic} maxLength={12000} onChange={(e) => setTopic(e.target.value)} placeholder="描述你想讨论的需求、约束与目标" /></label>
          <label>本场讨论规则<textarea rows={2} value={rules} maxLength={6000} onChange={(e) => setRules(e.target.value)} placeholder="例如：优先评估两周内的 MVP；明确证据和假设，不执行方案" /></label>
          <div className="discussion-agents">{seats.map((seat, i) => <div className="discussion-agent-fields discussion-seat-editor" key={seat.id}>
            <label>席位 {i + 1} 名称<input value={seat.name} maxLength={60} onChange={(e) => setSeats(seats.map((p) => p.id === seat.id ? { ...p, name: e.target.value } : p))} /></label>
            <label>本场职责（不覆盖 Agent 人格）<input value={seat.role} maxLength={2000} onChange={(e) => setSeats(seats.map((p) => p.id === seat.id ? { ...p, role: e.target.value } : p))} /></label>
            <button disabled={seats.length <= 2} onClick={() => { const next = seats.filter((p) => p.id !== seat.id); setSeats(next); if (moderator === seat.id) setModerator(next[0].id); }}>移除席位</button>
          </div>)}</div>
          <button className="discussion-add" disabled={seats.length >= 6} onClick={() => setSeats([...seats, { id: crypto.randomUUID(), name: `参与者 ${seats.length + 1}`, role: "提供独立且有依据的观点" }])}>＋ 添加席位（{seats.length}/6）</button>
          <div className="discussion-options"><label>主持总结人<select value={moderator} onChange={(e) => setModerator(e.target.value)}>{seats.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>交叉讨论轮数<select value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n} 轮</option>)}</select></label></div>
          <div className="discussion-launch"><p>独立初评 → 交叉讨论 → 主持总结。房间不代付模型费用，也不会控制外部 Agent 的工具权限。</p><button className="discussion-primary" disabled={busy || !topic.trim()} onClick={() => void create()}>创建并邀请 →</button></div>
        </section>}
        {selected && !room && <div className="discussion-card">正在读取讨论…</div>}
        {room && <>
          <section className="discussion-card"><span className="discussion-label">{statusLabels[room.status]}</span><h2>{room.topic}</h2><p>{room.rules}</p>
            {room.mode === "legacy" ? <p>{room.error}</p> : <>
              <div className="discussion-progress"><span>{current && ["running", "paused"].includes(room.status) ? `${room.status === "paused" ? "暂停于" : "当前等待"}：${room.participants.find((p) => p.id === current.participantId)?.name} · ${phaseLabels[current.phase]}` : room.status === "lobby" ? "全部加入后由房主开始" : `${statusLabels[room.status]} · 已发表内容已保留`}</span><span>{room.tasks.filter((t) => t.completed).length}/{room.tasks.length || "—"} 次发言</span></div>
              <div className="discussion-toolbar">
                {room.status === "lobby" && <button className="discussion-primary" disabled={busy || room.participants.some((p) => !p.joined || p.left || p.revoked)} onClick={() => void act({ action: "start" })}>开始讨论</button>}
                {room.status === "running" && <button disabled={busy} onClick={() => void act({ action: "pause" })}>暂停讨论</button>}
                {room.status === "paused" && <button disabled={busy} onClick={() => void act({ action: "resume" })}>恢复讨论</button>}
                {live && <button disabled={busy} onClick={() => void act({ action: "cancel" })}>结束讨论</button>}
                <a href="/api/discussion-connect/skill?format=zip" download>下载接入 Skill</a>
              </div>
              <p>参与者离线时会停在当前轮次等待；暂停、重邀或退出会使旧任务租约失效。邀请不授予本机或远程工具权限。</p>
            </>}
          </section>
          <section className="discussion-card"><h2>参与者</h2>{room.participants.map((p, i) => <div className="discussion-member" key={p.id}>
            <span className={`discussion-avatar color-${i % 6}`}>{p.name.slice(0, 1)}</span><div><strong>{p.name}{p.id === room.moderatorId ? " · 主持" : ""}</strong><p>{p.role}</p><small>{room.mode === "legacy" ? "历史参与者" : participantStatus(room, p)}{p.clientLabel ? ` · ${p.clientLabel}` : ""}</small></div>
            {live && <div className="discussion-toolbar"><button disabled={busy} onClick={() => void act({ action: "invite", participantId: p.id })}>{p.joined ? "重新邀请" : "生成邀请"}</button><button disabled={busy} onClick={() => void act({ action: "revoke", participantId: p.id })}>撤销</button></div>}
          </div>)}</section>
          {invitation && live && <section className="discussion-card discussion-invitation"><h2>邀请 {room.participants.find((p) => p.id === invitation.participantId)?.name}</h2>
            <label>外部 Agent 可访问的服务地址<input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://discussion.example.com" /></label>
            <p>同一台机器可使用 localhost；其他机器需填写可达的 HTTPS 地址。这里仅生成邀请文本，不会替你开端口或发布服务。</p>
            <div className="discussion-toolbar"><button onClick={() => { try { void copy(invitationText()); } catch (e) { setError((e as Error).message); } }}>复制参会说明（不含令牌）</button><button onClick={() => void copy(invitation.token)}>复制专属邀请令牌</button></div>
            <label>邀请令牌（只在本次生成后显示）<input readOnly type="password" value={invitation.token} /></label>
            <details><summary>查看参会说明</summary><pre className="discussion-invite-text">{(() => { try { return invitationText(); } catch { return "请填写有效服务地址"; } })()}</pre></details>
            <p>令牌请单独私下交给对应 Agent；服务端只存哈希。刷新后无法找回原令牌，可重新邀请，旧令牌立即失效。</p>
          </section>}
          {room.messages.map((message) => <article key={message.id} className={`discussion-speech ${message.phase === "summary" ? "discussion-conclusion" : ""}`}><div className="discussion-speech-body"><header><strong>{message.name}</strong><span>{phaseLabels[message.phase]}{message.phase === "debate" ? ` · 第 ${message.round} 轮` : ""}</span><time>{new Date(message.createdAt).toLocaleTimeString()}</time></header><div className="message-content discussion-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span>[图片：{alt || "未加载"}]</span>, a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{message.content}</ReactMarkdown></div></div></article>)}
          {live && <section className="discussion-card"><h2>补充约束</h2><textarea rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} /><div className="discussion-launch"><p>补充进入公开记录；已领取任务的 Agent 下次读取时可见。</p><button disabled={busy || !note.trim()} onClick={() => void act({ action: "note", content: note })}>发送补充</button></div></section>}
        </>}
      </section>
    </div>}
  </main>;
}
