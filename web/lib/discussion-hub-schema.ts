import { z } from "zod";
export const createSchema = z.object({
  requestId: z.string().uuid(), topic: z.string().trim().min(1).max(12000), rules: z.string().trim().max(6000).default(""),
  participants: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), name: z.string().trim().min(1).max(60), role: z.string().trim().max(2000) })).min(2).max(6),
  moderatorId: z.string(), rounds: z.number().int().min(1).max(3),
}).superRefine((value, ctx) => {
  if (new Set(value.participants.map((p) => p.id)).size !== value.participants.length || new Set(value.participants.map((p) => p.name)).size !== value.participants.length) ctx.addIssue({ code: "custom", message: "参与者 ID 和名称不得重复" });
  if (!value.participants.some((p) => p.id === value.moderatorId)) ctx.addIssue({ code: "custom", message: "主持人必须是参与者" });
});
export const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["start", "pause", "resume", "cancel"]) }),
  z.object({ action: z.literal("note"), content: z.string().trim().min(1).max(2000) }),
  z.object({ action: z.literal("invite"), participantId: z.string() }),
  z.object({ action: z.literal("revoke"), participantId: z.string() }),
]);
const identity = { clientId: z.string().uuid() };
export const connectSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("join"), ...identity, skillHash: z.string().length(64), clientLabel: z.string().trim().min(1).max(80) }),
  z.object({ action: z.literal("poll"), ...identity, waitSeconds: z.number().int().min(0).max(20).default(0) }),
  z.object({ action: z.literal("heartbeat"), ...identity, taskId: z.string().uuid().optional(), leaseId: z.string().uuid().optional() }),
  z.object({ action: z.literal("leave"), ...identity }),
  z.object({ action: z.literal("submit"), ...identity, taskId: z.string().uuid(), leaseId: z.string().uuid(), submissionId: z.string().uuid(), content: z.string().trim().min(1).max(16000) }),
]);
