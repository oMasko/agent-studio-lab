#!/usr/bin/env node
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const digest = (value) => createHash("sha256").update(value).digest("hex");
export async function run(args = process.argv.slice(2), env = process.env, fetcher = fetch) {
  const [command] = args;
  const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const base = new URL(env.DISCUSSION_URL || "http://127.0.0.1:3000");
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/" || !["http:", "https:"].includes(base.protocol)) throw new Error("DISCUSSION_URL 必须是不带凭据、路径或参数的 HTTP(S) origin");
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) && env.DISCUSSION_ALLOW_HTTP !== "1") throw new Error("远程连接请使用 HTTPS。仅可信内网试验可显式设置 DISCUSSION_ALLOW_HTTP=1。");
  async function request(path, body, token) {
    let response;
    try { response = await fetcher(new URL(path, base), { method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(25000), headers: body ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` } : {}, body: body ? JSON.stringify(body) : undefined }); }
    catch { throw new Error("网络请求失败；如果刚才提交结果不明，使用同一文件重试 submit，不要先 poll。连续三次失败请停止并联系房主。"); }
    const data = await response.json();
    if (!response.ok) { const error = new Error(`${data.code || response.status}: ${data.error || "请求失败"}`); error.status = response.status; error.code = data.code; throw error; }
    return data;
  }
  if (command === "skill") return request("/api/discussion-connect/skill?format=json");
  if (!["join", "poll", "submit", "heartbeat", "leave"].includes(command)) throw new Error("用法：skill | join --ack HASH --name LABEL | poll | submit --file PATH | heartbeat | leave");
  const token = env.DISCUSSION_TOKEN;
  if (!token || !/^[A-Za-z0-9_-]{24,256}$/.test(token)) throw new Error("请由用户私下提供 DISCUSSION_TOKEN 环境变量；不要将令牌写入命令参数。");
  const statePath = resolve(env.DISCUSSION_STATE || ".discussion-client.json");
  let state;
  try { state = JSON.parse(await readFile(statePath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("客户端状态文件无效，请使用本参与者原有状态或指定新的 DISCUSSION_STATE"); }
  if (state && (state.version !== 1 || state.origin !== base.origin || state.tokenHash !== digest(token))) throw new Error("状态文件属于其他邀请或服务器。请指定不同 DISCUSSION_STATE；不要覆盖其他参与者的状态。");
  if (state && env.DISCUSSION_CLIENT_ID && env.DISCUSSION_CLIENT_ID !== state.clientId) throw new Error("DISCUSSION_CLIENT_ID 与已保存身份不同");
  state ??= { version: 1, origin: base.origin, tokenHash: digest(token), clientId: env.DISCUSSION_CLIENT_ID || randomUUID() };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(state.clientId)) throw new Error("DISCUSSION_CLIENT_ID 必须为 UUID");
  async function save() {
    const temporary = join(dirname(statePath), `.discussion-state-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" });
    await rename(temporary, statePath);
  }
  await save(); // Persist identity before any request, so retries never create a new identity.
  const body = { action: command, clientId: state.clientId };
  if (command === "join") {
    const ack = option("--ack");
    if (!ack || !/^[0-9a-f]{64}$/.test(ack)) throw new Error("请先阅读 skill 的完整内容，再通过 --ack 提供其 hash");
    Object.assign(body, { skillHash: ack, clientLabel: option("--name") || "External Agent" });
  }
  if (command === "poll") {
    if (state.pending) throw new Error("上次提交结果不明，请先使用同一文件重试 submit；不要跳到下一任务。");
    body.waitSeconds = 20;
  }
  if (command === "heartbeat" && state.task) Object.assign(body, { taskId: state.task.id, leaseId: state.task.leaseId });
  if (command === "submit") {
    if (!state.task || !option("--file")) throw new Error("请先 poll 获取任务，并指定 --file 公开发言文件");
    const content = (await readFile(resolve(option("--file")), "utf8")).trim();
    if (!content || content.length > 16000) throw new Error("公开发言必须为 1–16000 字符");
    if (state.submission && state.submission.contentHash !== digest(content)) throw new Error("重试内容与上次提交不同。先确认上次结果，不能用同一任务覆盖已发表观点。");
    state.submission ??= { id: randomUUID(), contentHash: digest(content) };
    state.pending = true; await save();
    Object.assign(body, { taskId: state.task.id, leaseId: state.task.leaseId, submissionId: state.submission.id, content });
  }
  let data;
  try { data = await request("/api/discussion-connect", body, token); }
  catch (error) {
    if (command === "submit" && error.status >= 400 && error.status < 500) {
      state.pending = false;
      // These explicit rejections guarantee no publication: revised text is safe.
      if (["STALE_LEASE", "NOT_RUNNING", "GUARDRAIL"].includes(error.code)) delete state.submission;
      await save();
    }
    throw error;
  }
  if (command === "poll") {
    if (state.task?.id !== data.task?.id) delete state.submission;
    state.task = data.task;
  }
  if (command === "submit" && data.accepted) { state.pending = false; delete state.task; delete state.submission; }
  if (command === "leave") { state.pending = false; delete state.task; delete state.submission; }
  await save(); return data;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().then((data) => console.log(JSON.stringify(data, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
