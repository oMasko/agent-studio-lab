export type Phase = "initial" | "debate" | "summary" | "user";
export type RoomStatus = "lobby" | "running" | "paused" | "completed" | "cancelled" | "interrupted" | "failed";
export type Participant = { id: string; name: string; role: string; joined: boolean; left: boolean; revoked: boolean; lastSeen: number; clientLabel: string };
export type Message = { id: string; agentId: string; name: string; phase: Phase; round: number; content: string; createdAt: number };
export type Task = { id: string; participantId: string; phase: Exclude<Phase, "user">; round: number; completed: boolean;
  leaseId?: string; leaseUntil?: number; submissionId?: string; contentHash?: string };
export type Room = { id: string; requestId: string; mode: "external" | "legacy"; topic: string; rules: string; rounds: number; moderatorId: string;
  participants: Participant[]; status: RoomStatus; messages: Message[]; tasks: Task[]; createdAt: number; updatedAt: number; error: string; skillHash: string };
export type RoomSummary = Pick<Room, "id" | "mode" | "topic" | "status" | "createdAt" | "updatedAt">;
export const statusLabels: Record<RoomStatus, string> = { lobby: "等待加入", running: "讨论中", paused: "已暂停", completed: "已完成", cancelled: "已取消", interrupted: "已中断", failed: "失败" };
export const phaseLabels = { initial: "独立初评", debate: "交叉讨论", summary: "主持总结", user: "房主补充" };
export function participantStatus(room: Room, p: Participant, now = Date.now()) {
  if (p.revoked) return "邀请已撤销";
  if (p.left) return "已退出";
  if (!p.joined) return "待加入";
  if (now - p.lastSeen > 60000) return "离线 / 未报心跳";
  const task = room.tasks.find((t) => !t.completed);
  if (room.status === "running" && task?.participantId === p.id) return task.leaseId && (task.leaseUntil ?? 0) > now ? "发言中" : "等待领取发言";
  return "在线";
}
