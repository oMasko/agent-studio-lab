import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = resolve(projectDirectory, ".next/dev/lock");
const dryRun = process.argv.includes("--dry-run");

function lsof(args) {
  try {
    return execFileSync("/usr/sbin/lsof", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string") {
      return error.stdout;
    }
    return "";
  }
}

function nodeProcessesInProject() {
  const output = lsof(["-a", "-d", "cwd", "-c", "node", "-Fn"]);
  const matches = [];
  let currentPid;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) currentPid = Number(line.slice(1));
    if (line.startsWith("n") && line.slice(1) === projectDirectory && currentPid) matches.push(currentPid);
  }
  return [...new Set(matches)];
}

function ownsNextDevLock(pid) {
  const output = lsof(["-p", String(pid), "-Fn"]);
  return output.split("\n").some((line) => line === `n${lockPath}`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isAlive(pid))) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

const stalePids = nodeProcessesInProject()
  .filter((pid) => pid !== process.pid && pid !== process.ppid)
  .filter(ownsNextDevLock);

if (stalePids.length === 0) {
  console.log("✓ 没有发现当前项目的旧 Next.js 开发服务器");
  process.exit(0);
}

if (dryRun) {
  console.log(`将终止当前项目的旧 Next.js 开发服务器：${stalePids.join(", ")}`);
  process.exit(0);
}

console.log(`正在停止当前项目的旧 Next.js 开发服务器：${stalePids.join(", ")}`);
for (const pid of stalePids) {
  try { process.kill(pid, "SIGTERM"); } catch { /* It may have exited between discovery and shutdown. */ }
}
await waitForExit(stalePids, 3_000);

const remaining = stalePids.filter(isAlive);
for (const pid of remaining) {
  try { process.kill(pid, "SIGKILL"); } catch { /* It may have exited after the final check. */ }
}
if (remaining.length > 0) await waitForExit(remaining, 1_000);

const failed = stalePids.filter(isAlive);
if (failed.length > 0) {
  console.error(`无法停止旧开发服务器：${failed.join(", ")}。请检查进程权限。`);
  process.exit(1);
}

console.log("✓ 旧开发服务器已停止");
