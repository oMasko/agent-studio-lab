import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { randomUUID } from "node:crypto";
import ts from "typescript";
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = mkdtempSync(join(tmpdir(), "discussion-invitation-test-"));
mkdirSync(join(fixture, "web"));
cpSync(join(sourceRoot, "resources"), join(fixture, "web/resources"), { recursive: true });
process.chdir(join(fixture, "web"));
process.env.DISCUSSION_ADMIN_TOKEN = "test_admin_secret_not_for_participants_12345";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) return { url: pathToFileURL(resolve(sourceRoot, `${specifier.slice(2)}.ts`)).href, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(pathToFileURL(sourceRoot).href) && url.endsWith(".ts")) return { format: "module", source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, shortCircuit: true };
    return next(url, context);
  },
});
const { createRoom, getRoom, manageRoom, connectRoom, listRooms } = await import("@/lib/discussion-hub");
const { createSchema } = await import("@/lib/discussion-hub-schema");
const { discussionSkill, hash } = await import("@/lib/discussion-access");
const { agentDatabase } = await import("@/lib/database");
const api = await import("../app/api/discussions/route.ts");
const detail = await import("../app/api/discussions/[id]/route.ts");
const external = await import("../app/api/discussion-connect/route.ts");
const skillRoute = await import("../app/api/discussion-connect/skill/route.ts");
const { run: helper } = await import("../resources/discussion-room-participant/scripts/participate.mjs");
const input = () => createSchema.parse({ requestId: randomUUID(), topic: "可行性讨论", rules: "不要执行方案", participants: [{ id: "a", name: "产品", role: "澄清价值" }, { id: "b", name: "架构", role: "评估可行性" }], moderatorId: "a", rounds: 1 });
const bad = (action, code) => assert.throws(action, (error) => error.code === code);
const joinRoom = (token, clientId) => connectRoom(token, { action: "join", clientId, clientLabel: "Independent Agent", skillHash: discussionSkill().hash });
const poll = (token, clientId) => connectRoom(token, { action: "poll", clientId, waitSeconds: 0 });
const reply = (token, clientId, task, content = "public opinion", submissionId = randomUUID()) => {
  const body = { action: "submit", clientId, taskId: task.id, leaseId: task.leaseId, submissionId, content };
  return { response: connectRoom(token, body), body };
};
const config = input();
assert.equal(createSchema.safeParse({ ...config, participants: [config.participants[0]] }).success, false);
assert.equal(createSchema.safeParse({ ...config, moderatorId: "unknown" }).success, false);
const room = createRoom(config);
assert.equal(createRoom(config).id, room.id);
bad(() => createRoom({ ...config, topic: "different" }), "CONFLICT");
const inviteA = manageRoom(room.id, { action: "invite", participantId: "a" });
const inviteB = manageRoom(room.id, { action: "invite", participantId: "b" });
const ca = randomUUID(), cb = randomUUID();
assert.ok(!JSON.stringify(getRoom(room.id)).includes(inviteA.token));
assert.ok(!JSON.stringify(agentDatabase().prepare("SELECT * FROM discussion_hub_tokens").all()).includes(inviteA.token));
bad(() => poll(inviteA.token, ca), "JOIN_REQUIRED");
bad(() => joinRoom("missing", ca), "UNAUTHORIZED");
bad(() => connectRoom(inviteA.token, { action: "join", clientId: ca, clientLabel: "a", skillHash: "0".repeat(64) }), "SKILL_CHANGED");
bad(() => manageRoom(room.id, { action: "start" }), "NOT_READY");
joinRoom(inviteA.token, ca); joinRoom(inviteA.token, ca); // retry join is idempotent
bad(() => joinRoom(inviteA.token, randomUUID()), "IDENTITY_CONFLICT");
joinRoom(inviteB.token, cb); manageRoom(room.id, { action: "start" });
assert.equal(poll(inviteB.token, cb).task, null);
let task = poll(inviteA.token, ca).task;
assert.equal(task.leaseId, poll(inviteA.token, ca).task.leaseId);
bad(() => reply(inviteB.token, cb, task), "NOT_YOUR_TURN");
const first = reply(inviteA.token, ca, task, "PRIVATE_UNTIL_INITIAL_FINISHES");
assert.equal(connectRoom(inviteA.token, first.body).duplicate, true);
bad(() => connectRoom(inviteA.token, { ...first.body, content: "overwrite" }), "CONFLICT");
assert.ok(!JSON.stringify(poll(inviteB.token, cb)).includes("PRIVATE_UNTIL_INITIAL_FINISHES"));
task = poll(inviteB.token, cb).task;
manageRoom(room.id, { action: "note", content: "PUBLIC_NEW_CONSTRAINT" });
assert.ok(JSON.stringify(poll(inviteB.token, cb)).includes("PUBLIC_NEW_CONSTRAINT"));
const now = Date.now;
try {
  Date.now = () => now() + 11 * 60 * 1000;
  bad(() => reply(inviteB.token, cb, task), "STALE_LEASE");
  assert.equal(getRoom(room.id).status, "running", "expired lease must not end the room");
  const replacement = poll(inviteB.token, cb).task;
  assert.notEqual(replacement.leaseId, task.leaseId);
  task = replacement;
} finally { Date.now = now; }
reply(inviteB.token, cb, task);
assert.ok(JSON.stringify(poll(inviteA.token, ca)).includes("PRIVATE_UNTIL_INITIAL_FINISHES"));
task = poll(inviteA.token, ca).task;
manageRoom(room.id, { action: "pause" });
bad(() => reply(inviteA.token, ca, task), "NOT_RUNNING");
manageRoom(room.id, { action: "resume" });
bad(() => reply(inviteA.token, ca, task), "STALE_LEASE");
task = poll(inviteA.token, ca).task;
connectRoom(inviteA.token, { action: "heartbeat", clientId: ca, taskId: task.id, leaseId: task.leaseId });
reply(inviteA.token, ca, task);
// Restart persistence: close and reopen the real SQLite database, not in-memory state.
agentDatabase().close(); delete globalThis.__agentStudioDatabase;
assert.equal(getRoom(room.id).status, "running");
task = poll(inviteB.token, cb).task;
manageRoom(room.id, { action: "revoke", participantId: "b" });
bad(() => reply(inviteB.token, cb, task), "UNAUTHORIZED");
const replacementB = manageRoom(room.id, { action: "invite", participantId: "b" });
joinRoom(replacementB.token, cb);
task = poll(replacementB.token, cb).task;
reply(replacementB.token, cb, task);
task = poll(inviteA.token, ca).task; assert.equal(task.phase, "summary");
reply(inviteA.token, ca, task, "Final recommendation and unresolved disagreements");
assert.equal(getRoom(room.id).status, "completed");
assert.equal(poll(inviteA.token, ca).retryAfterSeconds, null);
assert.equal(getRoom(room.id).messages.filter((m) => m.phase !== "user").length, 5);
bad(() => manageRoom(room.id, { action: "invite", participantId: "a" }), "ENDED");

