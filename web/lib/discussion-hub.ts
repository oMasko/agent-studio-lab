import { randomBytes, randomUUID } from "node:crypto";
import type { z } from "zod";
import { agentDatabase } from "@/lib/database";
import { DiscussionError, discussionSkill, hash } from "@/lib/discussion-access";
import type { createSchema, actionSchema, connectSchema } from "@/lib/discussion-hub-schema";
import type { Room, RoomSummary, Task, Participant } from "@/lib/discussion-hub-types";
const LEASE_MS = 10 * 60 * 1000;
type Credential = { room_id: string; participant_id: string; client_id: string | null; revoked: number };
function db() {
  const database = agentDatabase();
  database.exec(`CREATE TABLE IF NOT EXISTS discussion_hub_rooms (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, room_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS discussion_hub_tokens (room_id TEXT NOT NULL, participant_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, client_id TEXT, revoked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(room_id, participant_id));`);
  return database;
}
// No await inside transactions: claims and submissions are atomic across processes.
function transaction<T>(action: () => T): T {
  const database = db(); database.exec("BEGIN IMMEDIATE");
  try { const result = action(); database.exec("COMMIT"); return result; }
  catch (error) { database.exec("ROLLBACK"); throw error; }
}
function read(id: string): Room {
  const row = db().prepare("SELECT room_json FROM discussion_hub_rooms WHERE id=?").get(id) as { room_json: string } | undefined;
  if (!row) throw new DiscussionError("NOT_FOUND", "讨论室不存在", 404);
  return JSON.parse(row.room_json);
}
function save(room: Room) { room.updatedAt = Date.now(); db().prepare("UPDATE discussion_hub_rooms SET room_json=? WHERE id=?").run(JSON.stringify(room), room.id); }
const terminal = (room: Room) => ["completed", "cancelled", "interrupted", "failed"].includes(room.status);
const currentTask = (room: Room) => room.tasks.find((task) => !task.completed);
function resetLease(room: Room, participantId?: string) {
  for (const task of room.tasks) if (!task.completed && (!participantId || task.participantId === participantId)) { delete task.leaseId; delete task.leaseUntil; }
}
export function createRoom(input: z.infer<typeof createSchema>): Room {
  const fingerprint = hash(JSON.stringify(input));
  return transaction(() => {
    const existing = db().prepare("SELECT room_json FROM discussion_hub_rooms WHERE request_id=?").get(input.requestId) as { room_json: string } | undefined;
    if (existing) {
      const value = JSON.parse(existing.room_json);
      if (value.creationHash !== fingerprint) throw new DiscussionError("CONFLICT", "请求 ID 已用于其他配置");
      return value;
    }
    const room: Room & { creationHash: string } = { ...input, mode: "external", id: randomUUID(), status: "lobby", skillHash: discussionSkill().hash, creationHash: fingerprint,
      participants: input.participants.map((p) => ({ ...p, joined: false, left: false, revoked: false, lastSeen: 0, clientLabel: "" })),
      tasks: [], messages: [], createdAt: Date.now(), updatedAt: Date.now(), error: "" };
    db().prepare("INSERT INTO discussion_hub_rooms VALUES (?, ?, ?)").run(room.id, room.requestId, JSON.stringify(room));
    return room;
  });
}
function legacyRooms(): Room[] {
  if (!db().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='discussion_rooms'").get()) return [];
  return (db().prepare("SELECT room_json FROM discussion_rooms ORDER BY updated_at DESC LIMIT 100").all() as { room_json: string }[]).map(({ room_json }) => {
    const old = JSON.parse(room_json);
    return { id: old.id, requestId: old.requestId, mode: "legacy", topic: old.topic, rules: "旧版讨论记录（只读）", rounds: old.config.rounds, moderatorId: old.config.moderatorId,
      participants: old.config.agents.map((a: { id: string; name: string; instructions: string }) => ({ id: a.id, name: a.name, role: a.instructions, joined: false, left: false, revoked: false, lastSeen: 0, clientLabel: "旧版" })),
      status: old.status === "running" ? "interrupted" : old.status, messages: old.messages.filter((m: { content: string }) => m.content), tasks: [],
      createdAt: old.createdAt, updatedAt: old.updatedAt, skillHash: "", error: "旧版自动调用模式已停用，历史记录保留。" };
  });
}
export function getRoom(id: string): Room {
  try { return read(id); } catch (error) { const legacy = legacyRooms().find((room) => room.id === id); if (legacy) return legacy; throw error; }
}
export function listRooms(): RoomSummary[] {
  const rooms = (db().prepare("SELECT room_json FROM discussion_hub_rooms").all() as { room_json: string }[]).map((row) => JSON.parse(row.room_json) as Room);
  return [...rooms, ...legacyRooms()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100).map(({ id, mode, topic, status, createdAt, updatedAt }) => ({ id, mode, topic, status, createdAt, updatedAt }));
}
export function manageRoom(id: string, action: z.infer<typeof actionSchema>): { room: Room; token?: string; participantId?: string } {
  return transaction(() => {
    const room = read(id);
    if (terminal(room)) throw new DiscussionError("ENDED", "讨论已结束，不能继续修改");
    let token: string | undefined;
    if (action.action === "invite" || action.action === "revoke") {
      const participant = room.participants.find((p) => p.id === action.participantId);
      if (!participant) throw new DiscussionError("NOT_FOUND", "参与者不存在", 404);
      resetLease(room, participant.id);
      participant.joined = false; participant.left = false; participant.lastSeen = 0; participant.clientLabel = "";
      participant.revoked = action.action === "revoke";
      if (action.action === "invite") {
        token = randomBytes(32).toString("base64url");
        db().prepare("INSERT INTO discussion_hub_tokens VALUES (?, ?, ?, NULL, 0) ON CONFLICT(room_id,participant_id) DO UPDATE SET token_hash=excluded.token_hash,client_id=NULL,revoked=0").run(id, participant.id, hash(token));
      } else db().prepare("UPDATE discussion_hub_tokens SET revoked=1 WHERE room_id=? AND participant_id=?").run(id, participant.id);
    } else if (action.action === "start") {
      if (room.status !== "lobby") throw new DiscussionError("CONFLICT", "讨论已开始");
      if (room.participants.some((p) => !p.joined || p.left || p.revoked)) throw new DiscussionError("NOT_READY", "请等待所有参与者加入后开始");
      const task = (participantId: string, phase: Task["phase"], round: number): Task => ({ id: randomUUID(), participantId, phase, round, completed: false });
      room.tasks = [...room.participants.map((p) => task(p.id, "initial", 0)),
        ...Array.from({ length: room.rounds }, (_, i) => room.participants.map((p) => task(p.id, "debate", i + 1))).flat(), task(room.moderatorId, "summary", room.rounds + 1)];
      room.status = "running";
    } else if (action.action === "pause") {
      if (room.status !== "running") throw new DiscussionError("CONFLICT", "当前没有运行中的讨论");
      room.status = "paused"; resetLease(room);
    } else if (action.action === "resume") {
      if (room.status !== "paused") throw new DiscussionError("CONFLICT", "讨论没有暂停");
      room.status = "running";
    } else if (action.action === "cancel") { room.status = "cancelled"; resetLease(room); }
    else if (action.action === "note") {
      if (room.messages.filter((m) => m.phase === "user").length >= 30) throw new DiscussionError("LIMIT", "每场最多补充 30 条意见");
      room.messages.push({ id: randomUUID(), agentId: "owner", name: "房主", phase: "user", round: 0, content: action.content, createdAt: Date.now() });
    }
    save(room); return { room, ...(token ? { token, participantId: "participantId" in action ? action.participantId : undefined } : {}) };
  });
}
function authenticate(token: string, clientId: string, joining: boolean): { room: Room; participant: Participant } {
  const credential = db().prepare("SELECT room_id,participant_id,client_id,revoked FROM discussion_hub_tokens WHERE token_hash=?").get(hash(token)) as Credential | undefined;
  if (!credential || credential.revoked) throw new DiscussionError("UNAUTHORIZED", "邀请不存在或已撤销", 401);
  if (credential.client_id && credential.client_id !== clientId) throw new DiscussionError("IDENTITY_CONFLICT", "邀请已绑定另一客户端；请使用原 clientId 或请房主重新邀请");
  const room = read(credential.room_id); const participant = room.participants.find((p) => p.id === credential.participant_id)!;
  if (!joining && (!credential.client_id || !participant.joined || participant.left)) throw new DiscussionError("JOIN_REQUIRED", "请先阅读 Skill 并加入讨论", 403);
  return { room, participant };
}
function publicState(room: Room, participant: Participant) {
  // Do not expose credentials, peer client identities, leases, or hidden initial opinions.
  const task = currentTask(room);
  const initial = !room.tasks.length || (task?.phase === "initial" && !terminal(room));
  return { roomId: room.id, topic: room.topic, rules: room.rules, status: room.status, you: { id: participant.id, name: participant.name, role: participant.role },
    participants: room.participants.map((p) => ({ id: p.id, name: p.name, role: p.role })),
    messages: room.messages.filter((m) => !initial || m.phase === "user" || m.agentId === participant.id),
    currentSpeaker: task ? room.participants.find((p) => p.id === task.participantId)?.name : null };
}
export function connectRoom(token: string, input: z.infer<typeof connectSchema>) {
  return transaction(() => {
    const { room, participant } = authenticate(token, input.clientId, input.action === "join");
    if (input.action === "join") {
      if (terminal(room)) throw new DiscussionError("ENDED", "讨论已经结束");
      if (input.skillHash !== discussionSkill().hash) throw new DiscussionError("SKILL_CHANGED", "请重新阅读当前版本 Skill 并使用其哈希加入", 428);
      db().prepare("UPDATE discussion_hub_tokens SET client_id=? WHERE room_id=? AND participant_id=?").run(input.clientId, room.id, participant.id);
      participant.joined = true; participant.left = false; participant.clientLabel = input.clientLabel;
    }
    // Long polls check once per second, but do not rewrite the entire transcript
    // every time. Persist idle presence at most every 15 seconds.
    let changed = input.action !== "poll" || Date.now() - participant.lastSeen >= 15000;
    if (changed) participant.lastSeen = Date.now();
    if (input.action === "leave") { participant.left = true; resetLease(room, participant.id); }
    const task = currentTask(room);
    if (input.action === "heartbeat" && input.taskId) {
      if (task?.id !== input.taskId || task.participantId !== participant.id || !input.leaseId || task.leaseId !== input.leaseId) throw new DiscussionError("STALE_LEASE", "发言任务已变化，请重新领取");
      if (room.status === "running") task.leaseUntil = Date.now() + LEASE_MS;
    }
    if (input.action === "submit") {
      const submitted = room.tasks.find((t) => t.id === input.taskId && t.participantId === participant.id);
      if (submitted?.completed) {
        if (submitted.submissionId === input.submissionId && submitted.contentHash === hash(input.content)) return { ...publicState(room, participant), accepted: true, duplicate: true };
        throw new DiscussionError("CONFLICT", "该轮已提交，不能覆盖观点");
      }
      if (room.status !== "running") throw new DiscussionError("NOT_RUNNING", "当前不可提交；请等待恢复或结束");
      if (!task || task !== submitted) throw new DiscussionError("NOT_YOUR_TURN", "尚未轮到你，或任务不属于你");
      if (task.leaseId !== input.leaseId || (task.leaseUntil ?? 0) <= Date.now()) throw new DiscussionError("STALE_LEASE", "租约已失效，请重新 poll 领取；讨论不会因此结束");
      room.messages.push({ id: randomUUID(), agentId: participant.id, name: participant.name, phase: task.phase, round: task.round, content: input.content, createdAt: Date.now() });
      task.completed = true; task.submissionId = input.submissionId; task.contentHash = hash(input.content);
      delete task.leaseId; delete task.leaseUntil;
      if (!currentTask(room)) room.status = "completed";
      save(room); return { ...publicState(room, participant), accepted: true, duplicate: false };
    }
    let assignment;
    if (input.action === "poll" && room.status === "running" && task?.participantId === participant.id) {
      if (!task.leaseId || (task.leaseUntil ?? 0) <= Date.now()) { task.leaseId = randomUUID(); task.leaseUntil = Date.now() + LEASE_MS; changed = true; }
      assignment = { id: task.id, leaseId: task.leaseId, leaseUntil: task.leaseUntil, phase: task.phase, round: task.round,
        instruction: task.phase === "initial" ? "独立评估：可行性、方案、关键假设、风险和待澄清问题。" : task.phase === "summary" ? "总结需求、候选方案、推荐方案及理由、实施步骤、风险、未解决分歧和待确认问题；不要把共识当证据。" : "回应其他人的公开观点，提出证据、反例或修订方案；避免重复与无意义附和。", maxCharacters: 16000 };
    }
    if (changed) save(room);
    return { ...publicState(room, participant), task: assignment ?? null, retryAfterSeconds: terminal(room) ? null : 3 };
  });
}