function req(path, body, token = process.env.DISCUSSION_ADMIN_TOKEN, method = "POST") {
  return new Request(`http://127.0.0.1:3000${path}`, { method: body ? method : "GET", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: body ? JSON.stringify(body) : undefined });
}
assert.equal((await api.GET(req("/api/discussions", undefined, ""))).status, 401);
assert.equal((await api.GET(req("/api/discussions", undefined, inviteA.token))).status, 401);
assert.equal((await detail.PATCH(req("/", { action: "cancel" }, inviteA.token, "PATCH"), { params: Promise.resolve({ id: room.id }) })).status, 401);
assert.equal((await external.POST(req("/", { action: "poll", clientId: ca }, process.env.DISCUSSION_ADMIN_TOKEN))).status, 401);
assert.equal((await api.POST(req("/", { ...input(), topic: "x".repeat(140000) }))).status, 413);
const skillData = await (await skillRoute.GET(req("/api/discussion-connect/skill?format=json"))).json();
assert.equal(hash(skillData.content), skillData.hash);
const zip = await skillRoute.GET(req("/api/discussion-connect/skill?format=zip"));
assert.equal(zip.headers.get("content-type"), "application/zip");
assert.ok((await zip.arrayBuffer()).byteLength > 1000);

// Exercise the downloadable client against real route handlers without a network/model.
const second = createRoom(input());
const token2 = manageRoom(second.id, { action: "invite", participantId: "a" }).token;
const token3 = manageRoom(second.id, { action: "invite", participantId: "b" }).token;
const environment = { DISCUSSION_URL: "http://127.0.0.1:3000", DISCUSSION_TOKEN: token2, DISCUSSION_STATE: join(fixture, "client-a.json") };
const routeFetch = async (url, init = {}) => {
  assert.equal(init.redirect, "error");
  const request = new Request(url, init);
  return new URL(url).pathname.endsWith("/skill") ? skillRoute.GET(request) : external.POST(request);
};
await helper(["skill"], environment, routeFetch);
await assert.rejects(helper(["join"], environment, routeFetch), /--ack/);
await helper(["join", "--ack", skillData.hash, "--name", "External Codex"], environment, routeFetch);
const cb2 = randomUUID(); joinRoom(token3, cb2); manageRoom(second.id, { action: "start" });
const polled = await helper(["poll"], environment, routeFetch);
const clientState = JSON.parse(readFileSync(environment.DISCUSSION_STATE, "utf8"));
assert.ok(!JSON.stringify(clientState).includes(token2));
assert.equal(polled.task.phase, "initial");
const publicFile = join(fixture, "reply.md"); writeFileSync(publicFile, "External participant's own public opinion");
writeFileSync(publicFile, "BEGIN_PRIVATE_DATA");
await assert.rejects(helper(["submit", "--file", publicFile], environment, routeFetch), /GUARDRAIL/);
assert.equal(getRoom(second.id).messages.length, 0, "guardrail must reject before publication");
writeFileSync(publicFile, "External participant's own public opinion");
let drop = true;
const droppedResponse = async (url, init) => {
  const response = await routeFetch(url, init);
  if (drop && JSON.parse(init.body).action === "submit") { drop = false; throw new Error("socket lost AFTER commit"); }
  return response;
};
await assert.rejects(helper(["submit", "--file", publicFile], environment, droppedResponse), /结果不明/);
await assert.rejects(helper(["poll"], environment, routeFetch), /上次提交结果不明/);
const retried = await helper(["submit", "--file", publicFile], environment, routeFetch);
assert.equal(retried.duplicate, true);
assert.equal(getRoom(second.id).messages.length, 1);
await assert.rejects(helper(["poll"], { ...environment, DISCUSSION_TOKEN: token3 }, routeFetch), /属于其他邀请/);
await assert.rejects(helper(["skill"], { DISCUSSION_URL: "http://remote.example" }, routeFetch), /HTTPS/);
assert.ok(!JSON.stringify(poll(token3, cb2)).includes("Final recommendation"), "rooms must not share context");
connectRoom(token3, { action: "leave", clientId: cb2 });
bad(() => poll(token3, cb2), "JOIN_REQUIRED");
joinRoom(token3, cb2);
const stale = poll(token3, cb2).task;
manageRoom(second.id, { action: "cancel" });
bad(() => reply(token3, cb2, stale), "NOT_RUNNING");
assert.equal(poll(token3, cb2).status, "cancelled");
// Check long-poll revocation is revalidated, rather than leaking a cached response.
const third = createRoom(input()); const t3 = manageRoom(third.id, { action: "invite", participantId: "a" }).token;
const c3 = randomUUID(); joinRoom(t3, c3);
const longPoll = external.POST(req("/api/discussion-connect", { action: "poll", clientId: c3, waitSeconds: 2 }, t3));
setTimeout(() => manageRoom(third.id, { action: "revoke", participantId: "a" }), 100);
assert.equal((await longPoll).status, 401);

agentDatabase().exec("CREATE TABLE discussion_rooms (room_json TEXT, updated_at INTEGER)");
agentDatabase().prepare("INSERT INTO discussion_rooms VALUES (?,?)").run(JSON.stringify({ id: "legacy", config: { agents: [{ id: "old", name: "Old", instructions: "old role" }], rounds: 1, moderatorId: "old" }, topic: "Old room", status: "completed", messages: [{ content: "Preserved" }], createdAt: 1, updatedAt: 1 }), 1);
assert.equal(getRoom("legacy").mode, "legacy");
assert.equal(getRoom("legacy").messages[0].content, "Preserved");
assert.ok(listRooms().some((r) => r.id === "legacy"));
bad(() => manageRoom("legacy", { action: "cancel" }), "NOT_FOUND");
agentDatabase().close();
console.log("PASS: invitations/hash-only storage, auth scopes, Skill ack, independent initial opinions, turn ownership, atomic/idempotent submissions, leases/heartbeat, pause/revoke/leave/cancel, durable restart, isolated rooms, legacy read-only, payload limits, Skill ZIP, real client+routes, lost-response recovery, long-poll revocation. No models or local Codex processes started.");
console.log(`Isolated test fixtures: ${fixture}`);
